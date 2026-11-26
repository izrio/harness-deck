/**
 * 设置 -> Agent -> 账号（参考 cockpit-tools 升级版）：
 * - 保留 Halo 去线留白视觉与各智能体官方/服务商渠道路由
 * - 增强可视化配额进度条、重置倒计时、单账号一键切号与单号刷新
 * - 新增标签/备注/启用禁用管理、搜索与按配额排序、低配额自动切号、以及兼容 cockpit-tools 的导入/导出备份
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  backendCapabilities,
  isProviderReadyForBackend,
  type AccountLoginProgress,
  type AccountRegion,
  type AccountView,
  type BackendView,
  type ProviderView,
  type QuotaWindowView,
} from '@harness-deck/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '../../lib/utils.ts';
import { useT } from '../../i18n.ts';
import { setSettingsTab, useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import { BackendLogo } from '../BackendLogo.tsx';
import {
  BanIcon,
  CheckIcon,
  ClockIcon,
  CodeIcon,
  CopyIcon,
  ErrorIcon,
  GlobeIcon,
  KeyIcon,
  LogInIcon,
  LogOutIcon,
  MoreIcon,
  PencilIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  SpinnerIcon,
  TerminalIcon,
  TrashIcon,
  ZapIcon,
} from '../icons.tsx';
import { AccountAutomationDialog, AccountPortabilityDialog } from './AccountDialogs.tsx';
import { SettingsSection } from './SettingsSection.tsx';

const REGION_DEFAULT_VALUE = '__default__';
type AccountSortMode = 'default' | 'quota' | 'status';

interface AccountEditorState {
  readonly isNew: boolean;
  readonly id?: string;
  readonly isSystemDefault?: boolean;
  readonly backendId: string;
  readonly label: string;
  readonly isolateSessions: boolean;
  readonly region: AccountRegion | '';
  readonly tagsText: string;
  readonly notes: string;
  readonly apiKey: string;
  readonly hasSecret: boolean;
  readonly usageCookie: string;
  readonly hasUsageCookie: boolean;
  readonly setActive: boolean;
}

function emptyEditor(backendId: string): AccountEditorState {
  return {
    isNew: true,
    backendId,
    label: '',
    isolateSessions: false,
    region: '',
    tagsText: '',
    notes: '',
    apiKey: '',
    hasSecret: false,
    usageCookie: '',
    hasUsageCookie: false,
    setActive: true,
  };
}

function editorFromAccount(account: AccountView): AccountEditorState {
  return {
    isNew: false,
    id: account.id,
    isSystemDefault: account.isSystemDefault === true,
    backendId: account.backendId,
    label: account.label,
    isolateSessions: account.isolateSessions === true,
    region: account.region ?? '',
    tagsText: (account.tags ?? []).join(', '),
    notes: account.notes ?? '',
    apiKey: '',
    hasSecret: account.hasSecret === true,
    usageCookie: '',
    hasUsageCookie: account.hasUsageCookie === true,
    setActive: false,
  };
}

function parseTagsInput(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[,，]+/u)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
}

function formatQuotaLabel(win: QuotaWindowView, t: ReturnType<typeof useT>): string {
  const kindLabel =
    win.kind === 'session'
      ? t('settings.accounts.quotaWindow.session')
      : win.kind === 'weekly' || win.kind === 'weeklyModel'
        ? t('settings.accounts.quotaWindow.weekly')
        : t('settings.accounts.quotaWindow.cycle');
  return win.label ? `${kindLabel}·${win.label}` : kindLabel;
}

function formatQuotaValue(win: QuotaWindowView, t: ReturnType<typeof useT>): string {
  if (win.remainingAmount !== undefined) {
    const unit = win.unit?.trim() || t('usage.credits.unit');
    const rem = new Intl.NumberFormat(undefined, {
      maximumFractionDigits: Number.isInteger(win.remainingAmount) ? 0 : 1,
    }).format(win.remainingAmount);
    if (win.totalAmount !== undefined) {
      const tot = new Intl.NumberFormat(undefined, {
        maximumFractionDigits: Number.isInteger(win.totalAmount) ? 0 : 1,
      }).format(win.totalAmount);
      return `${rem}/${tot} ${unit}`;
    }
    return `${rem} ${unit}`;
  }
  return t('settings.accounts.quotaRemaining', Math.round(win.remainingPercent));
}

function formatResetCountdown(resetsAt: number | undefined, t: ReturnType<typeof useT>): string | undefined {
  if (!resetsAt || !Number.isFinite(resetsAt)) return undefined;
  const diffMs = resetsAt - Date.now();
  if (diffMs <= 60_000) return t('settings.accounts.quotaResetSoon');
  const totalMin = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  let duration: string;
  if (days > 0) duration = `${days}d ${hours}h`;
  else if (hours > 0) duration = mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  else duration = `${mins}m`;
  return t('settings.accounts.quotaResetIn', duration);
}

function minVisibleQuotaPercent(acc: AccountView): number {
  const wins = (acc.quota?.windows ?? []).filter((w) => w.label.trim().toLowerCase() !== '3p');
  if (wins.length === 0) return -1;
  return Math.min(...wins.map((w) => Math.max(0, Math.min(100, w.remainingPercent))));
}

function statusSortRank(acc: AccountView): number {
  if (acc.disabled) return 4;
  if (acc.status === 'authenticated') return 0;
  if (acc.status === 'logging-in') return 1;
  if (acc.status === 'expired') return 2;
  return 3;
}

export function AccountSettings() {
  const t = useT();
  const backends = useView((s) => s.backends.items);
  const providers = useView((s) => s.providers.items);
  const protocolGatewayEnabled = useView((s) => s.providers.protocolGatewayEnabled === true);
  const fetchQuotaEnabled = useView((s) => s.preferences.fetchQuota !== false);
  const accountsState = useView((s) => s.accounts);

  const [editor, setEditor] = useState<AccountEditorState | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [pendingDelete, setPendingDelete] = useState<AccountView | undefined>();
  const [pendingLoginAfterCreate, setPendingLoginAfterCreate] = useState<
    { readonly backendId: string; readonly existingIds: ReadonlySet<string> } | undefined
  >();
  const [copiedKey, setCopiedKey] = useState<string | undefined>();
  const [searchQuery, setSearchQuery] = useState('');
  const [sortMode, setSortMode] = useState<AccountSortMode>('default');
  const [selectedTag, setSelectedTag] = useState<string>('');
  const [automationOpen, setAutomationOpen] = useState(false);
  const [portabilityOpen, setPortabilityOpen] = useState(false);
  const initialRefreshedRef = useRef(false);

  useEffect(() => {
    if (initialRefreshedRef.current) return;
    initialRefreshedRef.current = true;
    postToHost({ type: 'refreshAccounts', payload: { includeQuota: fetchQuotaEnabled } });
  }, [fetchQuotaEnabled]);

  useEffect(() => {
    if (!pendingLoginAfterCreate) return;
    const match = [...accountsState.items]
      .reverse()
      .find(
        (item) =>
          !item.isSystemDefault &&
          item.backendId === pendingLoginAfterCreate.backendId &&
          !pendingLoginAfterCreate.existingIds.has(item.id),
      );
    if (!match) return;
    setPendingLoginAfterCreate(undefined);
    postToHost({ type: 'loginAccount', payload: { id: match.id, backendId: match.backendId } });
  }, [accountsState.items, pendingLoginAfterCreate]);

  const multiAccountBackends = useMemo(
    () =>
      backends.filter((b) => {
        const cap = (b.capabilities ?? backendCapabilities(b)).account;
        return cap?.supported !== false && cap?.multiAccount === true;
      }),
    [backends],
  );

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const acc of accountsState.items) {
      for (const tag of acc.tags ?? []) set.add(tag);
    }
    return [...set];
  }, [accountsState.items]);

  useEffect(() => {
    if (selectedTag && !allTags.includes(selectedTag)) {
      setSelectedTag('');
    }
  }, [allTags, selectedTag]);

  const accountsByBackend = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const map = new Map<string, AccountView[]>();
    for (const acc of accountsState.items) {
      if (selectedTag && !(acc.tags ?? []).includes(selectedTag)) continue;
      if (q) {
        const hay = [acc.label, acc.identity, acc.notes, acc.plan, ...(acc.tags ?? [])]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) continue;
      }
      const list = map.get(acc.backendId);
      if (list) list.push(acc);
      else map.set(acc.backendId, [acc]);
    }
    if (sortMode !== 'default') {
      for (const list of map.values()) {
        list.sort((a, b) => {
          if (sortMode === 'quota') {
            return minVisibleQuotaPercent(b) - minVisibleQuotaPercent(a);
          }
          return statusSortRank(a) - statusSortRank(b);
        });
      }
    }
    return map;
  }, [accountsState.items, searchQuery, selectedTag, sortMode]);

  const refreshingSet = useMemo(
    () => new Set(accountsState.refreshingIds ?? []),
    [accountsState.refreshingIds],
  );

  const openAdd = (backendId?: string) => {
    const fallback = backendId ?? multiAccountBackends[0]?.id ?? backends[0]?.id ?? 'claude';
    setFormError(undefined);
    setEditor(emptyEditor(fallback));
  };

  const openEdit = (account: AccountView) => {
    setFormError(undefined);
    setEditor(editorFromAccount(account));
  };

  const closeEditor = () => {
    setEditor(undefined);
    setFormError(undefined);
  };

  const editorBackend = editor ? backends.find((b) => b.id === editor.backendId) : undefined;
  const editorAccountCap = editorBackend ? (editorBackend.capabilities ?? backendCapabilities(editorBackend)).account : undefined;

  const submitEditor = (andLogin: boolean) => {
    if (!editor) return;
    const label = editor.label.trim();
    const existingIds = new Set(
      accountsState.items
        .filter((item) => !item.isSystemDefault && item.backendId === editor.backendId)
        .map((item) => item.id),
    );
    const parsedTags = parseTagsInput(editor.tagsText);
    const trimmedNotes = editor.notes.trim();
    const editingExisting = !editor.isNew && !editor.isSystemDefault;

    postToHost({
      type: 'upsertAccount',
      payload: {
        ...(editor.id ? { id: editor.id } : {}),
        backendId: editor.backendId,
        label,
        ...(editorAccountCap?.supportsSessionIsolation ? { isolateSessions: editor.isolateSessions } : {}),
        ...(editorAccountCap?.supportsRegion && editor.region ? { region: editor.region } : {}),
        ...(parsedTags.length > 0 || editingExisting ? { tags: parsedTags } : {}),
        ...(trimmedNotes || editingExisting ? { notes: trimmedNotes } : {}),
        ...((editorAccountCap?.loginKind === 'api-key' || editorAccountCap?.supportsRegion) && editor.apiKey.trim()
          ? { apiKey: editor.apiKey.trim() }
          : {}),
        ...(editorAccountCap?.supportsRegion && editor.usageCookie.trim()
          ? { usageCookie: editor.usageCookie.trim() }
          : {}),
        ...(editor.setActive ? { setActive: true } : {}),
      },
    });
    const hasInlineApiKey = Boolean(editor.apiKey.trim());
    if (andLogin && editorAccountCap?.loginKind !== 'api-key' && !hasInlineApiKey) {
      if (editor.id) {
        postToHost({ type: 'loginAccount', payload: { id: editor.id, backendId: editor.backendId } });
      } else {
        setPendingLoginAfterCreate({ backendId: editor.backendId, existingIds });
      }
    }
    closeEditor();
  };

  const copyText = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((cur) => (cur === key ? undefined : cur)), 1_500);
  };

  const loginProgress = accountsState.loginProgress;
  const [dismissedProgress, setDismissedProgress] = useState<AccountLoginProgress | undefined>();
  const [authCode, setAuthCode] = useState('');
  const loginOpen = Boolean(loginProgress) && loginProgress !== dismissedProgress;
  const loginFinished =
    loginProgress?.phase === 'succeeded' || loginProgress?.phase === 'failed' || loginProgress?.phase === 'cancelled';
  const needsAuthCode = loginProgress?.phase === 'waiting-browser' && loginProgress.needsAuthCode === true;

  useEffect(() => {
    if (!needsAuthCode) setAuthCode('');
  }, [needsAuthCode, loginProgress?.accountId]);

  const dismissLogin = () => {
    setDismissedProgress(loginProgress);
    postToHost({
      type: 'cancelAccountLogin',
      payload: { ...(loginProgress ? { id: loginProgress.accountId } : {}), dismiss: true },
    });
    if (loginFinished) {
      postToHost({ type: 'refreshAccounts', payload: { includeQuota: false } });
    }
  };

  const submitAuthCode = () => {
    const code = authCode.trim();
    if (!code || !loginProgress) return;
    postToHost({ type: 'submitAccountLoginCode', payload: { id: loginProgress.accountId, code } });
    setAuthCode('');
  };

  const autoSwitchOn = accountsState.automation?.autoSwitchEnabled === true;

  return (
    <>
      <SettingsSection
        title={t('settings.accounts.title')}
        testId="settings-accounts"
        surface="plain"
        actions={
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-ink-2 hover:text-ink"
              data-testid="accounts-automation-btn"
              onClick={() => setAutomationOpen(true)}
            >
              <ZapIcon className={cn('size-3.5', autoSwitchOn && 'text-green')} />
              <span>{t('settings.accounts.automation.btn')}</span>
              {autoSwitchOn ? <span aria-hidden="true" className="size-1.5 rounded-full bg-green" /> : null}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-ink-2 hover:text-ink"
              data-testid="accounts-portability-btn"
              onClick={() => setPortabilityOpen(true)}
            >
              <CodeIcon className="size-3.5" />
              <span>{t('settings.accounts.portability.btn')}</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-ink-2 hover:text-ink"
              disabled={accountsState.checking === true}
              data-testid="accounts-refresh"
              onClick={() => postToHost({ type: 'refreshAccounts', payload: { includeQuota: fetchQuotaEnabled } })}
            >
              {accountsState.checking ? <SpinnerIcon className="size-3.5" /> : <RefreshIcon className="size-3.5" />}
              <span>{accountsState.checking ? t('settings.accounts.refreshing') : t('settings.accounts.refresh')}</span>
            </Button>
            {multiAccountBackends.length > 0 ? (
              <Button
                type="button"
                variant="default"
                size="sm"
                data-testid="accounts-add"
                onClick={() => openAdd()}
              >
                <PlusIcon className="size-3.5" />
                <span>{t('settings.accounts.add')}</span>
              </Button>
            ) : null}
          </>
        }
      >
        {/* 轻量搜索、配额排序与标签过滤条 */}
        {accountsState.items.length > 1 ? (
          <div className="mb-3 flex flex-col gap-2" data-testid="accounts-toolbar">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-44 flex-1">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
                <Input
                  size="sm"
                  data-testid="accounts-search-input"
                  className="pl-8"
                  value={searchQuery}
                  placeholder={t('settings.accounts.searchPlaceholder')}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <Select value={sortMode} onValueChange={(v) => setSortMode(v as AccountSortMode)}>
                <SelectTrigger size="sm" className="w-44" data-testid="accounts-sort-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">{t('settings.accounts.sortDefault')}</SelectItem>
                  <SelectItem value="quota">{t('settings.accounts.sortQuota')}</SelectItem>
                  <SelectItem value="status">{t('settings.accounts.sortStatus')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {allTags.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5" data-testid="accounts-tag-filters">
                <Button
                  type="button"
                  size="xs"
                  variant={selectedTag === '' ? 'default' : 'ghost'}
                  onClick={() => setSelectedTag('')}
                >
                  {t('settings.accounts.tagAll')}
                </Button>
                {allTags.map((tag) => (
                  <Button
                    key={tag}
                    type="button"
                    size="xs"
                    variant={selectedTag === tag ? 'default' : 'secondary'}
                    data-testid={`accounts-tag-filter-${tag}`}
                    onClick={() => setSelectedTag((cur) => (cur === tag ? '' : tag))}
                  >
                    #{tag}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-col gap-4">
          {backends.map((backend) => (
            <BackendAccountCard
              key={backend.id}
              backend={backend}
              accounts={accountsByBackend.get(backend.id) ?? []}
              providers={providers}
              protocolGatewayEnabled={protocolGatewayEnabled}
              channel={accountsState.channels[backend.id] ?? backend.activeChannel}
              refreshingSet={refreshingSet}
              fetchQuotaEnabled={fetchQuotaEnabled}
              onAdd={() => openAdd(backend.id)}
              onEdit={openEdit}
              onDelete={(acc) => setPendingDelete(acc)}
            />
          ))}
        </div>
      </SettingsSection>

      {/* 自动切号与定时刷新弹窗 */}
      <AccountAutomationDialog
        open={automationOpen}
        onOpenChange={setAutomationOpen}
        automation={accountsState.automation}
      />

      {/* 导入 / 导出备份弹窗 */}
      <AccountPortabilityDialog
        open={portabilityOpen}
        onOpenChange={setPortabilityOpen}
        backends={backends}
      />

      {/* 添加 / 编辑官方账号弹窗 */}
      <Dialog open={Boolean(editor)} onOpenChange={(open) => (!open ? closeEditor() : undefined)}>
        <DialogContent className="sm:max-w-md" data-testid="account-editor-dialog">
          <DialogHeader>
            <DialogTitle>
              {editor?.isNew
                ? t('settings.accounts.form.addTitle')
                : t('settings.accounts.form.editTitle', editor?.label ?? '')}
            </DialogTitle>
            <DialogDescription className="sr-only">{t('settings.accounts.desc')}</DialogDescription>
          </DialogHeader>

          {editor ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-[12px] font-medium text-ink-2">{t('settings.accounts.form.backend')}</span>
                <Select
                  disabled={!editor.isNew}
                  value={editor.backendId}
                  onValueChange={(value) => setEditor({ ...editor, backendId: value })}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-full"
                    data-testid="account-form-backend"
                    aria-label={t('settings.accounts.form.backend')}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(editor.isNew ? multiAccountBackends : backends).map((b) => (
                      <SelectItem key={b.id} value={b.id} textValue={b.name}>
                        <span className="inline-flex min-w-0 items-center gap-2">
                          <BackendLogo backend={b} size="sm" />
                          <span className="truncate">{b.name}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <label className="flex flex-col gap-1">
                <span className="text-[12px] font-medium text-ink-2">{t('settings.accounts.form.label')}</span>
                <Input
                  size="sm"
                  data-testid="account-form-label"
                  value={editor.label}
                  placeholder={t('settings.accounts.form.labelPlaceholder')}
                  onChange={(e) => {
                    setFormError(undefined);
                    setEditor({ ...editor, label: e.target.value });
                  }}
                />
              </label>

              {!editor.isSystemDefault ? (
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-[12px] font-medium text-ink-2">{t('settings.accounts.form.tags')}</span>
                    <Input
                      size="sm"
                      data-testid="account-form-tags"
                      value={editor.tagsText}
                      placeholder={t('settings.accounts.form.tagsPlaceholder')}
                      onChange={(e) => setEditor({ ...editor, tagsText: e.target.value })}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[12px] font-medium text-ink-2">{t('settings.accounts.form.notes')}</span>
                    <Input
                      size="sm"
                      data-testid="account-form-notes"
                      value={editor.notes}
                      placeholder={t('settings.accounts.form.notesPlaceholder')}
                      onChange={(e) => setEditor({ ...editor, notes: e.target.value })}
                    />
                  </label>
                </div>
              ) : null}

              {editorAccountCap?.supportsRegion && !editor.isSystemDefault ? (
                <div className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-ink-2">{t('settings.accounts.form.region')}</span>
                  <Select
                    value={editor.region || REGION_DEFAULT_VALUE}
                    onValueChange={(value) =>
                      setEditor({ ...editor, region: (value === REGION_DEFAULT_VALUE ? '' : value) as AccountRegion | '' })
                    }
                  >
                    <SelectTrigger
                      size="sm"
                      className="w-full"
                      data-testid="account-form-region"
                      aria-label={t('settings.accounts.form.region')}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={REGION_DEFAULT_VALUE}>{t('settings.accounts.form.regionDefault')}</SelectItem>
                      <SelectItem value="cn">{t('settings.accounts.form.regionCn')}</SelectItem>
                      <SelectItem value="ai">{t('settings.accounts.form.regionAi')}</SelectItem>
                      <SelectItem value="internal">{t('settings.accounts.form.regionInternal')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : null}

              {(editorAccountCap?.loginKind === 'api-key' || editorAccountCap?.supportsRegion) && !editor.isSystemDefault ? (
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-ink-2">
                    {editorAccountCap?.supportsRegion
                      ? t('settings.accounts.form.codebuddyApiKey')
                      : t('settings.accounts.form.apiKey')}
                  </span>
                  <Input
                    size="sm"
                    type="password"
                    data-testid="account-form-apikey"
                    value={editor.apiKey}
                    placeholder={
                      editor.hasSecret
                        ? t('settings.accounts.form.apiKeyKeep')
                        : editorAccountCap?.supportsRegion
                          ? t('settings.accounts.form.codebuddyApiKeyPlaceholder')
                          : t('settings.accounts.form.apiKeyPlaceholder')
                    }
                    onChange={(e) => setEditor({ ...editor, apiKey: e.target.value })}
                  />
                </label>
              ) : null}

              {editorAccountCap?.supportsRegion ? (
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-ink-2">{t('settings.accounts.form.usageCookie')}</span>
                  <Input
                    size="sm"
                    type="password"
                    data-testid="account-form-cookie"
                    value={editor.usageCookie}
                    placeholder={
                      editor.hasUsageCookie
                        ? t('settings.accounts.form.usageCookieKeep')
                        : t('settings.accounts.form.usageCookiePlaceholder')
                    }
                    onChange={(e) => setEditor({ ...editor, usageCookie: e.target.value })}
                  />
                </label>
              ) : null}

              {editorAccountCap?.supportsSessionIsolation && !editor.isSystemDefault ? (
                <div className="flex items-center justify-between gap-3 rounded-xl bg-field/60 px-3 py-2.5">
                  <span className="text-[12px] font-medium text-ink">
                    {t('settings.accounts.form.isolateSessions')}
                  </span>
                  <Switch
                    checked={editor.isolateSessions}
                    onCheckedChange={(checked) => setEditor({ ...editor, isolateSessions: checked })}
                  />
                </div>
              ) : null}

              {editor.isNew ? (
                <div className="flex items-center justify-between gap-3 px-0.5">
                  <span className="text-[12px] text-ink-2">{t('settings.accounts.form.setActive')}</span>
                  <Switch
                    checked={editor.setActive}
                    onCheckedChange={(checked) => setEditor({ ...editor, setActive: checked })}
                  />
                </div>
              ) : null}

              {formError ? (
                <div className="flex items-center gap-1.5 text-[12px] text-red">
                  <ErrorIcon className="size-3.5 shrink-0" />
                  <span>{formError}</span>
                </div>
              ) : null}
            </div>
          ) : null}

          <DialogFooter className="gap-1.5">
            <Button type="button" variant="outline" size="sm" onClick={closeEditor}>
              {t('settings.accounts.form.cancel')}
            </Button>
            {editor && editor.isNew && editorAccountCap?.loginKind !== 'api-key' && !editor.apiKey.trim() ? (
              <>
                <Button type="button" variant="secondary" size="sm" onClick={() => submitEditor(false)}>
                  {t('settings.accounts.form.save')}
                </Button>
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  data-testid="account-form-save-login"
                  onClick={() => submitEditor(true)}
                >
                  <LogInIcon className="size-3.5" />
                  <span>{t('settings.accounts.form.saveAndLogin')}</span>
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="default"
                size="sm"
                data-testid="account-form-save"
                onClick={() => submitEditor(false)}
              >
                {t('settings.accounts.form.save')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除二次确认弹窗 */}
      <Dialog open={Boolean(pendingDelete)} onOpenChange={(open) => (!open ? setPendingDelete(undefined) : undefined)}>
        <DialogContent className="sm:max-w-sm" data-testid="account-delete-dialog">
          <DialogHeader>
            <DialogTitle>{t('settings.accounts.deleteConfirmTitle')}</DialogTitle>
            <DialogDescription>
              {t('settings.accounts.deleteConfirmDesc', pendingDelete?.label ?? '')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-1.5">
            <Button type="button" variant="outline" size="sm" onClick={() => setPendingDelete(undefined)}>
              {t('settings.accounts.form.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              data-testid="account-delete-confirm"
              onClick={() => {
                if (pendingDelete) {
                  postToHost({ type: 'deleteAccount', payload: { id: pendingDelete.id } });
                }
                setPendingDelete(undefined);
              }}
            >
              {t('settings.accounts.deleteConfirmAction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 官方登录进度弹窗 */}
      <Dialog
        open={loginOpen}
        onOpenChange={(open) => {
          if (!open) dismissLogin();
        }}
      >
        <DialogContent className="sm:max-w-md" data-testid="account-login-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {loginProgress?.phase === 'succeeded' ? (
                <CheckIcon className="size-4 text-green" />
              ) : loginProgress?.phase === 'failed' ? (
                <ErrorIcon className="size-4 text-red" />
              ) : !loginFinished ? (
                <SpinnerIcon className="size-4 text-accent-ink" />
              ) : null}
              <span>{t('settings.accounts.loginModal.title')}</span>
            </DialogTitle>
            <DialogDescription>
              {loginProgress?.phase === 'starting'
                ? t('settings.accounts.loginModal.starting')
                : loginProgress?.phase === 'waiting-browser'
                  ? needsAuthCode
                    ? t('settings.accounts.loginModal.waitingAuthCode')
                    : t('settings.accounts.loginModal.waitingBrowser')
                  : loginProgress?.phase === 'waiting-terminal'
                    ? t('settings.accounts.loginModal.waitingTerminal')
                    : loginProgress?.phase === 'verifying'
                      ? t('settings.accounts.loginModal.verifying')
                      : loginProgress?.phase === 'succeeded'
                        ? t('settings.accounts.loginModal.succeeded')
                        : loginProgress?.phase === 'failed'
                          ? t('settings.accounts.loginModal.failed', loginProgress.message ?? '')
                          : t('settings.accounts.loginModal.cancelled')}
            </DialogDescription>
          </DialogHeader>

          {loginProgress ? (
            <div className="flex min-w-0 flex-col gap-2.5">
              {loginProgress.deviceCode ? (
                <div className="flex min-w-0 items-center justify-between gap-2 rounded-xl bg-field/70 px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="text-[11px] text-ink-3">{t('settings.accounts.loginModal.deviceCode')}</div>
                    <div className="font-mono text-[15px] font-semibold tracking-wider text-ink">
                      {loginProgress.deviceCode}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="xs"
                    onClick={() => copyText('code', loginProgress.deviceCode!)}
                  >
                    {copiedKey === 'code' ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
                    <span>{t('settings.accounts.loginModal.copyLink')}</span>
                  </Button>
                </div>
              ) : null}

              {loginProgress.authUrl ? (
                <div className="flex min-w-0 flex-col gap-2 rounded-xl bg-field/60 p-3">
                  <div
                    className="min-w-0 truncate font-mono text-[11.5px] text-ink-2"
                    title={loginProgress.authUrl}
                  >
                    {loginProgress.authUrl}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      type="button"
                      variant="default"
                      size="xs"
                      onClick={() => postToHost({ type: 'openExternal', payload: { url: loginProgress.authUrl! } })}
                    >
                      <GlobeIcon className="size-3" />
                      <span>{t('settings.accounts.loginModal.openBrowser')}</span>
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="xs"
                      onClick={() => copyText('url', loginProgress.authUrl!)}
                    >
                      {copiedKey === 'url' ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
                      <span>{t('settings.accounts.loginModal.copyLink')}</span>
                    </Button>
                  </div>
                </div>
              ) : null}

              {needsAuthCode ? (
                <form
                  className="flex min-w-0 flex-col gap-1.5"
                  data-testid="account-login-code-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    submitAuthCode();
                  }}
                >
                  <Label htmlFor="account-login-code" className="text-[11px] text-ink-3">
                    {t('settings.accounts.loginModal.authCodeLabel')}
                  </Label>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Input
                      id="account-login-code"
                      size="sm"
                      autoFocus
                      autoComplete="off"
                      spellCheck={false}
                      className="min-w-0 flex-1 font-mono"
                      data-testid="account-login-code-input"
                      placeholder={t('settings.accounts.loginModal.authCodePlaceholder')}
                      value={authCode}
                      onChange={(event) => setAuthCode(event.target.value)}
                    />
                    <Button
                      type="submit"
                      variant="default"
                      size="sm"
                      disabled={!authCode.trim()}
                      data-testid="account-login-code-submit"
                    >
                      <LogInIcon className="size-3.5" />
                      <span>{t('settings.accounts.loginModal.submitCode')}</span>
                    </Button>
                  </div>
                </form>
              ) : null}

              {loginProgress.command ? (
                <div className="flex min-w-0 flex-col gap-1.5 rounded-xl bg-field/60 p-3">
                  <div className="flex items-center gap-1.5 text-[11px] text-ink-3">
                    <TerminalIcon className="size-3" />
                    <span>{t('settings.accounts.loginModal.command')}</span>
                  </div>
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink" title={loginProgress.command}>
                      {loginProgress.command}
                    </code>
                    <Button
                      type="button"
                      variant="secondary"
                      size="xs"
                      onClick={() => copyText('cmd', loginProgress.command!)}
                    >
                      {copiedKey === 'cmd' ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          <DialogFooter className="gap-1.5">
            {loginProgress?.phase === 'waiting-terminal' ? (
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={() => {
                  postToHost({
                    type: 'refreshAccounts',
                    payload: { backendId: loginProgress.backendId, includeQuota: fetchQuotaEnabled },
                  });
                }}
              >
                <RefreshIcon className="size-3.5" />
                <span>{t('settings.accounts.loginModal.checkNow')}</span>
              </Button>
            ) : null}
            <Button
              type="button"
              variant={loginFinished ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                if (loginFinished) {
                  dismissLogin();
                  return;
                }
                postToHost({
                  type: 'cancelAccountLogin',
                  payload: { ...(loginProgress ? { id: loginProgress.accountId } : {}) },
                });
              }}
            >
              {loginFinished ? t('settings.accounts.loginModal.close') : t('settings.accounts.loginModal.cancel')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function BackendAccountCard({
  backend,
  accounts,
  providers,
  protocolGatewayEnabled,
  channel,
  refreshingSet,
  fetchQuotaEnabled,
  onAdd,
  onEdit,
  onDelete,
}: {
  readonly backend: BackendView;
  readonly accounts: readonly AccountView[];
  readonly providers: readonly ProviderView[];
  readonly protocolGatewayEnabled: boolean;
  readonly channel: BackendView['activeChannel'];
  readonly refreshingSet: ReadonlySet<string>;
  readonly fetchQuotaEnabled: boolean;
  readonly onAdd: () => void;
  readonly onEdit: (account: AccountView) => void;
  readonly onDelete: (account: AccountView) => void;
}) {
  const t = useT();
  const caps = backend.capabilities ?? backendCapabilities(backend);
  const accountCap = caps.account;
  const supportsProvider = caps.protocols.kind === 'supported';
  const compatibleProviders = useMemo(
    () =>
      supportsProvider
        ? providers.filter((p) => isProviderReadyForBackend(p, backend, { protocolGatewayEnabled }))
        : [],
    [supportsProvider, providers, backend, protocolGatewayEnabled],
  );

  const activeMode = channel?.mode ?? 'official';
  const activeAccountId =
    channel?.mode === 'official' ? (channel.accountId ?? `system:${backend.id}`) : undefined;
  const activeProviderId = channel?.mode === 'provider' ? channel.providerId : undefined;

  const switchToOfficial = (accountId?: string) => {
    postToHost({
      type: 'setBackendChannel',
      payload: {
        backendId: backend.id,
        mode: 'official',
        accountId: accountId ?? activeAccountId ?? `system:${backend.id}`,
      },
    });
  };

  const switchToProvider = (providerId: string) => {
    if (!providerId) return;
    postToHost({
      type: 'setBackendChannel',
      payload: {
        backendId: backend.id,
        mode: 'provider',
        providerId,
      },
    });
  };

  return (
    <Card
      className="gap-0 overflow-hidden rounded-2xl border-0 bg-field/55 py-0 shadow-none dark:bg-surface/65"
      data-testid={`account-backend-card-${backend.id}`}
    >
      {/* 顶部：智能体信息 + 渠道模式切换（官方 ↔ 服务商） */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <BackendLogo backend={backend} />
          <span className="truncate text-[13.5px] font-semibold text-ink">{backend.name}</span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <div
            className="inline-flex items-center gap-0.5 rounded-lg bg-canvas/85 p-0.5 dark:bg-page/60"
            role="group"
            aria-label={t('model.channel.label')}
          >
            <Button
              type="button"
              variant={activeMode === 'official' ? 'default' : 'ghost'}
              size="xs"
              aria-pressed={activeMode === 'official'}
              data-testid={`channel-official-${backend.id}`}
              className={cn(
                'px-2.5',
                activeMode === 'official'
                  ? 'font-medium shadow-none'
                  : 'text-ink-3 hover:bg-hover/70 hover:text-ink',
              )}
              onClick={() => switchToOfficial()}
            >
              <span>{t('settings.accounts.channelOfficial')}</span>
            </Button>
            <Button
              type="button"
              variant={activeMode === 'provider' ? 'default' : 'ghost'}
              size="xs"
              aria-pressed={activeMode === 'provider'}
              disabled={!supportsProvider || compatibleProviders.length === 0}
              data-testid={`channel-provider-${backend.id}`}
              className={cn(
                'px-2.5',
                activeMode === 'provider'
                  ? 'font-medium shadow-none'
                  : 'text-ink-3 hover:bg-hover/70 hover:text-ink',
              )}
              onClick={() => {
                const target = activeProviderId ?? compatibleProviders[0]?.id;
                if (target) switchToProvider(target);
              }}
            >
              <span>{t('settings.accounts.channelProvider')}</span>
            </Button>
          </div>

          {accountCap?.multiAccount ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="text-ink-2 hover:text-ink"
              data-testid={`add-account-${backend.id}`}
              onClick={onAdd}
            >
              <PlusIcon className="size-3" />
              <span>{t('settings.accounts.add')}</span>
            </Button>
          ) : null}
        </div>
      </div>

      {/* 第三方服务商选择栏 */}
      {supportsProvider && activeMode === 'provider' ? (
        <div className="px-4 pb-3.5">
          <div className="flex flex-wrap items-center gap-2 rounded-xl bg-canvas/75 px-3 py-2 dark:bg-page/50">
            <KeyIcon className="size-3.5 shrink-0 text-accent-ink" />
            {compatibleProviders.length > 0 ? (
              <Select value={activeProviderId ?? ''} onValueChange={switchToProvider}>
                <SelectTrigger
                  size="sm"
                  className="min-w-44 flex-1"
                  data-testid={`channel-provider-select-${backend.id}`}
                  aria-label={t('settings.accounts.providerSelectPlaceholder')}
                >
                  <SelectValue placeholder={t('settings.accounts.providerSelectPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {compatibleProviders.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="flex-1 text-[12px] text-ink-3">{t('settings.accounts.noCompatibleProvider')}</span>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={() => setSettingsTab('providers')}>
              {t('settings.accounts.gotoProviders')}
            </Button>
          </div>
        </div>
      ) : null}

      {/* 官方账号列表 */}
      {accounts.length > 0 ? (
        <div className="px-4">
          <div className="flex flex-col divide-y divide-line/55 border-t border-line/55">
            {accounts.map((acc) => {
              const isCurrent = activeMode === 'official' && activeAccountId === acc.id;
              const isRefreshing = refreshingSet.has(acc.id);
              const canEdit = true;
              const statusKey = `settings.accounts.status.${acc.status}` as const;
              const showUse = !isCurrent;
              const showLogin = accountCap?.loginKind !== 'api-key' || acc.isSystemDefault;
              const showLogout = acc.status === 'authenticated' || acc.status === 'expired';
              const showDelete = !acc.isSystemDefault;
              const showDisable = !acc.isSystemDefault;
              const hasPrimary = showUse || showLogin || canEdit;
              const hasSecondary = showLogout || showDelete || showDisable;
              const visibleQuotaWindows = (acc.quota?.windows ?? []).filter(
                (win) => win.label.trim().toLowerCase() !== '3p',
              );
              const showIdentity = Boolean(acc.identity && acc.identity !== acc.label);

              return (
                <div
                  key={acc.id}
                  data-testid={`account-row-${acc.id}`}
                  className={cn(
                    'flex items-start justify-between gap-3 py-3',
                    acc.disabled && 'opacity-65',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span
                        className={cn(
                          'size-2 shrink-0 rounded-full',
                          isCurrent ? 'bg-green' : acc.status === 'expired' ? 'bg-orange' : 'bg-ink-4',
                        )}
                        data-testid={isCurrent ? `account-active-${acc.id}` : `account-dot-${acc.id}`}
                        aria-label={isCurrent ? t('settings.accounts.activeBadge') : undefined}
                        title={isCurrent ? t('settings.accounts.activeBadge') : undefined}
                      />
                      <span className={cn('text-[12.5px]', isCurrent ? 'font-semibold text-ink' : 'font-medium text-ink-2')}>
                        {acc.label}
                      </span>

                      {acc.status === 'logging-in' ? (
                        <span className="inline-flex items-center gap-1 text-[11.5px] text-accent-ink">
                          <SpinnerIcon className="size-2.5" />
                          <span>{t(statusKey)}</span>
                        </span>
                      ) : acc.status === 'expired' ? (
                        <span className="text-[11.5px] font-medium text-orange">{t(statusKey)}</span>
                      ) : acc.status !== 'authenticated' ? (
                        <span className="text-[11.5px] text-ink-3">{t(statusKey)}</span>
                      ) : null}

                      {acc.plan ? <span className="text-[11.5px] text-ink-3">{acc.plan}</span> : null}
                      {acc.isolateSessions ? (
                        <span className="text-[11px] text-ink-3">{t('settings.accounts.isolatedSessionBadge')}</span>
                      ) : null}
                      {acc.disabled ? (
                        <span className="rounded-md bg-orange-tint/65 px-1.5 py-0.5 text-[10.5px] font-medium text-orange">
                          {t('settings.accounts.disabledBadge')}
                        </span>
                      ) : null}
                      {(acc.tags ?? []).map((tag) => (
                        <span
                          key={tag}
                          className="rounded-md bg-canvas/85 px-1.5 py-0.5 text-[10.5px] text-ink-2 dark:bg-page/55"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>

                    {showIdentity || acc.notes ? (
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 pl-4 text-[11.5px] text-ink-3">
                        {showIdentity ? <span className="truncate font-mono">{acc.identity}</span> : null}
                        {acc.notes ? <span className="truncate">{acc.notes}</span> : null}
                      </div>
                    ) : null}

                    {/* 可视化配额进度条 + 重置倒计时 */}
                    {visibleQuotaWindows.length > 0 ? (
                      <div
                        className="mt-2 grid grid-cols-1 gap-1.5 pl-4 sm:grid-cols-2"
                        data-testid={`account-quota-bars-${acc.id}`}
                      >
                        {visibleQuotaWindows.slice(0, 4).map((win, idx) => {
                          const pct = Math.max(0, Math.min(100, Math.round(win.remainingPercent)));
                          const barColor =
                            pct <= 10 || win.severity === 'critical'
                              ? 'bg-red'
                              : pct <= 30 || win.severity === 'warning'
                                ? 'bg-orange'
                                : 'bg-green';
                          const resetLabel = formatResetCountdown(win.resetsAt, t);
                          return (
                            <div
                              key={`${win.kind}:${win.label}:${idx}`}
                              className="flex flex-col gap-1 rounded-lg bg-canvas/75 px-2.5 py-1.5 dark:bg-page/45"
                            >
                              <div className="flex items-center justify-between gap-2 text-[10.5px] leading-4 tabular-nums">
                                <span className="truncate font-medium text-ink-2">
                                  {formatQuotaLabel(win, t)}
                                </span>
                                <span className="shrink-0 font-medium text-ink">
                                  {formatQuotaValue(win, t)}
                                </span>
                              </div>
                              <div className="h-1.5 w-full overflow-hidden rounded-full bg-line/60">
                                <div
                                  className={cn('h-full rounded-full transition-[width] duration-300', barColor)}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                              {resetLabel ? (
                                <div className="flex items-center gap-1 text-[10px] leading-3.5 text-ink-3 tabular-nums">
                                  <ClockIcon className="size-2.5 shrink-0" />
                                  <span>{resetLabel}</span>
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>

                  {/* 右侧操作：外置一键切号 + 单号刷新 + 更多菜单 */}
                  <div className="flex shrink-0 items-center gap-1">
                    {showUse && !acc.disabled ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="xs"
                        data-testid={`account-quick-use-${acc.id}`}
                        onClick={() => switchToOfficial(acc.id)}
                      >
                        <span>{t('settings.accounts.quickUse')}</span>
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="text-ink-3 hover:text-ink"
                      disabled={isRefreshing}
                      data-testid={`account-refresh-${acc.id}`}
                      aria-label={t('settings.accounts.refreshOne')}
                      title={t('settings.accounts.refreshOne')}
                      onClick={() =>
                        postToHost({
                          type: 'refreshAccount',
                          payload: { id: acc.id, backendId: acc.backendId, includeQuota: fetchQuotaEnabled },
                        })
                      }
                    >
                      {isRefreshing ? <SpinnerIcon className="size-3.5" /> : <RefreshIcon className="size-3.5" />}
                    </Button>

                    {hasPrimary || hasSecondary ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="shrink-0 text-ink-2 hover:text-ink"
                            data-testid={`account-actions-${acc.id}`}
                            aria-label={t('common.moreActions')}
                            title={t('common.moreActions')}
                          >
                            <MoreIcon className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-44">
                          {showUse ? (
                            <DropdownMenuItem
                              className="gap-2 text-[12.5px]"
                              data-testid={`account-use-${acc.id}`}
                              onSelect={() => switchToOfficial(acc.id)}
                            >
                              <CheckIcon className="size-3.5 text-ink-2" />
                              <span>{t('settings.accounts.use')}</span>
                            </DropdownMenuItem>
                          ) : null}
                          {showLogin ? (
                            <DropdownMenuItem
                              className="gap-2 text-[12.5px]"
                              data-testid={`account-login-${acc.id}`}
                              onSelect={() =>
                                postToHost({ type: 'loginAccount', payload: { id: acc.id, backendId: acc.backendId } })
                              }
                            >
                              <LogInIcon className="size-3.5 text-ink-2" />
                              <span>
                                {acc.status === 'authenticated'
                                  ? t('settings.accounts.relogin')
                                  : t('settings.accounts.login')}
                              </span>
                            </DropdownMenuItem>
                          ) : null}
                          {canEdit ? (
                            <DropdownMenuItem
                              className="gap-2 text-[12.5px]"
                              data-testid={`account-edit-${acc.id}`}
                              onSelect={() => onEdit(acc)}
                            >
                              <PencilIcon className="size-3.5 text-ink-2" />
                              <span>{t('settings.accounts.edit')}</span>
                            </DropdownMenuItem>
                          ) : null}
                          {hasPrimary && hasSecondary ? <DropdownMenuSeparator /> : null}
                          {showDisable ? (
                            <DropdownMenuItem
                              className="gap-2 text-[12.5px]"
                              data-testid={`account-toggle-disabled-${acc.id}`}
                              onSelect={() =>
                                postToHost({
                                  type: 'toggleAccountDisabled',
                                  payload: { id: acc.id, disabled: !acc.disabled },
                                })
                              }
                            >
                              <BanIcon className="size-3.5 text-ink-2" />
                              <span>
                                {acc.disabled ? t('settings.accounts.enable') : t('settings.accounts.disable')}
                              </span>
                            </DropdownMenuItem>
                          ) : null}
                          {showLogout ? (
                            <DropdownMenuItem
                              className="gap-2 text-[12.5px]"
                              data-testid={`account-logout-${acc.id}`}
                              onSelect={() => postToHost({ type: 'logoutAccount', payload: { id: acc.id } })}
                            >
                              <LogOutIcon className="size-3.5 text-ink-2" />
                              <span>{t('settings.accounts.logout')}</span>
                            </DropdownMenuItem>
                          ) : null}
                          {showDelete ? (
                            <DropdownMenuItem
                              variant="destructive"
                              className="gap-2 text-[12.5px]"
                              data-testid={`account-delete-${acc.id}`}
                              onSelect={() => onDelete(acc)}
                            >
                              <TrashIcon className="size-3.5" />
                              <span>{t('settings.accounts.delete')}</span>
                            </DropdownMenuItem>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
