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
import { LogIcon, PencilIcon, RefreshIcon, SlidersIcon } from '../icons.tsx';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';

const DEFAULT_ADVANCED: AdvancedPreferences = {
  dshPath: '',
  dshProfile: 'web',
  zcodePath: '',
  claudePath: '',
  piPath: '',
  backendTrace: false,
};

export function GeneralSettings() {
  const t = useT();
  const session = useView((s) => s.session);
  const preferences = useView((s) => s.preferences);

  const updatePref = (patch: Partial<PreferencesState>) => {
    setPreferencesLocal({ ...preferences, ...patch });
    postToHost({ type: 'setPreferences', payload: patch });
  };

  return (
    <section className="flex flex-col overflow-hidden rounded-card bg-surface shadow-card" data-testid="settings-preferences">
      <div className="primitive-card-bar flex items-start justify-between gap-2 border-b border-line bg-inset/50">
        <div className="flex min-w-0 items-start gap-2">
          <SlidersIcon className="mt-0.5 size-3.5 shrink-0 text-accent-ink" />
          <div className="min-w-0">
            <h3 className="m-0 text-[13px] font-semibold text-ink">{t('settings.session.title')}</h3>
            <p className="mt-0.5 mb-0 text-[11.5px] text-ink-3">{t('settings.session.desc')}</p>
          </div>
        </div>
        {session.id ? (
          <Button type="button" variant="outline" size="xs" onClick={() => postToHost({ type: 'renameSession', payload: {} })}>
            <PencilIcon className="size-3 text-ink-3" />
            <span>{t('header.rename')}</span>
          </Button>
        ) : null}
      </div>

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
    </section>
  );
}

export function AdvancedSettings() {
  const t = useT();
  const hostKind = useView((s) => s.hostKind);
  const preferences = useView((s) => s.preferences);
  const advanced = preferences.advanced ?? DEFAULT_ADVANCED;
  const [dshPath, setDshPath] = useState(advanced.dshPath);
  const [dshProfile, setDshProfile] = useState(advanced.dshProfile);
  const [zcodePath, setZcodePath] = useState(advanced.zcodePath ?? '');
  const [claudePath, setClaudePath] = useState(advanced.claudePath ?? '');
  const [piPath, setPiPath] = useState(advanced.piPath ?? '');

  useEffect(() => {
    setDshPath(advanced.dshPath);
    setDshProfile(advanced.dshProfile);
    setZcodePath(advanced.zcodePath ?? '');
    setClaudePath(advanced.claudePath ?? '');
    setPiPath(advanced.piPath ?? '');
  }, [advanced.dshPath, advanced.dshProfile, advanced.zcodePath, advanced.claudePath, advanced.piPath]);

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
    <section className="flex flex-col overflow-hidden rounded-card bg-surface shadow-card" data-testid="settings-advanced">
      <div className="primitive-card-bar border-b border-line bg-inset/50">
        <h3 className="m-0 text-[13px] font-semibold text-ink">{t('settings.advanced.title')}</h3>
      </div>
      <div className="primitive-card-pad flex flex-col gap-3">
        <div className="flex flex-col gap-1 [&_[data-slot=native-select-wrapper]]:mt-1 [&_[data-slot=native-select-wrapper]]:w-full">
          <span className="text-[12.5px] font-medium text-ink">{t('settings.schedules.title')}</span>
          <span className="text-[11.5px] text-ink-3">{t('settings.schedules.hint')}</span>
          <NativeSelect
            size="sm"
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
            size="sm"
            data-testid="adv-dsh-path"
            className="font-mono text-[12px]"
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
            size="sm"
            data-testid="adv-dsh-profile"
            className="font-mono text-[12px]"
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
            size="sm"
            data-testid="adv-zcode-path"
            className="font-mono text-[12px]"
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
            size="sm"
            data-testid="adv-claude-path"
            className="font-mono text-[12px]"
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
            size="sm"
            data-testid="adv-pi-path"
            className="font-mono text-[12px]"
            value={piPath}
            placeholder={t('settings.advanced.piPathPlaceholder')}
            onChange={(e) => setPiPath(e.target.value)}
            onBlur={() => piPath.trim() !== (advanced.piPath ?? '') && updateAdvanced({ piPath: piPath.trim() })}
            onKeyDown={(e) => e.key === 'Enter' && updateAdvanced({ piPath: piPath.trim() })}
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
            checked={advanced.backendTrace}
            onCheckedChange={(checked) => updateAdvanced({ backendTrace: checked })}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <Button type="button" variant="outline" size="sm" onClick={() => postToHost({ type: 'restartRuntime', payload: {} })}>
            <RefreshIcon className="size-3.5 text-ink-3" />
            <span>{t('header.restart')}</span>
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => postToHost({ type: 'showLogs', payload: {} })}>
            <LogIcon className="size-3.5 text-ink-3" />
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
      </div>
    </section>
  );
}
