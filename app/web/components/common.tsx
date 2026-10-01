import type { Schedule } from '../../shared/contracts/index.js';
import { scheduleText } from '../lib/format.js';
import { errorCode, koreanError } from '../lib/errors.js';
import styles from '../styles/common.module.css';
export const percent = (v: number | null) => (v === null ? '—' : `${Math.round(v * 10) / 10}%`);
// Korean text for the user; the code and the server's message stay available for debugging.
export function ErrorBox({ error }: { error: Error | null | undefined }) {
  return error ? (
    <div
      role="alert"
      className={styles.error}
      data-error-code={errorCode(error)}
      title={error.message}
    >
      {koreanError(error)}
    </div>
  ) : null;
}
export function Heading({
  eyebrow,
  title,
  children,
}: {
  eyebrow?: React.ReactNode;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <header className={styles.heading}>
      <div>
        {eyebrow && <div className={styles.eyebrow}>{eyebrow}</div>}
        <h1>{title}</h1>
      </div>
      {children && <div className={styles.headingActions}>{children}</div>}
    </header>
  );
}
export function Empty({ children }: { children: React.ReactNode }) {
  return <div className={styles.empty}>{children}</div>;
}
export const scheduleLabel = scheduleText;
const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'];
const FREQUENCIES: [Schedule['type'], string][] = [
  ['daily', '매일'],
  ['weekdays', '평일'],
  ['weekends', '주말'],
  ['weekly_quota', '주 N회'],
  ['selected_weekdays', '특정 요일'],
  ['monthly_quota', '월 N회'],
  ['every_n_days', 'N일마다'],
];
// Frequency as chips: one tap for the common cases, details only for the chosen type.
export function ScheduleEditor({
  value,
  onChange,
  today,
}: {
  value: Schedule;
  onChange: (s: Schedule) => void;
  today: string;
}) {
  return (
    <fieldset className={styles.schedule}>
      <legend>반복</legend>
      <div className={styles.chips}>
        {FREQUENCIES.map(([type, label]) => (
          <button
            type="button"
            key={type}
            aria-pressed={value.type === type}
            onClick={() =>
              value.type !== type &&
              onChange(
                type === 'selected_weekdays'
                  ? { type, weekdays: [1, 3, 5] }
                  : type === 'weekly_quota' || type === 'monthly_quota'
                    ? { type, count: 3 }
                    : type === 'every_n_days'
                      ? { type, interval_days: 2, anchor_date: today }
                      : { type },
              )
            }
          >
            {label}
          </button>
        ))}
      </div>
      {value.type === 'selected_weekdays' && (
        <div className={styles.weekdays} role="group" aria-label="요일">
          {WEEKDAYS.map((day, i) => {
            const on = value.weekdays.includes(i + 1);
            return (
              <button
                type="button"
                key={day}
                aria-pressed={on}
                aria-label={`${day}요일`}
                onClick={() =>
                  onChange({
                    ...value,
                    weekdays: (on
                      ? value.weekdays.filter((n) => n !== i + 1)
                      : [...value.weekdays, i + 1]
                    ).sort(),
                  })
                }
              >
                {day}
              </button>
            );
          })}
        </div>
      )}
      {'count' in value && (
        <label className={styles.inline}>
          {value.type === 'weekly_quota' ? '주당 횟수' : '월당 횟수'}
          <input
            type="number"
            min="1"
            max={value.type === 'weekly_quota' ? 7 : 31}
            value={value.count}
            onChange={(e) => onChange({ ...value, count: Number(e.target.value) })}
            required
          />
        </label>
      )}
      {value.type === 'every_n_days' && (
        <div className={styles.pair}>
          <label>
            간격 (일)
            <input
              type="number"
              min="1"
              value={value.interval_days}
              onChange={(e) => onChange({ ...value, interval_days: Number(e.target.value) })}
              required
            />
          </label>
          <label>
            기준 날짜
            <input
              type="date"
              value={value.anchor_date}
              onChange={(e) => onChange({ ...value, anchor_date: e.target.value })}
              required
            />
          </label>
        </div>
      )}
    </fieldset>
  );
}
