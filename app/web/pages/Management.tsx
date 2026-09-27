import { useEffect, useRef, useState } from 'react';
import { useData, useWrite, type DefinitionRows, type Today } from '../lib/api-client.js';
import type { Habit, HabitFields, Routine, RoutineFields } from '../../shared/contracts/index.js';
import { routineIds, membershipPatch } from '../../shared/domain/membership.js';
import { Heading, ErrorBox, Empty, ScheduleEditor, scheduleLabel } from '../components/common.js';
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
export function Management({ kind }: { kind: 'habit' | 'routine' }) {
  const query = useData<DefinitionRows>(`/${kind}s`);
  const today = useData<Today>('/today');
  const write = useWrite();
  const [editing, setEditing] = useState<Habit | Routine | 'new' | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const rows = query.data?.data ?? [];
  const title = kind === 'habit' ? 'Habits' : 'Routines';
  return (
    <>
      <Heading eyebrow="BUILD YOUR DAILY PRACTICE" title={title}>
        <button className={styles.button} onClick={() => setEditing('new')}>
          + New {kind}
        </button>
      </Heading>
      <p className={styles.intro}>
        {kind === 'habit'
          ? 'Simple actions, on a schedule that works for you.'
          : 'Bring related habits together. Keep each action independent.'}
      </p>
      <ErrorBox error={query.error ?? write.error} />
      <label className={styles.inlineLabel}>
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />{' '}
        Show deleted {title.toLowerCase()}
      </label>
      {query.isPending && <p>Loading…</p>}
      {!rows.length && <Empty>No {title.toLowerCase()} yet. Create one to get started.</Empty>}
      <div className={styles.managementList}>
        {rows.map((row) => {
          const current = row.current;
          const latest = row.pending.at(-1) ?? current!;
          if (!showArchived && current?.deleted) return null;
          return (
            <article key={row.id} className={styles.panel}>
              <div className={styles.groupTitle}>
                <h2>{latest.name}</h2>
                <span className={styles.badge}>
                  {current?.deleted
                    ? 'Deleted'
                    : !current
                      ? 'Upcoming'
                      : current.kind === 'habit' && !current.active
                        ? 'Inactive'
                        : 'Active'}
                </span>
              </div>
              <p>
                {scheduleLabel(latest.kind === 'habit' ? latest.schedule.rule : latest.schedule)} ·{' '}
                {(latest.kind === 'habit' ? latest.scheduled_time.value : latest.scheduled_time) ??
                  'Any time'}
              </p>
              {latest.description && <p className={styles.muted}>{latest.description}</p>}
              {row.pending.map((p) => (
                <p key={p.revision} className={styles.notice}>
                  Change scheduled for {p.effective_from}
                  {p.deleted ? ' · deletion' : ''}
                </p>
              ))}
              {!current?.deleted && (
                <div className={styles.actions}>
                  <button className={styles.secondary} onClick={() => setEditing(latest)}>
                    Edit {kind}
                  </button>
                  {latest.kind === 'habit' && !latest.deleted && (
                    <button
                      className={styles.quiet}
                      disabled={write.isPending}
                      onClick={() =>
                        write.mutate({
                          path: `/habits/${row.id}`,
                          method: 'PATCH',
                          body: { active: !latest.active },
                          etag: query.data!.etag,
                        })
                      }
                    >
                      {latest.active ? 'Deactivate' : 'Activate'}
                    </button>
                  )}
                  <button
                    className={styles.danger}
                    disabled={write.isPending || latest.deleted}
                    onClick={() =>
                      write.mutate({
                        path: `/${kind}s/${row.id}`,
                        method: 'DELETE',
                        etag: query.data!.etag,
                      })
                    }
                  >
                    Delete {kind}
                  </button>
                </div>
              )}
              <small className={styles.muted}>
                Deletion removes it from active use on its effective date and preserves history.
              </small>
            </article>
          );
        })}
      </div>
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
  return (
    <dialog ref={dialog} className={styles.dialog} onCancel={close}>
      <div className={styles.dialogTitle}>
        <h2>
          {initial ? 'Edit' : 'New'} {kind}
        </h2>
        <button className={styles.quiet} aria-label="Close editor" onClick={close}>
          ✕
        </button>
      </div>
      <form onSubmit={save} className={styles.editor}>
        <ErrorBox error={write.error} />
        <label>
          Name
          <input
            required
            maxLength={200}
            autoFocus
            value={value.name}
            onChange={(e) => update({ name: e.target.value })}
          />
        </label>
        <label>
          Description
          <textarea
            value={value.description}
            onChange={(e) => update({ description: e.target.value })}
          />
        </label>
        {!initial && (
          <label>
            Start date
            <input
              type="date"
              min={day}
              value={start}
              onChange={(e) => setStart(e.target.value)}
              required
            />
          </label>
        )}
        {kind === 'habit' && (
          <>
            <fieldset>
              <legend>Routines</legend>
              <p>Select any number of routines. Completion is shared across all of them.</p>
              {available.map((routine) => (
                <label key={routine.id} className={styles.inlineLabel}>
                  <input
                    type="checkbox"
                    checked={memberships.includes(routine.id)}
                    onChange={(e) => selectRoutine(routine, e.target.checked)}
                  />
                  {routine.name}
                </label>
              ))}
              {!available.length && <p>No routines yet. This habit can stand alone.</p>}
            </fieldset>
            {memberships.length > 0 && (
              <label>
                Defaults routine
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
                  <option value="">Use habit's own settings</option>
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
            {memberships.length > 1 && (
              <p className={styles.notice}>
                For a daily habit shared by weekday and weekend routines, turn off schedule
                inheritance and choose Every day. Routine schedules control where it appears; its
                own schedule controls what counts toward your streak.
              </p>
            )}
            {h.parent_routine_id && (
              <label className={styles.inlineLabel}>
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
                          ? (available.find((r) => r.id === h.parent_routine_id)?.revision ?? null)
                          : null,
                      },
                    })
                  }
                />
                Inherit Routine schedule
              </label>
            )}
          </>
        )}
        {(kind === 'routine' || h.schedule.mode === 'explicit') && (
          <ScheduleEditor
            today={day}
            value={kind === 'habit' ? h.schedule.rule : r.schedule}
            onChange={(schedule) =>
              setValue(
                kind === 'habit'
                  ? {
                      ...h,
                      schedule: { mode: 'explicit', source_routine_revision: null, rule: schedule },
                    }
                  : { ...r, schedule },
              )
            }
          />
        )}
        {kind === 'habit' && h.parent_routine_id && (
          <label className={styles.inlineLabel}>
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
            Use each routine's time (defaults routine when ungrouped)
          </label>
        )}
        {(kind === 'routine' || h.scheduled_time.mode === 'explicit') && (
          <label>
            Scheduled time (optional)
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
        {kind === 'habit' && (
          <>
            <label>
              Minimum duration (minutes)
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
                Target amount
                <input
                  inputMode="decimal"
                  pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]+)?"
                  value={h.target_amount ?? ''}
                  onChange={(e) => setValue({ ...h, target_amount: e.target.value || null })}
                />
              </label>
              <label>
                Unit
                <input
                  required={h.target_amount !== null}
                  placeholder="pages, reps, glasses…"
                  value={h.unit ?? ''}
                  onChange={(e) => setValue({ ...h, unit: e.target.value || null })}
                />
              </label>
            </div>
          </>
        )}
        {kind === 'routine' && initial && (
          <OrderEditor
            routine={initial as Routine}
            value={r.habit_order}
            onChange={(habit_order) => setValue({ ...r, habit_order })}
          />
        )}
        <p className={styles.notice}>
          {initial
            ? 'Changes start tomorrow. Weekly/monthly quota cadence, deactivation and deletion wait until the next period. The saved change will show its exact effective date.'
            : 'Your new habit or routine becomes available on its start date.'}
        </p>
        <div className={styles.actions}>
          <button className={styles.button} disabled={write.isPending}>
            {write.isPending ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className={styles.secondary} onClick={close}>
            Cancel
          </button>
        </div>
      </form>
      {kind === 'routine' && initial && <RoutineMembers routine={initial as Routine} />}
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
    <fieldset>
      <legend>Habit order</legend>
      {ordered.map((id, i) => (
        <div className={styles.orderRow} key={id}>
          <span>{members.find((h) => h.id === id)?.name}</span>
          <button
            type="button"
            className={styles.quiet}
            disabled={i === 0}
            aria-label={`Move ${members.find((h) => h.id === id)?.name} up`}
            onClick={() => move(i, -1)}
          >
            ↑
          </button>
          <button
            type="button"
            className={styles.quiet}
            disabled={i === ordered.length - 1}
            aria-label={`Move ${members.find((h) => h.id === id)?.name} down`}
            onClick={() => move(i, 1)}
          >
            ↓
          </button>
        </div>
      ))}
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
      <h3>Routine members</h3>
      <p className={styles.muted}>
        Membership actions save separately and start tomorrow. Adding a habit preserves its other
        routines and schedule. Removing its defaults routine keeps its resolved settings.
      </p>
      <ErrorBox error={write.error} />
      {members.map((h) => (
        <div className={styles.orderRow} key={h.id}>
          <span>{h.name}</span>
          <button
            className={styles.quiet}
            disabled={write.isPending}
            onClick={() => change(h, false)}
          >
            Remove
          </button>
        </div>
      ))}
      <label>
        Add an existing habit
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">Choose a habit</option>
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
        Add to routine
      </button>
    </section>
  );
}
