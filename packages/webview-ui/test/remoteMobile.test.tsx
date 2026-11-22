// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { App } from '../src/App.tsx';
import { DiffViewerModal } from '../src/components/DiffViewerModal.tsx';
import { MobilePairingGate } from '../src/components/MobilePairingGate.tsx';
import { QrCodeSvg } from '../src/components/QrCodeSvg.tsx';
import { RemoteSettings } from '../src/components/settings/RemoteSettings.tsx';
import { buildUnifiedDiffLines, parseUnifiedPatchLines } from '../src/lib/lineDiff.ts';
import { encodeQrMatrix } from '../src/lib/qr.ts';
import { applyHostMessage, resetStoreForTests } from '../src/store.ts';
import {
  ConnectionSupervisor,
  computeReconnectDelayMs,
  extractPairCodeFromHash,
  probeFallbackRoute,
  type SocketLike,
  type TransportStatus,
} from '../src/transport.ts';
import { makeSnapshot, mockVsCodeApi } from './setup.ts';

const vscode = mockVsCodeApi();

beforeEach(() => {
  vscode.reset();
  resetStoreForTests();
  window.innerWidth = 1024;
});

describe('HD-22 ConnectionSupervisor 与传输抽象', () => {
  it('支持建连发 ready、15s 心跳、指数抖动退避、切回前台立即重连与 4001 吊销终止', () => {
    const sockets: MockSocket[] = [];
    const statuses: TransportStatus[] = [];
    const hostMessages: unknown[] = [];
    let revoked = false;
    let nextTimerId = 1;
    const timers = new Map<number, { fn: () => void; ms: number }>();

    class MockSocket implements SocketLike {
      readyState = 0;
      sent: unknown[] = [];
      onopen: ((e: unknown) => void) | null = null;
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onclose: ((e: { code?: number; reason?: string }) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;

      send(data: string): void {
        this.sent.push(JSON.parse(data));
      }

      close(code?: number, reason?: string): void {
        this.readyState = 3;
        this.onclose?.({ code, reason });
      }

      emitOpen(): void {
        this.readyState = 1;
        this.onopen?.({});
      }
    }

    const supervisor = new ConnectionSupervisor({
      wsUrl: () => 'ws://127.0.0.1:9999/ws',
      createSocket: () => {
        const s = new MockSocket();
        sockets.push(s);
        return s;
      },
      onHostMessage: (m) => hostMessages.push(m),
      onStatusChange: (s) => statuses.push(s),
      onRevoked: () => {
        revoked = true;
      },
      random: () => 0.5,
      setTimer: (fn, ms) => {
        const id = nextTimerId++;
        timers.set(id, { fn, ms });
        return id;
      },
      clearTimer: (handle) => {
        timers.delete(handle as number);
      },
    });

    supervisor.start();
    expect(supervisor.getStatus()).toBe('connecting');
    expect(sockets).toHaveLength(1);

    // 建连后发送 visibility + ready 并启动 15s 心跳
    sockets[0]!.emitOpen();
    expect(supervisor.getStatus()).toBe('connected');
    expect(sockets[0]!.sent).toEqual([
      { type: 'visibility', payload: { visible: true } },
      { type: 'ready', payload: {} },
    ]);

    const hbEntry = [...timers.entries()].find(([, v]) => v.ms === 15_000);
    expect(hbEntry).toBeTruthy();
    hbEntry![1].fn();
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: 'ping' });

    // 收到 pong 不转发给业务层，同时清除 pong 超时定时器
    sockets[0]!.onmessage?.({ data: JSON.stringify({ type: 'pong' }) });
    expect(hostMessages).toHaveLength(0);

    // 断线后按指数退避重连
    sockets[0]!.close(1006, 'dropped');
    expect(supervisor.getStatus()).toBe('reconnecting');
    const retryEntry = [...timers.entries()].find(([, v]) => v.ms === computeReconnectDelayMs(0, 0.5));
    expect(retryEntry).toBeTruthy();

    // 切回前台立即重连
    supervisor.notifyVisibility(true);
    expect(sockets).toHaveLength(2);
    sockets[1]!.emitOpen();
    expect(supervisor.getStatus()).toBe('connected');

    // 4001 设备被吊销后进入 unauthenticated 且不再重连
    sockets[1]!.close(4001, 'Device revoked');
    expect(revoked).toBe(true);
    expect(supervisor.getStatus()).toBe('unauthenticated');
    expect(sockets).toHaveLength(2);

    supervisor.dispose();
  });

  it('extractPairCodeFromHash 正确解析 URL fragment 中的 code', () => {
    expect(extractPairCodeFromHash('#code=abc-123_XYZ')).toBe('abc-123_XYZ');
    expect(extractPairCodeFromHash('')).toBeUndefined();
  });

  it('probeFallbackRoute 按 LAN -> Tailscale -> Tunnel 优先级跳过当前与不可达路由', async () => {
    const visited: string[] = [];
    const route = await probeFallbackRoute(
      [
        { kind: 'tunnel', url: 'https://deck.example.com' },
        { kind: 'lan', url: 'http://192.168.1.10:37890' },
        { kind: 'tailscale', url: 'https://devbox.tail.ts.net' },
      ],
      'http://192.168.1.10:37890',
      (async (input: RequestInfo | URL) => {
        const url = String(input);
        visited.push(url);
        if (url.startsWith('https://devbox.tail.ts.net')) {
          return new Response('{"ok":true}', { status: 200 });
        }
        throw new Error('offline');
      }) as typeof fetch,
    );
    expect(route).toEqual({ kind: 'tailscale', url: 'https://devbox.tail.ts.net' });
    expect(visited).toEqual(['https://devbox.tail.ts.net/api/health']);
  });
});

