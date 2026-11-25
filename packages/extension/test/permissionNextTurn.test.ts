import { describe, expect, it } from 'vitest';
import type { HostToWebview } from '@harness-deck/shared';
import { AcpController, type AcpLink } from '../src/acp/AcpController.ts';
import { ClaudeController } from '../src/claude/ClaudeController.ts';
import type { ClaudeLink } from '../src/claude/connection.ts';
import { setLocale } from '../src/i18n.ts';
import { noWorkbench } from '../src/vm/workbench.ts';

setLocale('zh');

const MODES = {
  id: 'mode',
  category: 'mode',
  currentValue: 'default',
  options: [
    { value: 'default', name: 'Default' },
    { value: 'auto', name: 'Auto' },
    { value: 'plan', name: 'Plan' },
  ],
};

async function drainMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

describe('回复进行中切换权限延后至下一轮生效', () => {
  it('ACP 底层：正在回复时切换权限不发实时 RPC，提示下一轮生效，下一轮发消息前才应用', async () => {
    const rpcLog: string[] = [];
    let finishTurn!: (result: unknown) => void;
    let holdNextPrompt = true;

    const link: AcpLink = {
      request: async <T,>(method: string, params: unknown): Promise<T> => {
        const p = params as { value?: string };
        rpcLog.push(method === 'session/set_config_option' ? `${method}:${p.value}` : method);
        if (method === 'session/new') {
          return { sessionId: 's1', configOptions: [MODES] } as T;
        }
        if (method === 'session/set_config_option') {
          return { configOptions: [{ ...MODES, currentValue: p.value }] } as T;
        }
        if (method === 'session/prompt') {
          if (!holdNextPrompt) return { stopReason: 'end_turn' } as T;
          return new Promise<T>((resolve) => {
            finishTurn = (res) => resolve(res as T);
          });
        }
        return null as T;
      },
      notify: () => undefined,
    };

    const posts: HostToWebview[] = [];
    const controller = new AcpController({
      workspacePath: '/w',
      workbench: noWorkbench,
      post: (m) => posts.push(m),
      log: () => undefined,
      openExternal: () => undefined,
      showLogs: () => undefined,
      restartRuntime: () => undefined,
      loadActiveSessionId: () => undefined,
      saveActiveSessionId: () => undefined,
      loadSessions: () => [],
      saveSessions: () => undefined,
      renderDelayMs: 0,
    });

    controller.setLink(link, { authMethods: [] });
    await drainMicrotasks();

    // 发起第一轮（保持在 running 状态）
    const turn1 = controller.send('first turn');
    await drainMicrotasks();
    expect(controller.snapshot().session.running).toBe(true);
    rpcLog.length = 0;

    // 回复中切换权限为 plan：不应立即发 session/set_config_option，但界面展示 plan 并弹提示
    await controller.handle({ type: 'selectPermission', payload: { preset: 'plan' } });
    expect(rpcLog).toEqual([]);
    expect(controller.snapshot().permissions.current).toBe('plan');
    const toasts = posts.filter((m): m is Extract<HostToWebview, { type: 'toast' }> => m.type === 'toast');
    expect(toasts.at(-1)?.payload.text).toContain('将在下一轮生效');

    // 结束第一轮，再发第二轮：应在 session/prompt 之前先下发 session/set_config_option:plan
    holdNextPrompt = false;
    finishTurn({ stopReason: 'end_turn' });
    await turn1;

    await controller.send('second turn');
    expect(rpcLog).toEqual(['session/set_config_option:plan', 'session/prompt']);
  });

  it('Claude 原生底层：正在回复时切换权限不发 set_permission_mode，下一轮发送前才下发控制请求', async () => {
    const controlCalls: Record<string, unknown>[] = [];
    const userMessages: string[] = [];
    let emitEvent!: (event: Record<string, unknown>) => void;

    const fakeLink: ClaudeLink = {
      running: true,
      sendUserMessage: (content) => {
        userMessages.push(typeof content === 'string' ? content : JSON.stringify(content));
      },
      sendControlRequest: async <T,>(request: Record<string, unknown>): Promise<T> => {
        controlCalls.push(request);
        return {} as T;
      },
      dispose: async () => undefined,
    };

    const posts: HostToWebview[] = [];
    const controller = new ClaudeController({
      workspacePath: '/w',
      workbench: noWorkbench,
      post: (m) => posts.push(m),
      log: () => undefined,
      openExternal: () => undefined,
      showLogs: () => undefined,
      restartRuntime: () => undefined,
      loadActiveSessionId: () => undefined,
      saveActiveSessionId: () => undefined,
      loadSessions: () => [],
      saveSessions: () => undefined,
      renderDelayMs: 0,
    });

    controller.setSpawner(async (opts) => {
      emitEvent = opts.onEvent;
      return fakeLink;
    });

    await controller.send('turn 1');
    expect(controller.snapshot().session.running).toBe(true);
    expect(controlCalls).toEqual([]);

    // 回复中切换权限为 plan：不得立即下发 set_permission_mode
    await controller.handle({ type: 'selectPermission', payload: { preset: 'plan' } });
    expect(controlCalls).toEqual([]);
    expect(controller.snapshot().permissions.current).toBe('plan');
    const toasts = posts.filter((m): m is Extract<HostToWebview, { type: 'toast' }> => m.type === 'toast');
    expect(toasts.at(-1)?.payload.text).toContain('将在下一轮生效');

    // 第一轮结束后发送第二轮：在 sendUserMessage 前才下发 set_permission_mode
    emitEvent({ type: 'result', subtype: 'success', is_error: false });
    expect(controller.snapshot().session.running).toBe(false);

    await controller.send('turn 2');
    expect(controlCalls).toEqual([{ subtype: 'set_permission_mode', mode: 'plan' }]);
    expect(userMessages).toEqual(['turn 1', 'turn 2']);
  });
});
