import type { Schedule } from '../../shared/contracts/index.js';

const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'];
export function scheduleText(s: Schedule): string {
  switch (s.type) {
    case 'daily':
      return '매일';
    case 'weekdays':
      return '평일';
    case 'weekends':
      return '주말';
    case 'selected_weekdays':
      return s.weekdays.map((n) => WEEKDAYS[n - 1]).join('·');
    case 'weekly_quota':
      return `주 ${s.count}회`;
    case 'monthly_quota':
      return `월 ${s.count}회`;
    case 'every_n_days':
      return `${s.interval_days}일마다`;
  }
}
// Streak units follow the server: occurrences, weeks or months, never mixed.
export const STREAK_UNIT = { occurrences: '회', weeks: '주', months: '개월' } as const;
export const streakText = (n: number, unit: keyof typeof STREAK_UNIT) => `${n}${STREAK_UNIT[unit]}`;
export const percentText = (v: number | null) => (v === null ? '—' : `${Math.round(v)}%`);
/** "9월 27일 일요일" for a YYYY-MM-DD calendar date. */
export const longDate = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('ko-KR', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    timeZone: 'UTC',
  });
/** "9월 27일" for a YYYY-MM-DD calendar date. */
export const shortDate = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('ko-KR', {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
/** HH:MM of an instant in the tracker timezone. */
export const clockTime = (instant: string, timeZone: string) =>
  new Date(instant).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  });
export const minutesText = (seconds: number) => `${Math.round((seconds / 60) * 10) / 10}분`;
export const amountText = (amount: string, unit: string | null) =>
  unit ? `${amount}${/^[가-힣]/.test(unit) ? '' : ' '}${unit}` : amount;
