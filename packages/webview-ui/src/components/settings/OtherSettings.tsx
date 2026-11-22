/**
 * 辅助设置模块：
 * - GeneralSettings（归入「会话 -> 会话」）：编辑器上下文与每轮改动卡片显示开关、会话快捷操作
 * - AdvancedSettings（归入「其他 -> 运行时与诊断」）：定时任务默认权限、运行时路径、Profile、ACP 排查日志与 VS Code 原生设置入口
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
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
              variant="outline"
              size="sm"
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
              <PencilIcon className="size-3 text-ink-3" />
              <span>{t('header.rename')}</span>
            </Button>
          ) : undefined
        }
      >
      <div className="primitive-card-pad flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-[12.5px]">
            <span className="text-ink">{t('settings.includeActiveEditor')}</span>
            <span className="text-[11.5px] text-ink-3">{t('settings.includeActiveEditorHint')}</span>
          </span>
          <Switch
            data-testid="pref-include-active"
            aria-label={t('settings.includeActiveEditor')}
            checked={preferences.includeActiveEditor}
            onCheckedChange={(checked) => updatePref({ includeActiveEditor: checked })}
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-[12.5px]">
            <span className="text-ink">{t('settings.showTurnChanges')}</span>
            <span className="text-[11.5px] text-ink-3">{t('settings.showTurnChangesHint')}</span>
          </span>
          <Switch
            data-testid="pref-show-turn-changes"
            aria-label={t('settings.showTurnChanges')}
            checked={preferences.showTurnChanges}
            onCheckedChange={(checked) => updatePref({ showTurnChanges: checked })}
          />
        </div>
        </div>
      </SettingsSection>
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent data-testid="mobile-rename-dialog">
          <DialogHeader>
            <DialogTitle>{t('mobile.confirm.renameTitle')}</DialogTitle>
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
    <SettingsSection title={t('settings.advanced.title')} testId="settings-advanced">
      <div className="primitive-card-pad flex flex-col gap-3">
        <div className="flex flex-col gap-1 [&_[data-slot=native-select-wrapper]]:mt-1 [&_[data-slot=native-select-wrapper]]:w-full">
          <span className="text-[12.5px] font-medium text-ink">{t('settings.schedules.title')}</span>
          <span className="text-[11.5px] text-ink-3">{t('settings.schedules.hint')}</span>
          <NativeSelect
            size="default"
            data-testid="pref-schedule-permission"
            aria-label={t('settings.schedules.title')}
            value={preferences.schedulePermission ?? 'danger-full-access'}
            onChange={(e) =>
              updateSchedulePermission(e.target.value as NonNullable<PreferencesState['schedulePermission']>)
            }
          >
            <NativeSelectOption value="danger-full-access">{t('wb.schedules.permFull')}</NativeSelectOption>
            <NativeSelectOption value="workspace-write">{t('wb.schedules.permWorkspace')}</NativeSelectOption>
            <NativeSelectOption value="read-only">{t('wb.schedules.permRead')}</NativeSelectOption>
          </NativeSelect>
        </div>

        <label className="flex flex-col gap-1 border-t border-line pt-3">
          <span className="text-[12.5px] text-ink-2">{t('settings.advanced.dshPath')}</span>
          <Input
            size="default"
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

        <label className="flex flex-col gap-1">
          <span className="text-[12.5px] text-ink-2">{t('settings.advanced.dshProfile')}</span>
          <Input
            size="default"
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

        <label className="flex flex-col gap-1 border-t border-line pt-3">
          <span className="text-[12.5px] text-ink-2">{t('settings.advanced.zcodePath')}</span>
          <Input
            size="default"
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

        <label className="flex flex-col gap-1">
          <span className="text-[12.5px] text-ink-2">{t('settings.advanced.claudePath')}</span>
          <Input
            size="default"
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

        <label className="flex flex-col gap-1">
          <span className="text-[12.5px] text-ink-2">{t('settings.advanced.piPath')}</span>
          <Input
            size="default"
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

        <label className="flex flex-col gap-1">
          <span className="text-[12.5px] text-ink-2">{t('settings.advanced.codexPath')}</span>
          <Input
            size="default"
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

        <label className="flex flex-col gap-1">
          <span className="text-[12.5px] text-ink-2">{t('settings.advanced.codebuddyPath')}</span>
          <Input
            size="default"
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

        <div className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-[12.5px]">
            <span className="text-ink">{t('settings.advanced.backendTrace')}</span>
            <span className="text-[11.5px] text-ink-3">{t('settings.advanced.backendTraceHint')}</span>
          </span>
          <Switch
            data-testid="adv-backend-trace"
            aria-label={t('settings.advanced.backendTrace')}
            disabled={isMobileRemote}
            checked={advanced.backendTrace}
            onCheckedChange={(checked) => updateAdvanced({ backendTrace: checked })}
          />
        </div>

        {!isMobileRemote ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <Button type="button" variant="outline" size="default" onClick={() => postToHost({ type: 'restartRuntime', payload: {} })}>
              <RefreshIcon className="size-3.5 text-ink-3" />
              <span>{t('header.restart')}</span>
            </Button>
            <Button type="button" variant="outline" size="default" onClick={() => postToHost({ type: 'showLogs', payload: {} })}>
              <LogIcon className="size-3.5 text-ink-3" />
              <span>{t('header.logs')}</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="default"
              className="ml-auto text-ink-2 hover:text-ink"
              data-testid="open-vscode-settings"
              onClick={() => postToHost({ type: 'openSettings', payload: {} })}
            >
              {t(hostKind === 'jetbrains' ? 'settings.openIde' : 'settings.openVscode')}
            </Button>
          </div>
        ) : (
          <p className="m-0 border-t border-line pt-2 text-[11.5px] text-ink-3">{t('remote.mobileBlockedHint')}</p>
        )}
      </div>
    </SettingsSection>
  );
}
