/**
 * 辅助设置模块：
 * - GeneralSettings（归入「界面」Tab）：编辑器上下文与每轮改动卡片显示开关、会话快捷操作
 * - AdvancedSettings（归入「Agent」Tab）：运行时路径、Profile、ACP 排查日志与 VS Code 原生设置入口
 */
import { useEffect, useState } from 'react';
import type { AdvancedPreferences, PreferencesState } from '@harness-deck/shared';
import { useT } from '../../i18n.ts';
import { setPreferencesLocal, useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import { LogIcon, PencilIcon, RefreshIcon, SlidersIcon } from '../icons.tsx';
import { Button } from '../ui/Button.tsx';
import { Input, Select } from '../ui/FormControls.tsx';

const DEFAULT_ADVANCED: AdvancedPreferences = {
  dshPath: '',
  dshProfile: 'web',
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
      <div className="primitive-card-bar flex items-center justify-between gap-2 border-b border-line bg-inset/50">
        <div className="flex items-center gap-2">
          <SlidersIcon className="size-3.5 shrink-0 text-accent-ink" />
          <h3 className="m-0 text-[13px] font-semibold text-ink">{t('settings.nav.general')}</h3>
        </div>
        {session.id ? (
          <Button variant="secondary" size="xs" onClick={() => postToHost({ type: 'renameSession', payload: {} })}>
            <PencilIcon className="size-3 text-ink-3" />
            <span>{t('header.rename')}</span>
          </Button>
        ) : null}
      </div>

      <div className="primitive-card-pad flex flex-col gap-3">
        <label className="flex cursor-pointer items-center justify-between gap-3">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-[12.5px]">
            <span className="text-ink">{t('settings.includeActiveEditor')}</span>
            <span className="text-[11.5px] text-ink-3">{t('settings.includeActiveEditorHint')}</span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="bui-switch"
            data-testid="pref-include-active"
            checked={preferences.includeActiveEditor}
            onChange={(e) => updatePref({ includeActiveEditor: e.target.checked })}
          />
        </label>

        <label className="flex cursor-pointer items-center justify-between gap-3">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-[12.5px]">
            <span className="text-ink">{t('settings.showTurnChanges')}</span>
            <span className="text-[11.5px] text-ink-3">{t('settings.showTurnChangesHint')}</span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="bui-switch"
            data-testid="pref-show-turn-changes"
            checked={preferences.showTurnChanges}
            onChange={(e) => updatePref({ showTurnChanges: e.target.checked })}
          />
        </label>
      </div>
    </section>
  );
}

export function AdvancedSettings() {
  const t = useT();
  const preferences = useView((s) => s.preferences);
  const advanced = preferences.advanced ?? DEFAULT_ADVANCED;
  const [dshPath, setDshPath] = useState(advanced.dshPath);
  const [dshProfile, setDshProfile] = useState(advanced.dshProfile);

  useEffect(() => {
    setDshPath(advanced.dshPath);
    setDshProfile(advanced.dshProfile);
  }, [advanced.dshPath, advanced.dshProfile]);

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
        <label className="flex flex-col gap-1">
          <span className="text-[12.5px] font-medium text-ink">{t('settings.schedules.title')}</span>
          <span className="text-[11.5px] text-ink-3">{t('settings.schedules.hint')}</span>
          <Select
            data-testid="pref-schedule-permission"
            wrapperClassName="mt-1 w-full"
            value={preferences.schedulePermission ?? 'danger-full-access'}
            onChange={(e) =>
              updateSchedulePermission(e.target.value as NonNullable<PreferencesState['schedulePermission']>)
            }
          >
            <option value="danger-full-access">{t('wb.schedules.permFull')}</option>
            <option value="workspace-write">{t('wb.schedules.permWorkspace')}</option>
            <option value="read-only">{t('wb.schedules.permRead')}</option>
          </Select>
        </label>

        <label className="flex flex-col gap-1 border-t border-line pt-3">
          <span className="text-[12.5px] text-ink-2">{t('settings.advanced.dshPath')}</span>
          <Input
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
            data-testid="adv-dsh-profile"
            className="font-mono text-[12px]"
            value={dshProfile}
            placeholder={t('settings.advanced.dshProfilePlaceholder')}
            onChange={(e) => setDshProfile(e.target.value)}
            onBlur={() => dshProfile.trim() !== advanced.dshProfile && updateAdvanced({ dshProfile: dshProfile.trim() || 'web' })}
            onKeyDown={(e) => e.key === 'Enter' && updateAdvanced({ dshProfile: dshProfile.trim() || 'web' })}
          />
        </label>

        <label className="flex cursor-pointer items-center justify-between gap-3">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-[12.5px]">
            <span className="text-ink">{t('settings.advanced.backendTrace')}</span>
            <span className="text-[11.5px] text-ink-3">{t('settings.advanced.backendTraceHint')}</span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="bui-switch"
            data-testid="adv-backend-trace"
            checked={advanced.backendTrace}
            onChange={(e) => updateAdvanced({ backendTrace: e.target.checked })}
          />
        </label>

        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <Button variant="secondary" size="sm" onClick={() => postToHost({ type: 'restartRuntime', payload: {} })}>
            <RefreshIcon className="size-3.5 text-ink-3" />
            <span>{t('header.restart')}</span>
          </Button>
          <Button variant="secondary" size="sm" onClick={() => postToHost({ type: 'showLogs', payload: {} })}>
            <LogIcon className="size-3.5 text-ink-3" />
            <span>{t('header.logs')}</span>
          </Button>
          <Button
            variant="quiet"
            size="sm"
            className="ml-auto text-ink-2 hover:text-ink"
            data-testid="open-vscode-settings"
            onClick={() => postToHost({ type: 'openSettings', payload: {} })}
          >
            {t('settings.openVscode')}
          </Button>
        </div>
      </div>
    </section>
  );
}
