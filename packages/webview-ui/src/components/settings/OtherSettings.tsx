/**
 * 辅助设置模块：
 * - GeneralSettings（会话 -> 会话）：去线留白，无分割线开关列表
 * - AdvancedSettings（其他 -> 运行时与诊断）：按语义拆分为「默认行为 / 可执行路径双列网格 / 快捷操作」，消除 10 行堆叠横线
 */
import { useEffect, useState } from 'react';
import type { AdvancedPreferences, PreferencesState } from '@harness-deck/shared';
import { useT } from '../../i18n.ts';
import { setPreferencesLocal, useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import { LogIcon, PencilIcon, RefreshIcon } from '../icons.tsx';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { SettingsSection } from './SettingsSection.tsx';

const DEFAULT_ADVANCED: AdvancedPreferences = {
  dshPath: '',
  dshProfile: 'web',
  zcodePath: '',
  claudePath: '',
  piPath: '',
  codexPath: '',
  codebuddyPath: '',
  backendTrace: false,
};

export function GeneralSettings() {
  const t = useT();
  const session = useView((s) => s.session);
  const clientSurface = useView((s) => s.clientSurface);
  const preferences = useView((s) => s.preferences);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');

  const updatePref = (patch: Partial<PreferencesState>) => {
    setPreferencesLocal({ ...preferences, ...patch });
    postToHost({ type: 'setPreferences', payload: patch });
  };

  return (
    <>
      <SettingsSection
        title={t('settings.session.title')}
        testId="settings-preferences"
        actions={
          session.id ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="text-ink-2 hover:text-ink"
              data-testid="rename-session-btn"
              onClick={() => {
                if (clientSurface === 'mobile-web') {
                  setRenameDraft(session.title ?? '');
                  setRenameOpen(true);
                } else {
                  postToHost({ type: 'renameSession', payload: {} });
                }
              }}
            >
              <PencilIcon className="size-3" />
              <span>{t('header.rename')}</span>
            </Button>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-0.5 p-1.5">
          <div className="flex items-center justify-between gap-4 rounded-xl px-3 py-2.5 transition-colors hover:bg-canvas/65 dark:hover:bg-hover/35">
            <span className="min-w-0 flex-1 text-[12.5px] text-ink">{t('settings.includeActiveEditor')}</span>
            <Switch
              data-testid="pref-include-active"
              aria-label={t('settings.includeActiveEditor')}
              checked={preferences.includeActiveEditor}
              onCheckedChange={(checked) => updatePref({ includeActiveEditor: checked })}
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-xl px-3 py-2.5 transition-colors hover:bg-canvas/65 dark:hover:bg-hover/35">
            <span className="min-w-0 flex-1 text-[12.5px] text-ink">{t('settings.showTurnChanges')}</span>
            <Switch
              data-testid="pref-show-turn-changes"
              aria-label={t('settings.showTurnChanges')}
              checked={preferences.showTurnChanges}
              onCheckedChange={(checked) => updatePref({ showTurnChanges: checked })}
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-xl px-3 py-2.5 transition-colors hover:bg-canvas/65 dark:hover:bg-hover/35">
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] text-ink">{t('settings.fetchQuota')}</div>
              <div className="mt-0.5 text-[11.5px] text-ink-3">{t('settings.fetchQuotaHint')}</div>
            </div>
            <Switch
              data-testid="pref-fetch-quota"
              aria-label={t('settings.fetchQuota')}
              checked={preferences.fetchQuota !== false}
              onCheckedChange={(checked) => updatePref({ fetchQuota: checked })}
            />
          </div>
        </div>
      </SettingsSection>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent data-testid="mobile-rename-dialog">
          <DialogHeader>
            <DialogTitle>{t('mobile.confirm.renameTitle')}</DialogTitle>
            <DialogDescription className="sr-only">{t('mobile.confirm.renamePlaceholder')}</DialogDescription>
          </DialogHeader>
          <Input
            size="sm"
            data-testid="mobile-rename-input"
            value={renameDraft}
            placeholder={t('mobile.confirm.renamePlaceholder')}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && renameDraft.trim()) {
                postToHost({ type: 'renameSession', payload: { title: renameDraft.trim() } });
                setRenameOpen(false);
              }
            }}
          />
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setRenameOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="mobile-rename-confirm"
              disabled={!renameDraft.trim()}
              onClick={() => {
                if (!renameDraft.trim()) return;
                postToHost({ type: 'renameSession', payload: { title: renameDraft.trim() } });
                setRenameOpen(false);
              }}
            >
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function AdvancedSettings() {
  const t = useT();
  const hostKind = useView((s) => s.hostKind);
  const clientSurface = useView((s) => s.clientSurface);
  const isMobileRemote = clientSurface === 'mobile-web';
  const preferences = useView((s) => s.preferences);
  const advanced = preferences.advanced ?? DEFAULT_ADVANCED;
  const [dshPath, setDshPath] = useState(advanced.dshPath);
  const [dshProfile, setDshProfile] = useState(advanced.dshProfile);
  const [zcodePath, setZcodePath] = useState(advanced.zcodePath ?? '');
  const [claudePath, setClaudePath] = useState(advanced.claudePath ?? '');
  const [piPath, setPiPath] = useState(advanced.piPath ?? '');
  const [codexPath, setCodexPath] = useState(advanced.codexPath ?? '');
  const [codebuddyPath, setCodebuddyPath] = useState(advanced.codebuddyPath ?? '');

  useEffect(() => {
    setDshPath(advanced.dshPath);
    setDshProfile(advanced.dshProfile);
    setZcodePath(advanced.zcodePath ?? '');
    setClaudePath(advanced.claudePath ?? '');
    setPiPath(advanced.piPath ?? '');
    setCodexPath(advanced.codexPath ?? '');
    setCodebuddyPath(advanced.codebuddyPath ?? '');
  }, [advanced.dshPath, advanced.dshProfile, advanced.zcodePath, advanced.claudePath, advanced.piPath, advanced.codexPath, advanced.codebuddyPath]);

  const updateAdvanced = (patch: Partial<AdvancedPreferences>) => {
    const nextAdvanced: AdvancedPreferences = { ...advanced, ...patch };
    setPreferencesLocal({ ...preferences, advanced: nextAdvanced });
    postToHost({ type: 'setPreferences', payload: { advanced: patch } });
  };

  const updateSchedulePermission = (schedulePermission: NonNullable<PreferencesState['schedulePermission']>) => {
    setPreferencesLocal({ ...preferences, schedulePermission });
    postToHost({ type: 'setPreferences', payload: { schedulePermission } });
  };

  return (
    <div className="flex flex-col gap-8" data-testid="settings-advanced">
      {/* 1. 权限与诊断开关 */}
      <SettingsSection title={t('settings.advanced.title')}>
        <div className="flex flex-col gap-1 p-1.5">
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl px-3 py-2.5">
            <span className="text-[12.5px] font-medium text-ink">{t('settings.schedules.title')}</span>
            <div className="w-52">
              <Select
                value={preferences.schedulePermission ?? 'danger-full-access'}
                onValueChange={(value) =>
                  updateSchedulePermission(value as NonNullable<PreferencesState['schedulePermission']>)
                }
              >
                <SelectTrigger
                  size="sm"
                  className="w-full"
                  data-testid="pref-schedule-permission"
                  aria-label={t('settings.schedules.title')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="danger-full-access">{t('wb.schedules.permFull')}</SelectItem>
                  <SelectItem value="workspace-write">{t('wb.schedules.permWorkspace')}</SelectItem>
                  <SelectItem value="read-only">{t('wb.schedules.permRead')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-xl px-3 py-2.5 transition-colors hover:bg-canvas/65 dark:hover:bg-hover/35">
            <span className="min-w-0 flex-1 text-[12.5px] text-ink">{t('settings.advanced.backendTrace')}</span>
            <Switch
              data-testid="adv-backend-trace"
              aria-label={t('settings.advanced.backendTrace')}
              disabled={isMobileRemote}
              checked={advanced.backendTrace}
              onCheckedChange={(checked) => updateAdvanced({ backendTrace: checked })}
            />
          </div>
        </div>
      </SettingsSection>

      {/* 2. 可执行文件路径（双列紧凑网格，无需额外分组标题与分割线） */}
      <section className="grid grid-cols-1 gap-x-4 gap-y-4 rounded-2xl bg-field/55 p-4 sm:grid-cols-2 dark:bg-surface/65">
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-ink-2">{t('settings.advanced.dshPath')}</span>
          <Input
            size="sm"
            data-testid="adv-dsh-path"
            className="font-mono text-[12px]"
            disabled={isMobileRemote}
            value={dshPath}
            placeholder={t('settings.advanced.dshPathPlaceholder')}
            onChange={(e) => setDshPath(e.target.value)}
            onBlur={() => dshPath.trim() !== advanced.dshPath && updateAdvanced({ dshPath: dshPath.trim() })}
            onKeyDown={(e) => e.key === 'Enter' && updateAdvanced({ dshPath: dshPath.trim() })}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-ink-2">{t('settings.advanced.dshProfile')}</span>
          <Input
            size="sm"
            data-testid="adv-dsh-profile"
            className="font-mono text-[12px]"
            disabled={isMobileRemote}
            value={dshProfile}
            placeholder={t('settings.advanced.dshProfilePlaceholder')}
            onChange={(e) => setDshProfile(e.target.value)}
            onBlur={() => dshProfile.trim() !== advanced.dshProfile && updateAdvanced({ dshProfile: dshProfile.trim() || 'web' })}
            onKeyDown={(e) => e.key === 'Enter' && updateAdvanced({ dshProfile: dshProfile.trim() || 'web' })}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-ink-2">{t('settings.advanced.zcodePath')}</span>
          <Input
            size="sm"
            data-testid="adv-zcode-path"
            className="font-mono text-[12px]"
            disabled={isMobileRemote}
            value={zcodePath}
            placeholder={t('settings.advanced.zcodePathPlaceholder')}
            onChange={(e) => setZcodePath(e.target.value)}
            onBlur={() => zcodePath.trim() !== (advanced.zcodePath ?? '') && updateAdvanced({ zcodePath: zcodePath.trim() })}
            onKeyDown={(e) => e.key === 'Enter' && updateAdvanced({ zcodePath: zcodePath.trim() })}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-ink-2">{t('settings.advanced.claudePath')}</span>
          <Input
            size="sm"
            data-testid="adv-claude-path"
            className="font-mono text-[12px]"
            disabled={isMobileRemote}
            value={claudePath}
            placeholder={t('settings.advanced.claudePathPlaceholder')}
            onChange={(e) => setClaudePath(e.target.value)}
            onBlur={() => claudePath.trim() !== (advanced.claudePath ?? '') && updateAdvanced({ claudePath: claudePath.trim() })}
            onKeyDown={(e) => e.key === 'Enter' && updateAdvanced({ claudePath: claudePath.trim() })}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-ink-2">{t('settings.advanced.piPath')}</span>
          <Input
            size="sm"
            data-testid="adv-pi-path"
            className="font-mono text-[12px]"
            disabled={isMobileRemote}
            value={piPath}
            placeholder={t('settings.advanced.piPathPlaceholder')}
            onChange={(e) => setPiPath(e.target.value)}
            onBlur={() => piPath.trim() !== (advanced.piPath ?? '') && updateAdvanced({ piPath: piPath.trim() })}
            onKeyDown={(e) => e.key === 'Enter' && updateAdvanced({ piPath: piPath.trim() })}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-ink-2">{t('settings.advanced.codexPath')}</span>
          <Input
            size="sm"
            data-testid="adv-codex-path"
            className="font-mono text-[12px]"
            disabled={isMobileRemote}
            value={codexPath}
            placeholder={t('settings.advanced.codexPathPlaceholder')}
            onChange={(e) => setCodexPath(e.target.value)}
            onBlur={() => codexPath.trim() !== (advanced.codexPath ?? '') && updateAdvanced({ codexPath: codexPath.trim() })}
            onKeyDown={(e) => e.key === 'Enter' && updateAdvanced({ codexPath: codexPath.trim() })}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-ink-2">{t('settings.advanced.codebuddyPath')}</span>
          <Input
            size="sm"
            data-testid="adv-codebuddy-path"
            className="font-mono text-[12px]"
            disabled={isMobileRemote}
            value={codebuddyPath}
            placeholder={t('settings.advanced.codebuddyPathPlaceholder')}
            onChange={(e) => setCodebuddyPath(e.target.value)}
            onBlur={() => codebuddyPath.trim() !== (advanced.codebuddyPath ?? '') && updateAdvanced({ codebuddyPath: codebuddyPath.trim() })}
            onKeyDown={(e) => e.key === 'Enter' && updateAdvanced({ codebuddyPath: codebuddyPath.trim() })}
          />
        </label>
      </section>

      {/* 3. 快捷操作（直接落在画布上，无外框） */}
      {!isMobileRemote ? (
        <div className="flex flex-wrap items-center gap-2 px-1">
          <Button type="button" variant="secondary" size="sm" onClick={() => postToHost({ type: 'restartRuntime', payload: {} })}>
            <RefreshIcon className="size-3.5 text-ink-2" />
            <span>{t('header.restart')}</span>
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => postToHost({ type: 'showLogs', payload: {} })}>
            <LogIcon className="size-3.5 text-ink-2" />
            <span>{t('header.logs')}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto text-ink-2 hover:text-ink"
            data-testid="open-vscode-settings"
            onClick={() => postToHost({ type: 'openSettings', payload: {} })}
          >
            {t(hostKind === 'jetbrains' ? 'settings.openIde' : 'settings.openVscode')}
          </Button>
        </div>
      ) : (
        <p className="m-0 px-1 text-[11.5px] text-ink-3">{t('remote.mobileBlockedHint')}</p>
      )}
    </div>
  );
}
