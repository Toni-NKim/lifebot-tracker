import { usePlannerDraft } from '../lib/planner-store.js';
import { intervalLanes } from '../lib/timebox-layout.js';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Temporal } from '@js-temporal/polyfill';
import { useData } from '../lib/api-client.js';
import { usePlannerWrite, type Agenda } from '../lib/planner-api.js';
import {
  ColorField,
  InboxCapture,
  ModuleSetup,
  PlannerNotice,
} from '../components/PlannerCommon.js';
import { localInput, fromLocal } from './Todos.js';
import type { Placement } from '../../server/services/timebox.js';
import type { ManualData } from '../../shared/contracts/timebox.js';
import { Icon } from '../components/icons.js';
import { longDate, shortDate } from '../lib/format.js';
import { addDays } from '../../shared/domain/index.js';
import styles from '../styles/planner.module.css';
type Plan = Agenda['plans'][number];
type Actual = Agenda['actuals'][number];
interface Editor {
  id: string | null;
  inbox: string | null;
  placement: Placement;
  versions: Agenda['versions'];
}
const minutes = (instant: string, day: string, zone: string) => {
  const t = Temporal.Instant.from(instant).toZonedDateTimeISO(zone);
  const delta = Temporal.PlainDate.from(day).until(t.toPlainDate()).days;
  return Math.max(0, Math.min(1440, delta * 1440 + t.hour * 60 + t.minute + t.second / 60));
};
const stamp = (day: string, minute: number, zone: string) =>
  Temporal.PlainDate.from(day)
    .toZonedDateTime(zone)
    .add({ minutes: minute })
    .toInstant()
    .toString();
// Timeline scale: pixels per minute, and the width of the time gutter.
const PX = 2;
const GUTTER = 56;
const hhmm = (value: string, zone: string) => localInput(value, zone).slice(11);
// "8시간 45분", "45분", "0분".
const durationText = (total: number) =>
  total >= 60
    ? `${Math.floor(total / 60)}시간${total % 60 ? ` ${total % 60}분` : ''}`
    : `${total}분`;
