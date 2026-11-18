/**
 * 设置 -> 界面 -> 通知：系统通知开关、后台窗口过滤、触发时机配置与测试通知。
 */
import type { NotificationPreferences } from '@harness-deck/shared';
import { useT } from '../../i18n.ts';
import { setPreferencesLocal, useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import { Button } from '../ui/Button.tsx';
import { BellIcon } from '../icons.tsx';

const DEFAULT_NOTIFICATIONS: NotificationPreferences = {
  enabled: true,
  onlyWhenUnfocused: true,
  onAttention: true,
  onTurnComplete: true,
  onUnexpectedExit: true,
  onScheduledComplete: true,
};

export function NotificationSettings() {
  const t = useT();
  const preferences = useView((s) => s.preferences);
  const notifications = preferences.notifications ?? DEFAULT_NOTIFICATIONS;

  const update = (patch: Partial<NotificationPreferences>) => {
    const nextNotifications: NotificationPreferences = { ...notifications, ...patch };
    setPreferencesLocal({ ...preferences, notifications: nextNotifications });
    postToHost({ type: 'setPreferences', payload: { notifications: patch } });
  };

  return (
    <div className="flex flex-col gap-3" data-testid="settings-notifications">
      <section className="settings-section flex flex-col overflow-hidden rounded-card bg-surface shadow-card">
        <div className="primitive-card-bar flex items-start justify-between gap-2 border-b border-line bg-inset/50">
          <div className="min-w-0">
            <h3 className="m-0 text-[13px] font-semibold text-ink">{t('settings.notifications.title')}</h3>
            <p className="mt-0.5 mb-0 text-[11.5px] text-ink-3">{t('settings.notifications.desc')}</p>
          </div>
          <Button
            variant="secondary"
            size="xs"
            data-testid="notif-test-btn"
            onClick={() => postToHost({ type: 'testNotification', payload: {} })}
          >
            <BellIcon className="size-3" />
            <span>{t('settings.notifications.test')}</span>
          </Button>
        </div>

        <div className="primitive-card-pad flex flex-col gap-3">
          <SwitchRow
            testId="notif-enabled"
            label={t('settings.notifications.enabled')}
            hint={t('settings.notifications.enabledHint')}
            checked={notifications.enabled}
            onChange={(enabled) => update({ enabled })}
          />

          <SwitchRow
            testId="notif-only-unfocused"
            label={t('settings.notifications.onlyUnfocused')}
            hint={t('settings.notifications.onlyUnfocusedHint')}
            checked={notifications.onlyWhenUnfocused}
            disabled={!notifications.enabled}
            onChange={(onlyWhenUnfocused) => update({ onlyWhenUnfocused })}
          />

          <div className="border-t border-line pt-3">
            <div className="mb-2 text-[11.5px] font-medium text-ink-3">{t('settings.notifications.triggers')}</div>
            <div className="flex flex-col gap-3">
              <SwitchRow
                testId="notif-attention"
                label={t('settings.notifications.onAttention')}
                hint={t('settings.notifications.onAttentionHint')}
                checked={notifications.onAttention}
                disabled={!notifications.enabled}
                onChange={(onAttention) => update({ onAttention })}
              />
              <SwitchRow
                testId="notif-turn-complete"
                label={t('settings.notifications.onTurnComplete')}
                hint={t('settings.notifications.onTurnCompleteHint')}
                checked={notifications.onTurnComplete}
                disabled={!notifications.enabled}
                onChange={(onTurnComplete) => update({ onTurnComplete })}
              />
              <SwitchRow
                testId="notif-unexpected-exit"
                label={t('settings.notifications.onUnexpectedExit')}
                hint={t('settings.notifications.onUnexpectedExitHint')}
                checked={notifications.onUnexpectedExit}
                disabled={!notifications.enabled}
                onChange={(onUnexpectedExit) => update({ onUnexpectedExit })}
              />
              <SwitchRow
                testId="notif-scheduled-complete"
                label={t('settings.notifications.onScheduledComplete')}
                hint={t('settings.notifications.onScheduledCompleteHint')}
                checked={notifications.onScheduledComplete}
                disabled={!notifications.enabled}
                onChange={(onScheduledComplete) => update({ onScheduledComplete })}
              />
            </div>
          </div>

          <div className="rounded-[8px] bg-field px-2.5 py-2 text-[11.5px] text-ink-3 shadow-hairline">
            {t('settings.notifications.testHint')}
          </div>
        </div>
      </section>
    </div>
  );
}

function SwitchRow({
  testId,
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  readonly testId: string;
  readonly label: string;
  readonly hint: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 aria-disabled:cursor-default aria-disabled:opacity-50" aria-disabled={disabled}>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-[12.5px]">
        <span className="text-ink">{label}</span>
        <span className="text-[11.5px] text-ink-3">{hint}</span>
      </span>
      <input
        type="checkbox"
        role="switch"
        className="bui-switch"
        data-testid={testId}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}
