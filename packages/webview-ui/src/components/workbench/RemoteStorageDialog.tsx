/**
 * 卡片式极简远端存储接入弹窗（Google Drive / Google Cloud Storage / WebDAV）：
 * - 第一步：带离线品牌图标的厂商卡片点选
 * - 第二步：Google Drive / GCS 支持一键跳转浏览器登录授权（本地 OAuth PKCE 回环或本机 gcloud 零配置授权），
 *   手动 JSON / Token 折叠为高级选项；WebDAV 为精简表单
 * - 严格遵守 shadcn-ui（Dialog / Button / Input / Textarea / Popover）+ 4 档 size 规范与离线图标规范
 */
import { useEffect, useRef, useState } from 'react';
import type { RemoteStorageKind, RemoteStorageView } from '@harness-deck/shared';
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
import { Textarea } from '@/components/ui/textarea';
import { useT } from '../../i18n.ts';
import { cn } from '../../lib/utils.ts';
import { useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  QuestionIcon,
  SpinnerIcon,
  TrashIcon,
} from '../icons.tsx';
import { StorageVendorLogo } from '../StorageVendorLogo.tsx';

export interface RemoteStorageDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly editing?: RemoteStorageView | null;
  readonly onConnected?: (storageId: string) => void;
  readonly onDeleted?: (id: string) => void;
}

const VENDOR_CARDS: readonly {
  readonly kind: RemoteStorageKind;
  readonly titleKey: 'storage.kind.gdrive' | 'storage.kind.gcs' | 'storage.kind.webdav';
  readonly descKey: 'storage.card.gdriveDesc' | 'storage.card.gcsDesc' | 'storage.card.webdavDesc';
}[] = [
  { kind: 'google-drive', titleKey: 'storage.kind.gdrive', descKey: 'storage.card.gdriveDesc' },
  { kind: 'google-cloud-storage', titleKey: 'storage.kind.gcs', descKey: 'storage.card.gcsDesc' },
  { kind: 'webdav', titleKey: 'storage.kind.webdav', descKey: 'storage.card.webdavDesc' },
];

