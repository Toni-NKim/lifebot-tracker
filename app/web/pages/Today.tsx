import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useData, type DefinitionRows, type Today } from '../lib/api-client.js';
import { useSharedDraft } from '../lib/shared-draft.js';
import { useDashboardData, type Cell } from '../lib/dashboard-data.js';
import { useExecution, type Item } from '../lib/use-execution.js';
import {
  amountText,
  clockTime,
  longDate,
  percentText,
  scheduleText,
  streakText,
} from '../lib/format.js';
import type { Habit } from '../../shared/contracts/index.js';
import { HabitCard } from '../components/HabitCard.js';
import { Icon } from '../components/icons.js';
import { ErrorBox } from '../components/common.js';
import styles from '../styles/dashboard.module.css';

// Keeps a Habit's shared draft alive while the dashboard is open, even when its card is
// filtered out or moves between sections (drafts are dropped when nothing uses them).
function KeepDraft({ draftKey }: { draftKey: string }) {
  useSharedDraft(draftKey);
  return null;
}

export function TodayPage() {
  const query = useData<Today>('/today');
  const result = query.data;
  const today = result?.data;
  const data = useDashboardData(today);
  const [filter, setFilter] = useState<string | null>(null);
  const [showOff, setShowOff] = useState(false);
  const dated = today?.items.filter((i) => !i.quota) ?? [];
  const done = dated.filter((i) => i.execution?.status === 'completed').length;
  // "전체" keeps the server's scheduled-time order; a Routine uses its own Habit order.
  const routine = today?.routines.find((r) => r.id === filter);
  const items = (today?.items ?? []).filter(
    (i) => !routine || i.routine_contexts.some((c) => c.routine_id === routine.id),
  );
  if (routine)
    items.sort((a, b) => {
      const ai = routine.habit_order.indexOf(a.habit_id);
      const bi = routine.habit_order.indexOf(b.habit_id);
      return (
        (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi) ||
        a.habit.created_at.localeCompare(b.habit.created_at) ||
        a.habit_id.localeCompare(b.habit_id)
      );
    });
  const open = items.filter((i) => i.execution?.status !== 'completed');
  const finished = items.filter((i) => i.execution?.status === 'completed');
  const dueIds = new Set(today?.items.map((i) => i.habit_id));
  const notDue = data.habits.filter((h) => h.active && !dueIds.has(h.id));
  const card = (item: Item) =>
    today && (
      <DashboardCard
        key={`${today.date}/${item.id}`}
        item={item}
        date={today.date}
        timezone={today.timezone}
        etag={result!.etag}
        time={
          (routine
            ? item.routine_contexts.find((c) => c.routine_id === routine.id)?.scheduled_time
            : item.scheduled_time) ?? null
        }
        streak={data.streak(item.habit_id)}
        cells={data.strip(item.habit_id)}
      />
    );
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>{today ? longDate(today.date) : ' '}</p>
          <h1>오늘의 기록</h1>
        </div>
        <Link to="/habits" className={styles.addButton} aria-label="새 습관">
          <Icon name="plus" size={22} strokeWidth={2.2} />
        </Link>
      </header>
      <ErrorBox error={query.error} />
      {result?.index_warning && (
        <p role="status" className={styles.notice}>
          기록은 저장됐어요. 통계 인덱스를 확인해 주세요: {result.index_warning}
        </p>
      )}
      {query.isPending && <p className={styles.muted}>오늘 기록을 불러오는 중…</p>}
      {today && (
        <>
          {today.items.map((i) => (
            <KeepDraft key={i.habit_id} draftKey={`${today.date}/${i.habit_id}`} />
          ))}
          <section className={styles.summary} aria-label="요약">
            <div>
              <span>오늘</span>
              <strong>
                {done}
                <small>/{dated.length}</small>
              </strong>
              <span className={styles.bar} aria-hidden="true">
                <span style={{ width: `${dated.length ? (done / dated.length) * 100 : 0}%` }} />
              </span>
            </div>
            <div>
              <span>이번 주</span>
              <strong>{percentText(data.week?.rate ?? null)}</strong>
              <span>{data.week ? `${data.week.completed} / ${data.week.total}회` : ' '}</span>
            </div>
            <div>
              <span>이번 달</span>
              <strong>{percentText(data.month?.rate ?? null)}</strong>
              <span>{data.month ? `${data.month.completed} / ${data.month.total}회` : ' '}</span>
            </div>
          </section>
          {today.routines.length > 0 && (
            <div className={styles.chips} role="group" aria-label="루틴 필터">
              {[null, ...today.routines].map((r) => {
                const ids = r
                  ? today.items.filter((i) => i.routine_contexts.some((c) => c.routine_id === r.id))
                  : today.items;
                const ds = ids.filter((i) => !i.quota);
                return (
                  <button
                    key={r?.id ?? 'all'}
                    type="button"
                    aria-pressed={filter === (r?.id ?? null)}
                    onClick={() => setFilter(r?.id ?? null)}
                  >
                    {r?.name ?? '전체'}
                    <span>
                      {ds.filter((i) => i.execution?.status === 'completed').length}/{ds.length}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {!today.items.length && (
            <p className={styles.empty}>
              오늘 예정된 습관이 없어요. <Link to="/habits">습관 추가하기</Link>
            </p>
          )}
          {open.length > 0 && (
            <section className={styles.section} aria-labelledby="open-title">
              <div className={styles.sectionTitle}>
                <h2 id="open-title">오늘 남은 기록 {open.length}</h2>
                <span>누르면 바로 기록</span>
              </div>
              <div className={styles.grid}>{open.map(card)}</div>
            </section>
          )}
          {finished.length > 0 && (
            <section className={styles.section} aria-labelledby="done-title">
              <div className={styles.sectionTitle}>
                <h2 id="done-title">완료 {finished.length}</h2>
                <span>누르면 세부 기록</span>
              </div>
              <div className={styles.grid}>{finished.map(card)}</div>
            </section>
          )}
          {!filter && notDue.length > 0 && (
            <section className={styles.section}>
              <button
                type="button"
                className={styles.collapse}
                aria-expanded={showOff}
                onClick={() => setShowOff(!showOff)}
              >
                오늘 예정 없음 {notDue.length}개
                <Icon name={showOff ? 'chevronUp' : 'chevronDown'} size={18} />
              </button>
              {showOff && <NotDue habits={notDue} data={data} />}
            </section>
          )}
        </>
      )}
    </div>
  );
}

function DashboardCard({
  item,
  date,
  timezone,
  etag,
  time,
  streak,
  cells,
}: {
  item: Item;
  date: string;
  timezone: string;
  etag: string;
  time: string | null;
  streak: ReturnType<ReturnType<typeof useDashboardData>['streak']>;
  cells: Cell[];
}) {
  const execution = useExecution(item, date, etag);
  const e = item.execution;
  const h = item.habit;
  // One context only: quota progress, then target amount, then time.
  const context = item.quota
    ? `${item.quota.unit === 'weeks' ? '이번 주' : '이번 달'} ${item.quota.actual_count}/${item.quota.target_count}`
    : h.target_amount !== null
      ? `목표 ${amountText(h.target_amount, h.unit)}`
      : execution.complete && e?.completed_at
        ? clockTime(e.completed_at, timezone)
        : (time ?? '언제든');
  return (
    <HabitCard
      name={h.name}
      context={context}
      streak={streak ? streakText(streak.current, streak.unit) : null}
      cells={cells}
      state={execution.busy ? 'saving' : execution.complete ? 'done' : 'open'}
      primaryLabel={execution.complete ? `${h.name} 세부 기록` : `${h.name} 완료`}
      onPrimary={execution.complete ? undefined : () => execution.completeNow()}
      error={<ErrorBox error={execution.error} />}
    />
  );
}

function NotDue({
  habits,
  data,
}: {
  habits: ReturnType<typeof useDashboardData>['habits'];
  data: ReturnType<typeof useDashboardData>;
}) {
  // Schedules are only needed here, so the definitions load when the section opens.
  const definitions = useData<DefinitionRows>('/habits');
  const schedule = (id: string) => {
    const row = definitions.data?.data.find((r) => r.id === id);
    const h = (row?.current ?? row?.pending.at(-1)) as Habit | undefined;
    return h ? scheduleText(h.schedule.rule) : '';
  };
  return (
    <div className={styles.grid}>
      {habits.map((h) => (
        <HabitCard
          key={h.id}
          name={h.name}
          context={schedule(h.id)}
          streak={streakText(h.current, h.unit)}
          cells={data.strip(h.id)}
          state="off"
        />
      ))}
    </div>
  );
}
