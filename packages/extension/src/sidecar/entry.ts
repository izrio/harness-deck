/**
 * 独立 Node.js Sidecar 进程入口（打包为 `dist/sidecar.cjs`）。
 * 通过标准输入输出（NDJSON JSON-RPC 2.0）与宿主 IDE（IntelliJ IDEA / WebStorm / PyCharm 等）通信。
 * 当父进程退出（stdin EOF）或收到终止信号时，自动清理全部后台代理子进程后退出。
 */
import type { RemoteScope } from '@harness-deck/shared';
import { runHeadlessScheduler } from './headlessScheduler.ts';
import {
  readHeadlessServerStatus,
  runHeadlessServer,
  stopHeadlessServer,
  type HeadlessTunnelMode,
} from './headlessServer.ts';
import { startSidecarSession } from './server.ts';

function parseHeadlessServerFlags(args: readonly string[]): {
  readonly port?: number;
  readonly bindHost?: string;
  readonly scope?: RemoteScope;
  readonly tunnel?: HeadlessTunnelMode;
  readonly publicUrl?: string;
} {
  let port: number | undefined;
  let bindHost: string | undefined;
  let scope: RemoteScope | undefined;
  let tunnel: HeadlessTunnelMode | undefined;
  let publicUrl: string | undefined;
  let cloudPreset = false;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (token === '--cloud') {
      cloudPreset = true;
      continue;
    }
    if (token === '--port' && args[i + 1]) {
      const parsed = Number.parseInt(args[i + 1]!, 10);
      if (Number.isFinite(parsed) && parsed > 0 && parsed < 65536) port = parsed;
      i += 1;
      continue;
    }
    if (token === '--bind' && args[i + 1]) {
      bindHost = args[i + 1]!;
      i += 1;
      continue;
    }
    if (token === '--scope' && args[i + 1]) {
      const next = args[i + 1]!;
      if (next === 'read-only' || next === 'operate' || next === 'owner') scope = next;
      i += 1;
      continue;
    }
    if (token === '--tunnel' && args[i + 1]) {
      const next = args[i + 1]!;
      if (next === 'none' || next === 'quick' || next === 'tailscale') tunnel = next;
      i += 1;
      continue;
    }
    if (token === '--public-url' && args[i + 1]) {
      publicUrl = args[i + 1]!;
      i += 1;
      continue;
    }
    // 兼容旧版位置参数端口：`--headless-server <configRoot> <projectPath> <port>`
    if (i === 0 && !token.startsWith('-')) {
      const parsed = Number.parseInt(token, 10);
      if (Number.isFinite(parsed) && parsed > 0 && parsed < 65536) port = parsed;
    }
  }

  if (cloudPreset) {
    scope ??= 'owner';
    if (!publicUrl && !tunnel) {
      tunnel = 'quick';
    }
  }

  return {
    ...(port !== undefined ? { port } : {}),
    ...(bindHost ? { bindHost } : {}),
    ...(scope ? { scope } : {}),
    ...(tunnel ? { tunnel } : {}),
    ...(publicUrl ? { publicUrl } : {}),
  };
}

const [mode, arg1, arg2] = process.argv.slice(2);
if (mode === '--headless-scheduler' && arg1 && arg2) {
  void runHeadlessScheduler({
    configRoot: arg1,
    projectPath: arg2,
    log: (line) => console.log(`[scheduler] ${line}`),
  }).then((handle) => {
    if (!handle) {
      process.exit(0);
      return;
    }
    const shutdown = (): void => {
      void handle.stop().finally(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
} else if (mode === '--headless-server' && arg1 && arg2) {
  const flags = parseHeadlessServerFlags(process.argv.slice(5));
  void runHeadlessServer({
    configRoot: arg1,
    projectPath: arg2,
    ...flags,
    log: (line) => console.log(`[headless-server] ${line}`),
  }).then((handle) => {
    if (!handle) {
      process.exit(0);
      return;
    }
    const shutdown = (): void => {
      void handle.stop().finally(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
} else if (mode === '--headless-status' && arg1) {
  void readHeadlessServerStatus(arg1).then((status) => {
    console.log(JSON.stringify(status, null, 2));
    process.exit(status.running ? 0 : 1);
  });
} else if (mode === '--headless-stop' && arg1) {
  void stopHeadlessServer(arg1).then((stopped) => {
    console.log(stopped ? 'stopped' : 'not running');
    process.exit(stopped ? 0 : 1);
  });
} else if (mode === '--headless-pair' && arg1) {
  void readHeadlessServerStatus(arg1).then((status) => {
    if (!status.running) {
      console.error('headless server is not running');
      process.exit(1);
      return;
    }
    if (status.pairingUrl) {
      console.log(status.pairingUrl);
      process.exit(0);
      return;
    }
    console.error('no active pairing URL');
    process.exit(1);
  });
} else {
  const session = startSidecarSession(process.stdin, process.stdout, {
    onShutdown: () => {
      setImmediate(() => process.exit(0));
    },
  });

  const handleSignal = (): void => {
    void session.dispose().finally(() => process.exit(0));
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);
  process.stdin.resume();
}