describe('HD-23 本地 QR 编码与远程互通设置页', () => {
  it('encodeQrMatrix 严格遵循 ISO/IEC 18004（双副本格式位、暗模块、掩码与字节模式载荷可无损解回原 URL）', () => {
    const readFormatCopies = (mods: readonly (readonly boolean[])[]) => {
      const n = mods.length;
      let copy1 = 0;
      for (let i = 0; i < 6; i += 1) copy1 = (copy1 << 1) | (mods[8]![i] ? 1 : 0);
      copy1 = (copy1 << 1) | (mods[8]![7] ? 1 : 0);
      copy1 = (copy1 << 1) | (mods[8]![8] ? 1 : 0);
      copy1 = (copy1 << 1) | (mods[7]![8] ? 1 : 0);
      for (let row = 5; row >= 0; row -= 1) copy1 = (copy1 << 1) | (mods[row]![8] ? 1 : 0);

      let copy2 = 0;
      for (let i = 0; i < 7; i += 1) copy2 = (copy2 << 1) | (mods[n - 1 - i]![8] ? 1 : 0);
      for (let i = 0; i < 8; i += 1) copy2 = (copy2 << 1) | (mods[8]![n - 8 + i] ? 1 : 0);
      return { copy1, copy2 };
    };

    const verifyBch15 = (raw15: number): number => {
      let rem = raw15 ^ 0x5412;
      for (let i = 4; i >= 0; i -= 1) {
        if ((rem >>> (i + 10)) & 1) rem ^= 0x537 << i;
      }
      return rem;
    };

    const decodeBytePayload = (url: string) => {
      const m = encodeQrMatrix(url);
      expect(m.size).toBe(m.version * 4 + 17);
      // 固定暗模块 (size-8, 8)
      expect(m.modules[m.size - 8]![8]).toBe(true);
      const { copy1, copy2 } = readFormatCopies(m.modules);
      expect(copy1).toBe(copy2);
      expect(verifyBch15(copy1)).toBe(0);
      const unmaskedFmt = (copy1 ^ 0x5412) >>> 10;
      const eccBits = unmaskedFmt >>> 3;
      const mask = unmaskedFmt & 0b111;
      expect(eccBits).toBe(0b01); // ECC-L

      // 构造功能区掩码，按之字形读出未交织数据位（单块版本 v1..v5 可直接还原 UTF-8 载荷）
      if (m.version <= 5) {
        const n = m.size;
        const fn = Array.from({ length: n }, () => Array<boolean>(n).fill(false));
        const markRect = (r0: number, c0: number, h: number, w: number) => {
          for (let r = Math.max(0, r0); r < Math.min(n, r0 + h); r += 1) {
            for (let c = Math.max(0, c0); c < Math.min(n, c0 + w); c += 1) fn[r]![c] = true;
          }
        };
        markRect(0, 0, 9, 9);
        markRect(0, n - 8, 9, 8);
        markRect(n - 8, 0, 8, 9);
        for (let i = 0; i < n; i += 1) {
          fn[6]![i] = true;
          fn[i]![6] = true;
        }
        if (m.version >= 2) {
          const c = n - 7;
          markRect(c - 2, c - 2, 5, 5);
        }
        const maskFn = (r: number, c: number): boolean => {
          switch (mask) {
            case 0: return (r + c) % 2 === 0;
            case 1: return r % 2 === 0;
            case 2: return c % 3 === 0;
            case 3: return (r + c) % 3 === 0;
            case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
            case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
            case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
            default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
          }
        };
        const bits: number[] = [];
        let upward = true;
        for (let right = n - 1; right >= 1; right -= 2) {
          if (right === 6) right = 5;
          for (let vert = 0; vert < n; vert += 1) {
            const r = upward ? n - 1 - vert : vert;
            for (let dx = 0; dx < 2; dx += 1) {
              const c = right - dx;
              if (fn[r]![c]) continue;
              const rawBit = m.modules[r]![c] ? 1 : 0;
              bits.push(rawBit ^ (maskFn(r, c) ? 1 : 0));
            }
          }
          upward = !upward;
        }
        const readInt = (offset: number, len: number) => {
          let v = 0;
          for (let i = 0; i < len; i += 1) v = (v << 1) | (bits[offset + i] ?? 0);
          return v;
        };
        expect(readInt(0, 4)).toBe(0b0100); // Byte mode
        const byteLen = readInt(4, 8);
        const bytes = new Uint8Array(byteLen);
        for (let i = 0; i < byteLen; i += 1) {
          bytes[i] = readInt(12 + i * 8, 8);
        }
        expect(new TextDecoder().decode(bytes)).toBe(url);
      }
    };

    const shortUrl = 'http://192.168.1.10:37890/pair#code=AbCdEfGh1234';
    decodeBytePayload(shortUrl);
    // 长 URL（触发 Version 7+ 版本信息区）也校验双副本格式位与 BCH 校验
    decodeBytePayload(`https://my-long-workstation.tailnet-example.ts.net/pair#code=${'A'.repeat(110)}`);

    const { container } = render(<QrCodeSvg value={shortUrl} />);
    const svg = container.querySelector('[data-testid="remote-pairing-qr"]');
    expect(svg).toBeTruthy();
    expect(svg?.querySelector('path')?.getAttribute('d')?.length).toBeGreaterThan(20);
  });

  it('RemoteSettings 渲染并可切换总开关、生成配对码、吊销设备、探测 Tailscale 与发送测试推送', () => {
    act(() =>
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          remote: {
            enabled: true,
            running: true,
            port: 43210,
            bindHost: '0.0.0.0',
            interfaces: [{ name: 'wlan0', address: '192.168.1.42' }],
            selectedHost: '192.168.1.42',
            scope: 'operate',
            connectedClients: 1,
            devices: [
              {
                id: 'dev-1',
                name: 'iPhone Safari',
                scope: 'operate',
                createdAt: 1000,
                lastSeenAt: 2000,
                connected: true,
                pushSubscribed: true,
              },
            ],
            pairing: {
              url: 'http://192.168.1.42:43210/pair#code=oneTimeCode',
              code: 'oneTimeCode',
              scope: 'operate',
              expiresAt: Date.now() + 300_000,
              routeKind: 'lan',
            },
            tailscale: {
              installed: true,
              loggedIn: true,
              dnsName: 'macbook.tail.ts.net',
              serveUrl: 'https://macbook.tail.ts.net',
              serveEnabled: false,
            },
            push: {
              webPushEnabled: true,
              suppressWhenFocused: true,
              webhook: { enabled: false, preset: 'bark', url: '' },
            },
          },
        }),
      }),
    );

    render(<RemoteSettings />);
    expect(screen.getByTestId('remote-pairing-qr')).toBeTruthy();
    expect(screen.getByTestId('remote-device-dev-1')).toBeTruthy();

    fireEvent.click(screen.getByTestId('remote-generate-pairing-btn'));
    expect(vscode.posted.some((m) => m.type === 'generateRemotePairing')).toBe(true);

    fireEvent.click(screen.getByTestId('remote-revoke-dev-1'));
    expect(vscode.posted).toContainEqual({ type: 'revokeRemoteDevice', payload: { deviceId: 'dev-1' } });

    fireEvent.click(screen.getByTestId('remote-tailscale-probe-btn'));
    expect(vscode.posted).toContainEqual({ type: 'probeTailscale', payload: {} });

    fireEvent.click(screen.getByTestId('remote-test-push-btn'));
    expect(vscode.posted).toContainEqual({ type: 'testRemotePush', payload: {} });

    fireEvent.click(screen.getByTestId('remote-refresh-network-btn'));
    expect(vscode.posted).toContainEqual({ type: 'refreshRemoteNetwork', payload: {} });
  });

  it('RemoteSettings 在 WSL2 NAT 模式下展示 Windows 端口转发命令与刷新入口', () => {
    act(() =>
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          remote: {
            enabled: true,
            running: true,
            port: 37890,
            bindHost: '0.0.0.0',
            interfaces: [
              { name: 'Windows · 以太网', address: '192.168.100.32' },
              { name: 'WSL · eth0', address: '172.21.154.63' },
            ],
            selectedHost: '192.168.100.32',
            scope: 'operate',
            connectedClients: 0,
            devices: [],
            wslNat: {
              active: true,
              wslAddress: '172.21.154.63',
              windowsAddress: '192.168.100.32',
              portProxyConfigured: false,
              setupCommand:
                'netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=37890 connectaddress=172.21.154.63 connectport=37890',
            },
          },
        }),
      }),
    );

    render(<RemoteSettings />);
    expect(screen.getByTestId('remote-wsl-nat-card')).toBeTruthy();
    expect(screen.getByTestId('remote-wsl-nat-cmd').textContent).toContain('172.21.154.63');
    expect(screen.getByTestId('remote-copy-wsl-cmd-btn')).toBeTruthy();
  });

  it('MobilePairingGate 可提交配对码并在错误时展示提示', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, reason: 'invalid', remainingAttempts: 3 }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    try {
      render(<MobilePairingGate />);
      fireEvent.change(screen.getByTestId('mobile-pair-code-input'), { target: { value: 'bad-code' } });
      await act(async () => {
        fireEvent.click(screen.getByTestId('mobile-pair-submit'));
      });
      expect(screen.getByTestId('mobile-pair-error').textContent).toContain('3');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('HD-25 内嵌 Diff 审阅与无 IDE 弹窗降级', () => {
  it('lineDiff 正确计算 pair Diff 与解析 unified patch', () => {
    const pair = buildUnifiedDiffLines('a\nb\nc', 'a\nb2\nc');
    expect(pair.some((l) => l.kind === 'del' && l.text === 'b')).toBe(true);
    expect(pair.some((l) => l.kind === 'add' && l.text === 'b2')).toBe(true);

    const unified = parseUnifiedPatchLines('@@ -1,2 +1,2 @@\n-old\n+new\n ctx');
    expect(unified.map((l) => l.kind)).toEqual(['hunk', 'del', 'add', 'context']);
  });

  it('DiffViewerModal 展示 pair Diff、截断提示并支持关闭', () => {
    act(() =>
      applyHostMessage({
        type: 'diffContent',
        payload: {
          path: 'src/index.ts',
          title: 'index.ts',
          kind: 'pair',
          before: 'const x = 1;\n',
          after: 'const x = 2;\n',
          additions: 1,
          deletions: 1,
          truncated: true,
        },
      }),
    );

    render(<DiffViewerModal />);
    expect(screen.getByTestId('diff-viewer-modal')).toBeTruthy();
    expect(screen.getByTestId('diff-truncated-banner')).toBeTruthy();
    expect(screen.getByTestId('diff-lines-view')).toBeTruthy();

    fireEvent.click(screen.getByTestId('diff-viewer-close'));
    expect(screen.queryByTestId('diff-viewer-modal')).toBeNull();
  });

  it('DiffViewerModal 只读文件预览将 language 正确传入 CodeBlock lang 属性', () => {
    act(() =>
      applyHostMessage({
        type: 'diffContent',
        payload: {
          path: 'src/util.ts',
          title: 'util.ts',
          language: 'typescript',
          kind: 'file',
          after: 'export const ok = true;\n',
          readonly: true,
        },
      }),
    );

    render(<DiffViewerModal />);
    expect(screen.getByTestId('diff-file-preview')).toBeTruthy();
    expect(screen.getByText('typescript')).toBeTruthy();
  });

  it('mobile-web 端：隐藏 IDE 专属按钮，切换危险权限先弹确认框，390px 下使用 Sheet 会话抽屉', () => {
    window.innerWidth = 390;
    render(<App />);
    act(() =>
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          clientSurface: 'mobile-web',
          clientScope: 'operate',
          permissions: {
            current: 'workspace-write',
            options: ['workspace-write', 'danger-full-access'],
          },
          workbench: {
            overview: { waiting: [], todos: [], running: [], upcoming: [], unread: [] },
            schedules: [],
            agents: [],
            tasks: { items: [], autoRun: true },
            sessionGroups: [
              {
                projectPath: '/repo',
                projectName: 'repo',
                isCurrent: true,
                sessions: [
                  {
                    id: 's1',
                    title: 'Fix mobile layout',
                    backendId: 'dsh',
                    backendName: 'DeepSeek',
                    projectPath: '/repo',
                    updatedAt: Date.now(),
                    running: false,
                  },
                ],
              },
            ],
          },
        }),
      }),
    );

    // 连接状态胶囊存在，IDE 专属 openWorkbenchPanel 按钮隐藏
    expect(screen.getByTestId('mobile-conn-pill')).toBeTruthy();
    expect(screen.queryByTestId('open-workbench-panel-btn')).toBeNull();

    // 390px 窄屏使用移动端会话抽屉按钮而非堆叠侧栏
    expect(screen.getByTestId('mobile-sessions-drawer-btn')).toBeTruthy();
    fireEvent.click(screen.getByTestId('mobile-sessions-drawer-btn'));
    expect(screen.getByTestId('mobile-sessions-sheet')).toBeTruthy();

    // 切换 danger-full-access 先在 Webview 内弹出确认框而非直接下发
    fireEvent.click(screen.getByTestId('permission-picker'));
    fireEvent.click(screen.getByText('完全访问'));
    expect(screen.getByTestId('mobile-danger-permission-dialog')).toBeTruthy();
    expect(vscode.posted.some((m) => m.type === 'selectPermission')).toBe(false);

    fireEvent.click(screen.getByTestId('mobile-danger-permission-confirm'));
    expect(vscode.posted).toContainEqual({
      type: 'selectPermission',
      payload: { preset: 'danger-full-access', confirmed: true },
    });
  });

  it('mobile-web read-only 设备禁用发送与审批操作并展示只读提示条', () => {
    render(<App />);
    act(() =>
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          clientSurface: 'mobile-web',
          clientScope: 'read-only',
          interactions: [
            {
              kind: 'approval',
              id: 'ap-1',
              toolName: 'bash',
              reason: 'run test',
              subjectKind: 'command',
              subject: 'pnpm test',
              dirtyFiles: [],
              previewable: false,
            },
          ],
        }),
      }),
    );

    expect(screen.getByTestId('mobile-readonly-banner')).toBeTruthy();
    const allowBtn = screen.getByRole('button', { name: '允许本次' }) as HTMLButtonElement;
    expect(allowBtn.disabled).toBe(true);
  });
});
