// Independently maintained HTTP response readers. Never import canonical schemas.
// Unknown additive fields are stripped; missing/changed consumed fields fail closed.
import { z } from 'zod';
import { count, date, id, instant, token, zone } from './primitives.js';
const text = z.string();
const nullableText = text.nullable();
const timing = {
  actual_start: instant.nullable().optional(),
  actual_end: instant.nullable().optional(),
  completed_at: instant.nullable(),
};
export const execution = z.object({
  status: z.enum(['completed', 'incomplete']),
  duration_seconds: count.nullable(),
  actual_amount: nullableText,
  difficulty_or_quality: nullableText,
  energy_note: nullableText,
  ...timing,
});
const rule = z.discriminatedUnion('type', [
  z.object({ type: z.literal('daily') }),
  z.object({ type: z.literal('weekdays') }),
  z.object({ type: z.literal('weekends') }),
  z.object({
    type: z.literal('selected_weekdays'),
    weekdays: z.array(z.number().int().min(1).max(7)),
  }),
  z.object({ type: z.literal('weekly_quota'), count }),
  z.object({ type: z.literal('monthly_quota'), count }),
  z.object({ type: z.literal('every_n_days'), interval_days: count, anchor_date: date }),
]);
export const habit = z.object({
  id,
  name: text,
  description: text,
  active: z.boolean(),
  deleted: z.boolean(),
  effective_from: date,
  parent_routine_id: id.nullable(),
  routine_ids: z.array(id).optional(),
  schedule: z.object({ rule }),
  scheduled_time: z.object({ value: nullableText }),
  target_amount: nullableText,
  unit: nullableText,
});
export const quota = z.object({
  id,
  habit_id: id,
  unit: z.enum(['weeks', 'months']),
  start: date,
  end: date,
  target_count: count,
  actual_count: count,
  credited_count: count,
  status: z.enum(['completed', 'incomplete']),
  is_final: z.boolean(),
});
export const habitItem = z.object({
  habit_id: id,
  habit,
  scheduled_time: nullableText,
  execution: execution.nullable(),
  quota: quota.nullable(),
  routine_contexts: z.array(z.object({ routine_id: id, scheduled_time: nullableText })),
});
export const today = z.object({
  date,
  timezone: zone,
  items: z.array(habitItem),
  routines: z.array(z.object({ id, name: text, scheduled_time: nullableText })),
});
export const definitions = z.array(
  z.object({ id, current: habit.nullable(), pending: z.array(habit) }),
);
const todoData = z.object({
  title: text,
  description: text,
  deleted: z.boolean(),
  importance: z.enum(['high', 'normal', 'low']),
  recurrence: rule.nullable(),
  estimated_duration_seconds: count.nullable(),
});
export const todoItem = z.object({
  id,
  data: z.object({
    todo_id: id,
    anchor_date: date.nullable(),
    do_date: date.nullable(),
    due_at: instant.nullable(),
    title: text,
    project_id: id.nullable(),
  }),
  todo: z.object({ id, data: todoData }),
  workflow_status: z.enum(['next', 'waiting', 'someday', 'completed']),
  execution: z.object({ ...timing, note: text }).nullable(),
  actual_duration_seconds: count.nullable(),
  urgency: z.enum(['none', 'overdue', 'imminent', 'today', 'upcoming']),
});
export const inbox = z.object({
  id,
  created_at: instant,
  data: z.object({ title: text }),
  age_days: count,
});
export const project = z.object({
  id,
  data: z.object({ name: text, description: text, status: z.enum(['active', 'archived']) }),
  completed: count,
  total: count,
  completion_rate: z.number().min(0).max(1).nullable(),
  last_activity_at: instant,
});
export const todos = z.object({
  date,
  timezone: zone,
  items: z.array(todoItem),
  inbox: z.array(inbox),
  projects: z.array(project),
  history: z.array(todoItem),
});
const source = z.object({
  type: z.enum(['todo', 'habit', 'routine', 'manual']),
  id: id.nullable(),
  occurrence_id: id.nullable(),
  anchor_date: date.nullable(),
  habit_ids: z.array(id),
});
export const plan = z.object({
  id,
  revision: count,
  data: z.object({ title: text, date, source, planned_start: instant, planned_end: instant }),
  state: z.enum(['ghost', 'missed', 'delayed', 'planned']),
  execution_started: z.boolean(),
  execution_completed: z.boolean(),
});
export const actual = z.object({
  key: text,
  title: text,
  source_type: z.enum(['habit', 'todo', 'manual']),
  source_id: id,
  occurrence_id: id.nullable(),
  execution_date: date,
  start: instant.nullable(),
  end: instant.nullable(),
  completed_at: instant.nullable(),
  plan_id: id.nullable(),
  note: text,
});
export const candidate = z.object({
  key: text,
  title: text,
  source,
  time: nullableText,
  duration: count,
});
export const action = z.object({
  id,
  state: z.literal('pending'),
  title: text,
  error: nullableText,
});
export const agendaStats = z.object({
  planned_seconds: count,
  actual_seconds: count,
  completed_todos: count,
  incomplete_todos: count,
  week_completed_todos: count,
});
export const agenda = z.object({
  date,
  today: date,
  now: instant,
  timezone: zone,
  prepared: z.boolean(),
  priorities: z.array(id).max(3),
  versions: z.object({ habit: token, todo: token, timebox: token }),
  habits: today,
  todo: todos,
  plans: z.array(plan),
  actuals: z.array(actual),
  candidates: z.array(candidate),
  actions: z.array(action),
  stats: agendaStats,
});
export const historyRow = z.object({
  habit_id: id,
  date,
  kind: z.enum(['scheduled', 'quota_activity']),
  name: text,
  status: z.enum(['completed', 'incomplete']).optional(),
  execution: execution.nullable(),
});
export const history = z.object({
  rows: z.array(historyRow),
  total: count,
  offset: count,
  limit: count,
  quota_periods: z.array(quota),
  today: date,
});
const rate = z.object({
  completed: count,
  total: count,
  rate: z.number().min(0).max(100).nullable(),
});
const quotaRate = rate.extend({ successful_periods: count, total_periods: count });
const streak = z.object({
  id,
  name: text,
  current: count,
  unit: z.enum(['occurrences', 'weeks', 'months']),
  active: z.boolean(),
  longest: z.object({ occurrences: count, weeks: count, months: count }),
  provisional: z.boolean(),
});
export const statistics = z.object({
  from: date,
  to: date,
  date_scheduled: rate,
  weekly_quota: quotaRate,
  monthly_quota: quotaRate,
  live_quotas: z.array(quota),
  heatmap: z.array(rate.extend({ date })),
  habits: z.array(streak),
});
export const calendar = z.object({ date, timezone: zone, etag: token });
export const envelope = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ data, etag: token, index_warning: z.string().nullable().optional() });
