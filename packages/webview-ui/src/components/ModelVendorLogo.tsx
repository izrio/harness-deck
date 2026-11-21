/**
 * 模型厂商图标：根据模型 ID、显示名、服务商或分组识别厂商并渲染对应离线矢量徽标，
 * 无法识别时回退到通用 SparkleIcon。所有图标均为本地静态资源或内联品牌矢量，零网络请求。
 */
import { useId } from 'react';
import { cn } from '../lib/utils.ts';
import claudeLogo from '../assets/backends/claude.svg?inline';
import codebuddyLogo from '../assets/backends/codebuddy.svg?inline';
import deepseekLogo from '../assets/backends/deepseek.svg?inline';
import { SparkleIcon } from './icons.tsx';

export type ModelVendor =
  | 'gemini'
  | 'claude'
  | 'openai'
  | 'deepseek'
  | 'zhipu'
  | 'qwen'
  | 'kimi'
  | 'doubao'
  | 'minimax'
  | 'grok'
  | 'mistral'
  | 'meta'
  | 'codebuddy';

export interface ModelVendorInput {
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly name?: string | undefined;
  readonly group?: string | undefined;
}

const MODEL_PATTERNS: readonly (readonly [ModelVendor, RegExp])[] = [
  ['gemini', /(?:^|[\s/_.-])(gemini|gemma|imagen|veo|palm)(?:$|[\s/_.\d-])|gemini/iu],
  ['claude', /(?:^|[\s/_.-])(claude|opus|sonnet|haiku)(?:$|[\s/_.\d-])|claude/iu],
  ['openai', /(?:^|[\s/_.-])(gpt|chatgpt|codex|o1|o3|o4)(?:$|[\s/_.\d-])|gpt[-_\s.]?\d/iu],
  ['deepseek', /deepseek/iu],
  ['zhipu', /(?:^|[\s/_.-])(glm|chatglm|codegeex)(?:$|[\s/_.\d-])|glm[-_\s.]?\d/iu],
  ['qwen', /(?:^|[\s/_.-])(qwen|qwq|qvq)(?:$|[\s/_.\d-])|qwen/iu],
  ['kimi', /(?:^|[\s/_.-])(kimi|moonshot)(?:$|[\s/_.\d-])|kimi/iu],
  ['doubao', /(?:^|[\s/_.-])(doubao|ark-code|seed)(?:$|[\s/_.\d-])|doubao|豆包/iu],
  ['minimax', /(?:^|[\s/_.-])(minimax|abab)(?:$|[\s/_.\d-])|minimax/iu],
  ['grok', /(?:^|[\s/_.-])grok(?:$|[\s/_.\d-])|grok/iu],
  ['mistral', /(?:^|[\s/_.-])(mistral|mixtral|codestral|devstral|pixtral|ministral)(?:$|[\s/_.\d-])/iu],
  ['meta', /(?:^|[\s/_.-])llama(?:$|[\s/_.\d-])|llama/iu],
  ['codebuddy', /(?:^|[\s/_.-])(hunyuan|codebuddy)(?:$|[\s/_.\d-])|混元/iu],
];

const PROVIDER_PATTERNS: readonly (readonly [ModelVendor, RegExp])[] = [
  ['gemini', /(?:^|[\s/_.-])(google|gemini|vertex)(?:$|[\s/_.-])/iu],
  ['claude', /(?:^|[\s/_.-])(anthropic|claude)(?:$|[\s/_.-])/iu],
  ['openai', /(?:^|[\s/_.-])(openai|codex|chatgpt)(?:$|[\s/_.-])/iu],
  ['deepseek', /(?:^|[\s/_.-])(deepseek|dsh)(?:$|[\s/_.-])/iu],
  ['zhipu', /(?:^|[\s/_.-])(zhipu|bigmodel|zai|z-ai|z\.ai|zcode)(?:$|[\s/_.-])|智谱/iu],
  ['qwen', /(?:^|[\s/_.-])(qwen|alibaba|aliyun|bailian|dashscope|tongyi)(?:$|[\s/_.-])|通义|百炼|阿里/iu],
  ['kimi', /(?:^|[\s/_.-])(kimi|moonshot)(?:$|[\s/_.-])|月之暗面/iu],
  ['doubao', /(?:^|[\s/_.-])(doubao|volcengine|volces|bytedance|ark)(?:$|[\s/_.-])|火山|豆包/iu],
  ['minimax', /minimax/iu],
  ['grok', /(?:^|[\s/_.-])(xai|x-ai|grok)(?:$|[\s/_.-])/iu],
  ['mistral', /mistral/iu],
  ['meta', /(?:^|[\s/_.-])(meta|llama)(?:$|[\s/_.-])/iu],
  ['codebuddy', /(?:^|[\s/_.-])(tencent|hunyuan|codebuddy)(?:$|[\s/_.-])|腾讯/iu],
];

