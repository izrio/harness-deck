/**
 * 连接 / 更新云端开发环境弹窗（Google Colab / 远端 Linux / 自定义 Halo Server）：
 * - 极简双行表单（默认仅展示「配对链接」+「名称 / 类型」；仅在输入纯地址不含 #code= 时按需展开配对码）
 * - 启动说明收进标题头问号 Popover，保持弹窗留白与呼吸感
 * - 严格遵循 shadcn-ui + size="sm" 等高规范与离线 Iconify 图标规范
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CloudEnvironmentProvider, CloudEnvironmentView } from '@harness-deck/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useT } from '../i18n.ts';
import { postToHost } from '../vscode.ts';
import { CheckIcon, CloudIcon, CopyIcon, QuestionIcon } from './icons.tsx';

export interface CloudEnvironmentDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** 传入时为编辑/重新配对模式，不传则为新建云环境模式。 */
  readonly editing?: CloudEnvironmentView | null;
}

const COLAB_BOOTSTRAP_CMD = [
  '!curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared',
  '!node /content/drive/MyDrive/halo/bin/sidecar.cjs --headless-server /content/drive/MyDrive/halo/config /content/drive/MyDrive/workspace --cloud',
].join('\n');

const LINUX_BOOTSTRAP_CMD = 'node ./sidecar.cjs --headless-server ~/.halo-cloud ~/workspace --cloud';

