/**
 * 账号管理增强弹窗（参考 cockpit-tools）：
 * 1. AccountAutomationDialog：低配额 / 过期自动切号策略 + 后台定时刷新配额
 * 2. AccountPortabilityDialog：兼容 Halo JSON 与 cockpit-tools 格式的导入 / 导出备份
 */
import { useEffect, useRef, useState } from 'react';
import type {
  AccountAutomationConfig,
  AccountAutoSwitchStrategy,
  BackendView,
} from '@harness-deck/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useT } from '../../i18n.ts';
import { showToast, useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import { BackendLogo } from '../BackendLogo.tsx';
import { CheckIcon, CopyIcon, FileIcon, RefreshIcon, ZapIcon } from '../icons.tsx';

const DEFAULT_AUTOMATION: AccountAutomationConfig = {
  autoSwitchEnabled: false,
  autoSwitchThresholdPercent: 5,
  autoSwitchStrategy: 'highest-quota',
  autoRefreshIntervalMin: 0,
};

const THRESHOLD_OPTIONS = [5, 10, 15, 20, 30] as const;
const REFRESH_INTERVAL_OPTIONS = [0, 5, 15, 30, 60] as const;
const EXPORT_ALL_VALUE = '__all__';

export function AccountAutomationDialog({
  open,
  onOpenChange,
  automation,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly automation?: AccountAutomationConfig;
}) {
  const t = useT();
  const cfg = automation ?? DEFAULT_AUTOMATION;

  const update = (patch: Partial<AccountAutomationConfig>) => {
    postToHost({
      type: 'setAccountAutomation',
      payload: {
        ...(patch.autoSwitchEnabled !== undefined ? { autoSwitchEnabled: patch.autoSwitchEnabled } : {}),
        ...(patch.autoSwitchThresholdPercent !== undefined
          ? { autoSwitchThresholdPercent: patch.autoSwitchThresholdPercent }
          : {}),
        ...(patch.autoSwitchStrategy !== undefined ? { autoSwitchStrategy: patch.autoSwitchStrategy } : {}),
        ...(patch.autoRefreshIntervalMin !== undefined
          ? { autoRefreshIntervalMin: patch.autoRefreshIntervalMin }
          : {}),
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="account-automation-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ZapIcon className="size-4 text-accent-ink" />
            <span>{t('settings.accounts.automation.title')}</span>
          </DialogTitle>
          <DialogDescription>{t('settings.accounts.automation.desc')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3.5">
          <div className="flex items-center justify-between gap-4 rounded-xl bg-field/60 px-3.5 py-3">
            <span className="text-[13px] font-medium text-ink">
              {t('settings.accounts.automation.enable')}
            </span>
            <Switch
              data-testid="account-auto-switch-toggle"
              aria-label={t('settings.accounts.automation.enable')}
              checked={cfg.autoSwitchEnabled}
              onCheckedChange={(checked) => update({ autoSwitchEnabled: checked })}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-ink-2">
                {t('settings.accounts.automation.threshold')}
              </span>
              <Select
                value={String(cfg.autoSwitchThresholdPercent)}
                onValueChange={(val) => update({ autoSwitchThresholdPercent: Number(val) })}
              >
                <SelectTrigger size="sm" className="w-full" data-testid="account-auto-threshold">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {THRESHOLD_OPTIONS.map((pct) => (
                    <SelectItem key={pct} value={String(pct)}>
                      ≤ {pct}%
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-ink-2">
                {t('settings.accounts.automation.strategy')}
              </span>
              <Select
                value={cfg.autoSwitchStrategy}
                onValueChange={(val) => update({ autoSwitchStrategy: val as AccountAutoSwitchStrategy })}
              >
                <SelectTrigger size="sm" className="w-full" data-testid="account-auto-strategy">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="highest-quota">
                    {t('settings.accounts.automation.strategyHighest')}
                  </SelectItem>
                  <SelectItem value="round-robin">
                    {t('settings.accounts.automation.strategyRoundRobin')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-ink-2">
              {t('settings.accounts.automation.refreshInterval')}
            </span>
            <Select
              value={String(cfg.autoRefreshIntervalMin)}
              onValueChange={(val) => update({ autoRefreshIntervalMin: Number(val) })}
            >
              <SelectTrigger size="sm" className="w-full" data-testid="account-auto-refresh-interval">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REFRESH_INTERVAL_OPTIONS.map((mins) => (
                  <SelectItem key={mins} value={String(mins)}>
                    {mins === 0
                      ? t('settings.accounts.automation.refreshOff')
                      : t('settings.accounts.automation.refreshMin', mins)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {cfg.lastAutoSwitch ? (
            <div
              data-testid="account-auto-last-switch"
              className="rounded-xl bg-field/55 px-3 py-2 text-[11.5px] leading-relaxed text-ink-2"
            >
              {t(
                'settings.accounts.automation.lastSwitch',
                cfg.lastAutoSwitch.toLabel,
                cfg.lastAutoSwitch.reason === 'expired'
                  ? t('settings.accounts.automation.reasonExpired')
                  : t('settings.accounts.automation.reasonQuota'),
              )}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="default" size="sm" onClick={() => onOpenChange(false)}>
            {t('settings.accounts.loginModal.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

let exportReqSeq = 1;

export function AccountPortabilityDialog({
  open,
  onOpenChange,
  backends,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly backends: readonly BackendView[];
}) {
  const t = useT();
  const exportResult = useView((s) => s.accountsExportResult);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [tab, setTab] = useState<'import' | 'export'>('import');
  const [rawJson, setRawJson] = useState('');
  const [defaultBackendId, setDefaultBackendId] = useState<string>(backends[0]?.id ?? 'antigravity');
  const [exportBackendId, setExportBackendId] = useState<string>(EXPORT_ALL_VALUE);
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [pendingRequestId, setPendingRequestId] = useState<number | undefined>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) {
      setCopied(false);
    }
  }, [open]);

  useEffect(() => {
    if (backends.length > 0 && !backends.some((b) => b.id === defaultBackendId)) {
      setDefaultBackendId(backends[0]!.id);
    }
  }, [backends, defaultBackendId]);

  const activeExport =
    pendingRequestId !== undefined && exportResult?.requestId === pendingRequestId ? exportResult : undefined;

  const triggerExport = () => {
    const reqId = ++exportReqSeq;
    setPendingRequestId(reqId);
    postToHost({
      type: 'exportAccounts',
      payload: {
        requestId: reqId,
        includeSecrets,
        ...(exportBackendId !== EXPORT_ALL_VALUE ? { backendId: exportBackendId } : {}),
      },
    });
  };

  const handleFileChange = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      setRawJson(text);
    } catch {
      // ignore file read error
    }
  };

  const submitImport = () => {
    const trimmed = rawJson.trim();
    if (!trimmed) return;
    postToHost({
      type: 'importAccounts',
      payload: {
        rawJson: trimmed,
        ...(defaultBackendId ? { defaultBackendId } : {}),
      },
    });
    setRawJson('');
    onOpenChange(false);
  };

  const copyExportJson = async () => {
    if (!activeExport) return;
    try {
      await navigator.clipboard.writeText(activeExport.json);
      setCopied(true);
      showToast('info', t('settings.accounts.portability.copied'));
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore clipboard errors
    }
  };

  const downloadExportJson = () => {
    if (!activeExport) return;
    const blob = new Blob([activeExport.json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `halo-accounts-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="account-portability-dialog">
        <DialogHeader>
          <DialogTitle>{t('settings.accounts.portability.title')}</DialogTitle>
          <DialogDescription>{t('settings.accounts.portability.desc')}</DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as 'import' | 'export')}>
          <TabsList className="w-full">
            <TabsTrigger value="import" className="flex-1" data-testid="account-portability-tab-import">
              {t('settings.accounts.portability.tabImport')}
            </TabsTrigger>
            <TabsTrigger value="export" className="flex-1" data-testid="account-portability-tab-export">
              {t('settings.accounts.portability.tabExport')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="import" className="mt-3 flex flex-col gap-3">
            <div className="flex items-end justify-between gap-2">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-[12px] font-medium text-ink-2">
                  {t('settings.accounts.portability.defaultBackend')}
                </span>
                <Select value={defaultBackendId} onValueChange={setDefaultBackendId}>
                  <SelectTrigger size="sm" className="w-full" data-testid="account-import-backend">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {backends.map((b) => (
                      <SelectItem key={b.id} value={b.id} textValue={b.name}>
                        <span className="inline-flex items-center gap-2">
                          <BackendLogo backend={b} size="sm" />
                          <span>{b.name}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  void handleFileChange(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="account-import-load-file"
                onClick={() => fileInputRef.current?.click()}
              >
                <FileIcon className="size-3.5" />
                <span>{t('settings.accounts.portability.loadFile')}</span>
              </Button>
            </div>

            <Textarea
              rows={7}
              data-testid="account-import-textarea"
              className="font-mono text-[12px]"
              placeholder={t('settings.accounts.portability.importPlaceholder')}
              value={rawJson}
              onChange={(e) => setRawJson(e.target.value)}
            />

            <DialogFooter className="gap-1.5">
              <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                {t('settings.accounts.form.cancel')}
              </Button>
              <Button
                type="button"
                size="sm"
                data-testid="account-import-submit"
                disabled={!rawJson.trim()}
                onClick={submitImport}
              >
                {t('settings.accounts.portability.importSubmit')}
              </Button>
            </DialogFooter>
          </TabsContent>

          <TabsContent value="export" className="mt-3 flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-ink-2">
                {t('settings.accounts.portability.exportScope')}
              </span>
              <Select value={exportBackendId} onValueChange={setExportBackendId}>
                <SelectTrigger size="sm" className="w-full" data-testid="account-export-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={EXPORT_ALL_VALUE}>
                    {t('settings.accounts.portability.exportAll')}
                  </SelectItem>
                  {backends.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between gap-4 rounded-xl bg-field/60 px-3.5 py-2.5">
              <span className="text-[12px] leading-5 text-ink">
                {t('settings.accounts.portability.includeSecrets')}
              </span>
              <Switch
                data-testid="account-export-secrets"
                checked={includeSecrets}
                onCheckedChange={setIncludeSecrets}
              />
            </div>

            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="account-export-generate"
                onClick={triggerExport}
              >
                <RefreshIcon className="size-3.5" />
                <span>{t('settings.accounts.portability.exportGenerate')}</span>
              </Button>
              {activeExport ? (
                <span className="text-[12px] text-ink-2">
                  {t('settings.accounts.portability.exportSummary', activeExport.count)}
                </span>
              ) : null}
            </div>

            {activeExport ? (
              <>
                <Textarea
                  rows={6}
                  readOnly
                  data-testid="account-export-output"
                  className="font-mono text-[11.5px]"
                  value={activeExport.json}
                />
                <div className="flex items-center justify-end gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="account-export-copy"
                    onClick={() => void copyExportJson()}
                  >
                    {copied ? <CheckIcon className="size-3.5 text-green" /> : <CopyIcon className="size-3.5" />}
                    <span>{t('settings.accounts.portability.copyJson')}</span>
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    data-testid="account-export-download"
                    onClick={downloadExportJson}
                  >
                    <span>{t('settings.accounts.portability.downloadJson')}</span>
                  </Button>
                </div>
              </>
            ) : null}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
