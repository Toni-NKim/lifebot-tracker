import { Temporal } from '@js-temporal/polyfill';
import type { Snapshot } from '../contracts/index.js';
import type { PlanData, PlanSource, DayPlanData, ManualData } from '../contracts/timebox.js';
import type { TodoData, ProjectData, TodoExecutionData } from '../contracts/todo.js';
import { todayAt, todayView, project, isDue, addDays } from './index.js';
import { latest, todoView, durationSeconds, type TodoSource } from './todo.js';
export const DEFAULT_COLOR = '#6C63FF';
export function instantAt(day: string, time: string, zone: string) {
  return Temporal.PlainDate.from(day)
    .toZonedDateTime({ timeZone: zone, plainTime: time })
    .toInstant()
    .toString();
}
export interface Candidate {
  key: string;
  title: string;
  source: PlanSource;
  time: string | null;
  color: string | null;
  duration: number;
}
export function candidates(h: Snapshot, t: TodoSource, day: string) {
  // Validate the requested calendar range before projecting Habit history.
  const todo = todoView(t, instantAt(day, '12:00', t.settings.timezone), day);
  const habits = todayView(h, project(h, instantAt(day, '12:00', h.tracker.timezone)));
  const values: Candidate[] = [];
  const represented = new Set<string>();
  for (const r of habits.routines.filter((r) => isDue(r.schedule, day))) {
    const members = habits.items.filter((i) =>
      i.routine_contexts.some((c) => c.routine_id === r.id),
    );
    if (!members.length) continue;
    members.forEach((i) => represented.add(i.habit_id));
    values.push({
      key: `routine/${r.id}`,
      title: r.name,
      time: r.scheduled_time,
      color: r.color ?? null,
      duration: 1800,
      source: {
        type: 'routine',
        module_id: h.tracker.id,
        id: r.id,
        revision: r.revision,
        occurrence_id: null,
        anchor_date: null,
        habit_ids: members.map((i) => i.habit_id),
      },
    });
  }
  for (const i of habits.items)
    if (!represented.has(i.habit_id))
      values.push({
        key: `habit/${i.habit_id}`,
        title: i.habit.name,
        time: i.scheduled_time,
        color: i.habit.color ?? null,
        duration: 1800,
        source: {
          type: 'habit',
          module_id: h.tracker.id,
          id: i.habit_id,
          revision: i.habit.revision,
          occurrence_id: null,
          anchor_date: null,
          habit_ids: [i.habit_id],
        },
      });
  for (const i of todo.items.filter(
    (i) =>
      !i.todo.data.deleted &&
      i.workflow_status === 'next' &&
      (!i.data.do_date || i.data.do_date <= day),
  )) {
    const p = todo.projects.find((p) => p.id === i.data.project_id);
    values.push({
      key: `todo/${i.id}`,
      title: i.data.title,
      time: i.data.do_date === day ? i.todo.data.scheduled_time : null,
      color: i.todo.data.color ?? p?.data.color ?? null,
      duration: i.todo.data.estimated_duration_seconds || 1800,
      source: {
        type: 'todo',
        module_id: t.settings.id,
        id: i.todo.id,
        revision: i.data.template_revision,
        occurrence_id: i.id,
        anchor_date: i.data.anchor_date,
        habit_ids: [],
      },
    });
  }
  return { habits, todo, candidates: values };
}
export interface Actual {
  execution_date: string;
  key: string;
  title: string;
  source_type: string;
  source_id: string;
  occurrence_id: string | null;
  habit_id: string | null;
  start: string | null;
  end: string | null;
  completed_at: string | null;
  color: string;
  plan_id: string | null;
  note: string;
}
export function timeboxView(h: Snapshot, t: TodoSource, box: TodoSource, day: string, now: string) {
  const zone = h.tracker.timezone;
  const currentDay = todayAt(now, zone);
  const composed = candidates(h, t, day);
  const plans = latest<PlanData>(box, 'plan').filter(
    (r) => r.data.date === day && !r.data.cancelled,
  );
  const events: Actual[] = [];
  const begin = instantAt(day, '00:00', zone),
    finish = instantAt(addDays(day, 1), '00:00', zone);
  const intersects = (start: string | null, end: string | null, completed: string | null) =>
    start
      ? Temporal.Instant.compare(start, finish) < 0 &&
        Temporal.Instant.compare(end ?? now, begin) >= 0
      : !!completed && todayAt(completed, zone) === day;
  for (const daily of h.days)
    for (const e of daily.executions) {
      if (!e.actual_start && !e.completed_at) continue;
      const definition = h.habits.find(
        (v) => v.id === e.habit_id && v.revision === e.habit_revision,
      );
      events.push({
        key: `habit/${e.id}`,
        execution_date: daily.date,
        title: definition?.name ?? 'Habit',
        source_type: 'habit',
        source_id: e.habit_id,
        occurrence_id: null,
        habit_id: e.habit_id,
        start: e.actual_start ?? null,
        end: e.actual_end ?? null,
        completed_at: e.completed_at,
        color: definition?.color ?? DEFAULT_COLOR,
        plan_id: e.plan_ref?.plan_id ?? null,
        note: e.energy_note ?? '',
      });
    }
  for (const e of latest<TodoExecutionData>(t, 'todo_execution')) {
    const x = e.data;
    if (!x.actual_start && !x.completed_at) continue;
    const definition = latest<TodoData>(t, 'todo').find((v) => v.id === x.todo_id);
    const p = latest<ProjectData>(t, 'project').find((p) => p.id === definition?.data.project_id);
    events.push({
      key: `todo/${e.id}`,
      execution_date: todayAt(x.actual_start ?? x.completed_at!, zone),
      title: definition?.data.title ?? 'Todo',
      source_type: 'todo',
      source_id: x.todo_id,
      occurrence_id: x.occurrence_id,
      habit_id: null,
      start: x.actual_start,
      end: x.actual_end,
      completed_at: x.completed_at,
      color: definition?.data.color ?? p?.data.color ?? DEFAULT_COLOR,
      plan_id: x.plan_ref?.plan_id ?? null,
      note: x.note,
    });
  }
  for (const r of latest<ManualData>(box, 'manual_actual')) {
    const x = r.data;
    if (x.deleted) continue;
    events.push({
      key: `manual/${r.id}`,
      execution_date: x.date,
      title: x.title,
      source_type: 'manual',
      source_id: r.id,
      occurrence_id: null,
      habit_id: null,
      start: x.actual_start,
      end: x.actual_end,
      completed_at: x.actual_end,
      color: x.color ?? DEFAULT_COLOR,
      plan_id: x.plan_id,
      note: x.note,
    });
  }
  for (const a of events) {
    const plan = latest<PlanData>(box, 'plan').find(
      (p) =>
        p.id === a.plan_id &&
        ((a.source_type === 'manual' && p.data.source.type === 'manual') ||
          (a.source_type === 'todo' && p.data.source.occurrence_id === a.occurrence_id) ||
          (a.habit_id &&
            p.data.date === a.execution_date &&
            p.data.source.habit_ids.includes(a.habit_id))),
    );
    if (plan) a.color = plan.data.color_override ?? plan.data.inherited_color ?? a.color;
  }
  const actuals = events.filter(
    (a) =>
      (a.source_type !== 'habit' || a.execution_date === day) &&
      intersects(a.start, a.end, a.completed_at),
  );
  const dayPlan = latest<DayPlanData>(box, 'day_plan').find((r) => r.data.date === day);
  const clippedSeconds = (a: Actual) => {
    if (!a.start || (a.source_type === 'habit' && !a.end && day < currentDay)) return 0;
    const start = Temporal.Instant.compare(a.start, begin) < 0 ? begin : a.start;
    const end = Temporal.Instant.compare(a.end ?? now, finish) > 0 ? finish : (a.end ?? now);
    return Math.max(0, durationSeconds(start, end) ?? 0);
  };
  const todos = todoView(t, now);
  const monday = Temporal.PlainDate.from(day)
    .subtract({ days: Temporal.PlainDate.from(day).dayOfWeek - 1 })
    .toString();
  return {
    date: day,
    today: currentDay,
    now,
    timezone: zone,
    prepared: !!dayPlan,
    priorities: dayPlan?.data.priorities ?? [],
    ...composed,
    plans: plans.map((p) => {
      const related = events.filter(
        (a) =>
          (a.source_type === 'manual' && p.data.source.type === 'manual' && a.plan_id === p.id) ||
          (p.data.source.type === 'todo' && a.occurrence_id === p.data.source.occurrence_id) ||
          (a.habit_id &&
            a.execution_date === p.data.date &&
            p.data.source.habit_ids.includes(a.habit_id)),
      );
      const happened = related.length > 0;
      const progress =
        p.data.source.type === 'routine'
          ? {
              total: p.data.source.habit_ids.length,
              completed: p.data.source.habit_ids.filter((id) =>
                h.days
                  .find((d) => d.date === day)
                  ?.executions.some((e) => e.habit_id === id && e.status === 'completed'),
              ).length,
            }
          : null;
      return {
        ...p,
        progress,
        actual_keys: related.map((a) => a.key),
        execution_started: related.some((a) => !!a.start),
        execution_completed: related.some((a) => !!a.completed_at),
        color: p.data.color_override ?? p.data.inherited_color ?? DEFAULT_COLOR,
        state: happened
          ? 'ghost'
          : day < currentDay
            ? 'missed'
            : Temporal.Instant.compare(p.data.planned_end, now) < 0
              ? 'delayed'
              : 'planned',
        revision_count: box.records.filter((r) => r.kind === 'plan' && r.id === p.id).length,
      };
    }),
    actuals,
    stats: {
      planned_seconds: plans.reduce(
        (n, p) => n + (durationSeconds(p.data.planned_start, p.data.planned_end) ?? 0),
        0,
      ),
      actual_seconds: actuals.reduce((n, a) => n + clippedSeconds(a), 0),
      completed_todos: actuals.filter(
        (a) => a.source_type === 'todo' && a.completed_at && todayAt(a.completed_at, zone) === day,
      ).length,
      incomplete_todos: composed.todo.items.filter(
        (i) =>
          !i.todo.data.deleted &&
          i.workflow_status === 'next' &&
          (!i.data.do_date || i.data.do_date <= day),
      ).length,
      week_completed_todos: todos.history.filter((i) => {
        const d = todayAt(i.execution!.completed_at!, zone);
        return d >= monday && d <= day;
      }).length,
    },
  };
}
