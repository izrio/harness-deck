import type { Translate } from '../i18n.ts';

/** 将毫秒时间戳格式化为简短的相对时间文案。 */
export function relativeTime(time: number, t: Translate): string {
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60_000));
  if (minutes < 1) return t('time.now');
  if (minutes < 60) return t('time.minutes', minutes);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('time.hours', hours);
  const days = Math.round(hours / 24);
  return days < 30 ? t('time.days', days) : new Date(time).toLocaleDateString();
}