export function RemoteStorageDialog({
  open,
  onOpenChange,
  editing,
  onConnected,
  onDeleted,
}: RemoteStorageDialogProps) {
  const t = useT();
  const isEdit = Boolean(editing);
  const remoteStorages = useView((s) => s.remoteStorages);
  const auth = remoteStorages.auth;

  const [selectedKind, setSelectedKind] = useState<RemoteStorageKind | null>(null);
  const [name, setName] = useState('');
  const [bucket, setBucket] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [oauthClientId, setOauthClientId] = useState('');
  const [oauthClientSecret, setOauthClientSecret] = useState('');
  const [showOAuthConfig, setShowOAuthConfig] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const authStartedHereRef = useRef(false);

  useEffect(() => {
    if (!open) {
      authStartedHereRef.current = false;
      return;
    }
    postToHost({ type: 'probeRemoteStorageAuth', payload: {} });
    if (editing) {
      setSelectedKind(editing.kind);
      setName(editing.name);
      setBucket(editing.bucket ?? '');
      setEndpoint(editing.endpoint ?? '');
      setRootPath(editing.rootPath ?? '');
      setUsername(editing.username ?? '');
      setSecret('');
      setShowManual(false);
      setShowOAuthConfig(false);
    } else {
      setSelectedKind(null);
      setName('');
      setBucket('');
      setEndpoint('');
      setRootPath('');
      setUsername('');
      setSecret('');
      setShowManual(false);
      setShowOAuthConfig(false);
    }
  }, [open, editing]);

  useEffect(() => {
    if (open && remoteStorages.googleClientId && !oauthClientId) {
      setOauthClientId(remoteStorages.googleClientId);
    }
  }, [open, remoteStorages.googleClientId, oauthClientId]);

  // 浏览器授权成功后自动关闭弹窗并切到新连接的远端存储
  useEffect(() => {
    if (!open || !authStartedHereRef.current) return;
    if (auth?.status === 'succeeded' && auth.storageId) {
      authStartedHereRef.current = false;
      onConnected?.(auth.storageId);
      onOpenChange(false);
    }
  }, [open, auth?.status, auth?.storageId, onConnected, onOpenChange]);

  const kind = selectedKind;
  const isGoogle = kind === 'google-drive' || kind === 'google-cloud-storage';
  const isAuthorizing = auth?.status === 'authorizing';
  const hasSavedClientId = Boolean(remoteStorages.googleOAuthConfigured || oauthClientId.trim());
  const canUseGcloud = Boolean(remoteStorages.gcloudAvailable || remoteStorages.gcloudAdcReady);

  const startGoogleAuth = (method: 'oauth' | 'gcloud'): void => {
    if (!kind || !isGoogle) return;
    authStartedHereRef.current = true;
    postToHost({
      type: 'startRemoteStorageOAuth',
      payload: {
        kind,
        method,
        ...(editing ? { storageId: editing.id } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(kind === 'google-cloud-storage' && bucket.trim() ? { bucket: bucket.trim() } : {}),
        ...(rootPath.trim() ? { rootPath: rootPath.trim() } : {}),
        ...(method === 'oauth' && oauthClientId.trim() ? { clientId: oauthClientId.trim() } : {}),
        ...(method === 'oauth' && oauthClientSecret.trim() ? { clientSecret: oauthClientSecret.trim() } : {}),
      },
    });
  };

  const handleManualSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!kind) return;
    const trimmedBucket = bucket.trim();
    const trimmedEndpoint = endpoint.trim();
    const trimmedSecret = secret.trim();
    const fallbackName =
      kind === 'google-drive'
        ? 'Google Drive'
        : kind === 'google-cloud-storage'
          ? trimmedBucket || 'Google Cloud Storage'
          : trimmedEndpoint || 'WebDAV';
    const finalName = name.trim() || fallbackName;

    if (kind === 'google-cloud-storage' && (!trimmedBucket || (!isEdit && !trimmedSecret))) return;
    if (kind === 'google-drive' && !isEdit && !trimmedSecret) return;
    if (kind === 'webdav' && !trimmedEndpoint) return;

    postToHost({
      type: 'upsertRemoteStorage',
      payload: {
        ...(editing ? { id: editing.id } : {}),
        name: finalName,
        kind,
        ...(kind === 'webdav' && trimmedEndpoint ? { endpoint: trimmedEndpoint } : {}),
        ...(kind === 'google-cloud-storage' && trimmedBucket ? { bucket: trimmedBucket } : {}),
        ...(rootPath.trim() ? { rootPath: rootPath.trim() } : {}),
        ...(kind === 'webdav' && username.trim() ? { username: username.trim() } : {}),
        ...(trimmedSecret ? { secret: trimmedSecret } : {}),
      },
    });
    onOpenChange(false);
  };

  const canSaveManual = (() => {
    if (!kind) return false;
    if (kind === 'google-cloud-storage') return Boolean(bucket.trim()) && (isEdit || Boolean(secret.trim()));
    if (kind === 'google-drive') return isEdit || Boolean(secret.trim());
    return Boolean(endpoint.trim());
  })();

  const handleDelete = (): void => {
    if (!editing) return;
    postToHost({ type: 'deleteRemoteStorage', payload: { id: editing.id } });
    onDeleted?.(editing.id);
    onOpenChange(false);
  };

  const handleTest = (): void => {
    if (!editing) return;
    postToHost({ type: 'testRemoteStorage', payload: { id: editing.id } });
  };

  const currentVendorTitle =
    kind === 'google-drive'
      ? t('storage.kind.gdrive')
      : kind === 'google-cloud-storage'
        ? t('storage.kind.gcs')
        : kind === 'webdav'
          ? t('storage.kind.webdav')
          : isEdit
            ? t('storage.dialog.editTitle')
            : t('storage.dialog.addTitle');

  const gcsBucketMissing = kind === 'google-cloud-storage' && !bucket.trim();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && isAuthorizing) {
          postToHost({ type: 'cancelRemoteStorageOAuth', payload: {} });
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-[420px]" data-testid="remote-storage-dialog">
        <div className="flex flex-col gap-5">
          <DialogHeader className="gap-1">
            <DialogTitle className="flex items-center gap-2 pr-6 text-[15px]">
              {kind && !isEdit ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  data-testid="remote-storage-back-btn"
                  aria-label={t('storage.dialog.back')}
                  onClick={() => {
                    if (isAuthorizing) postToHost({ type: 'cancelRemoteStorageOAuth', payload: {} });
                    setSelectedKind(null);
                    setShowManual(false);
                  }}
                  className="-ml-1 shrink-0 text-ink-3 hover:text-ink"
                >
                  <ArrowLeftIcon className="size-3.5" />
                </Button>
              ) : null}
              {kind ? <StorageVendorLogo kind={kind} size="md" className="size-5" /> : null}
              <span>{currentVendorTitle}</span>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    data-testid="remote-storage-guide-toggle"
                    aria-label={t('storage.dialog.guideTitle')}
                    title={t('storage.dialog.guideTitle')}
                    className="shrink-0 text-ink-3 hover:text-ink"
                  >
                    <QuestionIcon className="size-3.5" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  sideOffset={6}
                  className="w-80 p-3.5"
                  data-testid="remote-storage-guide-popover"
                >
                  <div className="flex flex-col gap-2.5 text-[12px] leading-relaxed text-ink-2">
                    <div className="text-[12.5px] leading-4 font-semibold text-ink">
                      {t('storage.dialog.guideTitle')}
                    </div>
                    <div>
                      <span className="font-medium text-ink">{t('storage.kind.gdrive')}：</span>
                      {t('storage.dialog.guideGdrive')}
                    </div>
                    <div>
                      <span className="font-medium text-ink">{t('storage.kind.gcs')}：</span>
                      {t('storage.dialog.guideGcs')}
                    </div>
                    <div>
                      <span className="font-medium text-ink">{t('storage.kind.webdav')}：</span>
                      {t('storage.dialog.guideWebdav')}
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </DialogTitle>
            <DialogDescription className="text-[12px] text-ink-3">
              {!kind ? t('storage.card.pickSubtitle') : t('storage.dialog.desc')}
            </DialogDescription>
          </DialogHeader>

          {/* 第一步：厂商图标卡片选择 */}
          {!kind ? (
            <div className="flex flex-col gap-2" data-testid="remote-storage-vendor-cards">
              {VENDOR_CARDS.map((card) => (
                <button
                  key={card.kind}
                  type="button"
                  data-testid={`remote-storage-card-${card.kind}`}
                  onClick={() => setSelectedKind(card.kind)}
                  className="group flex w-full items-center gap-3.5 rounded-xl border border-line/70 bg-canvas/55 px-3.5 py-3 text-left transition-colors hover:border-line-strong hover:bg-hover"
                >
                  <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface shadow-xs ring-1 ring-line/60">
                    <StorageVendorLogo kind={card.kind} size="md" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] leading-5 font-semibold text-ink">
                      {t(card.titleKey)}
                    </span>
                    <span className="mt-0.5 block truncate text-[12px] leading-4 text-ink-3">
                      {t(card.descKey)}
                    </span>
                  </span>
                  <ChevronRightIcon className="size-4 shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5 group-hover:text-ink-2" />
                </button>
              ))}
            </div>
          ) : isGoogle ? (
            /* 第二步（Google Drive / GCS）：一键跳转浏览器授权 + 折叠高级手动凭据 */
            <div className="flex flex-col gap-4">
              {kind === 'google-cloud-storage' ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="rs-bucket" className="text-[12px] text-ink-2">
                    {t('storage.dialog.bucketLabel')}
                  </Label>
                  <Input
                    id="rs-bucket"
                    size="sm"
                    data-testid="remote-storage-bucket-input"
                    value={bucket}
                    onChange={(e) => setBucket(e.target.value)}
                    placeholder="my-gcs-bucket"
                    autoFocus
                  />
                </div>
              ) : null}

              {/* 一键授权主卡片 */}
              <div className="flex flex-col gap-3 rounded-xl bg-canvas/70 p-3.5 dark:bg-page/50">
                {isAuthorizing ? (
                  <div className="flex flex-col items-center gap-3 py-2 text-center">
                    <SpinnerIcon className="size-5 text-accent-ink" />
                    <div className="text-[12.5px] text-ink-2">{t('storage.auth.waitingBrowser')}</div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid="remote-storage-auth-cancel"
                      onClick={() => postToHost({ type: 'cancelRemoteStorageOAuth', payload: {} })}
                    >
                      {t('common.cancel')}
                    </Button>
                  </div>
                ) : (
                  <>
                    {/* 若本机可用 gcloud，提供最省心的零配置浏览器登录 */}
                    {canUseGcloud ? (
                      <Button
                        type="button"
                        size="default"
                        disabled={gcsBucketMissing}
                        data-testid="remote-storage-gcloud-auth-btn"
                        onClick={() => startGoogleAuth('gcloud')}
                        className="w-full gap-2"
                      >
                        <StorageVendorLogo kind={kind} size="sm" />
                        <span>
                          {remoteStorages.gcloudAdcReady
                            ? t('storage.auth.useGcloudAdc')
                            : t('storage.auth.signInWithGcloud')}
                        </span>
                        <ExternalLinkIcon className="size-3.5 opacity-80" />
                      </Button>
                    ) : null}

                    {/* OAuth Client ID 浏览器直连授权 */}
                    {hasSavedClientId || !canUseGcloud ? (
                      <div className="flex flex-col gap-2.5">
                        {!remoteStorages.googleOAuthConfigured || showOAuthConfig ? (
                          <div className="flex flex-col gap-2">
                            <div className="flex flex-col gap-1">
                              <Label htmlFor="rs-oauth-client-id" className="text-[11.5px] text-ink-2">
                                {t('storage.auth.clientIdLabel')}
                              </Label>
                              <Input
                                id="rs-oauth-client-id"
                                size="sm"
                                data-testid="remote-storage-oauth-client-id"
                                value={oauthClientId}
                                onChange={(e) => setOauthClientId(e.target.value)}
                                placeholder="xxxx.apps.googleusercontent.com"
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <Label htmlFor="rs-oauth-client-secret" className="text-[11.5px] text-ink-2">
                                {t('storage.auth.clientSecretLabel')}
                              </Label>
                              <Input
                                id="rs-oauth-client-secret"
                                type="password"
                                size="sm"
                                value={oauthClientSecret}
                                onChange={(e) => setOauthClientSecret(e.target.value)}
                                placeholder={t('storage.dialog.optionalPlaceholder')}
                              />
                            </div>
                          </div>
                        ) : null}

                        <Button
                          type="button"
                          variant={canUseGcloud ? 'outline' : 'default'}
                          size="default"
                          disabled={gcsBucketMissing || !hasSavedClientId}
                          data-testid="remote-storage-oauth-btn"
                          onClick={() => startGoogleAuth('oauth')}
                          className="w-full gap-2"
                        >
                          <StorageVendorLogo kind={kind} size="sm" />
                          <span>{t('storage.auth.signInWithGoogle')}</span>
                          <ExternalLinkIcon className="size-3.5 opacity-80" />
                        </Button>

                        {remoteStorages.googleOAuthConfigured ? (
                          <button
                            type="button"
                            onClick={() => setShowOAuthConfig((v) => !v)}
                            className="self-center text-[11px] text-ink-3 transition-colors hover:text-ink-2"
                          >
                            {t('storage.auth.changeClientId')}
                          </button>
                        ) : null}
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setShowOAuthConfig((v) => !v)}
                        className="self-center text-[11.5px] text-ink-3 transition-colors hover:text-ink-2"
                      >
                        {t('storage.auth.useCustomOAuth')}
                      </button>
                    )}

                    {showOAuthConfig && canUseGcloud && !hasSavedClientId ? (
                      <div className="flex flex-col gap-2 border-t border-line/60 pt-2.5">
                        <Input
                          size="sm"
                          data-testid="remote-storage-oauth-client-id"
                          value={oauthClientId}
                          onChange={(e) => setOauthClientId(e.target.value)}
                          placeholder="xxxx.apps.googleusercontent.com"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={gcsBucketMissing || !oauthClientId.trim()}
                          data-testid="remote-storage-oauth-btn"
                          onClick={() => startGoogleAuth('oauth')}
                          className="w-full gap-1.5"
                        >
                          <span>{t('storage.auth.signInWithGoogle')}</span>
                          <ExternalLinkIcon className="size-3.5" />
                        </Button>
                      </div>
                    ) : null}

                    {auth?.status === 'error' && auth.error ? (
                      <div className="text-[11.5px] leading-4 text-err">{auth.error}</div>
                    ) : null}
                  </>
                )}
              </div>

              {/* 高级：手动凭据 / 自定义名称（默认收起） */}
              <div className="flex flex-col gap-3">
                <button
                  type="button"
                  data-testid="remote-storage-manual-toggle"
                  onClick={() => setShowManual((v) => !v)}
                  className="inline-flex items-center gap-1 self-start text-[12px] text-ink-3 transition-colors hover:text-ink"
                >
                  {showManual ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
                  <span>{t('storage.auth.manualToggle')}</span>
                </button>

                {showManual ? (
                  <form onSubmit={handleManualSubmit} className="flex flex-col gap-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="rs-name" className="text-[12px] text-ink-2">
                          {t('storage.dialog.nameLabel')}
                        </Label>
                        <Input
                          id="rs-name"
                          size="sm"
                          data-testid="remote-storage-name-input"
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          placeholder={t('storage.dialog.namePlaceholder')}
                        />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="rs-root" className="text-[12px] text-ink-2">
                          {kind === 'google-drive' ? t('storage.dialog.driveRootLabel') : t('storage.dialog.prefixLabel')}
                        </Label>
                        <Input
                          id="rs-root"
                          size="sm"
                          value={rootPath}
                          onChange={(e) => setRootPath(e.target.value)}
                          placeholder={kind === 'google-drive' ? 'root' : t('storage.dialog.prefixPlaceholder')}
                        />
                      </div>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="rs-secret" className="text-[12px] text-ink-2">
                        {t('storage.dialog.googleSecretLabel')}
                      </Label>
                      <Textarea
                        id="rs-secret"
                        rows={3}
                        data-testid="remote-storage-secret-input"
                        value={secret}
                        onChange={(e) => setSecret(e.target.value)}
                        placeholder={isEdit ? t('storage.dialog.keepSecret') : t('storage.dialog.googleSecretPlaceholder')}
                        className="font-mono text-[11.5px]"
                      />
                    </div>

                    <div className="flex justify-end gap-2">
                      <Button type="submit" size="sm" disabled={!canSaveManual} data-testid="remote-storage-submit-btn">
                        {t('storage.dialog.saveBtn')}
                      </Button>
                    </div>
                  </form>
                ) : null}
              </div>

              {isEdit ? (
                <DialogFooter className="flex items-center justify-between gap-2 border-t border-line/60 pt-3 sm:justify-between">
                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      data-testid="remote-storage-delete-btn"
                      onClick={handleDelete}
                      className="gap-1 text-err hover:bg-red-tint hover:text-err"
                    >
                      <TrashIcon className="size-3.5" />
                      <span>{t('common.delete')}</span>
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid="remote-storage-test-btn"
                      onClick={handleTest}
                    >
                      {t('storage.dialog.testBtn')}
                    </Button>
                  </div>
                  <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                    {t('common.close')}
                  </Button>
                </DialogFooter>
              ) : null}
            </div>
          ) : (
            /* 第二步（WebDAV）：精简 3 项表单 */
            <form onSubmit={handleManualSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="rs-endpoint" className="text-[12px] text-ink-2">
                  {t('storage.dialog.endpointLabel')}
                </Label>
                <Input
                  id="rs-endpoint"
                  size="sm"
                  data-testid="remote-storage-endpoint-input"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="https://dav.example.com/dav"
                  autoFocus
                />
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="rs-user" className="text-[12px] text-ink-2">
                    {t('storage.dialog.usernameLabel')}
                  </Label>
                  <Input
                    id="rs-user"
                    size="sm"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder={t('storage.dialog.optionalPlaceholder')}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="rs-secret" className="text-[12px] text-ink-2">
                    {t('storage.dialog.passwordLabel')}
                  </Label>
                  <Input
                    id="rs-secret"
                    type="password"
                    size="sm"
                    data-testid="remote-storage-secret-input"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    placeholder={isEdit ? t('storage.dialog.keepSecret') : t('storage.dialog.passwordPlaceholder')}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="rs-name" className="text-[12px] text-ink-2">
                    {t('storage.dialog.nameLabel')}
                  </Label>
                  <Input
                    id="rs-name"
                    size="sm"
                    data-testid="remote-storage-name-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="WebDAV"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="rs-root" className="text-[12px] text-ink-2">
                    {t('storage.dialog.rootPathLabel')}
                  </Label>
                  <Input
                    id="rs-root"
                    size="sm"
                    value={rootPath}
                    onChange={(e) => setRootPath(e.target.value)}
                    placeholder={t('storage.dialog.prefixPlaceholder')}
                  />
                </div>
              </div>

              <DialogFooter className={cn('flex items-center gap-2', isEdit ? 'justify-between sm:justify-between' : 'justify-end')}>
                {isEdit ? (
                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      data-testid="remote-storage-delete-btn"
                      onClick={handleDelete}
                      className="gap-1 text-err hover:bg-red-tint hover:text-err"
                    >
                      <TrashIcon className="size-3.5" />
                      <span>{t('common.delete')}</span>
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid="remote-storage-test-btn"
                      onClick={handleTest}
                    >
                      {t('storage.dialog.testBtn')}
                    </Button>
                  </div>
                ) : null}
                <div className="flex items-center gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                    {t('common.cancel')}
                  </Button>
                  <Button type="submit" size="sm" disabled={!canSaveManual} data-testid="remote-storage-submit-btn">
                    {t('storage.dialog.saveBtn')}
                  </Button>
                </div>
              </DialogFooter>
            </form>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
