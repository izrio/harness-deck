/**
 * 服务商厂商图标：
 * 复用离线品牌矢量 `ModelVendorLogo`（火山方舟/豆包、智谱 GLM、阿里云百炼/通义、Kimi、MiniMax、DeepSeek、OpenAI、Claude、Gemini 等），
 * 对 CLIProxyAPI 与自定义网关使用离线 Iconify 语义图标。
 */
import { detectModelVendor, ModelVendorLogo } from '../../ModelVendorLogo.tsx';
import { ServerIcon, SlidersIcon } from '../../icons.tsx';
import { cn } from '../../../lib/utils.ts';

const PRESET_VENDOR_HINT: Readonly<Record<string, string>> = {
  'volcengine-coding': 'volcengine',
  'zhipu-coding': 'zhipu',
  'bailian-coding': 'bailian',
  'kimi-coding': 'kimi',
  'minimax-coding': 'minimax',
};

export function ProviderVendorIcon({
  presetId,
  name,
  defaultModel,
  size = 'md',
  className,
}: {
  readonly presetId?: string | undefined;
  readonly name?: string | undefined;
  readonly defaultModel?: string | undefined;
  readonly size?: 'sm' | 'md';
  readonly className?: string;
}) {
  const boxClass = size === 'sm' ? 'size-6 rounded-md' : 'size-7 rounded-lg';
  const iconClass = size === 'sm' ? 'size-3.5' : 'size-4';

  if (presetId === 'cliproxyapi') {
    return (
      <span
        data-provider-icon="cliproxyapi"
        aria-hidden="true"
        className={cn(
          'inline-flex shrink-0 items-center justify-center bg-accent-tint/75 text-accent-ink',
          boxClass,
          className,
        )}
      >
        <ServerIcon className={iconClass} />
      </span>
    );
  }

  const presetHint = presetId ? PRESET_VENDOR_HINT[presetId] : undefined;
  const vendor = detectModelVendor({
    provider: presetHint ?? name,
    model: defaultModel,
    name,
  });

  if (vendor) {
    return (
      <span
        data-provider-icon={vendor}
        aria-hidden="true"
        className={cn(
          'inline-flex shrink-0 items-center justify-center bg-canvas/85 text-ink dark:bg-page/60',
          boxClass,
          className,
        )}
      >
        <ModelVendorLogo provider={presetHint ?? name} model={defaultModel} name={name} className={iconClass} />
      </span>
    );
  }

  return (
    <span
      data-provider-icon="custom"
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center bg-field/85 text-ink-2 dark:bg-page/60',
        boxClass,
        className,
      )}
    >
      <SlidersIcon className={iconClass} />
    </span>
  );
}
