import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ExecutionInput } from '../../shared/contracts/index.js';
import { useData, useWrite, type Today } from '../lib/api-client.js';
import { Heading, ErrorBox, Empty, scheduleLabel } from '../components/common.js';
import styles from '../styles/app.module.css';
export function TodayPage() {
  const query = useData<Today>('/today');
  const result = query.data;
  const today = result?.data;
  const dated = today?.items.filter((i) => !i.quota) ?? [];
  const done = dated.filter((i) => i.execution?.status === 'completed').length;
  const group = (routineId: string | null) => {
    const r = today?.routines.find((r) => r.id === routineId);
    const items = today!.items.filter((i) =>
      routineId
        ? i.routine_contexts.some((r) => r.routine_id === routineId)
        : !i.routine_contexts.length,
    );
    if (r)
      items.sort((a, b) => {
        const ai = r.habit_order.indexOf(a.habit_id);
        const bi = r.habit_order.indexOf(b.habit_id);
        return (
          (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi) ||
          a.habit.created_at.localeCompare(b.habit.created_at) ||
          a.habit_id.localeCompare(b.habit_id)
        );
      });
    if (!items.length) return null;
    const ds = items.filter((i) => !i.quota);
    const qs = items.filter((i) => i.quota);
    return (
      <section key={routineId ?? 'standalone'} className={styles.group}>
        <div className={styles.groupTitle}>
          <h2>{r?.name ?? 'Your habits'}</h2>
          <span>
            {ds.length
              ? `${ds.filter((i) => i.execution?.status === 'completed').length}/${ds.length} today`
              : 'No dated tasks'}
            {qs.length
              ? ` · ${qs.filter((i) => i.quota?.status === 'completed').length}/${qs.length} quota goals met`
              : ''}
          </span>
        </div>
        {items.map((item) => (
          <HabitCard
            key={`${today!.date}/${item.id}`}
            item={item}
            scheduledTime={
              routineId
                ? item.routine_contexts.find((r) => r.routine_id === routineId)!.scheduled_time
                : item.scheduled_time
            }
            date={today!.date}
            etag={result!.etag}
          />
        ))}
      </section>
    );
  };
  return (
    <>
      <Heading
        eyebrow={today ? `${today.date} · ${today.timezone}` : 'YOUR DAILY PRACTICE'}
        title="Today"
      >
        <Link className={styles.button} to="/habits">
          + New habit
        </Link>
      </Heading>
      <p className={styles.intro}>Make space for the things that matter.</p>
      <ErrorBox error={query.error} />
      {result?.index_warning && (
        <p role="status" className={styles.notice}>
          Records are saved. Statistics index needs attention: {result.index_warning}
        </p>
      )}
      {query.isPending && <p>Loading your day…</p>}
      {today && (
        <>
          <section className={styles.summary}>
            <div>
              <span className={styles.eyebrow}>TODAY’S SCHEDULED HABITS</span>
              <div className={styles.bigNumber}>
                {done}
                <span> / {dated.length}</span>
              </div>
              <p>
                {dated.length
                  ? 'Small actions. Steady progress.'
                  : 'No dated habits scheduled today.'}
              </p>
            </div>
            <div
              className={styles.progressCircle}
              style={
                {
                  '--progress': `${dated.length ? (done / dated.length) * 100 : 0}%`,
                } as React.CSSProperties
              }
            >
              <span>{dated.length ? `${Math.round((done / dated.length) * 100)}%` : '—'}</span>
            </div>
          </section>
          {!today.items.length && (
            <Empty>
              No habits due today. <Link to="/habits">Create your first habit</Link> or check your
              upcoming schedules.
            </Empty>
          )}
          {today.routines.map((r) => group(r.id))}
          {group(null)}
        </>
      )}
    </>
  );
}
function HabitCard({
  item,
  scheduledTime,
  date,
  etag,
}: {
  item: Today['items'][number];
  scheduledTime: string | null;
  date: string;
  etag: string;
}) {
  const write = useWrite();
  const [expanded, setExpanded] = useState(false);
  const e = item.execution;
  const complete = e?.status === 'completed';
  const details = useRef<HTMLDivElement>(null);
  const [draft, setContext] = useState<Omit<ExecutionInput, 'status'> | null>(null);
  const savedContext = {
    duration_seconds: e?.duration_seconds ?? null,
    actual_amount: e?.actual_amount ?? null,
    difficulty_or_quality: e?.difficulty_or_quality ?? null,
    energy_note: e?.energy_note ?? null,
  };
  const context = complete ? savedContext : (draft ?? savedContext);
  const toggleCompletion = () => {
    if (!complete && details.current) {
      for (const input of details.current.querySelectorAll('input, textarea')) {
        if (!(input as HTMLInputElement | HTMLTextAreaElement).reportValidity()) return;
      }
    }
    // Undo clears canonical completion details, but keeps them as a local draft.
    if (complete) setContext(savedContext);
    write.mutate(
      {
        path: `/days/${date}/habits/${item.habit_id}/execution`,
        method: 'PUT',
        body: complete
          ? {
              status: 'incomplete',
              duration_seconds: null,
              actual_amount: null,
              difficulty_or_quality: null,
              energy_note: null,
            }
          : { status: 'completed', ...context },
        etag,
      },
      {
        onSuccess: () => {
          if (!complete) {
            setContext(null);
            setExpanded(false);
          }
        },
      },
    );
  };
  return (
    <article className={`${styles.habitCard} ${complete ? styles.completed : ''}`}>
      <div className={styles.cardTop}>
        <button
          className={styles.check}
          disabled={write.isPending}
          aria-label={`${complete ? 'Undo' : 'Complete'} ${item.habit.name}`}
          aria-pressed={complete}
          onClick={() => (complete ? toggleCompletion() : setExpanded(true))}
        >
          {write.isPending ? '…' : complete ? '✓' : ''}
        </button>
        <div className={styles.cardInfo}>
          <h3>{item.habit.name}</h3>
          <p>
            {scheduledTime ?? 'Any time'}
            <span> · </span>
            {scheduleLabel(item.habit.schedule.rule)}
            {item.habit.minimum_duration_seconds !== null && (
              <> · {item.habit.minimum_duration_seconds / 60} min minimum</>
            )}
            {item.habit.target_amount !== null && (
              <>
                {' '}
                · {item.habit.target_amount} {item.habit.unit}
              </>
            )}
          </p>
          {item.quota && (
            <p className={styles.quota}>
              {item.quota.actual_count} / {item.quota.target_count} this{' '}
              {item.quota.unit === 'weeks' ? 'week' : 'month'}
              {item.quota.eligible_start !== item.quota.start ? ' · adjusted first period' : ''}
              {item.quota.status === 'completed' ? ' · goal met' : ''}
            </p>
          )}
        </div>
        <button
          className={styles.quiet}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          Details {expanded ? '−' : '+'}
        </button>
      </div>
      <ErrorBox error={write.error} />
      {expanded && (
        <div ref={details} className={styles.detailForm}>
          <p>{item.habit.description || 'Add context if it helps. Completion is your decision.'}</p>
          <p>
            {complete
              ? 'To edit these details today, undo completion, then save and complete again.'
              : 'Details are optional. Save and complete to record this habit, with or without details.'}
          </p>
          {e?.completed_at && (
            <p>
              Completed at{' '}
              {new Date(e.completed_at).toLocaleTimeString('en-GB', { timeZone: 'Asia/Seoul' })}{' '}
              (tracker time)
            </p>
          )}
          <div className={styles.formRow}>
            <label>
              Duration (minutes)
              <input
                disabled={complete || write.isPending}
                type="number"
                min="0"
                step="0.1"
                value={context.duration_seconds === null ? '' : context.duration_seconds / 60}
                onChange={(ev) =>
                  setContext({
                    ...context,
                    duration_seconds:
                      ev.target.value === '' ? null : Math.round(Number(ev.target.value) * 60),
                  })
                }
              />
            </label>
            <label>
              Actual amount{item.habit.unit ? ` (${item.habit.unit})` : ''}
              <input
                disabled={complete || write.isPending}
                inputMode="decimal"
                pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]+)?"
                value={context.actual_amount ?? ''}
                onChange={(ev) =>
                  setContext({ ...context, actual_amount: ev.target.value || null })
                }
              />
            </label>
          </div>
          <label>
            Difficulty or quality
            <textarea
              disabled={complete || write.isPending}
              value={context.difficulty_or_quality ?? ''}
              onChange={(ev) =>
                setContext({ ...context, difficulty_or_quality: ev.target.value || null })
              }
            />
          </label>
          <label>
            Energy note
            <textarea
              disabled={complete || write.isPending}
              value={context.energy_note ?? ''}
              onChange={(ev) => setContext({ ...context, energy_note: ev.target.value || null })}
            />
          </label>
          {!complete && (
            <div className={styles.actions}>
              <button
                className={styles.button}
                disabled={write.isPending}
                onClick={toggleCompletion}
              >
                {write.isPending ? 'Saving…' : 'Save and complete'}
              </button>
              <button
                className={styles.quiet}
                disabled={write.isPending}
                onClick={() => {
                  setContext(null);
                  setExpanded(false);
                  write.reset();
                }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