/** 优先按模型 ID 与名称识别厂商（兼容多模型聚合网关），再回退按 provider 与分组识别。 */
export function detectModelVendor(input: ModelVendorInput): ModelVendor | undefined {
  const modelText = [input.model, input.name].filter(Boolean).join(' ').trim();
  if (modelText) {
    for (const [vendor, pattern] of MODEL_PATTERNS) {
      if (pattern.test(modelText)) return vendor;
    }
  }
  const providerText = [input.provider, input.group].filter(Boolean).join(' ').trim();
  if (providerText) {
    for (const [vendor, pattern] of PROVIDER_PATTERNS) {
      if (pattern.test(providerText)) return vendor;
    }
  }
  return undefined;
}

function GeminiMark({ className }: { readonly className?: string }) {
  const id = useId().replace(/:/gu, '');
  const gradId = `${id}-gemini`;
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false" className={className} data-vendor="gemini">
      <defs>
        <linearGradient id={gradId} x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#1C7EF7" />
          <stop offset="48%" stopColor="#5887F6" />
          <stop offset="82%" stopColor="#9B72CB" />
          <stop offset="100%" stopColor="#D96570" />
        </linearGradient>
      </defs>
      <path
        d="M12 1C12.38 7.05 16.95 11.62 23 12C16.95 12.38 12.38 16.95 12 23C11.62 16.95 7.05 12.38 1 12C7.05 11.62 11.62 7.05 12 1Z"
        fill={`url(#${gradId})`}
      />
    </svg>
  );
}

function OpenAiMark({ className }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" className={className} data-vendor="openai">
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
    </svg>
  );
}

function ZhipuMark({ className }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" className={className} data-vendor="zhipu">
      <path d="M12.42 4.98l-1.15 1.65c-.18.25-.48.41-.8.41H4.16V4.98h8.26zm7.84 0L10.35 19.02H3.74L13.65 4.98h6.61zm-8.68 14.04l1.16-1.65c.18-.26.48-.42.8-.42h6.3v2.07h-8.26z" />
    </svg>
  );
}

function QwenMark({ className }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false" className={className} data-vendor="qwen">
      <path
        fill="#615CED"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2.2L15.1 7.6L21.2 8.2L16.9 12.6L18.1 18.6L12 15.8L5.9 18.6L7.1 12.6L2.8 8.2L8.9 7.6L12 2.2ZM12 7.4L9.2 12L12 16.6L14.8 12L12 7.4Z"
      />
    </svg>
  );
}

function KimiMark({ className }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" className={className} data-vendor="kimi">
      <path d="M5 4h3.2v6.6L14.9 4h4.1l-6.8 6.9L19.4 20h-4.1l-5.6-6.9-1.5 1.5V20H5V4z" />
      <circle cx="18.2" cy="5.8" r="1.8" fill="#1A8CFF" />
    </svg>
  );
}

function DoubaoMark({ className }: { readonly className?: string }) {
  const id = useId().replace(/:/gu, '');
  const gradId = `${id}-doubao`;
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false" className={className} data-vendor="doubao">
      <defs>
        <linearGradient id={gradId} x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#00C6FF" />
          <stop offset="100%" stopColor="#2D68FF" />
        </linearGradient>
      </defs>
      <path d="M12 2.5L21 7.7V16.3L12 21.5L3 16.3V7.7L12 2.5Z" fill={`url(#${gradId})`} />
      <path d="M12 6.8L16.6 15.2H7.4L12 6.8Z" fill="#FFFFFF" />
    </svg>
  );
}

