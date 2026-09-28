import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ExecutionInput } from '../../shared/contracts/index.js';
import { useData, useWrite, type Today } from '../lib/api-client.js';
import {
  ErrorBox,
  Empty,
  Icon,
  Notice,
  Ring,
  clockTime,
  longDate,
  scheduleLabel,
} from '../components/common.js';
import styles from '../styles/app.module.css';
type Item = Today['items'][number];
type Context = Omit<ExecutionInput, 'status'>;
const EMPTY_CONTEXT: Context = {
  duration_seconds: null,
  actual_amount: null,
  difficulty_or_quality: null,
  energy_note: null,
};
const savedContext = (item: Item): Context => ({
  duration_seconds: item.execution?.duration_seconds ?? null,
  actual_amount: item.execution?.actual_amount ?? null,
  difficulty_or_quality: item.execution?.difficulty_or_quality ?? null,
  energy_note: item.execution?.energy_note ?? null,
});
const isComplete = (item: Item) => item.execution?.status === 'completed';
const minutes = (seconds: number) => `${Math.round((seconds / 60) * 10) / 10}분`;
function quotaText(q: NonNullable<Item['quota']>) {
  const week = q.unit === 'weeks';
  return (
    `${week ? '이번 주' : '이번 달'} ${q.actual_count} / ${q.target_count}` +
    (q.eligible_start !== q.start ? ` · 첫 ${week ? '주' : '달'} 조정` : '') +
    (q.status === 'completed' ? ' · 달성' : '')
  );
}
interface Group {
  id: string;
  name: string;
  time: string | null;
  routine: boolean;
  rows: { item: Item; scheduledTime: string | null; others: string[] }[];
  dated: number;
  done: number;
  quotas: number;
  quotasMet: number;
}
function buildGroups(today: Today): Group[] {
  const routineName = (id: string) => today.routines.find((r) => r.id === id)?.name;
  const routines = [...today.routines].sort((a, b) =>
    (a.scheduled_time ?? '99:99').localeCompare(b.scheduled_time ?? '99:99'),
  );
  const make = (routineId: string | null): Group | null => {
    const r = today.routines.find((r) => r.id === routineId);
    const items = today.items.filter((i) =>
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
    return {
      id: routineId ?? 'standalone',
      name: r?.name ?? '습관',
      time: r?.scheduled_time ?? null,
      routine: !!r,
      rows: items.map((item) => ({
        item,
        scheduledTime: routineId
          ? item.routine_contexts.find((c) => c.routine_id === routineId)!.scheduled_time
          : item.scheduled_time,
        others: item.routine_contexts
          .filter((c) => c.routine_id !== routineId)
          .map((c) => routineName(c.routine_id))
          .filter((n): n is string => !!n),
      })),
      dated: ds.length,
      done: ds.filter(isComplete).length,
      quotas: qs.length,
      quotasMet: qs.filter((i) => i.quota?.status === 'completed').length,
    };
  };
  return [...routines.map((r) => make(r.id)), make(null)].filter((g): g is Group => !!g);
}
const groupComplete = (g: Group) =>
  g.dated + g.quotas > 0 &&
  g.done === g.dated &&
  g.rows.every((r) => !r.item.quota || isComplete(r.item));

export function TodayPage() {
  const query = useData<Today>('/today');
  const result = query.data;
  const today = result?.data;
  const [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Context>>({});
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  // Routines that are already finished when the page opens start folded.
  const initialFold = useRef<Record<string, boolean> | null>(null);
  const groups = today ? buildGroups(today) : [];
  if (today && !initialFold.current)
    initialFold.current = Object.fromEntries(
      groups.filter((g) => g.routine).map((g) => [g.id, groupComplete(g)]),
    );
  const dated = today?.items.filter((i) => !i.quota) ?? [];
  const done = dated.filter(isComplete).length;
  const selectedItem = today?.items.find((i) => i.habit_id === selected) ?? null;
  const setDraft = (habitId: string, context: Context | null) =>
    setDrafts((d) => {
      const next = { ...d };
      if (context) next[habitId] = context;
      else delete next[habitId];
      return next;
    });
  return (
    <div className={styles.todayLayout}>
      <div className={styles.todayMain}>
        <header className={styles.todayHeader}>
          <div className={styles.headingText}>
            <div className={styles.eyebrow}>
              {today ? `${longDate(today.date)} · ${today.timezone}` : ' '}
            </div>
            <h1>오늘</h1>
          </div>
          <div className={styles.headingActions}>
            {today && (
              <div className={styles.progressPill}>
                <Ring value={dated.length ? done / dated.length : 0} />
                <span>
                  <strong>
                    {done}
                    <span> / {dated.length}</span>
                  </strong>
                  <small>
                    {dated.length
                      ? `${Math.round((done / dated.length) * 100)}% 완료`
                      : '예정 없음'}
                  </small>
                </span>
              </div>
            )}
            <Link className={styles.iconLink} to="/habits" aria-label="새 습관">
              <Icon name="plus" size={22} />
            </Link>
          </div>
        </header>
        <ErrorBox error={query.error} />
        {result?.index_warning && (
          <Notice role="status">
            기록은 저장됐어요. 통계 인덱스를 확인해 주세요: {result.index_warning}
          </Notice>
        )}
        {query.isPending && <p className={styles.muted}>오늘 일정을 불러오는 중…</p>}
        {today && !today.items.length && (
          <Empty>
            오늘 예정된 습관이 없어요. <Link to="/habits">첫 습관 만들기</Link>
          </Empty>
        )}
        {today &&
          groups.map((g) => {
            const open = !g.routine || !(folded[g.id] ?? initialFold.current?.[g.id] ?? false);
            const count = `${g.dated ? `${g.done}/${g.dated}` : ''}${
              g.quotas ? `${g.dated ? ' · ' : ''}목표 ${g.quotasMet}/${g.quotas}` : ''
            }`;
            const rows = g.rows.map(({ item, scheduledTime, others }) => (
              <HabitRow
                key={`${today.date}/${g.id}/${item.id}`}
                item={item}
                scheduledTime={scheduledTime}
                others={others}
                date={today.date}
                timezone={today.timezone}
                etag={result!.etag}
                selected={selected === item.habit_id}
                select={(open) => setSelected(open ? item.habit_id : null)}
                setDraft={(c) => setDraft(item.habit_id, c)}
              />
            ));
            if (!g.routine)
              return (
                <section key={g.id} className={styles.group}>
                  <div className={styles.looseTitle}>
                    <h2>{g.name}</h2>
                    <span>{count}</span>
                  </div>
                  <div className={styles.groupCard}>{rows}</div>
                </section>
              );
            return (
              <section key={g.id} className={styles.group}>
                <div className={styles.groupCard}>
                  <div className={styles.routineHeader}>
                    <div className={styles.routineTitle}>
                      <h2>{g.name}</h2>
                      {g.time && <span>{g.time}</span>}
                    </div>
                    <span
                      className={g.dated && g.done === g.dated ? styles.countDone : styles.count}
                    >
                      {count}
                    </span>
                    <button
                      className={styles.foldButton}
                      aria-expanded={open}
                      aria-label={`${g.name} ${open ? '접기' : '펼치기'}`}
                      onClick={() => setFolded((f) => ({ ...f, [g.id]: open }))}
                    >
                      <Icon name={open ? 'chevronUp' : 'chevronDown'} size={18} />
                    </button>
                    <span className={styles.routineBar} aria-hidden="true">
                      <span style={{ width: `${g.dated ? (g.done / g.dated) * 100 : 0}%` }} />
                    </span>
                  </div>
                  {open && rows}
                </div>
              </section>
            );
          })}
      </div>
      {today && selectedItem ? (
        <DetailsPanel
          key={selectedItem.habit_id}
          item={selectedItem}
          date={today.date}
          timezone={today.timezone}
          etag={result!.etag}
          draft={drafts[selectedItem.habit_id] ?? null}
          setDraft={(c) => setDraft(selectedItem.habit_id, c)}
          close={() => setSelected(null)}
        />
      ) : (
        today && (
          <aside className={styles.detailsPlaceholder}>
            <Icon name="note" size={22} />
            습관을 누르면 세부 기록을 보고 남길 수 있어요.
          </aside>
        )
      )}
    </div>
  );
}

function useUndo(item: Item, date: string, etag: string, setDraft: (c: Context | null) => void) {
  const write = useWrite();
  const undo = () => {
    // Undo clears canonical completion details, but keeps them as a local draft.
    setDraft(savedContext(item));
    write.mutate({
      path: `/days/${date}/habits/${item.habit_id}/execution`,
      method: 'PUT',
      body: { status: 'incomplete', ...EMPTY_CONTEXT },
      etag,
    });
  };
  return { write, undo };
}

function HabitRow({
  item,
  scheduledTime,
  others,
  date,
  timezone,
  etag,
  selected,
  select,
  setDraft,
}: {
  item: Item;
  scheduledTime: string | null;
  others: string[];
  date: string;
  timezone: string;
  etag: string;
  selected: boolean;
  select: (open: boolean) => void;
  setDraft: (c: Context | null) => void;
}) {
  const { write, undo } = useUndo(item, date, etag, setDraft);
  const complete = isComplete(item);
  const e = item.execution;
  const logged =
    complete &&
    !!(
      e?.duration_seconds !== null ||
      e?.actual_amount ||
      e?.difficulty_or_quality ||
      e?.energy_note
    );
  const meta = [
    item.habit.minimum_duration_seconds !== null &&
      `최소 ${minutes(item.habit.minimum_duration_seconds)}`,
    item.habit.target_amount !== null &&
      `목표 ${item.habit.target_amount}${item.habit.unit ? ` ${item.habit.unit}` : ''}`,
    others.length > 0 && `${others.join(', ')}에도 포함`,
  ].filter(Boolean);
  return (
    <article className={`${styles.habitRow} ${selected ? styles.rowSelected : ''}`}>
      <div className={styles.rowMain}>
        <button
          className={styles.check}
          disabled={write.isPending}
          aria-label={`${item.habit.name} ${complete ? '완료 취소' : '완료'}`}
          aria-pressed={complete}
          onClick={() => (complete ? undo() : select(true))}
        >
          <span className={complete ? styles.checkDone : styles.checkOpen}>
            {complete && <Icon name="check" size={14} strokeWidth={3} />}
          </span>
        </button>
        <div className={styles.rowBody}>
          <h3>
            <button
              className={styles.rowOpen}
              aria-expanded={selected}
              onClick={() => select(!selected)}
            >
              {item.habit.name}
            </button>
          </h3>
          {(meta.length > 0 || item.quota) && (
            <p className={styles.rowMeta}>
              {item.quota && <span className={styles.quotaPill}>{quotaText(item.quota)}</span>}
              {meta.length > 0 && <span className={styles.metaText}>{meta.join(' · ')}</span>}
            </p>
          )}
        </div>
        {logged && (
          <span className={styles.loggedIcon} title="세부 기록 있음">
            <Icon name="note" size={15} />
          </span>
        )}
        <span className={complete ? styles.rowTimeDone : styles.rowTime}>
          {write.isPending
            ? '저장 중…'
            : complete && e?.completed_at
              ? clockTime(e.completed_at, timezone)
              : (scheduledTime ?? '언제든')}
        </span>
      </div>
      <ErrorBox error={write.error} />
    </article>
  );
}

function DetailsPanel({
  item,
  date,
  timezone,
  etag,
  draft,
  setDraft,
  close,
}: {
  item: Item;
  date: string;
  timezone: string;
  etag: string;
  draft: Context | null;
  setDraft: (c: Context | null) => void;
  close: () => void;
}) {
  const write = useWrite();
  const { write: undoWrite, undo } = useUndo(item, date, etag, setDraft);
  const panel = useRef<HTMLElement>(null);
  const fields = useRef<HTMLDivElement>(null);
  const complete = isComplete(item);
  const e = item.execution;
  const context = complete ? savedContext(item) : (draft ?? savedContext(item));
  const busy = write.isPending || undoWrite.isPending;
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
  }, []);
  const saveAndComplete = () => {
    if (fields.current)
      for (const input of fields.current.querySelectorAll('input, textarea'))
        if (!(input as HTMLInputElement | HTMLTextAreaElement).reportValidity()) return;
    write.mutate(
      {
        path: `/days/${date}/habits/${item.habit_id}/execution`,
        method: 'PUT',
        body: { status: 'completed', ...context },
        etag,
      },
      {
        onSuccess: () => {
          setDraft(null);
          close();
        },
      },
    );
  };
  const h = item.habit;
  const sub = [
    scheduleLabel(h.schedule.rule),
    item.scheduled_time,
    h.minimum_duration_seconds !== null && `최소 ${minutes(h.minimum_duration_seconds)}`,
    h.target_amount !== null && `목표 ${h.target_amount}${h.unit ? ` ${h.unit}` : ''}`,
  ].filter(Boolean);
  return (
    <>
      <div className={styles.scrim} aria-hidden="true" onClick={close} />
      <aside
        ref={panel}
        tabIndex={-1}
        className={styles.detailsPanel}
        aria-label={`${h.name} 세부 기록`}
        onKeyDown={(ev) => {
          if (ev.key === 'Escape') close();
        }}
      >
        <span className={styles.grabber} aria-hidden="true" />
        <header className={styles.detailsHeader}>
          <div>
            <h2>{h.name}</h2>
            <p>{sub.join(' · ')}</p>
          </div>
          <button className={styles.iconButton} aria-label="세부 기록 닫기" onClick={close}>
            <Icon name="close" />
          </button>
        </header>
        {complete && e?.completed_at && (
          <div className={styles.completedBanner}>
            <span className={styles.checkDone}>
              <Icon name="check" size={16} strokeWidth={3} />
            </span>
            <span>
              <strong>{clockTime(e.completed_at, timezone)}에 완료</strong>
              <small>기준 시간 · {timezone}</small>
            </span>
          </div>
        )}
        <div className={styles.detailsBody}>
          {h.description && <p className={styles.description}>{h.description}</p>}
          <p className={styles.hint}>
            {complete
              ? '오늘 세부 기록을 고치려면 완료를 취소한 뒤 다시 저장하고 완료하세요.'
              : '세부 기록은 선택이에요. 비워 두고 저장해도 완료로 기록돼요.'}
          </p>
          <div ref={fields} className={styles.fields}>
            <div className={styles.formRow}>
              <label>
                수행 시간 (분)
                <input
                  disabled={complete || busy}
                  type="number"
                  min="0"
                  step="0.1"
                  placeholder={
                    h.minimum_duration_seconds !== null
                      ? `최소 ${minutes(h.minimum_duration_seconds)}`
                      : undefined
                  }
                  value={context.duration_seconds === null ? '' : context.duration_seconds / 60}
                  onChange={(ev) =>
                    setDraft({
                      ...context,
                      duration_seconds:
                        ev.target.value === '' ? null : Math.round(Number(ev.target.value) * 60),
                    })
                  }
                />
              </label>
              <label>
                실제 수행량{h.unit ? ` (${h.unit})` : ''}
                <input
                  disabled={complete || busy}
                  inputMode="decimal"
                  pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]+)?"
                  placeholder={h.target_amount !== null ? `목표 ${h.target_amount}` : undefined}
                  value={context.actual_amount ?? ''}
                  onChange={(ev) =>
                    setDraft({ ...context, actual_amount: ev.target.value || null })
                  }
                />
              </label>
            </div>
            <label>
              난이도 또는 완성도
              <textarea
                rows={2}
                disabled={complete || busy}
                value={context.difficulty_or_quality ?? ''}
                onChange={(ev) =>
                  setDraft({ ...context, difficulty_or_quality: ev.target.value || null })
                }
              />
            </label>
            <label>
              에너지 메모
              <textarea
                disabled={complete || busy}
                value={context.energy_note ?? ''}
                onChange={(ev) => setDraft({ ...context, energy_note: ev.target.value || null })}
              />
            </label>
          </div>
        </div>
        <ErrorBox error={write.error ?? undoWrite.error} />
        <footer className={styles.detailsFooter}>
          <span className={styles.lockNote}>
            <Icon name="lock" size={14} />
            오늘 기록만 수정할 수 있어요. 지난 날짜는 읽기 전용이에요.
          </span>
          {complete ? (
            <button className={styles.secondary} disabled={busy} onClick={undo}>
              {undoWrite.isPending ? '저장 중…' : '완료 취소'}
            </button>
          ) : (
            <div className={styles.actions}>
              <button className={styles.button} disabled={busy} onClick={saveAndComplete}>
                {write.isPending ? '저장 중…' : '저장하고 완료'}
              </button>
              <button
                className={styles.secondary}
                disabled={busy}
                onClick={() => {
                  setDraft(null);
                  write.reset();
                  close();
                }}
              >
                취소
              </button>
            </div>
          )}
        </footer>
      </aside>
    </>
  );
}
