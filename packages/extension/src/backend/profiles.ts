/**
 * 底层配置：dsh，内置的 ACP 代理（Pi、CodeBuddy、Claude Code），加上设置 `harnessDeck.backends` 里的 ACP 代理。
 * 设置里和内置项 id 相同的一项覆盖内置项（例如改成完整路径），其余追加在后面。
 * 纯函数，便于测试；extension.ts 负责读设置。
 */
import type { BackendView } from '@harness-deck/shared';
import type { BackendProfile } from './types.ts';

/** 设置里一项 ACP 底层的原始值（用户手写，逐项校验）。 */
export interface AcpProfileSetting {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly command?: unknown;
  readonly args?: unknown;
  readonly env?: unknown;
  readonly installHint?: unknown;
  readonly singleSession?: unknown;
}

/** 内置底层 DeepSeek（dsh，DeepSeek Harness）。id 保持 dsh：会话、标签等按 id 保存。 */
export const DSH_PROFILE: BackendProfile = { id: 'dsh', kind: 'dsh', name: 'DeepSeek' };
/** 内置底层 ZCode（智谱 Z.ai，通过 `zcode app-server --stdio` 接入）。 */
export const ZCODE_PROFILE: Extract<BackendProfile, { kind: 'zcode' }> = { id: 'zcode', kind: 'zcode', name: 'ZCode' };
/** 内置底层 Claude Code（Anthropic，通过 `claude -p --input-format stream-json --output-format stream-json` 原生接入）。 */
export const CLAUDE_PROFILE: Extract<BackendProfile, { kind: 'claude' }> = { id: 'claude', kind: 'claude', name: 'Claude Code' };
/** 内置底层 Pi（通过 `pi --mode rpc` 原生接入）。 */
export const PI_PROFILE: Extract<BackendProfile, { kind: 'pi' }> = { id: 'pi', kind: 'pi', name: 'Pi' };

type AcpProfile = Extract<BackendProfile, { kind: 'acp' }>;

export type BuiltinHintId =
  | 'pi'
  | 'pi-sign-in'
  | 'codebuddy'
  | 'claude'
  | 'claude-sign-in'
  | 'opencode'
  | 'opencode-sign-in'
  | 'zcode'
  | 'zcode-sign-in';

/**
 * 内置的智能体（原生 Pi / Claude Code / ZCode 与内置 ACP 代理）。
 * 不放在设置的默认值里：用户改过 `harnessDeck.backends` 后，设置的默认值就不再生效，新加的内置项会看不到。
 * @param hint - 安装与登录提示的文案（Host 侧 i18n）。
 */
export function builtinProfiles(hint: (id: BuiltinHintId) => string): BackendProfile[] {
  return [
    // Pi 原生通过 `pi --mode rpc` NDJSON 双向协议接入
    { ...PI_PROFILE, installHint: hint('pi'), signInHint: hint('pi-sign-in') },
    // CodeBuddy 2.x 的 ACP 只给一个会话推送实时更新，见 BackendProfile.singleSession
    { id: 'codebuddy', kind: 'acp', name: 'CodeBuddy', command: 'codebuddy', args: ['--acp'], env: {}, installHint: hint('codebuddy'), singleSession: true },
    // Claude Code 原生通过 `claude -p` 流式 JSON 协议接入
    { ...CLAUDE_PROFILE, installHint: hint('claude'), signInHint: hint('claude-sign-in') },
    // OpenCode 原生内置 ACP 子命令（opencode acp）
    { id: 'opencode', kind: 'acp', name: 'OpenCode', command: 'opencode', args: ['acp'], env: {}, installHint: hint('opencode'), signInHint: hint('opencode-sign-in') },
    // 智谱 ZCode 原生通过 `zcode app-server --stdio` 专有协议接入
    { ...ZCODE_PROFILE, installHint: hint('zcode'), signInHint: hint('zcode-sign-in') },
  ];
}

/**
 * 解析设置里的 ACP 底层。缺少名称或命令的项跳过；id 默认取名称，重复时只保留第一个。
 * @param log - 跳过的项写日志。
 * @param builtins - 内置的智能体：ACP 项在 id 和设置里某一项相同时用设置里的那项（位置不变）。
 */
