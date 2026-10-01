import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Temporal } from '@js-temporal/polyfill';
import { useData } from '../lib/api-client.js';
import { usePlannerWrite, type Todos } from '../lib/planner-api.js';
import {
  ColorField,
  InboxCapture,
  ModuleSetup,
  PlannerNotice,
} from '../components/PlannerCommon.js';
import type { TodoFields, TodoData, ProjectFields, RecordOf } from '../../shared/contracts/todo.js';
import styles from '../styles/planner.module.css';
const defaults = (): TodoFields => ({
  title: '',
  description: '',
  workflow_status: 'next',
  importance: 'normal',
  project_id: null,
  do_date: null,
  due_at: null,
  scheduled_time: null,
  estimated_duration_seconds: null,
  recurrence: null,
  color: null,
});
export function localInput(value: string | null, zone: string) {
  return value
    ? Temporal.Instant.from(value)
        .toZonedDateTimeISO(zone)
        .toPlainDateTime()
        .toString({ smallestUnit: 'minute' })
    : '';
}
export function fromLocal(value: string, zone: string) {
  return value
    ? Temporal.PlainDateTime.from(value)
        .toZonedDateTime(zone, { disambiguation: 'reject' })
        .toInstant()
        .toString()
    : null;
}
const workflow = {
  next: 'Next · 다음 할 일',
  waiting: 'Waiting · 대기',
  someday: 'Someday · 언젠가',
  completed: '완료',
};
export function TodosPage() {
  const query = useData<Todos>('/todo'),
    write = usePlannerWrite();
  const [tab, setTab] = useState('priorities');
  const [editor, setEditor] = useState<{ id: string | null; fields: TodoFields } | null>(null);
  const [project, setProject] = useState<{ id: string | null; fields: ProjectFields } | null>(null);
  const [undo, setUndo] = useState<{ item: Todos['items'][number]; etag: string } | null>(null);
  if (!query.data)
    return (
      <div className={styles.page}>
        <h1>Todo</h1>
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
  const data = query.data.data,
    etag = query.data.etag;
  const execute = async (
    item: Todos['items'][number],
    action: 'start' | 'complete' | 'undo',
    baseEtag?: string,
  ) => {
    if (
      await write.run(
        `/todo/items/${item.todo.id}/execute`,
        { anchor_date: item.data.anchor_date, action, plan_ref: null },
        baseEtag ?? etag,
      )
    )
      setUndo(action === 'complete' ? { item, etag: write.lastEtag.current } : null);
  };
  const edit = (t: RecordOf<TodoData>) => {
    const fields = defaults();
    for (const key of Object.keys(fields) as (keyof TodoFields)[])
      Object.assign(fields, { [key]: t.data[key] });
    setEditor({ id: t.id, fields });
  };
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>Todo</h1>
          <p className={styles.meta}>생각을 비우고, 다음 행동을 고르세요.</p>
        </div>
        <Link to="/">Today Timebox →</Link>
      </header>
      <PlannerNotice write={write} />
      {undo && (
        <div className={styles.notice} role="status">
          완료했습니다.{' '}
          <button
            disabled={write.pending}
            onClick={() => void execute(undo.item, 'undo', undo.etag)}
          >
            실행 취소
          </button>
        </div>
      )}
      <InboxCapture etag={etag} write={write} />
      <nav className={styles.tabs} aria-label="Todo 보기">
        {[
          ['priorities', 'Priorities'],
          ['inbox', `Inbox (${data.inbox.length})`],
          ['projects', 'Projects'],
          ['history', '완료 기록'],
        ].map(([id, label]) => (
          <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
        <button onClick={() => setEditor({ id: null, fields: defaults() })}>Todo 만들기</button>
      </nav>
      {editor && (
        <section className={`${styles.panel} ${styles.editor}`} aria-label="Todo 편집">
          <h2>{editor.id ? 'Todo 수정' : '새 Todo'}</h2>
          <TodoEditor
            key={editor.id ?? 'new'}
            initial={editor.fields}
            data={data}
            pending={write.pending}
            onClose={() => setEditor(null)}
            onSave={async (fields) => {
              if (
                await write.run(
                  `/todo/items${editor.id ? `/${editor.id}` : ''}`,
                  fields,
                  etag,
                  editor.id ? 'PATCH' : 'POST',
                )
              )
                setEditor(null);
            }}
          />
        </section>
      )}
      {tab === 'inbox' && (
        <section className={styles.panel}>
          <h2>Inbox</h2>
          {data.inbox.length === 0 && <p>아직 처리할 생각이 없어요.</p>}
          {data.inbox.map((i) => (
            <InboxRow
              key={i.id}
              item={i}
              date={data.date}
              disabled={write.pending}
              process={(when, do_date) =>
                write.run(`/todo/inbox/${i.id}/process`, { when, do_date }, etag)
              }
            />
          ))}
        </section>
      )}
      {tab === 'priorities' && (
        <>
          <section className={styles.panel}>
            <h2>지금 먼저 · 중요도와 마감 순</h2>
            {(['next', 'waiting', 'someday'] as const).map((state) => (
              <div className={styles.list} key={state}>
                <h3>{workflow[state]}</h3>
                {data.items
                  .filter((i) => !i.todo.data.deleted && i.workflow_status === state)
                  .map((i) => (
                    <article className={styles.item} key={i.id}>
                      <div className={styles.row}>
                        <h3>{i.data.title}</h3>
                        <span className={styles.meta}>
                          {i.todo.data.importance === 'high'
                            ? '중요'
                            : i.todo.data.importance === 'low'
                              ? '낮음'
                              : '보통'}{' '}
                          · {i.data.anchor_date ? `반복 ${i.data.anchor_date}` : '단일 Todo'}
                        </span>
                      </div>
                      <p className={styles.meta}>
                        하기로 한 날 {i.data.do_date ?? '미정'} · 마감{' '}
                        {i.data.due_at
                          ? localInput(i.data.due_at, data.timezone).replace('T', ' ')
                          : '없음'}{' '}
                        {i.urgency === 'overdue'
                          ? '· 기한 지남'
                          : i.urgency === 'imminent'
                            ? '· 매우 임박'
                            : ''}
                      </p>
                      <div className={styles.actions}>
                        <button
                          disabled={write.pending || !!i.execution?.actual_start}
                          onClick={() => void execute(i, 'start')}
                        >
                          {i.execution?.actual_start ? '실행 중' : '시작'}
                        </button>
                        <button
                          disabled={write.pending}
                          onClick={() => void execute(i, 'complete')}
                        >
                          완료
                        </button>
                        <button onClick={() => edit(i.todo)}>수정</button>
                        <Link to={`/?candidate=${encodeURIComponent(`todo/${i.id}`)}`}>
                          시간 배치
                        </Link>
                        <button
                          disabled={write.pending}
                          onClick={() =>
                            void write.run(`/todo/items/${i.todo.id}`, {}, etag, 'DELETE')
                          }
                        >
                          삭제
                        </button>
                      </div>
                      {i.data.anchor_date && (
                        <details>
                          <summary>이 occurrence만 날짜 변경</summary>
                          <form
                            className={styles.row}
                            onSubmit={(e) => {
                              e.preventDefault();
                              const f = new FormData(e.currentTarget);
                              void write.run(
                                `/todo/items/${i.todo.id}/reschedule`,
                                {
                                  anchor_date: i.data.anchor_date,
                                  do_date: String(f.get('do_date')) || null,
                                  due_at: fromLocal(String(f.get('due_at')), data.timezone),
                                },
                                etag,
                              );
                            }}
                          >
                            <label>
                              Do date
                              <input
                                name="do_date"
                                type="date"
                                defaultValue={i.data.do_date ?? ''}
                              />
                            </label>
                            <label>
                              Due date
                              <input
                                name="due_at"
                                type="datetime-local"
                                defaultValue={localInput(i.data.due_at, data.timezone)}
                              />
                            </label>
                            <button disabled={write.pending}>날짜 저장</button>
                          </form>
                        </details>
                      )}
                    </article>
                  ))}
              </div>
            ))}
          </section>
          <details className={styles.panel}>
            <summary>모든 Todo · 반복 템플릿 관리</summary>
            {data.todos
              .filter((t) => !t.data.deleted)
              .map((t) => (
                <div className={styles.row} key={t.id}>
                  {t.data.title} <button onClick={() => edit(t)}>수정</button>
                </div>
              ))}
          </details>
        </>
      )}
      {tab === 'projects' && (
        <section className={styles.panel}>
          <div className={styles.header}>
            <h2>Projects</h2>
            <button
              onClick={() =>
                setProject({
                  id: null,
                  fields: { name: '', description: '', color: null, status: 'active' },
                })
              }
            >
              Project 만들기
            </button>
          </div>
          {project && (
            <form
              className={styles.form}
              onSubmit={async (e) => {
                e.preventDefault();
                if (
                  await write.run(
                    `/todo/projects${project.id ? `/${project.id}` : ''}`,
                    project.fields,
                    etag,
                    project.id ? 'PUT' : 'POST',
                  )
                )
                  setProject(null);
              }}
            >
              <label>
                Project 이름
                <input
                  required
                  value={project.fields.name}
                  onChange={(e) =>
                    setProject({ ...project, fields: { ...project.fields, name: e.target.value } })
                  }
                />
              </label>
              <label>
                설명
                <textarea
                  value={project.fields.description}
                  onChange={(e) =>
                    setProject({
                      ...project,
                      fields: { ...project.fields, description: e.target.value },
                    })
                  }
                />
              </label>
              <ColorField
                value={project.fields.color}
                onChange={(color) =>
                  setProject({ ...project, fields: { ...project.fields, color } })
                }
              />
              <button disabled={write.pending}>Project 저장</button>
              <button type="button" onClick={() => setProject(null)}>
                닫기
              </button>
            </form>
          )}
          {data.projects.map((p) => (
            <article
              className={styles.item}
              key={p.id}
              style={{ borderLeft: `4px solid ${p.data.color ?? '#6C63FF'}` }}
            >
              <h3>
                {p.data.name} {p.data.status === 'archived' && '· 보관됨'}
              </h3>
              <p>{p.data.description}</p>
              <p>
                {p.completed} / {p.total} 완료 ·{' '}
                {p.completion_rate === null
                  ? '아직 할 일 없음'
                  : `${Math.round(p.completion_rate * 100)}%`}
              </p>
              <p className={styles.meta}>
                최근 활동 {localInput(p.last_activity_at, data.timezone).replace('T', ' ')}
              </p>
              <div className={styles.actions}>
                <button
                  onClick={() =>
                    setProject({
                      id: p.id,
                      fields: {
                        name: p.data.name,
                        description: p.data.description,
                        color: p.data.color,
                        status: p.data.status,
                      },
                    })
                  }
                >
                  Project 수정
                </button>
                <button
                  disabled={write.pending}
                  onClick={() =>
                    void write.run(
                      `/todo/projects/${p.id}`,
                      {
                        name: p.data.name,
                        description: p.data.description,
                        color: p.data.color,
                        status: p.data.status === 'active' ? 'archived' : 'active',
                      },
                      etag,
                      'PUT',
                    )
                  }
                >
                  {p.data.status === 'active' ? '보관' : '복원'}
                </button>
              </div>
            </article>
          ))}
          <p className={styles.meta}>
            단일 Todo와 오늘까지 도래한 반복 occurrence를 계산합니다. Waiting·Someday는 제외합니다.
          </p>
        </section>
      )}
      {tab === 'history' && (
        <section className={styles.panel}>
          <h2>완료 기록</h2>
          {data.history.length === 0 && <p>완료한 Todo가 여기에 쌓입니다.</p>}
          {data.history.map((i) => (
            <article className={styles.item} key={i.id}>
              <h3>{i.data.title}</h3>
              <p>
                {localInput(i.execution!.completed_at, data.timezone).replace('T', ' ')} ·{' '}
                {data.projects.find((p) => p.id === i.data.project_id)?.data.name ?? 'Project 없음'}
              </p>
              <p className={styles.meta}>
                {i.actual_duration_seconds === null
                  ? '빠른 완료 · 실행 시간 미기록'
                  : `실행 ${localInput(i.execution!.actual_start, data.timezone).slice(11)}–${localInput(i.execution!.actual_end, data.timezone).slice(11)} · ${Math.round(i.actual_duration_seconds / 60)}분`}
              </p>
              <div className={styles.actions}>
                <Link
                  to={`/?date=${i.execution!.completed_at ? Temporal.Instant.from(i.execution!.completed_at).toZonedDateTimeISO(data.timezone).toPlainDate().toString() : data.date}`}
                >
                  그날 Plan / Actual
                </Link>
                <button
                  disabled={write.pending || i.todo.data.deleted}
                  onClick={() => void execute(i, 'undo')}
                >
                  완료 취소
                </button>
              </div>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
function InboxRow({
  item,
  date,
  disabled,
  process,
}: {
  item: Todos['inbox'][number];
  date: string;
  disabled: boolean;
  process: (when: string, day: string | null) => Promise<boolean>;
}) {
  const [day, setDay] = useState(date);
  return (
    <article className={styles.item}>
      <h3>{item.data.title}</h3>
      <p className={styles.meta}>{item.age_days + 1}일째 Inbox</p>
      <div className={styles.actions}>
        <button disabled={disabled} onClick={() => void process('today', null)}>
          오늘 하기
        </button>
        <button disabled={disabled} onClick={() => void process('someday', null)}>
          Someday
        </button>
        <button disabled={disabled} onClick={() => void process('discard', null)}>
          삭제
        </button>
      </div>
      <div className={styles.row}>
        <label>
          다른 날<input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </label>
        <button disabled={disabled || !day} onClick={() => void process('date', day)}>
          선택 날짜에 하기
        </button>
      </div>
    </article>
  );
}
function TodoEditor({
  initial,
  data,
  pending,
  onSave,
  onClose,
}: {
  initial: TodoFields;
  data: Todos;
  pending: boolean;
  onSave: (fields: TodoFields) => Promise<void>;
  onClose: () => void;
}) {
  const [f, set] = useState(initial);
  const patch = (value: Partial<TodoFields>) => set({ ...f, ...value });
  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(f);
      }}
    >
      <label>
        Todo 제목
        <input
          required
          maxLength={200}
          value={f.title}
          onChange={(e) => patch({ title: e.target.value })}
        />
      </label>
      <label>
        설명
        <textarea value={f.description} onChange={(e) => patch({ description: e.target.value })} />
      </label>
      <div className={styles.fields}>
        <label>
          Workflow
          <select
            value={f.workflow_status}
            onChange={(e) =>
              patch({ workflow_status: e.target.value as TodoFields['workflow_status'] })
            }
          >
            {(['next', 'waiting', 'someday'] as const).map((v) => (
              <option value={v} key={v}>
                {workflow[v]}
              </option>
            ))}
          </select>
        </label>
        <label>
          중요도
          <select
            value={f.importance}
            onChange={(e) => patch({ importance: e.target.value as TodoFields['importance'] })}
          >
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </select>
        </label>
        <label>
          Project
          <select
            value={f.project_id ?? ''}
            onChange={(e) => patch({ project_id: e.target.value || null })}
          >
            <option value="">없음</option>
            {data.projects
              .filter((p) => p.data.status === 'active' || p.id === f.project_id)
              .map((p) => (
                <option value={p.id} key={p.id}>
                  {p.data.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Do date · 하기로 한 날
          <input
            type="date"
            value={f.do_date ?? ''}
            onChange={(e) => patch({ do_date: e.target.value || null })}
          />
        </label>
        <label>
          Due date · 실제 마감
          <input
            type="datetime-local"
            value={localInput(f.due_at, data.timezone)}
            onChange={(e) => patch({ due_at: fromLocal(e.target.value, data.timezone) })}
          />
        </label>
        <label>
          예정 시각
          <input
            type="time"
            value={f.scheduled_time ?? ''}
            onChange={(e) => patch({ scheduled_time: e.target.value || null })}
          />
        </label>
        <label>
          예상 시간 · 분
          <input
            type="number"
            min={0}
            max={1440}
            value={f.estimated_duration_seconds === null ? '' : f.estimated_duration_seconds / 60}
            onChange={(e) =>
              patch({
                estimated_duration_seconds:
                  e.target.value === '' ? null : Number(e.target.value) * 60,
              })
            }
          />
        </label>
        <label>
          반복
          <select
            value={f.recurrence?.type ?? 'none'}
            onChange={(e) => {
              const type = e.target.value;
              patch({
                recurrence:
                  type === 'none'
                    ? null
                    : type === 'selected_weekdays'
                      ? { type, weekdays: [1] }
                      : type === 'every_n_days'
                        ? { type, interval_days: 2, anchor_date: f.do_date ?? data.date }
                        : { type: type as 'daily' | 'weekdays' | 'weekends' },
              });
            }}
          >
            <option value="none">없음</option>
            <option value="daily">매일</option>
            <option value="weekdays">평일</option>
            <option value="weekends">주말</option>
            <option value="selected_weekdays">요일 선택</option>
            <option value="every_n_days">N일 간격</option>
          </select>
        </label>
      </div>
      {f.recurrence?.type === 'selected_weekdays' && (
        <fieldset>
          <legend>반복 요일</legend>
          <div className={styles.row}>
            {['월', '화', '수', '목', '금', '토', '일'].map((day, i) => (
              <label key={day}>
                <input
                  type="checkbox"
                  checked={
                    f.recurrence?.type === 'selected_weekdays' &&
                    f.recurrence.weekdays.includes(i + 1)
                  }
                  onChange={(e) => {
                    if (f.recurrence?.type === 'selected_weekdays')
                      patch({
                        recurrence: {
                          type: 'selected_weekdays',
                          weekdays: e.target.checked
                            ? [...f.recurrence.weekdays, i + 1]
                            : f.recurrence.weekdays.filter((d) => d !== i + 1),
                        },
                      });
                  }}
                />
                {day}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {f.recurrence?.type === 'every_n_days' && (
        <label>
          반복 간격 · 일
          <input
            type="number"
            min={1}
            max={366}
            value={f.recurrence.interval_days}
            onChange={(e) => {
              if (f.recurrence?.type === 'every_n_days')
                patch({ recurrence: { ...f.recurrence, interval_days: Number(e.target.value) } });
            }}
          />
        </label>
      )}
      <ColorField value={f.color} onChange={(color) => patch({ color })} />
      <div className={styles.actions}>
        <button
          disabled={
            pending ||
            (f.recurrence?.type === 'selected_weekdays' && f.recurrence.weekdays.length === 0)
          }
        >
          Todo 저장
        </button>
        <button type="button" onClick={onClose}>
          닫기
        </button>
      </div>
    </form>
  );
}
