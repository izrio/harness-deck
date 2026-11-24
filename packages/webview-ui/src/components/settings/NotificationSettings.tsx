/**
 * 设置 -> 界面 -> 通知：系统通知开关、后台窗口过滤、触发时机配置与测试通知。
 */
import type { NotificationPreferences } from '@harness-deck/shared';
import { useT } from '../../i18n.ts';
import { setPreferencesLocal, useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { BellIcon } from '../icons.tsx';
import { SettingsSection } from './SettingsSection.tsx';

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
    <div className="flex flex-col gap-5" data-testid="settings-notifications">
      <SettingsSection
        title={t('settings.notifications.title')}
        actions={
          <Button
            type="button"
            variant="outline"
            size="xs"
            data-testid="notif-test-btn"
            onClick={() => postToHost({ type: 'testNotification', payload: {} })}
          >
            <BellIcon className="size-3" />
            <span>{t('settings.notifications.test')}</span>
          </Button>
        }
      >
        <div className="divide-y divide-line/60">
          <SwitchRow
            testId="notif-enabled"
            label={t('settings.notifications.enabled')}
            checked={notifications.enabled}
            onChange={(enabled) => update({ enabled })}
          />

          <SwitchRow
            testId="notif-only-unfocused"
            label={t('settings.notifications.onlyUnfocused')}
            checked={notifications.onlyWhenUnfocused}
            disabled={!notifications.enabled}
            onChange={(onlyWhenUnfocused) => update({ onlyWhenUnfocused })}
          />
        </div>

        <div className="border-y border-line/60 bg-field/40 px-4 py-2 text-[11px] font-medium text-ink-3">
          {t('settings.notifications.triggers')}
        </div>

        <div className="divide-y divide-line/60">
          <SwitchRow
            testId="notif-attention"
            label={t('settings.notifications.onAttention')}
            checked={notifications.onAttention}
            disabled={!notifications.enabled}
            onChange={(onAttention) => update({ onAttention })}
          />
          <SwitchRow
            testId="notif-turn-complete"
            label={t('settings.notifications.onTurnComplete')}
            checked={notifications.onTurnComplete}
            disabled={!notifications.enabled}
            onChange={(onTurnComplete) => update({ onTurnComplete })}
          />
          <SwitchRow
            testId="notif-unexpected-exit"
            label={t('settings.notifications.onUnexpectedExit')}
            checked={notifications.onUnexpectedExit}
            disabled={!notifications.enabled}
            onChange={(onUnexpectedExit) => update({ onUnexpectedExit })}
          />
          <SwitchRow
            testId="notif-scheduled-complete"
            label={t('settings.notifications.onScheduledComplete')}
            checked={notifications.onScheduledComplete}
            disabled={!notifications.enabled}
            onChange={(onScheduledComplete) => update({ onScheduledComplete })}
          />
        </div>
      </SettingsSection>
    </div>
  );
}

function SwitchRow({
  testId,
  label,
  checked,
  disabled,
  onChange,
}: {
  readonly testId: string;
  readonly label: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <div
      className="flex items-center justify-between gap-4 px-4 py-3 aria-disabled:opacity-50"
      aria-disabled={disabled}
    >
      <span className="min-w-0 flex-1 text-[12.5px] text-ink">{label}</span>
      <Switch
        data-testid={testId}
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </div>
  );
}