export function parseProfiles(raw: unknown, log: (line: string) => void = () => undefined, builtins: readonly BackendProfile[] = []): BackendProfile[] {
  const fromSettings = parseSettings(raw, log);
  const overrides = new Map(fromSettings.map((p) => [p.id, p]));
  const builtinIds = new Set(builtins.map((p) => p.id));
  return [
    DSH_PROFILE,
    ...builtins.map((builtin) => {
      if (builtin.kind !== 'acp') return builtin;
      const override = overrides.get(builtin.id);
      // 覆盖时没写安装提示，沿用内置的
      if (!override) return builtin;
      return {
        ...override,
        ...(override.installHint || !builtin.installHint ? {} : { installHint: builtin.installHint }),
        // 代理本身的限制：覆盖命令路径时沿用，除非明确写了 false
        ...(override.singleSession === undefined && builtin.singleSession ? { singleSession: true } : {}),
        ...(builtin.signInHint ? { signInHint: builtin.signInHint } : {}),
      };
    }),
    ...fromSettings.filter((p) => !builtinIds.has(p.id)),
  ];
}

const RESERVED_NATIVE_IDS = new Set<string>(['dsh', 'zcode', 'claude', 'pi']);

function parseSettings(raw: unknown, log: (line: string) => void): AcpProfile[] {
  const profiles: AcpProfile[] = [];
  const seen = new Set<string>(RESERVED_NATIVE_IDS);
  for (const item of Array.isArray(raw) ? (raw as AcpProfileSetting[]) : []) {
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    const command = typeof item?.command === 'string' ? item.command.trim() : '';
    if (!name || !command) {
      log(`底层配置缺少 name 或 command，已跳过：${JSON.stringify(item)}`);
      continue;
    }
    const id = (typeof item.id === 'string' && item.id.trim() ? item.id.trim() : name).toLowerCase().replace(/[^a-z0-9._-]+/gu, '-');
    if (seen.has(id)) {
      log(`底层配置的 id 重复（${id}），已跳过后面的一项`);
      continue;
    }
    seen.add(id);
    const args = Array.isArray(item.args) ? item.args.filter((a): a is string => typeof a === 'string') : [];
    const env =
      item.env && typeof item.env === 'object' && !Array.isArray(item.env)
        ? Object.fromEntries(Object.entries(item.env as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'))
        : {};
    profiles.push({
      id,
      kind: 'acp',
      name,
      command,
      args,
      env,
      ...(typeof item.installHint === 'string' && item.installHint.trim() ? { installHint: item.installHint.trim() } : {}),
      ...(typeof item.singleSession === 'boolean' ? { singleSession: item.singleSession } : {}),
    });
  }
  return profiles;
}

/** 内置底层对应的 npm 包名（用于设置页点击安装、卸载、切换版本）。 */
export const BACKEND_NPM_PACKAGES: Readonly<Record<string, string>> = {
  dsh: '@deepseek-ai/dsh',
  pi: '@earendil-works/pi-coding-agent',
  codebuddy: '@tencent-ai/codebuddy-code',
  claude: '@anthropic-ai/claude-code',
  opencode: 'opencode-ai',
  zcode: 'zcode-app-cli',
};

/** 查找某个底层 id 对应的 npm 包名。 */
export function npmPackageFor(id: string): string | undefined {
  return BACKEND_NPM_PACKAGES[id];
}

/** 内置底层的安装命令（供复制和提示）。 */
const INSTALL_COMMANDS: Readonly<Record<string, string>> = {
  dsh: 'npm install -g @deepseek-ai/dsh',
  pi: 'npm install -g @earendil-works/pi-coding-agent',
  codebuddy: 'npm install -g @tencent-ai/codebuddy-code',
  claude: 'npm install -g @anthropic-ai/claude-code',
  opencode: 'npm install -g opencode-ai',
  zcode: 'npm install -g zcode-app-cli',
};

export interface ProfileViewMeta {
  readonly available?: boolean;
  readonly version?: string;
  readonly versions?: readonly string[];
  readonly versionsLoading?: boolean;
  readonly versionsError?: string;
  readonly busy?: 'installing' | 'uninstalling' | 'switching';
  readonly builtinIds?: ReadonlySet<string>;
  readonly overriddenIds?: ReadonlySet<string>;
}

/** 规范化自定义或覆盖智能体的 id。 */
export function normalizeProfileId(rawId: string): string {
  return rawId.trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, '-');
}

export interface UpsertProfileInput {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly installHint?: string;
  readonly singleSession?: boolean;
}

/** 把新增或编辑后的智能体写回 `harnessDeck.backends` 数组（纯函数，保留其他项顺序）。 */
export function upsertBackendSetting(raw: unknown, input: UpsertProfileInput): AcpProfileSetting[] {
  const list = Array.isArray(raw) ? raw.filter((item): item is AcpProfileSetting => Boolean(item && typeof item === 'object')) : [];
  const rawId = normalizeProfileId(input.id || input.name) || 'custom-agent';
  // dsh / zcode / claude / pi 为内置非 ACP 底层保留 id，避免新增自定义 ACP 代理时被 parseProfiles 跳过
  const id = RESERVED_NATIVE_IDS.has(rawId) ? `${rawId}-acp` : rawId;
  const entry: AcpProfileSetting = {
    id,
    name: input.name.trim(),
    command: input.command.trim(),
    args: input.args.map((a) => a.trim()).filter(Boolean),
    env: Object.fromEntries(Object.entries(input.env).filter(([k]) => k.trim().length > 0)),
    ...(input.installHint?.trim() ? { installHint: input.installHint.trim() } : {}),
    ...(input.singleSession !== undefined ? { singleSession: input.singleSession } : {}),
  };
  let replaced = false;
  const next = list.map((item) => {
    const itemName = typeof item.name === 'string' ? item.name : '';
    const itemId = normalizeProfileId(typeof item.id === 'string' && item.id.trim() ? item.id : itemName);
    if (itemId === id) {
      replaced = true;
      return entry;
    }
    return item;
  });
  return replaced ? next : [...next, entry];
}

/** 从 `harnessDeck.backends` 数组里移除指定 id 的自定义/覆盖项。 */
export function deleteBackendSetting(raw: unknown, id: string): AcpProfileSetting[] {
  const target = normalizeProfileId(id);
  const list = Array.isArray(raw) ? raw.filter((item): item is AcpProfileSetting => Boolean(item && typeof item === 'object')) : [];
  return list.filter((item) => {
    const itemName = typeof item.name === 'string' ? item.name : '';
    const itemId = normalizeProfileId(typeof item.id === 'string' && item.id.trim() ? item.id : itemName);
    return itemId !== target;
  });
}

/**
 * 界面上的一项底层。
 * @param meta - 本机安装状态、版本、版本列表及操作状态。
 */
export function profileView(profile: BackendProfile, meta?: ProfileViewMeta | boolean): BackendView {
  const info: ProfileViewMeta = typeof meta === 'boolean' ? { available: meta } : (meta ?? {});
  const installCommand = INSTALL_COMMANDS[profile.id];
  const npmPackage = BACKEND_NPM_PACKAGES[profile.id];
  const isBuiltin = info.builtinIds ? info.builtinIds.has(profile.id) : profile.kind !== 'acp';
  const isOverridden = info.overriddenIds?.has(profile.id) ?? false;
  const isCustom = profile.kind === 'acp' && !isBuiltin;
  return {
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    ...(isBuiltin ? { builtin: true } : {}),
    ...(isCustom ? { custom: true } : {}),
    ...(isOverridden ? { overridden: true } : {}),
    ...(profile.kind === 'acp'
      ? {
          command: [profile.command, ...profile.args].join(' '),
          executable: profile.command,
          args: profile.args,
          env: profile.env,
          ...(profile.singleSession !== undefined ? { singleSession: profile.singleSession } : {}),
        }
      : {}),
    ...(info.available !== undefined ? { available: info.available } : {}),
    ...(info.version ? { version: info.version } : {}),
    ...(npmPackage ? { npmPackage } : {}),
    ...(info.versions !== undefined ? { versions: info.versions } : {}),
    ...(info.versionsLoading ? { versionsLoading: true } : {}),
    ...(info.versionsError ? { versionsError: info.versionsError } : {}),
    ...(info.busy ? { busy: info.busy } : {}),
    ...(installCommand ? { installCommand } : {}),
    ...(profile.kind !== 'dsh' && profile.installHint && !installCommand ? { installHint: profile.installHint } : {}),
  };
}