function hasEmbeddedPairCode(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  return /[#?&]code=[^&#\s]+/iu.test(trimmed);
}

export function CloudEnvironmentDialog({ open, onOpenChange, editing }: CloudEnvironmentDialogProps) {
  const t = useT();
  const isEdit = Boolean(editing);

  const [endpointInput, setEndpointInput] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<CloudEnvironmentProvider>('colab');
  const [copiedKey, setCopiedKey] = useState<'colab' | 'linux' | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(copyTimerRef.current), []);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setEndpointInput(editing.endpointUrl);
      setPairingCode('');
      setName(editing.name);
      setProvider(editing.provider);
    } else {
      setEndpointInput('');
      setPairingCode('');
      setName('');
      setProvider('colab');
    }
  }, [open, editing]);

  const trimmedEndpoint = endpointInput.trim();
  const codeDetected = useMemo(() => hasEmbeddedPairCode(trimmedEndpoint), [trimmedEndpoint]);
  // 仅当用户输入了不含 #code= 的纯服务地址（或编辑态修改地址）时按需展示配对码输入框，减少表单噪音
  const showManualCode = Boolean(trimmedEndpoint) && !codeDetected;
  const canSubmit = Boolean(trimmedEndpoint) && (isEdit || codeDetected || Boolean(pairingCode.trim()));

  const copyCommand = (key: 'colab' | 'linux', text: string): void => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopiedKey(key);
    clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopiedKey(null), 1600);
  };

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!trimmedEndpoint) return;
    const trimmedCode = pairingCode.trim();
    const trimmedName = name.trim();

    if (editing) {
      postToHost({
        type: 'updateCloudEnvironment',
        payload: {
          id: editing.id,
          ...(trimmedName ? { name: trimmedName } : {}),
          provider,
          pairingUrlOrEndpoint: trimmedEndpoint,
          ...(trimmedCode ? { pairingCode: trimmedCode } : {}),
          reconnect: true,
        },
      });
    } else {
      postToHost({
        type: 'addCloudEnvironment',
        payload: {
          ...(trimmedName ? { name: trimmedName } : {}),
          provider,
          pairingUrlOrEndpoint: trimmedEndpoint,
          ...(trimmedCode ? { pairingCode: trimmedCode } : {}),
          connectNow: true,
        },
      });
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]" data-testid="cloud-env-dialog">
        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <DialogHeader className="gap-1">
            <DialogTitle className="flex items-center gap-1.5 pr-6 text-[15px]">
              <CloudIcon className="size-4 shrink-0 text-accent-ink" />
              <span>{isEdit ? t('cloud.dialog.editTitle') : t('cloud.dialog.addTitle')}</span>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    data-testid="cloud-env-guide-toggle"
                    aria-label={t('cloud.dialog.guideToggle')}
                    title={t('cloud.dialog.guideToggle')}
                    className="ml-0.5 shrink-0 text-ink-3 hover:text-ink"
                  >
                    <QuestionIcon className="size-3.5" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  sideOffset={6}
                  className="w-80 p-3.5"
                  data-testid="cloud-env-guide-popover"
                >
                  <div className="flex flex-col gap-3">
                    <div className="text-[12.5px] leading-4 font-semibold text-ink">
                      {t('cloud.dialog.guideToggle')}
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11.5px] font-medium text-ink-2">
                          {t('cloud.dialog.colabGuideTitle')}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => copyCommand('colab', COLAB_BOOTSTRAP_CMD)}
                          className="gap-1 text-ink-2 hover:text-ink"
                        >
                          {copiedKey === 'colab' ? (
                            <CheckIcon className="size-3 text-ok" />
                          ) : (
                            <CopyIcon className="size-3" />
                          )}
                          <span>{copiedKey === 'colab' ? t('cloud.dialog.copied') : t('cloud.dialog.copyCmd')}</span>
                        </Button>
                      </div>
                      <pre className="m-0 overflow-x-auto rounded-lg bg-field/80 px-2.5 py-2 font-mono text-[10.5px] leading-4 text-ink-2">
                        {COLAB_BOOTSTRAP_CMD}
                      </pre>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11.5px] font-medium text-ink-2">
                          {t('cloud.dialog.linuxGuideTitle')}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => copyCommand('linux', LINUX_BOOTSTRAP_CMD)}
                          className="gap-1 text-ink-2 hover:text-ink"
                        >
                          {copiedKey === 'linux' ? (
                            <CheckIcon className="size-3 text-ok" />
                          ) : (
                            <CopyIcon className="size-3" />
                          )}
                          <span>{copiedKey === 'linux' ? t('cloud.dialog.copied') : t('cloud.dialog.copyCmd')}</span>
                        </Button>
                      </div>
                      <pre className="m-0 overflow-x-auto rounded-lg bg-field/80 px-2.5 py-2 font-mono text-[10.5px] leading-4 text-ink-2">
                        {LINUX_BOOTSTRAP_CMD}
                      </pre>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </DialogTitle>
            <DialogDescription className="text-[12px] text-ink-3">
              {t('cloud.dialog.desc')}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cloud-env-endpoint" className="text-[12px] text-ink-2">
                {t('cloud.dialog.endpointLabel')}
              </Label>
              <Input
                id="cloud-env-endpoint"
                size="sm"
                data-testid="cloud-env-endpoint-input"
                value={endpointInput}
                onChange={(e) => setEndpointInput(e.target.value)}
                placeholder={t('cloud.dialog.endpointPlaceholder')}
                autoFocus
              />
              {codeDetected ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-ok">
                  <CheckIcon className="size-3 shrink-0" />
                  <span>{t('cloud.dialog.codeDetected')}</span>
                </span>
              ) : null}
            </div>

            {showManualCode ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cloud-env-code" className="text-[12px] text-ink-2">
                  {t('cloud.dialog.codeLabel')}
                </Label>
                <Input
                  id="cloud-env-code"
                  size="sm"
                  data-testid="cloud-env-code-input"
                  value={pairingCode}
                  onChange={(e) => setPairingCode(e.target.value)}
                  placeholder={isEdit ? t('cloud.dialog.codeOptionalEdit') : t('cloud.dialog.codePlaceholder')}
                />
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cloud-env-name" className="text-[12px] text-ink-2">
                  {t('cloud.dialog.nameLabel')}
                </Label>
                <Input
                  id="cloud-env-name"
                  size="sm"
                  data-testid="cloud-env-name-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('cloud.dialog.namePlaceholder')}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cloud-env-provider" className="text-[12px] text-ink-2">
                  {t('cloud.dialog.providerLabel')}
                </Label>
                <Select
                  value={provider}
                  onValueChange={(value) => setProvider(value as CloudEnvironmentProvider)}
                >
                  <SelectTrigger
                    id="cloud-env-provider"
                    size="sm"
                    data-testid="cloud-env-provider-select"
                    className="w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="colab">{t('cloud.provider.colab')}</SelectItem>
                    <SelectItem value="linux">{t('cloud.provider.linux')}</SelectItem>
                    <SelectItem value="custom">{t('cloud.provider.custom')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!canSubmit}
              data-testid="cloud-env-submit-btn"
            >
              {isEdit ? t('cloud.dialog.saveBtn') : t('cloud.dialog.connectBtn')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
