import { z } from 'zod';
import * as u from './contracts/upstream.js';

export type Paging = { offset: number; limit: number };
export const paginate = <T>(items: T[], p: Paging) => ({
  items: items.slice(p.offset, p.offset + p.limit),
  total: items.length,
  offset: p.offset,
  limit: p.limit,
});
export const completion = (e: z.infer<typeof u.execution> | null) =>
  e
    ? {
        status: e.status,
        completed_at: e.completed_at,
        start: e.actual_start ?? null,
        end: e.actual_end ?? null,
        duration_seconds: e.duration_seconds,
        amount: e.actual_amount,
        difficulty_or_quality: e.difficulty_or_quality,
        note: e.energy_note,
      }
    : null;
export const quota = (q: z.infer<typeof u.quota>) => ({
  habit_id: q.habit_id,
  unit: q.unit,
  start: q.start,
  end: q.end,
  target: q.target_count,
  actual: q.actual_count,
  credited: q.credited_count,
  status: q.status,
  final: q.is_final,
});
export const habit = (
  h: z.infer<typeof u.habit>,
  p: Paging,
  item?: z.infer<typeof u.habitItem>,
) => ({
  habit_id: h.id,
  name: h.name,
  description: h.description,
  active: h.active,
  deleted: h.deleted,
  effective_from: h.effective_from,
  cadence: h.schedule.rule.type,
  scheduled_time: item?.scheduled_time ?? h.scheduled_time.value,
  target_amount: h.target_amount,
  unit: h.unit,
  routine_ids: paginate(h.routine_ids ?? (h.parent_routine_id ? [h.parent_routine_id] : []), p),
  execution: completion(item?.execution ?? null),
  quota: item?.quota ? quota(item.quota) : null,
});
export const todo = (i: z.infer<typeof u.todoItem>) => ({
  execution_target: {
    todo_id: i.data.todo_id,
    occurrence_id: i.id,
    anchor_date: i.data.anchor_date,
  },
  title: i.data.title,
  description: i.todo.data.description,
  status: i.workflow_status,
  importance: i.todo.data.importance,
  project_id: i.data.project_id,
  do_date: i.data.do_date,
  due_at: i.data.due_at,
  urgency: i.urgency,
  recurrence: i.todo.data.recurrence?.type ?? null,
  estimated_duration_seconds: i.todo.data.estimated_duration_seconds,
  start: i.execution?.actual_start ?? null,
  end: i.execution?.actual_end ?? null,
  completed_at: i.execution?.completed_at ?? null,
  actual_duration_seconds: i.actual_duration_seconds,
  note: i.execution?.note ?? '',
});
export const inbox = (i: z.infer<typeof u.inbox>) => ({
  inbox_id: i.id,
  title: i.data.title,
  created_at: i.created_at,
  age_days: i.age_days,
});
export const project = (i: z.infer<typeof u.project>) => ({
  project_id: i.id,
  name: i.data.name,
  description: i.data.description,
  status: i.data.status,
  completed: i.completed,
  total: i.total,
  completion_rate: i.completion_rate,
  rate_unit: 'fraction' as const,
  last_activity_at: i.last_activity_at,
});
export const overview = (a: z.infer<typeof u.agenda>, p: Paging) => {
  const source = (s: z.infer<typeof u.plan>['data']['source']) => ({
    ...s,
    habit_ids: paginate(s.habit_ids, p),
  });
  return {
    prepared: a.prepared,
    habits: paginate(
      a.habits.items.map((i) => habit(i.habit, p, i)),
      p,
    ),
    todos: paginate(
      a.todo.items
        .filter(
          (i) =>
            !i.todo.data.deleted &&
            i.workflow_status === 'next' &&
            (!i.data.do_date || i.data.do_date <= a.date),
        )
        .map(todo),
      p,
    ),
    inbox: paginate(a.todo.inbox.map(inbox), p),
    plans: paginate(
      a.plans.map((i) => ({
        plan_id: i.id,
        revision: i.revision,
        date: i.data.date,
        title: i.data.title,
        source: source(i.data.source),
        start: i.data.planned_start,
        end: i.data.planned_end,
        state: i.state,
        execution_started: i.execution_started,
        execution_completed: i.execution_completed,
      })),
      p,
    ),
    actuals: paginate(a.actuals, p),
    candidates: paginate(
      a.candidates.map((i) => ({
        candidate_key: i.key,
        title: i.title,
        source: source(i.source),
        scheduled_time: i.time,
        duration_seconds: i.duration,
      })),
      p,
    ),
    priorities: a.priorities,
    pending_actions: paginate(
      a.actions.map((i) => ({
        action_id: i.id,
        title: i.title,
        state: i.state,
        source_changed: i.error !== null,
      })),
      p,
    ),
    stats: a.stats,
  };
};
