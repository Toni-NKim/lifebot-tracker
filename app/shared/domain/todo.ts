import { v5 as uuidv5 } from 'uuid';
import { Temporal } from '@js-temporal/polyfill';
import { AppError } from '../contracts/index.js';
import type { ModuleSettings, ModuleRecord } from '../contracts/module.js';
import type {
  TodoData,
  InboxData,
  ProjectData,
  OccurrenceData,
  TodoExecutionData,
  RecordOf,
} from '../contracts/todo.js';
import { addDays, date, isDue, todayAt } from './index.js';

export interface TodoSource {
  settings: ModuleSettings;
  records: readonly ModuleRecord[];
}
export function latest<T>(s: TodoSource, kind: string): RecordOf<T>[] {
  const map = new Map<string, ModuleRecord>();
  for (const r of s.records)
    if (r.kind === kind && (map.get(r.id)?.revision ?? 0) < r.revision) map.set(r.id, r);
  return [...map.values()] as RecordOf<T>[];
}
export const occurrenceId = (moduleId: string, todoId: string, anchor: string | null) =>
  uuidv5(`${todoId}/${anchor ?? 'single'}`, moduleId);
export const todoExecutionId = (moduleId: string, occurrence: string) =>
  uuidv5(`execution/${occurrence}`, moduleId);
