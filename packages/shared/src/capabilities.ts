/**
 * 底层能力描述符：把「这个底层支持什么」集中在一处，界面只读结果，不再按 id / kind 判断功能。
 *
 * 事实来源：`packages/extension/README.md` 的「不同底层的差别」与各控制器的实现。
 * 新增底层时在这里补一条；权限档位不在这里——它随会话由底层下发（`PermissionState.options`）。
 */
import type { BackendCapabilities, BackendProtocolCapability, QuotaProviderId } from './viewModel.ts';

/** 判断能力时需要的底层信息；`BackendView`、`BackendProfile` 都能直接传进来。 */
export interface BackendCapabilityInput {
  readonly id: string;
  readonly kind?: string;
  readonly name?: string;
  readonly command?: string;
  readonly executable?: string;
}

const THREE_PROTOCOLS: BackendProtocolCapability = {
  kind: 'supported',
  protocols: ['openai-chat', 'openai-responses', 'anthropic'],
};
const ANTHROPIC_ONLY: BackendProtocolCapability = { kind: 'supported', protocols: ['anthropic'] };
const OPENAI_CHAT: BackendProtocolCapability = { kind: 'supported', protocols: ['openai-chat'] };
const OPENAI_RESPONSES_CHAT: BackendProtocolCapability = {
  kind: 'supported',
  protocols: ['openai-responses', 'openai-chat'],
};
const ACCOUNT_ONLY: BackendProtocolCapability = { kind: 'account-only' };

/** 所有底层都有的基础能力。 */
const BASIC: BackendCapabilities = {
  protocols: THREE_PROTOCOLS,
  webUi: false,
  apiKeySetup: false,
  approvalHint: false,
  steer: false,
  turnChanges: false,
  subagents: false,
  questions: false,
  goal: false,
  images: true,
  rollback: 'none',
  worktree: true,
};

/** dsh（DeepSeek Harness）：功能最全。 */
const DSH: BackendCapabilities = {
  ...BASIC,
  webUi: true,
  apiKeySetup: true,
  approvalHint: true,
  steer: true,
  turnChanges: true,
  subagents: true,
  questions: true,
  goal: true,
  rollback: 'files',
};

/** ZCode：原生协议，支持消息插队与提问卡片。 */
const ZCODE: BackendCapabilities = { ...BASIC, steer: true, questions: true };

/** Pi：原生 RPC，支持运行中 `steer` 插队。 */
const PI: BackendCapabilities = { ...BASIC, steer: true };

/** Claude Code：原生 stream-json，可查订阅额度。 */
const CLAUDE: BackendCapabilities = { ...BASIC, protocols: ANTHROPIC_ONLY, quota: 'claude' };

function baseFor(kind: string | undefined): BackendCapabilities {
  switch (kind) {
    case 'dsh':
      return DSH;
    case 'zcode':
      return ZCODE;
    case 'claude':
      return CLAUDE;
    case 'pi':
      return PI;
    default:
      return BASIC;
  }
}

/** 按 id / 名称 / 命令识别已知底层；未知 ACP 代理按现有启发式判断协议。 */
function protocolFor(input: BackendCapabilityInput): BackendProtocolCapability {
  const id = input.id.toLowerCase();
  if (input.kind === 'dsh' || id === 'dsh') return THREE_PROTOCOLS;
  if (input.kind === 'zcode' || id === 'zcode') return THREE_PROTOCOLS;
  if (input.kind === 'claude' || id === 'claude') return ANTHROPIC_ONLY;
  if (input.kind === 'pi' || id === 'pi' || id === 'oh-my-pi') return THREE_PROTOCOLS;
  if (id === 'opencode') return THREE_PROTOCOLS;
  if (id === 'codebuddy') return OPENAI_CHAT;
  if (id === 'antigravity') return ACCOUNT_ONLY;

  const hint = `${id} ${input.name ?? ''} ${input.executable ?? ''} ${input.command ?? ''}`.toLowerCase();
  if (/\b(cursor|antigravity|agy|gemini|kimi[-_\s]?code|kimi[-_\s]?cli)\b/iu.test(hint)) return ACCOUNT_ONLY;
  if (/\bcodex\b/iu.test(hint)) return OPENAI_RESPONSES_CHAT;
  if (/\bclaude\b/iu.test(hint)) return ANTHROPIC_ONLY;
  return THREE_PROTOCOLS;
}

/** 取命令首个 token 的文件名：`/usr/local/bin/agy acp` → `agy`。 */
function commandBin(command: string | undefined): string {
  const head = command?.trim().split(/\s+/u)[0] ?? '';
  return (head.split(/[\\/]/u).pop() ?? '').toLowerCase();
}

/** 哪些底层能查订阅额度：Claude、Antigravity、CodeBuddy（自定义 ACP 按命令名识别）。 */
function quotaFor(input: BackendCapabilityInput): QuotaProviderId | undefined {
  if (input.kind === 'claude') return 'claude';
  const id = input.id.toLowerCase();
  if (id === 'antigravity') return 'antigravity';
  if (id === 'codebuddy') return 'codebuddy';
  if (input.kind !== 'acp') return undefined;
  const bin = commandBin(input.command);
  if (bin === 'agy' || bin === 'antigravity') return 'antigravity';
  if (bin === 'codebuddy' || bin === 'cbc') return 'codebuddy';
  return undefined;
}

const ID_OVERRIDES: Readonly<Record<string, Partial<BackendCapabilities>>> = {
  dsh: DSH,
  zcode: ZCODE,
  pi: PI,
  'oh-my-pi': PI,
  codebuddy: { protocols: OPENAI_CHAT, quota: 'codebuddy' },
  opencode: { protocols: THREE_PROTOCOLS },
  antigravity: { protocols: ACCOUNT_ONLY, quota: 'antigravity' },
};

/**
 * 解析一个底层的能力。已知的 id / kind 用固定描述符，其余 ACP 代理按命令与名称推断协议，
 * 功能默认按「基础能力」处理，避免把 dsh 专属功能误给别的底层。
 */
export function backendCapabilities(input: BackendCapabilityInput): BackendCapabilities {
  const base = baseFor(input.kind);
  const override = ID_OVERRIDES[input.id.toLowerCase()];
  const quota = quotaFor(input);
  return {
    ...base,
    ...override,
    protocols: protocolFor(input),
    ...(quota ? { quota } : {}),
  };
}
