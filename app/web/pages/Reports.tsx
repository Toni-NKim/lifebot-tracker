import { useState } from 'react';
import {
  useData,
  useRaw,
  useWrite,
  type Stats,
  type HistoryData,
  type Today,
} from '../lib/api-client.js';
import { Heading, ErrorBox, Empty, percent } from '../components/common.js';
import { bounds, date, addDays } from '../../shared/domain/index.js';
import styles from '../styles/app.module.css';
export function StatisticsPage() {
  const today = useData<Today>('/today');
  const [period, setPeriod] = useState('month');
  const [selected, setSelected] = useState('');
  const day = selected || today.data?.data.date;
  const [habitId, setHabitId] = useState('');
  const range = day
    ? period === 'day'
      ? { start: day, end: day }
      : period === 'week'
        ? bounds(day, 'weeks')
        : period === 'month'
          ? bounds(day, 'months')
          : null
    : null;
  const params = new URLSearchParams({
    ...(range ? { from: range.start, to: range.end } : {}),
    ...(habitId ? { habit_id: habitId } : {}),
  });
  const query = useData<Stats>(`/statistics?${params}`);
  const data = query.data?.data;
  const all = useData<Stats>('/statistics');
  return (
    <>
      <Heading eyebrow="SEE YOUR PROGRESS" title="Statistics" />
      <p className={styles.intro}>Consistency takes shape over time.</p>
      <div className={styles.filters}>
        <label>
          Period
          <select value={period} onChange={(e) => setPeriod(e.target.value)}>
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
            <option value="all">All time</option>
          </select>
        </label>
        {period !== 'all' && (
          <label>
            Date in period
            <input
              type="date"
              value={day ?? ''}
              max={today.data?.data.date}
              onChange={(e) => setSelected(e.target.value)}
            />
          </label>
        )}
        <label>
          Habit
          <select value={habitId} onChange={(e) => setHabitId(e.target.value)}>
            <option value="">All habits</option>
            {all.data?.data.habits.map((h) => (
              <option value={h.id} key={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorBox error={query.error} />
      {query.data?.index_warning && (
        <p role="status" className={styles.notice}>
          Index unavailable. These figures were calculated from canonical Markdown.
        </p>
      )}
      {data && (
        <>
          <p className={styles.muted}>
            {data.from} – {data.to} · to date
          </p>
          <div className={styles.statGrid}>
            {[
              ['Scheduled completion', data.date_scheduled],
              ['Finalized weekly quotas', data.weekly_quota],
              ['Finalized monthly quotas', data.monthly_quota],
            ].map(([label, raw]) => {
              const v = raw as Stats['date_scheduled'];
              return (
                <article className={styles.panel} key={String(label)}>
                  <span className={styles.eyebrow}>{String(label)}</span>
                  <div className={styles.bigNumber}>{percent(v.rate)}</div>
                  <p>
                    {v.completed} / {v.total} credited occurrences
                  </p>
                </article>
              );
            })}
          </div>
          <section className={styles.panel}>
            <h2>Daily consistency</h2>
            <p className={styles.muted}>
              Date-scheduled habits only. Flexible quota days are not failures.
            </p>
            <CalendarHeatmap data={data} />
            {!data.heatmap.length && <p>No date-scheduled occurrences in this period.</p>}
            <div className={styles.legend}>
              Less <span /> More
            </div>
          </section>
          <section className={styles.group}>
            <h2>Current quota progress</h2>
            {!data.live_quotas.length && <p className={styles.muted}>No open quota periods.</p>}
            {data.live_quotas.map((q) => (
              <article key={q.id} className={styles.panel}>
                <div className={styles.groupTitle}>
                  <h3>{all.data?.data.habits.find((h) => h.id === q.habit_id)?.name}</h3>
                  <strong>
                    {q.actual_count}/{q.target_count}
                  </strong>
                </div>
                <p>
                  {q.start} – {q.end} · {q.unit === 'weeks' ? 'weekly' : 'monthly'} goal
                  {q.eligible_start !== q.start ? ' · prorated first period' : ''}
                </p>
                <progress max={q.target_count} value={q.credited_count} />
              </article>
            ))}
          </section>
          <section className={styles.group}>
            <h2>Streaks</h2>
            {data.habits.map((h) => (
              <article key={h.id} className={styles.panel}>
                <div className={styles.groupTitle}>
                  <h3>{h.name}</h3>
                  <span>{h.active ? 'Active' : 'Inactive'}</span>
                </div>
                <p>
                  <strong>{h.current}</strong> current {h.unit}
                  {h.provisional ? ' · provisional' : ''}
                </p>
                <p className={styles.muted}>
                  Longest:{' '}
                  {Object.entries(h.longest)
                    .filter(([, n]) => n > 0)
                    .map(([unit, n]) => `${n} ${unit}`)
                    .join(' · ') || '0'}
                </p>
              </article>
            ))}
          </section>
        </>
      )}
    </>
  );
}
export function HistoryPage() {
  const today = useData<Today>('/today');
  const [selected, setSelected] = useState('');
  const [offset, setOffset] = useState(0);
  const day = selected || today.data?.data.date;
  const query = useData<HistoryData>(
    `/history?${new URLSearchParams({ ...(day ? { from: day, to: day } : {}), offset: String(offset), limit: '50' })}`,
  );
  return (
    <>
      <Heading eyebrow="YOUR PRACTICE, RECORDED" title="History" />
      <p className={styles.intro}>
        Past records are read-only. Every day keeps its original context.
      </p>
      <label className={styles.dateFilter}>
        View date
        <input
          type="date"
          value={day ?? ''}
          max={today.data?.data.date}
          onChange={(e) => {
            setSelected(e.target.value);
            setOffset(0);
          }}
        />
      </label>
      <ErrorBox error={query.error} />
      {query.data?.data.rows.map((row) => (
        <article className={styles.panel} key={row.id}>
          <div className={styles.groupTitle}>
            <h2>{row.name}</h2>
            <span className={styles.badge}>
              {row.execution?.status === 'completed'
                ? 'Completed'
                : row.date === today.data?.data.date
                  ? 'Incomplete · open'
                  : 'Incomplete'}
            </span>
          </div>
          <p>
            {row.date} · {row.kind === 'quota_activity' ? 'Quota activity' : 'Scheduled occurrence'}
            {row.scheduled_time ? ` · ${row.scheduled_time}` : ''}
          </p>
          {row.execution && (
            <dl className={styles.record}>
              {Object.entries({
                'Completed at': row.execution.completed_at,
                'Duration (seconds)': row.execution.duration_seconds,
                Target: row.execution.target_amount,
                Actual: row.execution.actual_amount,
                Unit: row.execution.unit,
                'Difficulty / quality': row.execution.difficulty_or_quality,
                Energy: row.execution.energy_note,
              })
                .filter(([, v]) => v !== null)
                .map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
            </dl>
          )}
        </article>
      ))}
      {query.data?.data.rows.length === 0 && (
        <Empty>No scheduled occurrences or recorded quota activity on this date.</Empty>
      )}
      {query.data?.data.quota_periods.map((q) => (
        <article key={q.id} className={styles.panel}>
          <h3>{q.unit === 'weeks' ? 'Weekly' : 'Monthly'} quota closed</h3>
          <p>
            {q.start} – {q.end}: {q.actual_count}/{q.target_count} · {q.status}
          </p>
        </article>
      ))}
      {query.data && (
        <div className={styles.actions}>
          <button
            className={styles.secondary}
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            Previous
          </button>
          <span>{query.data.data.total} records</span>
          <button
            className={styles.secondary}
            disabled={offset + 50 >= query.data.data.total}
            onClick={() => setOffset(offset + 50)}
          >
            Next
          </button>
        </div>
      )}
    </>
  );
}
export function SettingsPage() {
  const query = useRaw<{
    vault_path: string;
    timezone?: string;
    date?: string;
    source_changed?: boolean;
    index_warning?: string;
    error?: string;
    warnings?: string[];
  }>('/system/status');
  const write = useWrite();
  const [message, setMessage] = useState('');
  const run = async (action: string) => {
    setMessage('');
    try {
      await write.mutateAsync({ path: `/system/${action}` });
      setMessage(
        action === 'rebuild'
          ? 'Index rebuilt from canonical Markdown.'
          : 'Canonical Vault validation passed.',
      );
    } catch {
      /* Error displayed below. */
    }
  };
  return (
    <>
      <Heading eyebrow="LOCAL & PRIVATE" title="System" />
      <p className={styles.intro}>Your Vault holds the records. The index can always be rebuilt.</p>
      <ErrorBox error={query.error ?? write.error} />
      {query.data && (
        <section className={styles.panel}>
          <dl className={styles.record}>
            <div>
              <dt>Obsidian tracker directory</dt>
              <dd>{query.data.vault_path}</dd>
            </div>
            <div>
              <dt>Calendar timezone</dt>
              <dd>{query.data.timezone ?? 'Unavailable'}</dd>
            </div>
            <div>
              <dt>Server date</dt>
              <dd>{query.data.date}</dd>
            </div>
            <div>
              <dt>Source status</dt>
              <dd>
                {query.data.source_changed
                  ? 'External changes detected — explicit rebuild required'
                  : (query.data.error ?? 'Ready')}
              </dd>
            </div>
            <div>
              <dt>SQLite index</dt>
              <dd>{query.data.index_warning ?? 'Ready / rebuildable'}</dd>
            </div>
          </dl>
          {query.data.warnings?.map((w) => (
            <p key={w} className={styles.notice}>
              {w}
            </p>
          ))}
        </section>
      )}
      <section className={styles.panel}>
        <h2>Validate & rebuild</h2>
        <p>
          Rebuilding reads canonical Markdown and replaces the derived SQLite index. Valid external
          Markdown edits will become visible, including any edits to historical files.
        </p>
        <div className={styles.actions}>
          <button
            className={styles.secondary}
            disabled={write.isPending}
            onClick={() => void run('validate')}
          >
            Validate Vault
          </button>
          <button
            className={styles.button}
            disabled={write.isPending}
            onClick={() => void run('rebuild')}
          >
            {write.isPending ? 'Working…' : 'Rebuild index'}
          </button>
        </div>
        {message && <p role="status">{message}</p>}
      </section>
      <section className={styles.panel}>
        <h2>Current boundaries</h2>
        <p>Monday weeks · Asia/Seoul timezone · current-day editing only.</p>
        <p>
          Recording requires a connection to your Mac mini. Timers, offline capture, multiple daily
          completions, and Lifebot are planned for a later version.
        </p>
      </section>
    </>
  );
}

function CalendarHeatmap({ data }: { data: Stats }) {
  const [selected, setSelected] = useState('Select a date for details.');
  const values = new Map(data.heatmap.map((d) => [d.date, d]));
  const months: Record<string, string[]> = {};
  for (let day = data.from; day <= data.to; day = addDays(day, 1))
    (months[day.slice(0, 7)] ??= []).push(day);
  return (
    <>
      <div className={styles.calendarMonths}>
        {Object.entries(months).map(([month, days]) => (
          <div key={month}>
            <h3>{date(`${month}-01`).toLocaleString('en', { month: 'long', year: 'numeric' })}</h3>
            <div className={styles.calendarGrid}>
              {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
                <span key={i} aria-hidden="true">
                  {d}
                </span>
              ))}
              {Array.from({ length: date(days[0]).dayOfWeek - 1 }, (_, i) => (
                <span key={`blank-${i}`} />
              ))}
              {days.map((day) => {
                const value = values.get(day);
                const label = value
                  ? `${day}: ${value.completed}/${value.total} (${percent(value.rate)})`
                  : `${day}: no scheduled habits`;
                return (
                  <button
                    key={day}
                    type="button"
                    className={styles.calendarDay}
                    style={{
                      backgroundColor:
                        value?.rate === undefined || value.rate === null
                          ? '#eef1ec'
                          : `hsl(157 36% ${92 - value.rate * 0.55}%)`,
                      color: (value?.rate ?? 0) > 60 ? '#fff' : '#31543d',
                    }}
                    aria-label={label}
                    title={label}
                    onClick={() => setSelected(label)}
                  >
                    {date(day).day}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <p className={styles.muted} role="status">
        {selected}
      </p>
    </>
  );
}
