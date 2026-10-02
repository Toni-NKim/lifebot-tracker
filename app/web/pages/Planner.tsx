import { intervalLanes } from '../lib/timebox-layout.js';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
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
const hhmm = (value: string, zone: string) => localInput(value, zone).slice(11);
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
  const write = usePlannerWrite();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [selected, setSelected] = useState<Plan | null>(null);
  const [manual, setManual] = useState<{
    id: string | null;
    etag: string;
    data: ManualData;
  } | null>(null);
  const [undo, setUndo] = useState<{ plan: Plan; habitId?: string; etag: string } | null>(null);
  const [showRail, setShowRail] = useState(false);
  const [localError, setLocalError] = useState('');
  const timeline = useRef<HTMLDivElement>(null),
    editorRef = useRef<HTMLElement>(null);
  const data = query.data?.data;
  const day = data?.date;
  useEffect(() => {
    if (timeline.current) timeline.current.scrollTop = 7 * 120;
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
    return {
      left: `calc(64px + (100% - 78px) * ${lane} / ${count} + ${actual ? 8 : 0}px)`,
      width: `calc((100% - 78px) / ${count} - ${actual ? 10 : 3}px)`,
      right: 'auto',
    };
  };
  const selectedCurrent = selected ? data.plans.find((p) => p.id === selected.id) : null;
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>
            {data.date === data.today ? 'Today' : data.date}{' '}
            <span className={styles.meta}>LIFEbot</span>
          </h1>
          <p className={styles.meta}>오늘의 계획과 실제로 보낸 시간 · {data.timezone}</p>
        </div>
        <div className={styles.actions}>
          <label>
            날짜
            <input type="date" value={data.date} onChange={(e) => selectDate(e.target.value)} />
          </label>
          <Link to="/todos">Todo / Inbox</Link>
          <Link to="/habits/today">Habit 대시보드</Link>
        </div>
      </header>
      <PlannerNotice write={write} />
      {query.data?.index_warning && (
        <p role="status" className={styles.notice}>
          {query.data.index_warning}
        </p>
      )}
      {localError && <p role="alert">{localError}</p>}
      {undo && (
        <div className={styles.notice} role="status">
          완료했습니다.{' '}
          <button
            disabled={write.pending}
            onClick={() => void execute(undo.plan, 'undo', undo.habitId, undo.etag)}
          >
            실행 취소
          </button>
        </div>
      )}
      {data.actions.map((a) => (
        <div className={styles.notice} key={a.id}>
          <p>배치 대기: {a.title} · Todo는 저장됨</p>
          {a.error && <p role="alert">{a.error}</p>}
          <button
            disabled={write.pending}
            onClick={() =>
              void write.run(`/timebox/actions/${a.id}/cancel`, { versions: v }, v.todo)
            }
          >
            대기 배치 취소
          </button>
          <button
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
        </div>
      ))}
      <div className={styles.stats}>
        {[
          ['계획', `${Math.round(data.stats.planned_seconds / 60)}분`],
          ['실제', `${Math.round(data.stats.actual_seconds / 60)}분`],
          ['완료 Todo', data.stats.completed_todos],
          ['미완료 Todo', data.stats.incomplete_todos],
          ['이번 주 완료', data.stats.week_completed_todos],
        ].map(([title, value]) => (
          <div key={title}>
            <span className={styles.meta}>{title}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      {(editor || manual) && (
        <section
          ref={editorRef}
          className={`${styles.panel} ${styles.editor}`}
          aria-label={manual ? 'Actual 편집' : '시간 배치'}
        >
          {editor && (
            <>
              <h2>
                {editor.id
                  ? editor.placement.title
                  : editor.inbox
                    ? 'Inbox → Todo → Plan'
                    : '시간 배치'}
              </h2>
              <form
                className={styles.form}
                onSubmit={async (e) => {
                  e.preventDefault();
                  const path = editor.inbox
                    ? `/timebox/inbox/${editor.inbox}/plan`
                    : `/timebox/plans${editor.id ? `/${editor.id}` : ''}`;
                  if (
                    await write.run(
                      path,
                      { placement: editor.placement, versions: editor.versions },
                      editor.inbox ? editor.versions.todo : editor.versions.timebox,
                      editor.id ? 'PUT' : 'POST',
                    )
                  ) {
                    setEditor(null);
                    setSelected(null);
                  }
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
                <div className={styles.actions}>
                  <button disabled={past || write.pending}>계획 저장</button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditor(null);
                      setSelected(null);
                    }}
                  >
                    닫기
                  </button>
                  {editor.id && (
                    <button
                      type="button"
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
            </>
          )}
          {selectedCurrent && (
            <div className={styles.list}>
              <h3>실행 · {sourceName[selectedCurrent.data.source.type]}</h3>
              {selectedCurrent.data.source.type === 'routine' ? (
                selectedCurrent.data.source.habit_ids.map((id) => {
                  const item = data.habits.items.find((i) => i.habit_id === id);
                  return (
                    <div className={styles.row} key={id}>
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
          {manual && (
            <>
              <h2>실제 활동 {manual.id ? '수정' : '추가'}</h2>
              <form
                className={styles.form}
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (
                    await write.run(
                      `/timebox/actuals${manual.id ? `/${manual.id}` : ''}`,
                      manual.data,
                      manual.etag,
                      manual.id ? 'PUT' : 'POST',
                    )
                  )
                    setManual(null);
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
                <div className={styles.actions}>
                  <button disabled={write.pending}>실제 활동 저장</button>
                  <button type="button" onClick={() => setManual(null)}>
                    닫기
                  </button>
                  {manual.id && (
                    <button
                      type="button"
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
            </>
          )}
        </section>
      )}
      <button className={styles.mobileOnly} onClick={() => setShowRail(!showRail)}>
        {showRail ? '후보 / Inbox 접기' : '후보 / Inbox 펼치기'}
      </button>
      <div className={styles.grid}>
        <aside className={`${styles.rail} ${showRail ? '' : styles.railClosed}`}>
          <section className={styles.panel}>
            <h2>Top 3</h2>
            {data.priorities.map((id, n) => {
              const i = data.todo.items.find((i) => i.id === id);
              return (
                <div key={id}>
                  {n + 1}. {i?.data.title ?? 'Todo'} {i?.execution?.completed_at && '✓'}
                  <button
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
                    해제
                  </button>
                </div>
              );
            })}
            {data.priorities.length === 0 && (
              <p className={styles.meta}>
                오늘 계획을 준비한 뒤 중요한 Todo를 최대 3개 고정하세요.
              </p>
            )}
          </section>
          <section className={styles.panel}>
            <h2>Inbox</h2>
            <InboxCapture etag={v.todo} write={write} />
            {data.todo.inbox.map((i) => (
              <article
                key={i.id}
                className={styles.item}
                draggable={!past}
                onDragStart={(e) => drag(e, `inbox:${i.id}`)}
              >
                <h3>{i.data.title}</h3>
                <p className={styles.meta}>{i.age_days + 1}일째</p>
                <button disabled={past} onClick={() => newPlacement(null, 9 * 60, i.id)}>
                  시간 배치
                </button>
              </article>
            ))}
          </section>
          <section className={styles.panel}>
            <h2>Priorities · 배치 후보</h2>
            {data.candidates.map((c) => (
              <article
                key={c.key}
                className={styles.item}
                draggable={!past}
                onDragStart={(e) => drag(e, c.key)}
              >
                <h3>{c.title}</h3>
                <p className={styles.meta}>
                  {sourceName[c.source.type]} · {c.time ?? '시간 미지정'}
                </p>
                <div className={styles.actions}>
                  <button disabled={past} onClick={() => newPlacement(c.key)}>
                    시간 배치
                  </button>
                  {c.source.type === 'todo' &&
                    !data.priorities.includes(c.source.occurrence_id!) && (
                      <button
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
                </div>
              </article>
            ))}
          </section>
        </aside>
        <section className={styles.list} aria-label="Timebox">
          <div className={styles.header}>
            <h2>Timebox</h2>
            <div className={styles.actions}>
              {data.date === data.today && !data.prepared && (
                <button
                  disabled={write.pending}
                  onClick={() =>
                    void write.run('/timebox/prepare', { date: data.date, versions: v }, v.timebox)
                  }
                >
                  오늘 계획 준비
                </button>
              )}
              <button disabled={past} onClick={() => newPlacement(null)}>
                계획 추가
              </button>
              <button onClick={newActual}>실제 활동 추가</button>
            </div>
          </div>
          <div className={styles.legend}>
            <span>░ Plan</span>
            <span>█ Actual</span>
            <span>회색 = 미실행</span>
            <span>배치 15분 · 눈금 30분</span>
          </div>
          {!data.prepared && (
            <p className={styles.meta}>
              {past
                ? '이 날짜에는 자동 계획을 준비한 기록이 없습니다.'
                : '오늘 계획 준비를 누르면 예정 시각이 있는 Habit/Routine/Todo 계획을 저장합니다.'}
            </p>
          )}
          <div ref={timeline} className={styles.timelineWrap}>
            <div className={styles.timeline}>
              {Array.from({ length: 48 }, (_, i) => (
                <div
                  key={i}
                  className={styles.tick}
                  style={{ top: i * 60 }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const rect = e.currentTarget.getBoundingClientRect();
                    drop(
                      e.dataTransfer.getData('text/plain'),
                      i * 30 + (e.clientY - rect.top >= 30 ? 15 : 0),
                    );
                  }}
                >
                  <span>
                    {String(Math.floor(i / 2)).padStart(2, '0')}:{i % 2 ? '30' : '00'}
                  </span>
                  <button
                    aria-label={`${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}에 계획 추가`}
                    disabled={past}
                    onClick={() => newPlacement(null, i * 30)}
                  />
                </div>
              ))}
              {data.plans.map((p, index) => (
                <div
                  key={p.id}
                  className={styles.block}
                  data-state={p.state}
                  draggable={!past}
                  onDragStart={(e) => drag(e, `plan:${p.id}`)}
                  style={
                    {
                      top: minutes(p.data.planned_start, data.date, data.timezone) * 2,
                      height:
                        (minutes(p.data.planned_end, data.date, data.timezone) -
                          minutes(p.data.planned_start, data.date, data.timezone)) *
                        2,
                      '--block-color': p.color,
                      '--block-ink': ink(p.color),
                      ...laneStyle(p.id),
                    } as CSSProperties
                  }
                >
                  <button onClick={() => editPlan(p)}>
                    <strong>
                      {p.data.title} · {sourceName[p.data.source.type]}
                      {p.progress ? ` · ${p.progress.completed}/${p.progress.total}` : ''}
                    </strong>
                    <small>
                      {hhmm(p.data.planned_start, data.timezone)}–
                      {hhmm(p.data.planned_end, data.timezone)} ·{' '}
                      {label[p.state as keyof typeof label]}
                    </small>
                  </button>
                </div>
              ))}
              {data.actuals
                .filter((a) => a.start)
                .map((a, i) => (
                  <div
                    key={a.key}
                    className={`${styles.block} ${styles.actual}`}
                    style={
                      {
                        top: minutes(a.start!, data.date, data.timezone) * 2,
                        height: Math.max(
                          28,
                          (minutes(
                            a.end ?? (a.source_type === 'habit' && past ? a.start! : data.now),
                            data.date,
                            data.timezone,
                          ) -
                            minutes(a.start!, data.date, data.timezone)) *
                            2,
                        ),
                        '--block-color': a.color,
                        '--block-ink': ink(a.color),
                        ...laneStyle(actualGroups.get(a.key)!, true),
                      } as CSSProperties
                    }
                  >
                    <button onClick={() => openActual(a)}>
                      <strong>{a.title} · Actual</strong>
                      <small>
                        {hhmm(a.start!, data.timezone)}–
                        {a.end
                          ? hhmm(a.end, data.timezone)
                          : a.source_type === 'habit' && past
                            ? '종료 미기록'
                            : '실행 중'}{' '}
                        ·{' '}
                        {a.plan_id || data.plans.some((p) => p.actual_keys.includes(a.key))
                          ? '계획 연결'
                          : '계획 외 활동'}
                      </small>
                    </button>
                  </div>
                ))}
            </div>
          </div>
          <details className={styles.panel}>
            <summary>Plan / Actual 목록 · 겹친 일정과 빠른 완료</summary>
            {data.plans.map((p) => (
              <div key={p.id} className={styles.row}>
                {p.data.title} · {label[p.state as keyof typeof label]}
                <button onClick={() => editPlan(p)}>계획 열기</button>
              </div>
            ))}
            {data.actuals.map((a) => (
              <div key={a.key} className={styles.row}>
                {a.title} ·{' '}
                {a.start
                  ? `${hhmm(a.start, data.timezone)}–${a.end ? hhmm(a.end, data.timezone) : a.source_type === 'habit' && past ? '종료 미기록' : '실행 중'}`
                  : '빠른 완료 · 시각 미기록'}
                <button onClick={() => openActual(a)}>실행 열기</button>
              </div>
            ))}
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
    <div className={styles.actions}>
      <button disabled={disabled || started || completed} onClick={() => onAction('start')}>
        {started ? '시작됨' : '시작'}
      </button>
      <button disabled={disabled || completed} onClick={() => onAction('complete')}>
        완료
      </button>
      <button disabled={disabled || (!completed && !started)} onClick={() => onAction('undo')}>
        실행 취소
      </button>
    </div>
  );
}
