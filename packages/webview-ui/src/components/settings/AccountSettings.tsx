/**
 * 设置 -> Agent -> 账号：
 * 支持为不同智能体添加与登录多个官方渠道账号（原生目录隔离 / 凭据槽位快照 / 官方 API Key），
 * 并在每个智能体卡片上随时切换使用「官方渠道（指定账号）」或「第三方服务商」。
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
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { cn } from '../../lib/utils.ts';
import { useT } from '../../i18n.ts';
import { setSettingsTab, useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import { BackendLogo } from '../BackendLogo.tsx';
import { ValuePill } from '../beautifului/index.ts';
import {
  CheckIcon,
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
  SpinnerIcon,
  TerminalIcon,
  TrashIcon,
  UsersIcon,
} from '../icons.tsx';

interface AccountEditorState {
  readonly isNew: boolean;
  readonly id?: string;
  readonly isSystemDefault?: boolean;
  readonly backendId: string;
  readonly label: string;
  readonly isolateSessions: boolean;
  readonly region: AccountRegion | '';
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
    apiKey: '',
    hasSecret: account.hasSecret === true,
    usageCookie: '',
    hasUsageCookie: account.hasUsageCookie === true,
    setActive: false,
  };
}

function statusTone(status: AccountView['status']): 'green' | 'orange' | 'accent' | 'neutral' {
  switch (status) {
    case 'authenticated':
      return 'green';
    case 'expired':
      return 'orange';
    case 'logging-in':
      return 'accent';
    default:
      return 'neutral';
  }
}

function formatQuotaChip(win: QuotaWindowView, t: ReturnType<typeof useT>): string {
  const kindLabel =
    win.kind === 'session'
      ? t('settings.accounts.quotaWindow.session')
      : win.kind === 'weekly' || win.kind === 'weeklyModel'
        ? t('settings.accounts.quotaWindow.weekly')
        : t('settings.accounts.quotaWindow.cycle');
  const scope = win.label ? `${kindLabel}·${win.label}` : kindLabel;
  return `${scope} ${t('settings.accounts.quotaRemaining', Math.round(win.remainingPercent))}`;
}

export function AccountSettings() {
  const t = useT();
  const backends = useView((s) => s.backends.items);
  const providers = useView((s) => s.providers.items);
  const protocolGatewayEnabled = useView((s) => s.providers.protocolGatewayEnabled === true);
  const accountsState = useView((s) => s.accounts);

  const [editor, setEditor] = useState<AccountEditorState | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [pendingDelete, setPendingDelete] = useState<AccountView | undefined>();
  const [pendingLoginAfterCreate, setPendingLoginAfterCreate] = useState<
    { readonly backendId: string; readonly label: string } | undefined
  >();
  const [copiedKey, setCopiedKey] = useState<string | undefined>();
  const initialRefreshedRef = useRef(false);

  useEffect(() => {
    if (initialRefreshedRef.current) return;
    initialRefreshedRef.current = true;
    postToHost({ type: 'refreshAccounts', payload: { includeQuota: true } });
  }, []);

  // 保存新账号并立即登录：等待 Host 推送该新账号后自动触发 loginAccount
  useEffect(() => {
    if (!pendingLoginAfterCreate) return;
    const match = [...accountsState.items]
      .reverse()
      .find(
        (item) =>
          !item.isSystemDefault &&
          item.backendId === pendingLoginAfterCreate.backendId &&
          item.label === pendingLoginAfterCreate.label,
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

  const accountsByBackend = useMemo(() => {
    const map = new Map<string, AccountView[]>();
    for (const acc of accountsState.items) {
      const list = map.get(acc.backendId);
      if (list) list.push(acc);
      else map.set(acc.backendId, [acc]);
    }
    return map;
  }, [accountsState.items]);

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
    if (!editor.isSystemDefault && !label) {
      setFormError(t('settings.accounts.form.labelRequired'));
      return;
    }
    postToHost({
      type: 'upsertAccount',
      payload: {
        ...(editor.id ? { id: editor.id } : {}),
        backendId: editor.backendId,
        label: editor.isSystemDefault ? editor.label : label,
        ...(editorAccountCap?.supportsSessionIsolation ? { isolateSessions: editor.isolateSessions } : {}),
        ...(editorAccountCap?.supportsRegion && editor.region ? { region: editor.region } : {}),
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
        setPendingLoginAfterCreate({ backendId: editor.backendId, label });
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
  // 本地记住已关闭的进度对象：点击关闭后立即隐藏弹窗，Host 推送新的进度时再自动打开
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

  return (
    <>
      <div className="flex flex-col gap-2.5" data-testid="settings-accounts">
        <div className="flex min-w-0 flex-col gap-1 px-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="m-0 truncate text-[13px] font-semibold tracking-tight text-ink">
              {t('settings.accounts.title')}
            </h3>
            <div className="ml-auto flex shrink-0 flex-wrap items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={accountsState.checking === true}
                data-testid="accounts-refresh"
                onClick={() => postToHost({ type: 'refreshAccounts', payload: { includeQuota: true } })}
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
            </div>
          </div>
          <p className="m-0 text-[12px] leading-relaxed text-ink-3">{t('settings.accounts.desc')}</p>
        </div>

        <div className="flex flex-col gap-2.5">
          {backends.map((backend) => (
            <BackendAccountCard
              key={backend.id}
              backend={backend}
              accounts={accountsByBackend.get(backend.id) ?? []}
              providers={providers}
              protocolGatewayEnabled={protocolGatewayEnabled}
              channel={accountsState.channels[backend.id] ?? backend.activeChannel}
              onAdd={() => openAdd(backend.id)}
              onEdit={openEdit}
              onDelete={(acc) => setPendingDelete(acc)}
            />
          ))}
        </div>
      </div>

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
            <div className="flex flex-col gap-3 [&_[data-slot=native-select-wrapper]]:w-full">
              <label className="flex flex-col gap-1">
                <span className="text-[12px] font-medium text-ink-2">{t('settings.accounts.form.backend')}</span>
                <NativeSelect
                  size="sm"
                  disabled={!editor.isNew}
                  data-testid="account-form-backend"
                  value={editor.backendId}
                  onChange={(e) => setEditor({ ...editor, backendId: e.target.value })}
                >
                  {(editor.isNew ? multiAccountBackends : backends).map((b) => (
                    <NativeSelectOption key={b.id} value={b.id}>
                      {b.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>

              {!editor.isSystemDefault ? (
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
              ) : null}

              {editorAccountCap?.supportsRegion && !editor.isSystemDefault ? (
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-ink-2">{t('settings.accounts.form.region')}</span>
                  <NativeSelect
                    size="sm"
                    data-testid="account-form-region"
                    value={editor.region}
                    onChange={(e) => setEditor({ ...editor, region: e.target.value as AccountRegion | '' })}
                  >
                    <NativeSelectOption value="">{t('settings.accounts.form.regionDefault')}</NativeSelectOption>
                    <NativeSelectOption value="cn">{t('settings.accounts.form.regionCn')}</NativeSelectOption>
                    <NativeSelectOption value="ai">{t('settings.accounts.form.regionAi')}</NativeSelectOption>
                    <NativeSelectOption value="internal">{t('settings.accounts.form.regionInternal')}</NativeSelectOption>
                  </NativeSelect>
                </label>
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
                <div className="flex items-start justify-between gap-3 rounded-control border border-line bg-inset/45 px-2.5 py-2">
                  <div className="min-w-0">
                    <div className="text-[12px] font-medium text-ink">
                      {t('settings.accounts.form.isolateSessions')}
                    </div>
                    <p className="mt-0.5 mb-0 text-[11px] leading-snug text-ink-3">
                      {t('settings.accounts.form.isolateSessionsHint')}
                    </p>
                  </div>
                  <Switch
                    checked={editor.isolateSessions}
                    onCheckedChange={(checked) => setEditor({ ...editor, isolateSessions: checked })}
                  />
                </div>
              ) : null}

              {editor.isNew ? (
                <div className="flex items-center justify-between gap-3">
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
                <div className="flex min-w-0 items-center justify-between gap-2 rounded-control border border-line bg-inset/60 px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-[11px] text-ink-3">{t('settings.accounts.loginModal.deviceCode')}</div>
                    <div className="font-mono text-[15px] font-semibold tracking-wider text-ink">
                      {loginProgress.deviceCode}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => copyText('code', loginProgress.deviceCode!)}
                  >
                    {copiedKey === 'code' ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
                    <span>{t('settings.accounts.loginModal.copyLink')}</span>
                  </Button>
                </div>
              ) : null}

              {loginProgress.authUrl ? (
                <div className="flex min-w-0 flex-col gap-2 rounded-control border border-line bg-inset/45 p-2.5">
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
                      variant="outline"
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
                <div className="flex min-w-0 flex-col gap-1.5 rounded-control border border-line bg-inset/45 p-2.5">
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
                      variant="outline"
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
                    payload: { backendId: loginProgress.backendId, includeQuota: true },
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
  onAdd,
  onEdit,
  onDelete,
}: {
  readonly backend: BackendView;
  readonly accounts: readonly AccountView[];
  readonly providers: readonly ProviderView[];
  readonly protocolGatewayEnabled: boolean;
  readonly channel: BackendView['activeChannel'];
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

  const isolationHint =
    accountCap?.isolation === 'config-dir'
      ? t('settings.accounts.isolation.configDir')
      : accountCap?.isolation === 'credential-slot'
        ? t('settings.accounts.isolation.credentialSlot')
        : accountCap?.isolation === 'api-key'
          ? t('settings.accounts.isolation.apiKey')
          : t('settings.accounts.isolation.single');

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
      className="gap-0 overflow-hidden border-line/75 bg-surface/80 py-0 shadow-xs dark:bg-surface/75"
      data-testid={`account-backend-card-${backend.id}`}
    >
      {/* 顶部：智能体信息 + 渠道模式切换（官方 ↔ 服务商） */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <BackendLogo backend={backend} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[13px] font-semibold text-ink">{backend.name}</span>
              <ValuePill className="text-[10.5px]">{isolationHint}</ValuePill>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <div
            className="inline-flex items-center rounded-control border border-line bg-surface p-0.5"
            role="group"
            aria-label={t('model.channel.label')}
          >
            <Button
              type="button"
              variant={activeMode === 'official' ? 'secondary' : 'ghost'}
              size="xs"
              data-testid={`channel-official-${backend.id}`}
              onClick={() => switchToOfficial()}
            >
              <UsersIcon className="size-3" />
              <span>{t('settings.accounts.channelOfficial')}</span>
            </Button>
            <Button
              type="button"
              variant={activeMode === 'provider' ? 'secondary' : 'ghost'}
              size="xs"
              disabled={!supportsProvider || compatibleProviders.length === 0}
              data-testid={`channel-provider-${backend.id}`}
              onClick={() => {
                const target = activeProviderId ?? compatibleProviders[0]?.id;
                if (target) switchToProvider(target);
              }}
            >
              <KeyIcon className="size-3" />
              <span>{t('settings.accounts.channelProvider')}</span>
            </Button>
          </div>

          {accountCap?.multiAccount ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              data-testid={`add-account-${backend.id}`}
              onClick={onAdd}
            >
              <PlusIcon className="size-3" />
              <span>{t('settings.accounts.add')}</span>
            </Button>
          ) : null}
        </div>
      </div>

      {/* 第三方服务商选择栏（当支持服务商时展示） */}
      {!supportsProvider ? (
        <div className="px-3.5 pb-2.5">
          <p className="m-0 text-[11.5px] text-ink-3">{t('settings.accounts.accountOnlyHint')}</p>
        </div>
      ) : activeMode === 'provider' ? (
        <div className="px-3.5 pb-2.5">
          <div className="flex flex-wrap items-center gap-2 rounded-control bg-inset/45 px-2.5 py-2">
            <KeyIcon className="size-3.5 shrink-0 text-accent-ink" />
            {compatibleProviders.length > 0 ? (
              <NativeSelect
                size="sm"
                className="min-w-44 flex-1"
                data-testid={`channel-provider-select-${backend.id}`}
                value={activeProviderId ?? ''}
                onChange={(e) => switchToProvider(e.target.value)}
              >
                <NativeSelectOption value="" disabled>
                  {t('settings.accounts.providerSelectPlaceholder')}
                </NativeSelectOption>
                {compatibleProviders.map((p) => (
                  <NativeSelectOption key={p.id} value={p.id}>
                    {p.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            ) : (
              <span className="flex-1 text-[12px] text-ink-3">{t('settings.accounts.noCompatibleProvider')}</span>
            )}
            <Button type="button" variant="outline" size="sm" onClick={() => setSettingsTab('providers')}>
              {t('settings.accounts.gotoProviders')}
            </Button>
          </div>
        </div>
      ) : null}

      {/* 官方账号列表 */}
      {accounts.length > 0 ? (
        <div className="divide-y divide-line/40 border-t border-line/40 bg-inset/20">
          {accounts.map((acc) => {
            const isCurrent = activeMode === 'official' && activeAccountId === acc.id;
            const canEdit = !acc.isSystemDefault || accountCap?.supportsRegion === true;
            const statusKey = `settings.accounts.status.${acc.status}` as const;
            const showUse = !isCurrent;
            const showLogin = accountCap?.loginKind !== 'api-key' || acc.isSystemDefault;
            const showLogout = acc.status === 'authenticated' || acc.status === 'expired';
            const showDelete = !acc.isSystemDefault;
            const hasPrimary = showUse || showLogin || canEdit;
            const hasSecondary = showLogout || showDelete;
            return (
              <div
                key={acc.id}
                data-testid={`account-row-${acc.id}`}
                className="flex items-center justify-between gap-2 px-3.5 py-2 transition-colors hover:bg-hover/35"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={cn('size-2 shrink-0 rounded-full', isCurrent ? 'bg-green' : 'bg-ink-4')}
                      data-testid={isCurrent ? `account-active-${acc.id}` : `account-dot-${acc.id}`}
                      aria-label={isCurrent ? t('settings.accounts.activeBadge') : undefined}
                      title={isCurrent ? t('settings.accounts.activeBadge') : undefined}
                    />
                    <span className={cn('text-[12.5px]', isCurrent ? 'font-semibold text-ink' : 'font-medium text-ink-2')}>
                      {acc.label}
                    </span>
                    {acc.isSystemDefault ? (
                      <ValuePill className="text-[10.5px]">{t('settings.accounts.systemBadge')}</ValuePill>
                    ) : null}
                    <ValuePill tone={statusTone(acc.status)} className="text-[10.5px]">
                      {acc.status === 'logging-in' ? <SpinnerIcon className="size-2.5" /> : null}
                      <span>{t(statusKey)}</span>
                    </ValuePill>
                    {acc.plan ? <ValuePill className="text-[10.5px]">{acc.plan}</ValuePill> : null}
                    {acc.isolateSessions ? (
                      <ValuePill className="text-[10.5px]">{t('settings.accounts.isolatedSessionBadge')}</ValuePill>
                    ) : null}
                  </div>

                  {acc.identity || (acc.quota && acc.quota.windows.length > 0) ? (
                    <div className="mt-1 flex flex-wrap items-center gap-2 pl-4 text-[11.5px] text-ink-3">
                      {acc.identity ? <span className="truncate font-mono">{acc.identity}</span> : null}
                      {acc.quota?.windows.slice(0, 3).map((win, idx) => (
                        <span
                          key={`${win.kind}:${win.label}:${idx}`}
                          className="rounded bg-inset px-1.5 py-0.5 text-[10.5px] text-ink-2"
                        >
                          {formatQuotaChip(win, t)}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>

                {hasPrimary || hasSecondary ? (
                  <div className="shrink-0">
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
                      <DropdownMenuContent align="end" className="min-w-40">
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
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </Card>
  );
}
