import type { Schedule } from '../../shared/contracts/index.js';
import styles from '../styles/app.module.css';
export const percent = (v: number | null) => (v === null ? '—' : `${Math.round(v * 10) / 10}%`);
const ICONS = {
  today: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  stats: 'M6 20V11M12 20V5M18 20v-6',
  history: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4l3 2',
  habits: 'M5 12.5l4.5 4.5L19 7.5',
  routines: 'M9 6h11M9 12h11M9 18h11M4 6h1M4 12h1M4 18h1',
  settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  manage: 'M9 6h11M9 12h11M9 18h11M4 6h1M4 12h1M4 18h1',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  close: 'M6 6l12 12M18 6L6 18',
  chevronDown: 'M6 9l6 6 6-6',
  chevronUp: 'M6 15l6-6 6 6',
  chevronLeft: 'M15 6l-6 6 6 6',
  chevronRight: 'M9 6l6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M6 12h12',
  note: 'M5 4h10l4 4v12H5zM9 12h6M9 16h4',
  lock: 'M5 11h14v9H5zM8 11V8a4 4 0 0 1 8 0v3',
  edit: 'M4 20h4L19 9l-4-4L4 16z',
  pause: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM8 12h8',
  trash: 'M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12',
  info: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4M12 16h.01',
} as const;
export type IconName = keyof typeof ICONS;
export function Icon({
  name,
  size = 20,
  strokeWidth = 1.8,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
}) {
  return (
    <svg
      className={styles.icon}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}
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
  mobileTitle,
  children,
}: {
  eyebrow?: React.ReactNode;
  title: string;
  mobileTitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <header className={styles.heading}>
      <div className={styles.headingText}>
        {eyebrow && <div className={styles.eyebrow}>{eyebrow}</div>}
        <h1>
          {mobileTitle ? (
            <>
              <span className={styles.desktopOnly}>{title}</span>
              <span className={styles.mobileOnly}>{mobileTitle}</span>
            </>
          ) : (
            title
          )}
        </h1>
      </div>
      {children && <div className={styles.headingActions}>{children}</div>}
    </header>
  );
}
export function Empty({ children }: { children: React.ReactNode }) {
  return <div className={styles.empty}>{children}</div>;
}
export function Notice({ children, role }: { children: React.ReactNode; role?: 'status' }) {
  return (
    <div role={role} className={styles.notice}>
      <Icon name="info" size={16} />
      <span>{children}</span>
    </div>
  );
}
/** Progress ring for the Today summary pill. */
export function Ring({ value, size = 36 }: { value: number; size?: number }) {
  const r = size / 2 - 3;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle className={styles.ringTrack} cx={size / 2} cy={size / 2} r={r} strokeWidth="4" />
      <circle
        className={styles.ringValue}
        cx={size / 2}
        cy={size / 2}
        r={r}
        strokeWidth="4"
        strokeDasharray={`${(Math.min(1, Math.max(0, value)) * c).toFixed(2)} ${c.toFixed(2)}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}
/** Segmented bar for small quota targets, plain bar for larger ones. */
export function QuotaBar({ value, max }: { value: number; max: number }) {
  if (max > 0 && max <= 12)
    return (
      <span className={styles.segments} aria-hidden="true">
        {Array.from({ length: max }, (_, i) => (
          <span key={i} className={i < value ? styles.segmentOn : styles.segmentOff} />
        ))}
      </span>
    );
  return (
    <span className={styles.bar} aria-hidden="true">
      <span style={{ width: `${max ? Math.min(100, (value / max) * 100) : 0}%` }} />
    </span>
  );
}
const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'];
export function scheduleLabel(s: Schedule): string {
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
/** "9월 27일 일요일" for a YYYY-MM-DD calendar date. */
export function longDate(day: string) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('ko-KR', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    timeZone: 'UTC',
  });
}
/** "9월 27일" for a YYYY-MM-DD calendar date. */
export function shortDate(day: string) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('ko-KR', {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
/** HH:MM of an instant in the tracker timezone. */
export function clockTime(instant: string, timeZone: string) {
  return new Date(instant).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  });
}
const FREQUENCIES: [Schedule['type'], string][] = [
  ['daily', '매일'],
  ['selected_weekdays', '특정 요일'],
  ['weekdays', '평일'],
  ['weekends', '주말'],
  ['weekly_quota', '주 N회'],
  ['monthly_quota', '월 N회'],
  ['every_n_days', 'N일마다'],
];
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
    <fieldset className={styles.scheduleEditor}>
      <legend>반복 주기</legend>
      <div className={styles.chips} role="group" aria-label="반복">
        {FREQUENCIES.map(([type, label]) => (
          <button
            type="button"
            key={type}
            className={styles.chip}
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
                className={styles.weekday}
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
        <label className={styles.inlineField}>
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
        <div className={styles.formRow}>
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
