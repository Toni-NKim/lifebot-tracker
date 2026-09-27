import type { Schedule } from '../../shared/contracts/index.js';
import styles from '../styles/app.module.css';
export const percent = (v: number | null) => (v === null ? '—' : `${Math.round(v * 10) / 10}%`);
export function ErrorBox({ error }: { error: Error | null | undefined }) {
  return error ? (
    <div role="alert" className={styles.error}>
      {error.message}
    </div>
  ) : null;
}
export function Heading({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <header className={styles.heading}>
      <div>
        <div className={styles.eyebrow}>{eyebrow}</div>
        <h1>{title}</h1>
      </div>
      {children}
    </header>
  );
}
export function Empty({ children }: { children: React.ReactNode }) {
  return <div className={styles.empty}>{children}</div>;
}
export function scheduleLabel(s: Schedule): string {
  switch (s.type) {
    case 'daily':
      return 'Every day';
    case 'weekdays':
      return 'Weekdays';
    case 'weekends':
      return 'Weekends';
    case 'selected_weekdays':
      return s.weekdays
        .map((n) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][n - 1])
        .join(' · ');
    case 'weekly_quota':
      return `${s.count} times / week`;
    case 'monthly_quota':
      return `${s.count} times / month`;
    case 'every_n_days':
      return `Every ${s.interval_days} days`;
  }
}
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
    <fieldset>
      <legend>Repeat schedule</legend>
      <label>
        Frequency
        <select
          value={value.type}
          onChange={(e) => {
            const type = e.target.value as Schedule['type'];
            onChange(
              type === 'selected_weekdays'
                ? { type, weekdays: [1, 3, 5] }
                : type === 'weekly_quota' || type === 'monthly_quota'
                  ? { type, count: 3 }
                  : type === 'every_n_days'
                    ? { type, interval_days: 2, anchor_date: today }
                    : { type },
            );
          }}
        >
          {[
            ['daily', 'Every day'],
            ['selected_weekdays', 'Selected weekdays'],
            ['weekdays', 'Weekdays'],
            ['weekends', 'Weekends'],
            ['weekly_quota', 'N times per week'],
            ['monthly_quota', 'N times per month'],
            ['every_n_days', 'Every N days'],
          ].map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>
      {value.type === 'selected_weekdays' && (
        <div className={styles.weekdays}>
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, i) => (
            <label key={day}>
              <input
                type="checkbox"
                checked={value.weekdays.includes(i + 1)}
                onChange={(e) =>
                  onChange({
                    ...value,
                    weekdays: (e.target.checked
                      ? [...value.weekdays, i + 1]
                      : value.weekdays.filter((n) => n !== i + 1)
                    ).sort(),
                  })
                }
              />
              {day}
            </label>
          ))}
        </div>
      )}
      {'count' in value && (
        <label>
          Times per {value.type === 'weekly_quota' ? 'week' : 'month'}
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
        <div className={styles.formRow}>
          <label>
            Interval in days
            <input
              type="number"
              min="1"
              value={value.interval_days}
              onChange={(e) => onChange({ ...value, interval_days: Number(e.target.value) })}
              required
            />
          </label>
          <label>
            Anchor date
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