const label = { planned: '계획', ghost: '계획 · 실행 있음', delayed: '지연', missed: '미실행' };
const ink = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return r * 0.299 + g * 0.587 + b * 0.114 > 150 ? '#141421' : '#FFFFFF';
};
const sourceName: Record<string, string> = {
  habit: 'Habit',
  routine: 'Routine',
  todo: 'Todo',
  manual: '자유 일정',
};
export function PlannerPage() {
  const [search, setSearch] = useSearchParams();
  const selectedDay = search.get('date');
  const query = useData<Agenda>(`/agenda${selectedDay ? `?date=${selectedDay}` : ''}`);
  const write = usePlannerWrite('timebox');
  const editorKey = `planner/timebox/${selectedDay ?? 'today'}/editor`;
  const manualKey = `planner/timebox/${selectedDay ?? 'today'}/manual`;
  const [editor, setEditor] = usePlannerDraft<Editor>(editorKey);
  const [selected, setSelected] = useState<Plan | null>(null);
  const [manual, setManual] = usePlannerDraft<{
    id: string | null;
    etag: string;
    data: ManualData;
  }>(manualKey);
  const [undo, setUndo] = useState<{ plan: Plan; habitId?: string; etag: string } | null>(null);
  const [showRail, setShowRail] = useState(false);
  const [localError, setLocalError] = useState('');
  const timeline = useRef<HTMLDivElement>(null),
    editorRef = useRef<HTMLElement>(null);
  const data = query.data?.data;
  const day = data?.date;
  // Open on the hour before the current time today (with some context), otherwise 07:00.
  useEffect(() => {
    if (!timeline.current || !data) return;
    const focus =
      data.date === data.today ? minutes(data.now, data.date, data.timezone) - 90 : 7 * 60;
    timeline.current.scrollTop = Math.max(0, Math.floor(focus / 60) * 60) * PX;
  }, [day]);
  useEffect(() => {
    if (editor || manual || selected) editorRef.current?.scrollIntoView({ block: 'start' });
  }, [!!editor, editor?.id, !!manual, manual?.id, selected?.id]);
  useEffect(() => {
    const candidate = search.get('candidate');
    if (data && candidate && !editor) {
      const c = data.candidates.find((c) => c.key === candidate);
      if (c) {
        setEditor({
          id: null,
          inbox: null,
          versions: data.versions,
          placement: {
            date: data.date,
            candidate,
            title: c.title,
            start: stamp(data.date, 9 * 60, data.timezone),
            end: stamp(data.date, 9 * 60 + 30, data.timezone),
            color: null,
          },
        });
        const next = new URLSearchParams(search);
        next.delete('candidate');
        setSearch(next, { replace: true });
      }
    }
  }, [data, search, setSearch, editor]);
  if (!data)
    return (
      <div className={styles.page}>
        <h1>Today Timebox</h1>
        {query.error ? (
          <>
            <p role="alert">{query.error.message}</p>
            <ModuleSetup />
          </>
        ) : (
          <p>불러오는 중…</p>
        )}
      </div>
    );
  const v = data.versions,
    past = data.date < data.today;
  const selectDate = (value: string) => {
    setSelected(null);
    setEditor(null);
    setManual(null);
    setSearch(value ? { date: value } : {});
  };
  const newPlacement = (key: string | null, minute = 9 * 60, inbox: string | null = null) => {
    const c = data.candidates.find((c) => c.key === key);
    setSelected(null);
    setManual(null);
    setEditor({
      id: null,
      inbox,
      versions: v,
      placement: {
        date: data.date,
        candidate: key,
        title:
          c?.title ?? (inbox ? data.todo.inbox.find((i) => i.id === inbox)?.data.title : '') ?? '',
        start: stamp(data.date, minute, data.timezone),
        end: stamp(
          data.date,
          Math.min(1440, minute + Math.ceil((c?.duration || 1800) / 900) * 15),
          data.timezone,
        ),
        color: null,
      },
    });
  };
  const editPlan = (p: Plan, minute?: number) => {
    setSelected(p);
    setManual(null);
    setEditor({
      id: p.id,
      inbox: null,
      versions: v,
      placement: {
        date: p.data.date,
        candidate: null,
        title: p.data.title,
        start:
          minute === undefined ? p.data.planned_start : stamp(data.date, minute, data.timezone),
        end:
          minute === undefined
            ? p.data.planned_end
            : stamp(
                data.date,
                Math.min(
                  1440,
                  minute +
                    Math.round(
                      (minutes(p.data.planned_end, data.date, data.timezone) -
                        minutes(p.data.planned_start, data.date, data.timezone)) /
                        15,
                    ) *
                      15,
                ),
                data.timezone,
              ),
        color: p.data.color_override,
      },
    });
  };
  const execute = async (
    p: Plan,
    action: 'start' | 'complete' | 'undo',
    habitId?: string,
    baseEtag?: string,
  ) => {
    let saved = false;
    if (p.data.source.type === 'todo')
      saved = await write.run(
        `/todo/items/${p.data.source.id}/execute`,
        {
          anchor_date: p.data.source.anchor_date,
          action,
          plan_ref: { module_id: data.module_ids.timebox, plan_id: p.id, revision: p.revision },
        },
        baseEtag ?? v.todo,
      );
    else if (p.data.source.type === 'manual')
      saved = await write.run(`/timebox/plans/${p.id}/execute`, { action }, baseEtag ?? v.timebox);
    else {
      const id = habitId ?? p.data.source.id;
      saved = await write.run(
        `/days/${p.data.date}/habits/${id}/${action === 'start' ? 'start' : 'execution'}`,
        action === 'start'
          ? {
              plan_ref: { module_id: data.module_ids.timebox, plan_id: p.id, revision: p.revision },
            }
          : {
              status: action === 'complete' ? 'completed' : 'incomplete',
              duration_seconds: null,
              actual_amount: null,
              difficulty_or_quality: null,
              energy_note: null,
            },
        baseEtag ?? v.habit,
        action === 'start' ? 'POST' : 'PUT',
      );
    }
    if (saved) {
      setUndo(action === 'complete' ? { plan: p, habitId, etag: write.lastEtag.current } : null);
      setSelected(null);
      setEditor(null);
    }
  };
  const openActual = (a: Actual) => {
    if (a.source_type !== 'manual') {
      const p = data.plans.find((p) => p.actual_keys.includes(a.key));
      if (p) editPlan(p);
      return;
    }
    setSelected(null);
    setEditor(null);
    setManual({
      id: a.source_id,
      etag: v.timebox,
      data: {
        date: Temporal.Instant.from(a.start!)
          .toZonedDateTimeISO(data.timezone)
          .toPlainDate()
          .toString(),
        title: a.title,
        actual_start: a.start!,
        actual_end: a.end,
        note: a.note,
        plan_id: a.plan_id,
        color: a.color,
        deleted: false,
      },
    });
  };
  const newActual = () => {
    setSelected(null);
    setEditor(null);
    const start = past ? stamp(data.date, 9 * 60, data.timezone) : data.now;
    setManual({
      id: null,
      etag: v.timebox,
      data: {
        date: data.date,
        title: '',
        actual_start: start,
        actual_end: past ? stamp(data.date, 10 * 60, data.timezone) : data.now,
        color: null,
        note: '',
        plan_id: null,
        deleted: false,
      },
    });
  };
  const drag = (e: React.DragEvent, value: string) => {
    e.dataTransfer.setData('text/plain', value);
    e.dataTransfer.effectAllowed = 'copyMove';
  };
  const drop = (value: string, minute: number) => {
    if (past) return;
    if (value.startsWith('plan:')) {
      const p = data.plans.find((p) => p.id === value.slice(5));
      if (p) editPlan(p, minute);
    } else if (value.startsWith('inbox:')) {
      const id = value.slice(6);
      if (data.todo.inbox.some((i) => i.id === id)) newPlacement(null, minute, id);
    } else if (data.candidates.some((c) => c.key === value)) newPlacement(value, minute);
  };
  const actualGroups = new Map(
    data.actuals.map((a) => [
      a.key,
      data.plans.find((p) => p.actual_keys.includes(a.key))?.id ?? a.key,
    ]),
  );
  const groups = data.plans.map((p) => {
    const related = data.actuals.filter((a) => a.start && actualGroups.get(a.key) === p.id);
    return {
      key: p.id,
      start: Math.min(
        minutes(p.data.planned_start, data.date, data.timezone),
        ...related.map((a) => minutes(a.start!, data.date, data.timezone)),
      ),
      end: Math.max(
        minutes(p.data.planned_end, data.date, data.timezone),
        ...related.map((a) =>
          minutes(
            a.end ?? (a.source_type === 'habit' && past ? a.start! : data.now),
            data.date,
            data.timezone,
          ),
        ),
      ),
    };
  });
  for (const a of data.actuals.filter((a) => a.start && actualGroups.get(a.key) === a.key))
    groups.push({
      key: a.key,
      start: minutes(a.start!, data.date, data.timezone),
      end: minutes(
        a.end ?? (a.source_type === 'habit' && past ? a.start! : data.now),
        data.date,
        data.timezone,
      ),
    });
  const lanes = intervalLanes(groups);
  const laneStyle = (key: string, actual = false) => {
    const { lane, count } = lanes.get(key) ?? { lane: 0, count: 1 };
    const laneWidth = `((100% - ${GUTTER + 8}px) / ${count})`;
    const inset = `min(12px, ${laneWidth} * 0.2)`;
    return {
      // An Actual is inset over its Plan by at most 12px, and never more than a fifth of
      // its lane, so in a crowded hour it still stays inside its own lane.
      left: `calc(${GUTTER}px + ${laneWidth} * ${lane} + ${actual ? inset : '0px'})`,
      width: `calc(${laneWidth} - ${actual ? `${inset} - 2px` : '4px'})`,
      right: 'auto',
    };
  };
  const selectedCurrent = selected ? data.plans.find((p) => p.id === selected.id) : null;
  const isToday = data.date === data.today;
  const nowMinute = isToday ? minutes(data.now, data.date, data.timezone) : null;
  const plannedMinutes = Math.round(data.stats.planned_seconds / 60);
  const actualMinutes = Math.round(data.stats.actual_seconds / 60);
  const todoTotal = data.stats.completed_todos + data.stats.incomplete_todos;
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>
            {longDate(data.date)} · 계획과 실제{isToday ? '' : ' · 지난 기록은 읽기 전용'}
          </p>
          <h1>
            <span aria-hidden="true">{isToday ? 'Today' : shortDate(data.date)}</span>
            <span className={styles.srOnly}>{isToday ? 'Today' : data.date} LIFEbot</span>
          </h1>
        </div>
        <div className={styles.headerActions}>
          <div className={styles.dateNav}>
            <button
              type="button"
              className={styles.iconButton}
              aria-label="이전 날"
              onClick={() => selectDate(addDays(data.date, -1))}
            >
              <Icon name="chevronLeft" size={18} />
            </button>
            <span className={styles.dateLabel}>
              {isToday ? '오늘' : shortDate(data.date)}
              <input
                type="date"
                aria-label="날짜"
                value={data.date}
                onChange={(e) => selectDate(e.target.value)}
              />
            </span>
            <button
              type="button"
              className={styles.iconButton}
              aria-label="다음 날"
              onClick={() => selectDate(addDays(data.date, 1))}
            >
              <Icon name="chevronRight" size={18} />
            </button>
          </div>
          {!isToday && (
            <button type="button" className={styles.secondary} onClick={() => selectDate('')}>
              오늘로
            </button>
          )}
          <button
            type="button"
            className={`${styles.primary} ${styles.addPlan}`}
            disabled={past}
            onClick={() => newPlacement(null)}
          >
            <Icon name="plus" size={16} strokeWidth={2.2} />
            <span className={styles.labelWide}>계획 추가</span>
          </button>
        </div>
      </header>
      <section className={styles.summary} aria-label="요약">
        <div>
          <span>계획</span>
          <strong>{durationText(plannedMinutes)}</strong>
          <span className={styles.summaryNote}>{data.plans.length}개 블록</span>
        </div>
        <div>
          <span>실제</span>
          <strong>{durationText(actualMinutes)}</strong>
          <span className={styles.bar} aria-hidden="true">
            <span
              style={{
                width: `${plannedMinutes ? Math.min(100, (actualMinutes / plannedMinutes) * 100) : 0}%`,
              }}
            />
          </span>
        </div>
        <div>
          <span>Todo 완료</span>
          <strong>
            {data.stats.completed_todos}
            <small>/{todoTotal}</small>
          </strong>
          <span className={styles.summaryNote}>남은 {data.stats.incomplete_todos}개</span>
        </div>
        <div className={styles.wideOnly}>
          <span>이번 주 완료</span>
          <strong>{data.stats.week_completed_todos}</strong>
          <span className={styles.summaryNote}>Todo</span>
        </div>
      </section>
      <PlannerNotice write={write} />
      {query.data?.index_warning && (
        <p role="status" className={styles.notice}>
          {query.data.index_warning}
        </p>
      )}
      {localError && (
        <p role="alert" className={styles.notice}>
          {localError}
        </p>
      )}
      {undo && (
        <div className={styles.snackbar} role="status">
          <span>완료했습니다.</span>
          <button
            disabled={write.pending}
            onClick={() => void execute(undo.plan, 'undo', undo.habitId, undo.etag)}
          >
            실행 취소
          </button>
          <button
            className={styles.snackbarClose}
            aria-label="알림 닫기"
            onClick={() => setUndo(null)}
          >
            <Icon name="close" size={18} />
          </button>
        </div>
      )}
      {data.actions.map((a) => (
        <div className={styles.pending} key={a.id}>
          <p>
            <strong>배치 대기 · {a.title}</strong>
            <span className={styles.meta}> Todo는 저장됨</span>
          </p>
          {a.error && <p role="alert">{a.error}</p>}
          <div className={styles.rowActions}>
            <button
              className={`${styles.secondary} ${styles.small}`}
              disabled={write.pending}
              onClick={() =>
                void write.run(
                  `/timebox/actions/${a.id}/resume`,
                  { versions: v, accept_current: false },
                  v.todo,
                )
              }
            >
              중단된 배치 재개
            </button>
            <button
              className={`${styles.secondary} ${styles.small}`}
              disabled={write.pending}
              onClick={() =>
                void write.run(
                  `/timebox/actions/${a.id}/resume`,
                  { versions: v, accept_current: true },
                  v.todo,
                )
              }
            >
              현재 계획을 확인했고 이어서 배치
            </button>
            <button
              className={`${styles.dangerButton} ${styles.small}`}
              disabled={write.pending}
              onClick={() =>
                void write.run(`/timebox/actions/${a.id}/cancel`, { versions: v }, v.todo)
              }
            >
              대기 배치 취소
            </button>
          </div>
        </div>
      ))}
      <div className={styles.mobileBar}>
        <button
          type="button"
          className={styles.railToggle}
          aria-expanded={showRail}
          onClick={() => setShowRail(!showRail)}
        >
          <Icon name="inbox" size={18} />
          {showRail ? '후보 / Inbox 접기' : '후보 / Inbox 펼치기'}
          <span className={styles.count} aria-hidden="true">
            {data.todo.inbox.length}
          </span>
          <Icon name={showRail ? 'chevronUp' : 'chevronDown'} size={16} />
        </button>
      </div>
      <div className={styles.workspace}>
        <aside className={styles.side} aria-label="계획 작업 공간">
          {(editor || manual) && (
            <section
              ref={editorRef}
              className={styles.inspector}
              aria-label={manual ? 'Actual 편집' : '시간 배치'}
              style={
                {
                  '--block-color':
                    (manual ? manual.data.color : editor?.placement.color) ??
                    selectedCurrent?.color ??
                    'var(--accent)',
                } as CSSProperties
              }
            >
              <header className={styles.inspectorHead}>
                <div>
                  <p className={styles.eyebrow}>
                    {manual
                      ? '실제 활동'
                      : selectedCurrent
                        ? `${sourceName[selectedCurrent.data.source.type]} · ${label[selectedCurrent.state as keyof typeof label]}`
                        : editor?.inbox
                          ? 'Inbox → Todo → Plan'
                          : '새 계획'}
                  </p>
                  <h2>
                    {manual
                      ? `실제 활동 ${manual.id ? '수정' : '추가'}`
                      : editor!.id
                        ? editor!.placement.title
                        : editor!.inbox
                          ? 'Inbox → Todo → Plan'
                          : '시간 배치'}
                  </h2>
                </div>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label="닫기"
                  onClick={() => {
                    setEditor(null);
                    setManual(null);
                    setSelected(null);
                  }}
                >
                  <Icon name="close" size={18} />
                </button>
              </header>
              {editor && selectedCurrent && (
                <div className={styles.execution}>
                  <h3>실행 · {sourceName[selectedCurrent.data.source.type]}</h3>
                  {selectedCurrent.data.source.type === 'routine' ? (
                    selectedCurrent.data.source.habit_ids.map((id) => {
                      const item = data.habits.items.find((i) => i.habit_id === id);
                      return (
                        <div className={styles.executionRow} key={id}>
                          <span>{item?.habit.name ?? 'Habit'}</span>
                          <ExecutionButtons
                            disabled={write.pending || data.date !== data.today}
                            started={!!item?.execution?.actual_start}
                            completed={item?.execution?.status === 'completed'}
                            onAction={(a) => void execute(selectedCurrent, a, id)}
                          />
                        </div>
                      );
                    })
                  ) : (
                    <ExecutionButtons
                      disabled={
                        write.pending ||
                        (selectedCurrent.data.source.type === 'habit' && data.date !== data.today)
                      }
                      started={selectedCurrent.execution_started}
                      completed={selectedCurrent.execution_completed}
                      onAction={(a) => void execute(selectedCurrent, a)}
                    />
                  )}
                </div>
              )}
              {editor && (
                <form
                  className={styles.form}
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const path = editor.inbox
                      ? `/timebox/inbox/${editor.inbox}/plan`
                      : `/timebox/plans${editor.id ? `/${editor.id}` : ''}`;
                    await write.run(
                      path,
                      { placement: editor.placement, versions: editor.versions },
                      editor.inbox ? editor.versions.todo : editor.versions.timebox,
                      editor.id ? 'PUT' : 'POST',
                      () => setSelected(null),
                      { key: editorKey, value: editor },
                    );
                  }}
                >
                  <label>
                    일정 제목
                    <input
                      required
                      value={editor.placement.title}
                      disabled={!!editor.id || !!editor.inbox || !!editor.placement.candidate}
                      onChange={(e) =>
                        setEditor({
                          ...editor,
                          placement: { ...editor.placement, title: e.target.value },
                        })
                      }
                    />
                  </label>
                  <div className={styles.fields}>
                    {(['start', 'end'] as const).map((field) => (
                      <label key={field}>
                        {field === 'start' ? '계획 시작' : '계획 종료'}
                        <input
                          type="datetime-local"
                          required
                          step={900}
                          disabled={past}
                          value={localInput(editor.placement[field], data.timezone)}
                          onChange={(e) => {
                            try {
                              const value = fromLocal(e.target.value, data.timezone);
                              if (value)
                                setEditor({
                                  ...editor,
                                  placement: { ...editor.placement, [field]: value },
                                });
                              setLocalError('');
                            } catch {
                              setLocalError('유효한 현지 시각을 입력해 주세요.');
                            }
                          }}
                        />
                      </label>
                    ))}
                  </div>
                  <ColorField
                    value={editor.placement.color}
                    onChange={(color) =>
                      setEditor({ ...editor, placement: { ...editor.placement, color } })
                    }
                  />
                  <div className={styles.formActions}>
                    <button className={styles.primary} disabled={past || write.pending}>
                      계획 저장
                    </button>
                    {editor.id && (
                      <button
                        type="button"
                        className={styles.dangerButton}
                        disabled={past || write.pending}
                        onClick={async () => {
                          if (
                            await write.run(
                              `/timebox/plans/${editor.id}`,
                              {},
                              editor.versions.timebox,
                              'DELETE',
                            )
                          ) {
                            setEditor(null);
                            setSelected(null);
                          }
                        }}
                      >
                        계획 취소
                      </button>
                    )}
                  </div>
                  {editor.id && (
                    <p className={styles.meta}>
                      수정 이력 {selectedCurrent?.revision_count ?? 1}개 · Habit/Todo의 반복 시각은
                      바뀌지 않습니다.
                    </p>
                  )}
                </form>
              )}
              {manual && (
                <form
                  className={styles.form}
                  onSubmit={async (e) => {
                    e.preventDefault();
                    await write.run(
                      `/timebox/actuals${manual.id ? `/${manual.id}` : ''}`,
                      manual.data,
                      manual.etag,
                      manual.id ? 'PUT' : 'POST',
                      undefined,
                      { key: manualKey, value: manual },
                    );
                  }}
                >
                  <label>
                    활동 제목
                    <input
                      required
                      value={manual.data.title}
                      onChange={(e) =>
                        setManual({ ...manual, data: { ...manual.data, title: e.target.value } })
                      }
                    />
                  </label>
                  <div className={styles.fields}>
                    {(['actual_start', 'actual_end'] as const).map((field) => (
                      <label key={field}>
                        {field === 'actual_start' ? '실제 시작' : '실제 종료 · 비우면 실행 중'}
                        <input
                          type="datetime-local"
                          step="1"
                          required={field === 'actual_start'}
                          value={
                            manual.data[field]
                              ? Temporal.Instant.from(manual.data[field]!)
                                  .toZonedDateTimeISO(data.timezone)
                                  .toPlainDateTime()
                                  .toString({ smallestUnit: 'second' })
                              : ''
                          }
                          onChange={(e) => {
                            try {
                              const value = fromLocal(e.target.value, data.timezone);
                              if (field === 'actual_start' && !value) return;
                              setManual({
                                ...manual,
                                data: {
                                  ...manual.data,
                                  [field]: value,
                                  ...(field === 'actual_start' && value
                                    ? {
                                        date: Temporal.Instant.from(value)
                                          .toZonedDateTimeISO(data.timezone)
                                          .toPlainDate()
                                          .toString(),
                                      }
                                    : {}),
                                },
                              });
                              setLocalError('');
                            } catch {
                              setLocalError('유효한 시각을 입력해 주세요.');
                            }
                          }}
                        />
                      </label>
                    ))}
                  </div>
                  <label>
                    메모
                    <textarea
                      rows={2}
                      value={manual.data.note}
                      onChange={(e) =>
                        setManual({ ...manual, data: { ...manual.data, note: e.target.value } })
                      }
                    />
                  </label>
                  <ColorField
                    value={manual.data.color}
                    onChange={(color) => setManual({ ...manual, data: { ...manual.data, color } })}
                  />
                  <div className={styles.formActions}>
                    <button className={styles.primary} disabled={write.pending}>
                      실제 활동 저장
                    </button>
                    {manual.id && (
                      <button
                        type="button"
                        className={styles.dangerButton}
                        disabled={write.pending}
                        onClick={async () => {
                          if (
                            await write.run(
                              `/timebox/actuals/${manual.id}`,
                              { ...manual.data, deleted: true },
                              manual.etag,
                              'PUT',
                            )
                          )
                            setManual(null);
                        }}
                      >
                        실제 활동 삭제
                      </button>
                    )}
                  </div>
                </form>
              )}
            </section>
          )}
          <div className={`${styles.planning} ${showRail ? styles.planningOpen : ''}`}>
            <section className={styles.panel}>
              <div className={styles.panelTitle}>
                <h2>
                  <Icon name="pin" size={16} />
                  Top 3
                </h2>
                <span>{data.priorities.length}/3</span>
              </div>
              {data.priorities.length === 0 ? (
                <p className={styles.muted}>
                  오늘 계획을 준비한 뒤 중요한 Todo를 최대 3개 고정하세요.
                </p>
              ) : (
                <ol className={styles.priorities}>
                  {data.priorities.map((id, n) => {
                    const i = data.todo.items.find((i) => i.id === id);
                    const color =
                      data.candidates.find((c) => c.source.occurrence_id === id)?.color ??
                      'var(--accent)';
                    const done = !!i?.execution?.completed_at;
                    return (
                      <li key={id} data-done={done || undefined}>
                        <span className={styles.rank} aria-hidden="true">
                          {done ? <Icon name="check" size={13} strokeWidth={3} /> : n + 1}
                        </span>
                        <span
                          className={styles.dot}
                          style={{ '--dot': color } as CSSProperties}
                          aria-hidden="true"
                        />
                        <span className={styles.priorityTitle}>
                          {i?.data.title ?? 'Todo'}
                          {done && <span className={styles.srOnly}> · 완료</span>}
                        </span>
                        <button
                          className={styles.iconButton}
                          disabled={write.pending || past}
                          aria-label={`${i?.data.title ?? 'Todo'} 고정 해제`}
                          onClick={() =>
                            void write.run(
                              '/timebox/priorities',
                              {
                                date: data.date,
                                ids: data.priorities.filter((v) => v !== id),
                                versions: v,
                              },
                              v.timebox,
                            )
                          }
                        >
                          <Icon name="close" size={16} />
                        </button>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>
            <section className={styles.panel}>
              <div className={styles.panelTitle}>
                <h2>
                  <Icon name="inbox" size={16} />
                  Inbox
                  <span className={styles.panelKicker}>Brain Dump</span>
                </h2>
                <span>{data.todo.inbox.length}개</span>
              </div>
              <InboxCapture etag={v.todo} write={write} compact />
              {data.todo.inbox.length > 0 && (
                <div className={styles.rows}>
                  {data.todo.inbox.map((i) => (
                    <article
                      key={i.id}
                      className={styles.itemRow}
                      draggable={!past}
                      onDragStart={(e) => drag(e, `inbox:${i.id}`)}
                    >
                      <div className={styles.itemBody}>
                        <h3>{i.data.title}</h3>
                        <p className={styles.meta}>{i.age_days + 1}일째</p>
                      </div>
                      <button
                        className={`${styles.secondary} ${styles.small}`}
                        disabled={past}
                        onClick={() => newPlacement(null, 9 * 60, i.id)}
                      >
                        시간 배치
                      </button>
                    </article>
                  ))}
                </div>
              )}
            </section>
            <section className={styles.panel}>
              <div className={styles.panelTitle}>
                <h2>배치 후보</h2>
                <span>끌어서 타임라인에 놓기</span>
              </div>
              {data.candidates.length === 0 && (
                <p className={styles.muted}>오늘 배치할 Habit·Routine·Todo가 없어요.</p>
              )}
              <div className={styles.rows}>
                {data.candidates.map((c) => (
                  <article
                    key={c.key}
                    className={styles.itemRow}
                    draggable={!past}
                    onDragStart={(e) => drag(e, c.key)}
                  >
                    <span
                      className={`${styles.dot} ${styles.dotSolid}`}
                      style={{ '--dot': c.color ?? 'var(--accent)' } as CSSProperties}
                      aria-hidden="true"
                    />
                    <div className={styles.itemBody}>
                      <h3>{c.title}</h3>
                      <p className={styles.meta}>
                        {sourceName[c.source.type]} · {c.time ?? '시간 미지정'}
                      </p>
                    </div>
                    <div className={styles.rowActions}>
                      {c.source.type === 'todo' &&
                        !data.priorities.includes(c.source.occurrence_id!) && (
                          <button
                            className={`${styles.ghostButton} ${styles.small}`}
                            disabled={
                              write.pending ||
                              !data.prepared ||
                              data.date !== data.today ||
                              data.priorities.length >= 3
                            }
                            onClick={() =>
                              void write.run(
                                '/timebox/priorities',
                                {
                                  date: data.date,
                                  ids: [...data.priorities, c.source.occurrence_id],
                                  versions: v,
                                },
                                v.timebox,
                              )
                            }
                          >
                            Top 3 고정
                          </button>
                        )}
                      <button
                        className={`${styles.secondary} ${styles.small}`}
                        disabled={past}
                        onClick={() => newPlacement(c.key)}
                      >
                        시간 배치
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </div>
        </aside>
        <section className={styles.timelineCard} aria-label="Timebox">
          <div className={styles.timelineHead}>
            <div>
              <h2>Timebox</h2>
              <p className={`${styles.meta} ${styles.wideOnly}`}>
                {data.timezone} · 15분 단위로 배치
              </p>
            </div>
            <div className={styles.rowActions}>
              {isToday && !data.prepared && (
                <button
                  className={`${styles.primary} ${styles.small}`}
                  disabled={write.pending}
                  onClick={() =>
                    void write.run('/timebox/prepare', { date: data.date, versions: v }, v.timebox)
                  }
                >
                  오늘 계획 준비
                </button>
              )}
              <button className={`${styles.secondary} ${styles.small}`} onClick={newActual}>
                <Icon name="plus" size={14} strokeWidth={2.2} />
                실제 활동 추가
              </button>
            </div>
          </div>
          <ul className={styles.legend} aria-label="범례">
            <li>
              <span className={styles.keyPlan} aria-hidden="true" />
              계획
            </li>
            <li>
              <span className={styles.keyGhost} aria-hidden="true" />
              실행된 계획
            </li>
            <li>
              <span className={styles.keyActual} aria-hidden="true" />
              실제
            </li>
            <li>
              <span className={styles.keyMissed} aria-hidden="true" />
              미실행
            </li>
          </ul>
          {!data.prepared && (
            <p className={styles.hint}>
              {past
                ? '이 날짜에는 자동 계획을 준비한 기록이 없습니다.'
                : '오늘 계획 준비를 누르면 예정 시각이 있는 Habit/Routine/Todo 계획을 저장합니다.'}
            </p>
          )}
          <div ref={timeline} className={styles.timelineScroll}>
            <div className={styles.timeline} style={{ height: 1440 * PX }}>
              {Array.from({ length: 48 }, (_, i) => {
                const time = `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`;
                return (
                  <div
                    key={i}
                    className={`${styles.tick} ${i % 2 ? styles.tickHalf : ''}`}
                    style={{ top: i * 30 * PX }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const rect = e.currentTarget.getBoundingClientRect();
                      drop(
                        e.dataTransfer.getData('text/plain'),
                        i * 30 + (e.clientY - rect.top >= 15 * PX ? 15 : 0),
                      );
                    }}
                  >
                    {i % 2 === 0 && <span className={styles.tickLabel}>{time}</span>}
                    <button
                      aria-label={`${time}에 계획 추가`}
                      disabled={past}
                      onClick={() => newPlacement(null, i * 30)}
                    />
                  </div>
                );
              })}
              {nowMinute !== null && (
                <div className={styles.now} style={{ top: nowMinute * PX }} aria-hidden="true">
                  <span>{hhmm(data.now, data.timezone)}</span>
                </div>
              )}
              {data.plans.map((p) => {
                const start = minutes(p.data.planned_start, data.date, data.timezone);
                const height = (minutes(p.data.planned_end, data.date, data.timezone) - start) * PX;
                const time = `${hhmm(p.data.planned_start, data.timezone)}–${hhmm(p.data.planned_end, data.timezone)}`;
                const state = label[p.state as keyof typeof label];
                return (
                  <div
                    key={p.id}
                    className={styles.block}
                    data-kind="plan"
                    data-state={p.state}
                    data-compact={height < 44 || undefined}
                    draggable={!past}
                    onDragStart={(e) => drag(e, `plan:${p.id}`)}
                    style={
                      {
                        top: start * PX,
                        height,
                        '--block-color': p.color,
                        '--block-ink': ink(p.color),
                        ...laneStyle(p.id),
                      } as CSSProperties
                    }
                  >
                    <button
                      aria-label={`${p.data.title} · ${sourceName[p.data.source.type]} · ${time} · ${state}`}
                      onClick={() => editPlan(p)}
                    >
                      <span className={styles.blockTitle}>
                        {p.data.title}
                        {p.progress && (
                          <span className={styles.blockCount}>
                            {p.progress.completed}/{p.progress.total}
                          </span>
                        )}
                      </span>
                      <span className={styles.blockMeta}>
                        {time} · {sourceName[p.data.source.type]}
                        {(p.state === 'delayed' || p.state === 'missed') && (
                          <span className={styles.tag}>
                            {p.state === 'delayed' ? '지연' : '미실행'}
                          </span>
                        )}
                      </span>
                    </button>
                  </div>
                );
              })}
              {data.actuals
                .filter((a) => a.start)
                .map((a) => {
                  const start = minutes(a.start!, data.date, data.timezone);
                  const open = !a.end;
                  const unknownEnd = open && a.source_type === 'habit' && past;
                  const height = Math.max(
                    28,
                    (minutes(
                      a.end ?? (unknownEnd ? a.start! : data.now),
                      data.date,
                      data.timezone,
                    ) -
                      start) *
                      PX,
                  );
                  const linked =
                    !!a.plan_id || data.plans.some((p) => p.actual_keys.includes(a.key));
                  const time = `${hhmm(a.start!, data.timezone)}–${a.end ? hhmm(a.end, data.timezone) : unknownEnd ? '종료 미기록' : '실행 중'}`;
                  return (
                    <div
                      key={a.key}
                      className={styles.block}
                      data-kind="actual"
                      data-running={(open && !unknownEnd) || undefined}
                      data-unplanned={!linked || undefined}
                      data-compact={height < 44 || undefined}
                      style={
                        {
                          top: start * PX,
                          height,
                          '--block-color': a.color,
                          '--block-ink': ink(a.color),
                          ...laneStyle(actualGroups.get(a.key)!, true),
                        } as CSSProperties
                      }
                    >
                      <button
                        aria-label={`${a.title} · Actual · ${time} · ${linked ? '계획 연결' : '계획 외 활동'}`}
                        onClick={() => openActual(a)}
                      >
                        <span className={styles.blockTitle}>
                          <span className={styles.mark} aria-hidden="true">
                            {open && !unknownEnd ? (
                              <span className={styles.pulse} />
                            ) : (
                              <Icon name="check" size={12} strokeWidth={3} />
                            )}
                          </span>
                          {a.title}
                        </span>
                        <span className={styles.blockMeta}>
                          {time}
                          {!linked && <span className={styles.tag}>계획 외</span>}
                        </span>
                      </button>
                    </div>
                  );
                })}
            </div>
          </div>
          <details className={styles.listDetails}>
            <summary>
              Plan / Actual 목록 · 겹친 일정과 빠른 완료
              <Icon name="chevronDown" size={16} />
            </summary>
            {data.plans.map((p) => (
              <div key={p.id} className={styles.listRow}>
                <span
                  className={styles.dot}
                  style={
                    {
                      '--dot': p.state === 'missed' ? 'var(--text-disabled)' : p.color,
                    } as CSSProperties
                  }
                  aria-hidden="true"
                />
                <span className={styles.listText}>
                  {p.data.title} · {label[p.state as keyof typeof label]}
                  <small>
                    계획 {hhmm(p.data.planned_start, data.timezone)}–
                    {hhmm(p.data.planned_end, data.timezone)}
                  </small>
                </span>
                <button
                  className={`${styles.ghostButton} ${styles.small}`}
                  onClick={() => editPlan(p)}
                >
                  계획 열기
                </button>
              </div>
            ))}
            {data.actuals.map((a) => (
              <div key={a.key} className={styles.listRow}>
                <span
                  className={`${styles.dot} ${styles.dotSolid}`}
                  style={{ '--dot': a.color } as CSSProperties}
                  aria-hidden="true"
                />
                <span className={styles.listText}>
                  {a.title} ·{' '}
                  {a.start
                    ? `${hhmm(a.start, data.timezone)}–${a.end ? hhmm(a.end, data.timezone) : a.source_type === 'habit' && past ? '종료 미기록' : '실행 중'}`
                    : '빠른 완료 · 시각 미기록'}
                  <small>실제</small>
                </span>
                <button
                  className={`${styles.ghostButton} ${styles.small}`}
                  onClick={() => openActual(a)}
                >
                  실행 열기
                </button>
              </div>
            ))}
            {data.plans.length === 0 && data.actuals.length === 0 && (
              <p className={styles.muted}>아직 이 날의 계획이나 실제 기록이 없어요.</p>
            )}
          </details>
        </section>
      </div>
    </div>
  );
}
function ExecutionButtons({
  disabled,
  started,
  completed,
  onAction,
}: {
  disabled: boolean;
  started: boolean;
  completed: boolean;
  onAction: (action: 'start' | 'complete' | 'undo') => void;
}) {
  return (
    <div className={styles.rowActions}>
      <button
        className={`${styles.secondary} ${styles.small}`}
        disabled={disabled || started || completed}
        onClick={() => onAction('start')}
      >
        <Icon name="play" size={12} strokeWidth={2.2} />
        {started ? '시작됨' : '시작'}
      </button>
      <button
        className={`${styles.primary} ${styles.small}`}
        disabled={disabled || completed}
        onClick={() => onAction('complete')}
      >
        완료
      </button>
      <button
        className={`${styles.ghostButton} ${styles.small}`}
        disabled={disabled || (!completed && !started)}
        onClick={() => onAction('undo')}
      >
        실행 취소
      </button>
    </div>
  );
}
