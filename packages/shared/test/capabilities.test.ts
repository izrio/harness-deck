import { describe, expect, it } from 'vitest';
import { backendCapabilities } from '../src/capabilities.ts';

describe('backendCapabilities', () => {
  it('dsh 功能最全', () => {
    const caps = backendCapabilities({ id: 'dsh', kind: 'dsh', name: 'DeepSeek' });
    expect(caps.webUi).toBe(true);
    expect(caps.apiKeySetup).toBe(true);
    expect(caps.approvalHint).toBe(true);
    expect(caps.steer).toBe(true);
    expect(caps.turnChanges).toBe(true);
    expect(caps.subagents).toBe(true);
    expect(caps.questions).toBe(true);
    expect(caps.goal).toBe(true);
    expect(caps.protocols).toEqual({
      kind: 'supported',
      protocols: ['openai-chat', 'openai-responses', 'anthropic'],
    });
    expect(caps.worktree).toBe(true);
    expect(caps.rollback).toBe('files');
    expect(caps.quota).toBeUndefined();
  });

  it('Claude 只支持 Anthropic 协议，可查额度', () => {
    const caps = backendCapabilities({ id: 'claude', kind: 'claude' });
    expect(caps.protocols).toEqual({ kind: 'supported', protocols: ['anthropic'] });
    expect(caps.quota).toBe('claude');
    expect(caps.steer).toBe(false);
    expect(caps.turnChanges).toBe(false);
  });

  it('Pi 支持插队，不支持 dsh 专属能力', () => {
    const caps = backendCapabilities({ id: 'pi', kind: 'pi' });
    expect(caps.steer).toBe(true);
    expect(caps.webUi).toBe(false);
    expect(caps.turnChanges).toBe(false);
    expect(caps.quota).toBeUndefined();
  });

  it('ZCode 支持插队与提问卡片', () => {
    const caps = backendCapabilities({ id: 'zcode', kind: 'zcode' });
    expect(caps.steer).toBe(true);
    expect(caps.questions).toBe(true);
    expect(caps.subagents).toBe(false);
  });

  it('CodeBuddy 走 ACP：只支持 OpenAI Chat，可查额度', () => {
    const caps = backendCapabilities({ id: 'codebuddy', kind: 'acp', command: 'codebuddy --acp' });
    expect(caps.protocols).toEqual({ kind: 'supported', protocols: ['openai-chat'] });
    expect(caps.quota).toBe('codebuddy');
    expect(caps.steer).toBe(false);
  });

  it('Antigravity 只能账号登录', () => {
    const caps = backendCapabilities({ id: 'antigravity', kind: 'acp', command: 'agy acp' });
    expect(caps.protocols).toEqual({ kind: 'account-only' });
    expect(caps.quota).toBe('antigravity');
  });

  it('自定义 ACP 代理默认使用基础能力', () => {
    const caps = backendCapabilities({ id: 'my-agent', kind: 'acp', command: 'my-agent acp' });
    expect(caps.protocols).toEqual({
      kind: 'supported',
      protocols: ['openai-chat', 'openai-responses', 'anthropic'],
    });
    expect(caps.webUi).toBe(false);
    expect(caps.approvalHint).toBe(false);
    expect(caps.steer).toBe(false);
    expect(caps.images).toBe(true);
    expect(caps.worktree).toBe(true);
    expect(caps.quota).toBeUndefined();
  });

  it('未知 ACP 代理仍按命令与名称识别协议和额度', () => {
    expect(
      backendCapabilities({ id: 'custom-cursor', kind: 'acp', command: 'cursor-agent acp' }).protocols,
    ).toEqual({ kind: 'account-only' });
    expect(
      backendCapabilities({ id: 'my-codex', kind: 'acp', command: 'codex-acp' }).protocols,
    ).toEqual({ kind: 'supported', protocols: ['openai-responses', 'openai-chat'] });
    expect(
      backendCapabilities({ id: 'office', kind: 'acp', command: '/usr/local/bin/cbc acp' }).quota,
    ).toBe('codebuddy');
  });
});
