import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useData, useWrite, type DefinitionRows, type Today } from '../lib/api-client.js';
import type { Habit, HabitFields, Routine, RoutineFields } from '../../shared/contracts/index.js';
import { routineIds, membershipPatch } from '../../shared/domain/membership.js';
import {
  Heading,
  ErrorBox,
  Empty,
  Icon,
  Notice,
  ScheduleEditor,
  scheduleLabel,
  shortDate,
} from '../components/common.js';
import styles from '../styles/app.module.css';

const newHabit: HabitFields = {
  name: '',
  description: '',
  active: true,
  deleted: false,
  parent_routine_id: null,
  routine_ids: [],
  schedule: { mode: 'explicit', source_routine_revision: null, rule: { type: 'daily' } },
  scheduled_time: { mode: 'explicit', source_routine_revision: null, value: null },
  minimum_duration_seconds: null,
  target_amount: null,
  unit: null,
};
const newRoutine: RoutineFields = {
  name: '',
  description: '',
  deleted: false,
  schedule: { type: 'daily' },
  scheduled_time: null,
  habit_order: [],
};
function fields(d: Habit | Routine): HabitFields | RoutineFields {
  const {
    schema_version,
    kind,
    id,
    revision,
    command_id,
    created_at,
    recorded_at,
    effective_from,
    ...rest
  } = d;
  return rest;
}
const latestOf = (row: DefinitionRows[number]) => row.pending.at(-1) ?? row.current;
const minutes = (seconds: number) => `${Math.round((seconds / 60) * 10) / 10}분`;
export function Management({ kind }: { kind: 'habit' | 'routine' }) {
  const query = useData<DefinitionRows>(`/${kind}s`);
  const today = useData<Today>('/today');
  const habitRows = useData<DefinitionRows>('/habits');
  const routineRows = useData<DefinitionRows>('/routines');
  const write = useWrite();
  const [editing, setEditing] = useState<Habit | Routine | 'new' | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const rows = query.data?.data ?? [];
  const noun = kind === 'habit' ? '습관' : '루틴';
  const routines = (routineRows.data?.data ?? [])
    .map(latestOf)
    .filter((r): r is Routine => !!r && r.kind === 'routine' && !r.deleted);
  const habits = (habitRows.data?.data ?? [])
    .map(latestOf)
    .filter((h): h is Habit => !!h && h.kind === 'habit' && !h.deleted);
  const visible = rows.filter((row) => showArchived || !row.current?.deleted);
  return (
    <>
      <Heading title={noun} mobileTitle="관리">
        <button className={styles.button} onClick={() => setEditing('new')}>
          <Icon name="plus" size={16} strokeWidth={2.2} />새 {noun}
        </button>
        <Link
          to="/settings"
          className={`${styles.iconLink} ${styles.mobileOnly}`}
          aria-label="설정"
        >
          <Icon name="settings" />
        </Link>
      </Heading>
      <nav aria-label="관리 항목" className={`${styles.segmented} ${styles.mobileOnly}`}>
        <Link to="/habits" aria-current={kind === 'habit' ? 'page' : undefined}>
          습관
        </Link>
        <Link to="/routines" aria-current={kind === 'routine' ? 'page' : undefined}>
          루틴
        </Link>
      </nav>
      <ErrorBox error={query.error ?? write.error} />
      <label className={styles.checkboxLine}>
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />
        삭제된 {noun} 보기
      </label>
      {query.isPending && <p className={styles.muted}>불러오는 중…</p>}
      {!rows.length && !query.isPending && (
        <Empty>아직 {noun}이 없어요. 새로 만들어 시작해 보세요.</Empty>
      )}
      {visible.length > 0 && (
        <div className={styles.manageList}>
          {visible.map((row) => {
            const current = row.current;
            const latest = latestOf(row)!;
            const status = current?.deleted
              ? ['삭제됨', styles.badgeDanger]
              : !current
                ? ['예정', styles.badgeCaution]
                : current.kind === 'habit' && !current.active
                  ? ['비활성', styles.badgeNeutral]
                  : null;
            const time =
              (latest.kind === 'habit' ? latest.scheduled_time.value : latest.scheduled_time) ??
              '언제든';
            const sub =
              latest.kind === 'habit'
                ? [
                    scheduleLabel(latest.schedule.rule),
                    time,
                    routines
                      .filter((r) => routineIds(latest).includes(r.id))
                      .map((r) => r.name)
                      .join(', '),
                    latest.minimum_duration_seconds !== null &&
                      `최소 ${minutes(latest.minimum_duration_seconds)}`,
                    latest.target_amount !== null &&
                      `목표 ${latest.target_amount}${latest.unit ? ` ${latest.unit}` : ''}`,
                  ]
                : [scheduleLabel(latest.schedule), time];
            const members =
              latest.kind === 'routine'
                ? habits
                    .filter((h) => routineIds(h).includes(latest.id))
                    .sort((a, b) => {
                      const ai = latest.habit_order.indexOf(a.id);
                      const bi = latest.habit_order.indexOf(b.id);
                      return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
                    })
                : [];
            return (
              <article
                key={row.id}
                className={`${styles.manageRow} ${
                  status && status[0] !== '예정' ? styles.manageRowMuted : ''
                }`}
              >
                <div className={styles.manageInfo}>
                  <div className={styles.manageTitle}>
                    <h2>
                      {current?.deleted ? (
                        latest.name
                      ) : (
                        <button className={styles.rowOpen} onClick={() => setEditing(latest)}>
                          {latest.name}
                        </button>
                      )}
                    </h2>
                    {status && <span className={`${styles.badge} ${status[1]}`}>{status[0]}</span>}
                  </div>
                  <p className={styles.metaText}>
                    {[
                      ...sub.filter(Boolean),
                      latest.kind === 'routine' && `습관 ${members.length}개`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  {latest.description && <p className={styles.description}>{latest.description}</p>}
                  {row.pending.map((p) => (
                    <p key={p.revision} className={styles.pendingText}>
                      {shortDate(p.effective_from)}부터 변경 적용{p.deleted ? ' · 삭제' : ''}
                    </p>
                  ))}
                  {members.length > 0 && (
                    <ol className={styles.memberList}>
                      {members.map((h) => (
                        <li key={h.id}>{h.name}</li>
                      ))}
                    </ol>
                  )}
                </div>
                {!current?.deleted && (
                  <RowMenu
                    label={latest.name}
                    items={[
                      [`${noun} 수정`, 'edit', () => setEditing(latest)],
                      ...(latest.kind === 'habit' && !latest.deleted
                        ? ([
                            [
                              latest.active ? '비활성화' : '활성화',
                              'pause',
                              () =>
                                write.mutate({
                                  path: `/habits/${row.id}`,
                                  method: 'PATCH',
                                  body: { active: !latest.active },
                                  etag: query.data!.etag,
                                }),
                            ],
                          ] as MenuItem[])
                        : []),
                      [
                        `${noun} 삭제`,
                        'trash',
                        () =>
                          write.mutate({
                            path: `/${kind}s/${row.id}`,
                            method: 'DELETE',
                            etag: query.data!.etag,
                          }),
                        true,
                      ],
                    ]}
                    disabled={write.isPending || latest.deleted}
                  />
                )}
              </article>
            );
          })}
        </div>
      )}
      <p className={styles.footnote}>
        {kind === 'habit'
          ? '삭제하면 적용일부터 사용이 중단되고, 지난 기록은 그대로 남아요.'
          : '루틴을 삭제해도 습관은 남고, 이 루틴과의 연결만 해제돼요.'}
      </p>
      {editing && today.data && query.data && (
        <Editor
          key={editing === 'new' ? `${kind}-new` : editing.id}
          kind={kind}
          initial={editing === 'new' ? null : editing}
          day={today.data.data.date}
          etag={query.data.etag}
          close={() => setEditing(null)}
        />
      )}
    </>
  );
}
type MenuItem = [string, 'edit' | 'pause' | 'trash', () => void, boolean?];
function RowMenu({
  label,
  items,
  disabled,
}: {
  label: string;
  items: MenuItem[];
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return (
    <div
      ref={root}
      className={styles.menuRoot}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false);
      }}
    >
      <button
        className={styles.iconButton}
        aria-label={`${label} 메뉴`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(!open)}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="19" cy="12" r="1.6" />
        </svg>
      </button>
      {open && (
        <div role="menu" id={menuId} aria-label={`${label} 메뉴`} className={styles.menu}>
          {items.map(([text, icon, run, danger]) => (
            <button
              key={text}
              role="menuitem"
              className={danger ? styles.menuDanger : ''}
              disabled={disabled && icon !== 'edit'}
              onClick={() => {
                setOpen(false);
                run();
              }}
            >
              {text}
              <Icon name={icon} size={16} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
function Editor({
  kind,
  initial,
  day,
  etag,
  close,
}: {
  kind: 'habit' | 'routine';
  initial: Habit | Routine | null;
  day: string;
  etag: string;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const formId = useId();
  const write = useWrite();
  const routines = useData<DefinitionRows>('/routines');
  const [value, setValue] = useState<HabitFields | RoutineFields>(() =>
    structuredClone(initial ? fields(initial) : kind === 'habit' ? newHabit : newRoutine),
  );
  const [start, setStart] = useState(day);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const h = value as HabitFields;
  const r = value as RoutineFields;
  const update = (patch: Partial<HabitFields & RoutineFields>) =>
    setValue((v) => ({ ...v, ...patch }) as typeof value);
  const available =
    routines.data?.data
      .map((row) => row.pending.at(-1) ?? row.current)
      .filter((r): r is Routine => !!r && r.kind === 'routine' && !r.deleted) ?? [];
  const memberships = kind === 'habit' ? routineIds(h) : [];
  const selectRoutine = (routine: Routine, checked: boolean) => {
    const ids = checked
      ? [...memberships, routine.id]
      : memberships.filter((id) => id !== routine.id);
    const next = { ...h, ...membershipPatch(h, ids) };
    if (checked && !memberships.length) {
      next.parent_routine_id = routine.id;
      // Preserve an existing Habit's own cadence when adding it to a group.
      if (!initial) {
        next.schedule = {
          mode: 'routine',
          source_routine_revision: routine.revision,
          rule: routine.schedule,
        };
        next.scheduled_time = {
          mode: 'routine',
          source_routine_revision: routine.revision,
          value: routine.scheduled_time,
        };
      }
    }
    setValue(next);
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const old = initial ? fields(initial) : null;
    const body = old
      ? Object.fromEntries(
          Object.entries(value).filter(
            ([key, v]) =>
              JSON.stringify(v) !==
              JSON.stringify((old as unknown as Record<string, unknown>)[key]),
          ),
        )
      : { fields: value, starts_on: start };
    try {
      await write.mutateAsync({
        path: `/${kind}s${initial ? `/${initial.id}` : ''}`,
        method: initial ? 'PATCH' : 'POST',
        body,
        etag,
      });
      close();
    } catch {
      /* Error remains visible in dialog. */
    }
  };
  const noun = kind === 'habit' ? '습관' : '루틴';
  return (
    <dialog ref={dialog} className={styles.dialog} onCancel={close}>
      <div className={styles.dialogTitle}>
        <h2>{initial ? `${noun} 수정` : `새 ${noun}`}</h2>
        <button className={styles.iconButton} aria-label="편집 닫기" onClick={close}>
          <Icon name="close" />
        </button>
      </div>
      <div className={styles.dialogBody}>
        <form id={formId} onSubmit={save} className={styles.editor}>
          <ErrorBox error={write.error} />
          <section className={styles.formSection}>
            <label>
              이름
              <input
                required
                maxLength={200}
                autoFocus
                value={value.name}
                onChange={(e) => update({ name: e.target.value })}
              />
            </label>
            <label>
              설명
              <textarea
                value={value.description}
                onChange={(e) => update({ description: e.target.value })}
              />
            </label>
            {!initial && (
              <label>
                시작일
                <input
                  type="date"
                  min={day}
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  required
                />
              </label>
            )}
          </section>
          {kind === 'habit' && (
            <fieldset className={styles.formSection}>
              <legend>루틴</legend>
              <div className={styles.optionList}>
                {available.map((routine) => (
                  <div key={routine.id} className={styles.optionRow}>
                    <label className={styles.optionLabel}>
                      <input
                        type="checkbox"
                        checked={memberships.includes(routine.id)}
                        onChange={(e) => selectRoutine(routine, e.target.checked)}
                      />
                      <span>{routine.name}</span>
                    </label>
                    <small>
                      {scheduleLabel(routine.schedule)} · {routine.scheduled_time ?? '언제든'}
                    </small>
                  </div>
                ))}
                {!available.length && (
                  <p className={styles.optionEmpty}>
                    아직 루틴이 없어요. 습관은 단독으로도 쓸 수 있어요.
                  </p>
                )}
                {memberships.length > 0 && (
                  <label className={styles.optionRow}>
                    <span>기본 설정 루틴</span>
                    <select
                      value={h.parent_routine_id ?? ''}
                      onChange={(e) => {
                        const parent = available.find((r) => r.id === e.target.value);
                        setValue({
                          ...h,
                          routine_ids: memberships,
                          parent_routine_id: parent?.id ?? null,
                          ...(!parent
                            ? {
                                schedule: {
                                  ...h.schedule,
                                  mode: 'explicit',
                                  source_routine_revision: null,
                                },
                                scheduled_time: {
                                  ...h.scheduled_time,
                                  mode: 'explicit',
                                  source_routine_revision: null,
                                },
                              }
                            : {}),
                        });
                      }}
                    >
                      <option value="">습관 자체 설정 사용</option>
                      {available
                        .filter((r) => memberships.includes(r.id))
                        .map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                {h.parent_routine_id && (
                  <label className={styles.optionRow}>
                    <span>루틴 반복 주기 따르기</span>
                    <input
                      type="checkbox"
                      checked={h.schedule.mode === 'routine'}
                      onChange={(e) =>
                        setValue({
                          ...h,
                          schedule: {
                            ...h.schedule,
                            mode: e.target.checked ? 'routine' : 'explicit',
                            source_routine_revision: e.target.checked
                              ? (available.find((r) => r.id === h.parent_routine_id)?.revision ??
                                null)
                              : null,
                          },
                        })
                      }
                    />
                  </label>
                )}
              </div>
              <p className={styles.fieldHint}>
                루틴은 여러 개 고를 수 있어요. 완료 기록은 모든 루틴에서 공유돼요.
              </p>
              {memberships.length > 1 && (
                <Notice>
                  평일·주말 루틴에 함께 넣은 매일 습관이라면 루틴 반복 주기 따르기를 끄고 매일을
                  고르세요. 루틴 반복 주기는 어디에 표시될지를, 습관의 반복 주기는 연속 달성에
                  무엇이 반영될지를 정해요.
                </Notice>
              )}
            </fieldset>
          )}
          {(kind === 'routine' || h.schedule.mode === 'explicit') && (
            <section className={styles.formSection}>
              <ScheduleEditor
                today={day}
                value={kind === 'habit' ? h.schedule.rule : r.schedule}
                onChange={(schedule) =>
                  setValue(
                    kind === 'habit'
                      ? {
                          ...h,
                          schedule: {
                            mode: 'explicit',
                            source_routine_revision: null,
                            rule: schedule,
                          },
                        }
                      : { ...r, schedule },
                  )
                }
              />
            </section>
          )}
          <section className={styles.formSection}>
            {kind === 'habit' && h.parent_routine_id && (
              <label className={styles.checkboxLine}>
                <input
                  type="checkbox"
                  checked={h.scheduled_time.mode === 'routine'}
                  onChange={(e) =>
                    setValue({
                      ...h,
                      scheduled_time: {
                        ...h.scheduled_time,
                        mode: e.target.checked ? 'routine' : 'explicit',
                        source_routine_revision: e.target.checked
                          ? (available.find((r) => r.id === h.parent_routine_id)?.revision ?? null)
                          : null,
                      },
                    })
                  }
                />
                루틴별 시간 사용 (루틴 밖에서는 기본 설정 루틴 시간)
              </label>
            )}
            {(kind === 'routine' || h.scheduled_time.mode === 'explicit') && (
              <label>
                예정 시간 (선택)
                <input
                  type="time"
                  value={(kind === 'habit' ? h.scheduled_time.value : r.scheduled_time) ?? ''}
                  onChange={(e) =>
                    setValue(
                      kind === 'habit'
                        ? {
                            ...h,
                            scheduled_time: {
                              mode: 'explicit',
                              source_routine_revision: null,
                              value: e.target.value || null,
                            },
                          }
                        : { ...r, scheduled_time: e.target.value || null },
                    )
                  }
                />
              </label>
            )}
          </section>
          {kind === 'habit' && (
            <section className={styles.formSection}>
              <label>
                최소 수행 시간 (분)
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={h.minimum_duration_seconds === null ? '' : h.minimum_duration_seconds / 60}
                  onChange={(e) =>
                    setValue({
                      ...h,
                      minimum_duration_seconds:
                        e.target.value === '' ? null : Math.round(Number(e.target.value) * 60),
                    })
                  }
                />
              </label>
              <div className={styles.formRow}>
                <label>
                  목표량
                  <input
                    inputMode="decimal"
                    pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]+)?"
                    value={h.target_amount ?? ''}
                    onChange={(e) => setValue({ ...h, target_amount: e.target.value || null })}
                  />
                </label>
                <label>
                  단위
                  <input
                    required={h.target_amount !== null}
                    placeholder="쪽, 회, 잔…"
                    value={h.unit ?? ''}
                    onChange={(e) => setValue({ ...h, unit: e.target.value || null })}
                  />
                </label>
              </div>
            </section>
          )}
          {kind === 'routine' && initial && (
            <OrderEditor
              routine={initial as Routine}
              value={r.habit_order}
              onChange={(habit_order) => setValue({ ...r, habit_order })}
            />
          )}
          <Notice>
            {initial
              ? '수정 사항은 내일부터 적용돼요. 주·월 목표 주기, 비활성화, 삭제는 다음 기간부터 적용돼요. 저장하면 정확한 적용일이 표시돼요.'
              : `새 ${noun}은 시작일부터 사용할 수 있어요.`}
          </Notice>
        </form>
        {kind === 'routine' && initial && <RoutineMembers routine={initial as Routine} />}
      </div>
      <div className={styles.dialogFooter}>
        <button form={formId} className={styles.button} disabled={write.isPending}>
          {write.isPending ? '저장 중…' : '저장'}
        </button>
        <button type="button" className={styles.secondary} onClick={close}>
          취소
        </button>
      </div>
    </dialog>
  );
}
function OrderEditor({
  routine,
  value,
  onChange,
}: {
  routine: Routine;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const query = useData<DefinitionRows>('/habits');
  const members =
    query.data?.data
      .map((row) => row.pending.at(-1) ?? row.current)
      .filter(
        (h): h is Habit =>
          !!h && h.kind === 'habit' && routineIds(h).includes(routine.id) && !h.deleted,
      ) ?? [];
  const ordered = [
    ...value.filter((id) => members.some((h) => h.id === id)),
    ...members.filter((h) => !value.includes(h.id)).map((h) => h.id),
  ];
  const move = (index: number, delta: number) => {
    const next = [...ordered];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    onChange(next);
  };
  return (
    <fieldset className={styles.formSection}>
      <legend>습관 순서</legend>
      <div className={styles.optionList}>
        {ordered.map((id, i) => {
          const name = members.find((h) => h.id === id)?.name;
          return (
            <div className={styles.orderRow} key={id}>
              <span className={styles.orderIndex}>{i + 1}</span>
              <span className={styles.orderName}>{name}</span>
              <button
                type="button"
                className={styles.iconButton}
                disabled={i === 0}
                aria-label={`${name} 위로`}
                onClick={() => move(i, -1)}
              >
                <Icon name="chevronUp" size={18} />
              </button>
              <button
                type="button"
                className={styles.iconButton}
                disabled={i === ordered.length - 1}
                aria-label={`${name} 아래로`}
                onClick={() => move(i, 1)}
              >
                <Icon name="chevronDown" size={18} />
              </button>
            </div>
          );
        })}
        {!ordered.length && <p className={styles.optionEmpty}>아직 이 루틴에 습관이 없어요.</p>}
      </div>
    </fieldset>
  );
}
function RoutineMembers({ routine }: { routine: Routine }) {
  const query = useData<DefinitionRows>('/habits');
  const write = useWrite();
  const [selected, setSelected] = useState('');
  const habits =
    query.data?.data
      .map((row) => row.pending.at(-1) ?? row.current)
      .filter((h): h is Habit => !!h && h.kind === 'habit' && !h.deleted) ?? [];
  const members = habits.filter((h) => routineIds(h).includes(routine.id));
  const change = (h: Habit, add: boolean) =>
    write.mutate({
      path: `/habits/${h.id}`,
      method: 'PATCH',
      body: membershipPatch(
        h,
        add ? [...routineIds(h), routine.id] : routineIds(h).filter((id) => id !== routine.id),
      ),
      etag: query.data!.etag,
    });
  return (
    <section className={styles.members}>
      <div className={styles.membersTitle}>
        <h3>루틴 멤버</h3>
        <span>따로 저장 · 내일부터 적용</span>
      </div>
      <ErrorBox error={write.error} />
      <div className={styles.optionList}>
        {members.map((h) => (
          <div className={styles.orderRow} key={h.id}>
            <span className={styles.orderName}>{h.name}</span>
            <button
              className={styles.dangerText}
              disabled={write.isPending}
              onClick={() => change(h, false)}
            >
              제거
            </button>
          </div>
        ))}
        {!members.length && <p className={styles.optionEmpty}>아직 멤버가 없어요.</p>}
      </div>
      <div className={styles.addMember}>
        <label>
          기존 습관 추가
          <select value={selected} onChange={(e) => setSelected(e.target.value)}>
            <option value="">습관 선택</option>
            {habits
              .filter((h) => !routineIds(h).includes(routine.id))
              .map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
          </select>
        </label>
        <button
          className={styles.secondary}
          disabled={!selected || write.isPending}
          onClick={() => {
            const h = habits.find((h) => h.id === selected);
            if (h) change(h, true);
          }}
        >
          루틴에 추가
        </button>
      </div>
      <p className={styles.fieldHint}>
        습관을 추가해도 다른 루틴과 반복 주기는 유지돼요. 기본 설정 루틴에서 빼면 현재 설정이 그대로
        고정돼요.
      </p>
    </section>
  );
}
