import { describe, expect, it } from 'vitest';
import type { BackendProfile } from '../src/backend/types.ts';
import { quotaProviderFor } from '../src/quota/provider.ts';

const acp = (command: string): BackendProfile => ({
  id: 'custom',
  kind: 'acp',
  name: 'Custom',
  command,
  args: [],
  env: {},
});

describe('订阅额度提供方分发', () => {
  it('Claude 与原生 CodeBuddy profile 直接映射到对应服务', () => {
    expect(quotaProviderFor({ id: 'claude', kind: 'claude', name: 'Claude Code' })).toBe('claude');
    expect(quotaProviderFor({ id: 'codebuddy', kind: 'codebuddy', name: 'CodeBuddy' })).toBe('codebuddy');
  });

  it('ACP 按启动命令识别 Antigravity，包含绝对路径', () => {
    expect(quotaProviderFor(acp('agy acp'))).toBe('antigravity');
    expect(quotaProviderFor(acp('/usr/local/bin/agy acp'))).toBe('antigravity');
    expect(quotaProviderFor(acp('antigravity --acp'))).toBe('antigravity');
  });

  it('ACP 按启动命令识别 CodeBuddy，包含 Windows 绝对路径', () => {
    expect(quotaProviderFor(acp('codebuddy --acp'))).toBe('codebuddy');
    expect(quotaProviderFor(acp('C:\\Tools\\codebuddy acp'))).toBe('codebuddy');
    expect(quotaProviderFor(acp('cbc acp'))).toBe('codebuddy');
  });

  it('其它后端与没有 profile 时不可查询', () => {
    expect(quotaProviderFor(acp('opencode acp'))).toBeUndefined();
    expect(quotaProviderFor({ id: 'pi', kind: 'pi', name: 'Pi' })).toBeUndefined();
    expect(quotaProviderFor({ id: 'dsh', kind: 'dsh', name: 'DeepSeek' })).toBeUndefined();
    expect(quotaProviderFor(undefined)).toBeUndefined();
  });
});