export function durationSeconds(
  start: string | null | undefined,
  end: string | null | undefined,
): number | null {
  return start && end
    ? Number(
        (Temporal.Instant.from(end).epochNanoseconds -
          Temporal.Instant.from(start).epochNanoseconds) /
          1000000000n,
      )
    : null;
}
export function occurrence(
  s: TodoSource,
  todoId: string,
  anchor: string | null,
): { id: string; data: OccurrenceData; saved: boolean } {
  const id = occurrenceId(s.settings.id, todoId, anchor);
  const saved = latest<OccurrenceData>(s, 'todo_occurrence').find((r) => r.id === id);
  if (saved) return { id, data: saved.data, saved: true };
  const versions = s.records.filter(
    (r) => r.kind === 'todo' && r.id === todoId,
  ) as RecordOf<TodoData>[];
  const current = versions.toSorted((a, b) => a.revision - b.revision).at(-1);
  if (!current) throw new AppError('NOT_FOUND', 'Todo not found', 404);
  const day = anchor ?? todayAt(current.created_at, s.settings.timezone);
  const template =
    anchor === null
      ? current
      : versions
          .filter((r) => todayAt(r.recorded_at, s.settings.timezone) <= day)
          .toSorted((a, b) => a.revision - b.revision)
          .at(-1);
  const rule = versions
    .filter((r) => r.data.recurrence_effective_on <= day)
    .toSorted(
      (a, b) =>
        a.data.recurrence_effective_on.localeCompare(b.data.recurrence_effective_on) ||
        a.revision - b.revision,
    )
    .at(-1)?.data.recurrence;
  if (
    !template ||
    (anchor === null
      ? current.data.recurrence !== null
      : !rule || !isDue(rule, anchor) || anchor < template.data.recurrence_anchor)
  )
    throw new AppError('NOT_SCHEDULED', 'Todo occurrence is not scheduled on this date');
  const d = template.data;
  if (!d.active || d.deleted) throw new AppError('NOT_SCHEDULED', 'Todo is inactive');
  let due = d.due_at;
  if (anchor && due) {
    const delta = date(d.recurrence_anchor).until(date(anchor)).days;
    due = Temporal.Instant.from(due)
      .toZonedDateTimeISO(s.settings.timezone)
      .add({ days: delta })
      .toInstant()
      .toString();
  }
  return {
    id,
    saved: false,
    data: {
      todo_id: todoId,
      template_revision: template.revision,
      anchor_date: anchor,
      do_date: anchor ?? d.do_date,
      due_at: due,
      title: d.title,
      project_id: d.project_id,
      workflow_status: d.workflow_status,
    },
  };
}
export function todoView(
  s: TodoSource,
  now: string,
  referenceDate = todayAt(now, s.settings.timezone),
) {
  try {
    date(referenceDate);
  } catch {
    throw new AppError('VALIDATION_ERROR', 'Invalid calendar date');
  }
  s = {
    ...s,
    records: s.records.filter((r) => todayAt(r.recorded_at, s.settings.timezone) <= referenceDate),
  };
  if (Math.abs(date(s.settings.activated_on).until(date(referenceDate)).days) > 36600)
    throw new AppError(
      'VALIDATION_ERROR',
      'Reference date is outside the supported calendar range',
    );
  const todos = latest<TodoData>(s, 'todo');
  const executions = new Map(
    latest<TodoExecutionData>(s, 'todo_execution').map((r) => [r.data.occurrence_id, r]),
  );
  const occurrences = new Map(
    latest<OccurrenceData>(s, 'todo_occurrence').map((r) => [
      r.id,
      { id: r.id, data: r.data, saved: true },
    ]),
  );
  for (const t of todos) {
    if (t.data.recurrence === null) {
      try {
        const o = occurrence(s, t.id, null);
        occurrences.set(o.id, o);
      } catch (e) {
        if (!(e instanceof AppError) || e.code !== 'NOT_SCHEDULED') throw e;
      }
    } else {
      for (let day = t.data.recurrence_anchor; day <= referenceDate; day = addDays(day, 1)) {
        try {
          const o = occurrence(s, t.id, day);
          occurrences.set(o.id, o);
        } catch (e) {
          if (!(e instanceof AppError) || e.code !== 'NOT_SCHEDULED') throw e;
        }
      }
    }
  }
  const items = [...occurrences.values()]
    .map((o) => {
      const todo = todos.find((t) => t.id === o.data.todo_id)!;
      const execution = executions.get(o.id)?.data ?? null;
      const seconds = o.data.due_at
        ? Number(
            Temporal.Instant.from(o.data.due_at).epochMilliseconds -
              Temporal.Instant.from(now).epochMilliseconds,
          ) / 1000
        : null;
      return {
        ...o,
        todo,
        execution,
        workflow_status: execution?.completed_at
          ? ('completed' as const)
          : o.saved
            ? o.data.workflow_status
            : todo.data.workflow_status,
        actual_duration_seconds: durationSeconds(execution?.actual_start, execution?.actual_end),
        urgency:
          seconds === null
            ? 'none'
            : seconds < 0
              ? 'overdue'
              : seconds <= 7200
                ? 'imminent'
                : todayAt(o.data.due_at!, s.settings.timezone) === referenceDate
                  ? 'today'
                  : 'upcoming',
      };
    })
    .sort((a, b) => {
      const score = { high: 0, normal: 1, low: 2 };
      return (
        score[a.todo.data.importance] - score[b.todo.data.importance] ||
        (a.data.due_at ?? 'z').localeCompare(b.data.due_at ?? 'z') ||
        a.id.localeCompare(b.id)
      );
    });
  const projects = latest<ProjectData>(s, 'project').map((p) => {
    const eligible = items.filter(
      (i) =>
        i.data.project_id === p.id &&
        !i.todo.data.deleted &&
        !['waiting', 'someday'].includes(i.data.workflow_status) &&
        (!i.data.anchor_date || i.data.anchor_date <= referenceDate),
    );
    const completed = eligible.filter((i) => !!i.execution?.completed_at).length;
    const activity =
      s.records
        .filter(
          (r) =>
            r.id === p.id ||
            (r.kind === 'todo' && (r.data as TodoData).project_id === p.id) ||
            (r.kind === 'todo_execution' &&
              eligible.some((i) => i.id === (r.data as TodoExecutionData).occurrence_id)),
        )
        .map((r) => r.recorded_at)
        .sort()
        .at(-1) ?? p.created_at;
    return {
      ...p,
      completed,
      total: eligible.length,
      completion_rate: eligible.length ? completed / eligible.length : null,
      last_activity_at: activity,
    };
  });
  const inbox = latest<InboxData>(s, 'inbox_item')
    .filter((i) => !i.data.processed_at && !i.data.discarded_at)
    .map((i) => ({
      ...i,
      age_days: Math.max(
        0,
        date(todayAt(i.created_at, s.settings.timezone)).until(date(referenceDate)).days,
      ),
    }))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  return {
    date: referenceDate,
    timezone: s.settings.timezone,
    inbox,
    todos,
    items,
    projects,
    history: items
      .filter((i) => i.execution?.completed_at)
      .sort((a, b) => b.execution!.completed_at!.localeCompare(a.execution!.completed_at!)),
  };
}
