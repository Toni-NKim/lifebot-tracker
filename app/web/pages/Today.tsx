import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useData, type DefinitionRows, type Today } from '../lib/api-client.js';
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
import { DetailsSheet, subtitleFor } from '../components/DetailsSheet.js';
import { Snackbar, type Notice, type NoticeInput } from '../components/Snackbar.js';
import { Icon } from '../components/icons.js';
import { ErrorBox } from '../components/common.js';
import styles from '../styles/dashboard.module.css';

export function TodayPage() {
  const query = useData<Today>('/today');
  const result = query.data;
  const today = result?.data;
  const data = useDashboardData(today);
  const [filter, setFilter] = useState<string | null>(null);
  const [showOff, setShowOff] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  // The Habit whose Details are open; its sheet shares the card's draft and write queue.
  const [details, setDetails] = useState<string | null>(null);
  const definitions = useData<DefinitionRows>('/habits', !!details || showOff);
  const notify = (n: NoticeInput) => setNotice({ ...n, stamp: Date.now() });
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
  const detailItem = today?.items.find((i) => i.habit_id === details);
  const schedule = (id: string) => {
    const item = today?.items.find((i) => i.habit_id === id);
    if (item) return scheduleText(item.habit.schedule.rule);
    const row = definitions.data?.data.find((r) => r.id === id);
    const h = (row?.current ?? row?.pending.at(-1)) as Habit | undefined;
    return h ? scheduleText(h.schedule.rule) : '';
  };
  const notDue = data.habits.filter((h) => h.active && !dueIds.has(h.id));
  // Every card of today stays mounted in one grid while the dashboard is open: moving a
  // card between sections is a keyed reorder and a filtered-out card is only hidden. So a
  // write's callbacks (clearing the draft, the snackbar) always run, and every Habit keeps
  // its shared draft for as long as the dashboard is open, as on the Today page before.
  const shown = new Set(items.map((i) => i.habit_id));
  const hidden = (today?.items ?? []).filter((i) => !shown.has(i.habit_id));
  const card = (item: Item) =>
    today && (
      <DashboardCard
        key={`${today.date}/${item.id}`}
        hidden={!shown.has(item.habit_id)}
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
        notify={notify}
        openDetails={() => setDetails(item.habit_id)}
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
          {/* One flat keyed list, so React moves cards instead of remounting them. */}
          <div className={styles.grid}>
            {[
              open.length > 0 && (
                <div key="open-title" className={styles.sectionTitle}>
                  <h2>오늘 남은 기록 {open.length}</h2>
                  <span>누르면 바로 기록</span>
                </div>
              ),
              ...open.map(card),
              finished.length > 0 && (
                <div key="done-title" className={styles.sectionTitle}>
                  <h2>완료 {finished.length}</h2>
                  <span>누르면 세부 기록</span>
                </div>
              ),
              ...finished.map(card),
              ...hidden.map(card),
            ]}
          </div>
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
              {showOff && (
                <NotDue
                  habits={notDue}
                  data={data}
                  schedule={schedule}
                  open={(id) => setDetails(id)}
                />
              )}
            </section>
          )}
        </>
      )}
      {today && details && (
        <DetailsSheet
          key={details}
          habitId={details}
          name={detailItem?.habit.name ?? data.habits.find((h) => h.id === details)?.name ?? ''}
          subtitle={subtitleFor(detailItem, schedule(details), detailItem?.scheduled_time ?? null)}
          item={detailItem}
          date={today.date}
          timezone={today.timezone}
          etag={result!.etag}
          cells={data.strip(details)}
          amounts={data.amounts(details)}
          streak={data.streak(details)}
          notify={notify}
          close={() => setDetails(null)}
        />
      )}
      {today &&
      notice?.kind === 'done' &&
      today.items.some((i) => i.habit_id === notice.habitId) ? (
        <UndoSnackbar
          key={notice.stamp}
          notice={notice}
          item={today.items.find((i) => i.habit_id === notice.habitId)!}
          date={today.date}
          timezone={today.timezone}
          etag={result!.etag}
          notify={notify}
          dismiss={() => setNotice(null)}
        />
      ) : (
        <Snackbar
          notice={notice?.kind === 'error' ? notice : null}
          dismiss={() => setNotice(null)}
        />
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
  notify,
  hidden,
  openDetails,
}: {
  hidden: boolean;
  openDetails: () => void;
  item: Item;
  date: string;
  timezone: string;
  etag: string;
  time: string | null;
  streak: ReturnType<ReturnType<typeof useDashboardData>['streak']>;
  cells: Cell[];
  notify: (n: NoticeInput) => void;
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
      hidden={hidden}
      name={h.name}
      context={context}
      streak={streak ? streakText(streak.current, streak.unit) : null}
      cells={cells}
      state={execution.busy ? 'saving' : execution.complete ? 'done' : 'open'}
      primaryLabel={execution.complete ? `${h.name} 세부 기록` : `${h.name} 완료`}
      onMore={execution.complete ? undefined : openDetails}
      onPrimary={
        execution.complete
          ? openDetails
          : () =>
              execution.completeNow({
                onSuccess: () => notify({ kind: 'done', habitId: item.habit_id, text: h.name }),
                onError: (error) => notify({ kind: 'error', text: error.message }),
              })
      }
    />
  );
}

function NotDue({
  habits,
  data,
  schedule,
  open,
}: {
  habits: ReturnType<typeof useDashboardData>['habits'];
  data: ReturnType<typeof useDashboardData>;
  schedule: (id: string) => string;
  open: (id: string) => void;
}) {
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
          primaryLabel={`${h.name} 통계`}
          onPrimary={() => open(h.id)}
        />
      ))}
    </div>
  );
}

// The Undo snackbar of the latest completion. Undo runs through the same execution hook as
// the card and the Details sheet, so a failed Undo restores the shared draft everywhere.
function UndoSnackbar({
  notice,
  item,
  date,
  timezone,
  etag,
  notify,
  dismiss,
}: {
  notice: Extract<Notice, { kind: 'done' }>;
  item: Item;
  date: string;
  timezone: string;
  etag: string;
  notify: (n: NoticeInput) => void;
  dismiss: () => void;
}) {
  const execution = useExecution(item, date, etag);
  const at = item.execution?.completed_at;
  return (
    <Snackbar
      notice={{
        ...notice,
        text: `${item.habit.name} 기록됨${at ? ` · ${clockTime(at, timezone)}` : ''}`,
      }}
      dismiss={dismiss}
      undoBusy={execution.busy}
      undo={
        execution.complete
          ? () =>
              execution.undo({
                onSuccess: dismiss,
                onError: (error) => notify({ kind: 'error', text: error.message }),
              })
          : undefined
      }
    />
  );
}