function MiniMaxMark({ className }: { readonly className?: string }) {
  const id = useId().replace(/:/gu, '');
  const gradId = `${id}-minimax`;
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false" className={className} data-vendor="minimax">
      <defs>
        <linearGradient id={gradId} x1="2" y1="12" x2="22" y2="12" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#E21B5A" />
          <stop offset="55%" stopColor="#F84B5C" />
          <stop offset="100%" stopColor="#FF8A3D" />
        </linearGradient>
      </defs>
      <path
        d="M3 17.5V7.8C3 6.5 4.5 5.8 5.5 6.6L12 11.8L18.5 6.6C19.5 5.8 21 6.5 21 7.8V17.5"
        stroke={`url(#${gradId})`}
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GrokMark({ className }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false" className={className} data-vendor="grok">
      <path
        d="M17.2 6.8A7.4 7.4 0 1 0 19 14.3"
        stroke="currentColor"
        strokeWidth="2.3"
        strokeLinecap="round"
      />
      <path d="M5.2 19.2L19.4 4.6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

function MistralMark({ className }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false" className={className} data-vendor="mistral">
      <rect x="3" y="4" width="3.6" height="3.2" fill="#F7D046" />
      <rect x="17.4" y="4" width="3.6" height="3.2" fill="#F7D046" />
      <rect x="3" y="7.2" width="7.2" height="3.2" fill="#F2A73B" />
      <rect x="13.8" y="7.2" width="7.2" height="3.2" fill="#F2A73B" />
      <rect x="3" y="10.4" width="18" height="3.2" fill="#EE792F" />
      <rect x="3" y="13.6" width="3.6" height="3.2" fill="#EB5829" />
      <rect x="10.2" y="13.6" width="3.6" height="3.2" fill="#EB5829" />
      <rect x="17.4" y="13.6" width="3.6" height="3.2" fill="#EB5829" />
      <rect x="3" y="16.8" width="5.4" height="3.2" fill="#EA3326" />
      <rect x="15.6" y="16.8" width="5.4" height="3.2" fill="#EA3326" />
    </svg>
  );
}

function MetaMark({ className }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false" className={className} data-vendor="meta">
      <path
        d="M6.4 16.8C4.4 16.8 3 15.1 3 12.7C3 9.7 5.2 6.8 7.5 6.8C9.3 6.8 10.6 8.3 12 10.7C13.4 8.3 14.7 6.8 16.5 6.8C18.8 6.8 21 9.7 21 12.7C21 15.1 19.6 16.8 17.6 16.8C15.8 16.8 14.4 15.2 12 11.4C9.6 15.2 8.2 16.8 6.4 16.8Z"
        stroke="#0081FB"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const IMAGE_LOGOS: Readonly<Partial<Record<ModelVendor, string>>> = {
  claude: claudeLogo,
  deepseek: deepseekLogo,
  codebuddy: codebuddyLogo,
};

export function ModelVendorLogo({
  provider,
  model,
  name,
  group,
  className = 'size-3.5 shrink-0',
}: ModelVendorInput & { readonly className?: string }) {
  const vendor = detectModelVendor({ provider, model, name, group });
  if (!vendor) {
    return <SparkleIcon className={cn('text-ink-3', className)} />;
  }
  const src = IMAGE_LOGOS[vendor];
  if (src) {
    return (
      <img
        src={src}
        alt=""
        draggable={false}
        aria-hidden="true"
        data-vendor={vendor}
        className={cn('inline-block shrink-0 object-contain', vendor === 'codebuddy' && 'rounded-[3px]', className)}
      />
    );
  }
  switch (vendor) {
    case 'gemini':
      return <GeminiMark className={className} />;
    case 'openai':
      return <OpenAiMark className={className} />;
    case 'zhipu':
      return <ZhipuMark className={className} />;
    case 'qwen':
      return <QwenMark className={className} />;
    case 'kimi':
      return <KimiMark className={className} />;
    case 'doubao':
      return <DoubaoMark className={className} />;
    case 'minimax':
      return <MiniMaxMark className={className} />;
    case 'grok':
      return <GrokMark className={className} />;
    case 'mistral':
      return <MistralMark className={className} />;
    case 'meta':
      return <MetaMark className={className} />;
    default:
      return <SparkleIcon className={cn('text-ink-3', className)} />;
  }
}
