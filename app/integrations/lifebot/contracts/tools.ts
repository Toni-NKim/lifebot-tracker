import { z } from 'zod';
import { count, date, id, instant, page, pageInput, target, versions, zone } from './primitives.js';

const inputs = z.object(pageInput).strict();
const query = z.string().max(200).optional();
export const inputSchemas = {
  get_today: inputs,
  get_agenda: inputs.extend({ date: date.optional() }),
  get_habits: inputs.extend({
    view: z.enum(['today', 'definitions']).default('today'),
    include_pending: z.boolean().default(false),
    routine_id: id.optional(),
  }),
  get_todos: inputs.extend({
    date: date.optional(),
    status: z.enum(['open', 'next', 'waiting', 'someday', 'completed']).default('open'),
    project_id: id.optional(),
    query,
  }),
  get_inbox: inputs.extend({ query }),
  get_projects: inputs.extend({ status: z.enum(['active', 'archived', 'all']).default('active') }),
  get_history: inputs
    .extend({ domain: z.enum(['habit', 'todo']), from: date, to: date })
    .refine((a) => a.from <= a.to, 'from must not follow to'),
  get_stats: z.union([
    inputs
      .extend({
        domain: z.literal('habit'),
        from: date.optional(),
        to: date.optional(),
        habit_id: id.optional(),
      })
      .refine((a) => !a.from || !a.to || a.from <= a.to, 'from must not follow to'),
    inputs.extend({ domain: z.literal('agenda'), date: date.optional() }),
  ]),
};
export type ToolName = keyof typeof inputSchemas;
export const toolNames = Object.keys(inputSchemas) as ToolName[];
export const descriptions: Record<ToolName, string> = {
  get_today:
    'Read integrated Today without preparing or saving Plans. Collections have independent pages; unavailable sections are null.',
  get_agenda:
    'Read one Tracker-calendar day of Plans, Actuals, candidates and pending-action summaries. Never prepares Plans.',
  get_habits:
    'Read today’s Habits or current/pending definitions. Does not edit schedules or executions.',
  get_todos:
    'Read Todo occurrences; copy execution_target unchanged for identity. date is an as-of reference date, not a due-date filter.',
  get_inbox: 'Read unprocessed Inbox captures, oldest first.',
  get_projects:
    'Read Projects and Tracker completion fractions (0–1), without changing their denominator.',
  get_history:
    'Read Habit scheduled/quota history or currently completed Todo occurrences. This is not a full edit/undo audit log.',
  get_stats:
    'Read Tracker Habit rates (percent) or one day’s agenda metrics (seconds/counts). Never combines them into a score.',
};
const nullableText = z.string().nullable();
const completion = z
  .object({
    status: z.enum(['completed', 'incomplete']),
    completed_at: instant.nullable(),
    start: instant.nullable(),
    end: instant.nullable(),
    duration_seconds: count.nullable(),
    amount: nullableText,
    difficulty_or_quality: nullableText,
    note: nullableText,
  })
  .strict();
const quota = z
  .object({
    habit_id: id,
    unit: z.enum(['weeks', 'months']),
    start: date,
    end: date,
    target: count,
    actual: count,
    credited: count,
    status: z.enum(['completed', 'incomplete']),
    final: z.boolean(),
  })
  .strict();
const habit = z
  .object({
    habit_id: id,
    name: z.string(),
    description: z.string(),
    active: z.boolean(),
    deleted: z.boolean(),
    effective_from: date,
    cadence: z.string(),
    scheduled_time: nullableText,
    target_amount: nullableText,
    unit: nullableText,
    routine_ids: page(id),
    execution: completion.nullable(),
    quota: quota.nullable(),
  })
  .strict();
const todo = z
  .object({
    execution_target: target,
    title: z.string(),
    description: z.string(),
    status: z.enum(['next', 'waiting', 'someday', 'completed']),
    importance: z.enum(['high', 'normal', 'low']),
    project_id: id.nullable(),
    do_date: date.nullable(),
    due_at: instant.nullable(),
    urgency: z.enum(['none', 'overdue', 'imminent', 'today', 'upcoming']),
    recurrence: nullableText,
    estimated_duration_seconds: count.nullable(),
    start: instant.nullable(),
    end: instant.nullable(),
    completed_at: instant.nullable(),
    actual_duration_seconds: count.nullable(),
    note: z.string(),
  })
  .strict();
const inbox = z
  .object({ inbox_id: id, title: z.string(), created_at: instant, age_days: count })
  .strict();
const project = z
  .object({
    project_id: id,
    name: z.string(),
    description: z.string(),
    status: z.enum(['active', 'archived']),
    completed: count,
    total: count,
    completion_rate: z.number().min(0).max(1).nullable(),
    rate_unit: z.literal('fraction'),
    last_activity_at: instant,
  })
  .strict();
const source = z
  .object({
    type: z.enum(['habit', 'routine', 'todo', 'manual']),
    id: id.nullable(),
    occurrence_id: id.nullable(),
    anchor_date: date.nullable(),
    habit_ids: page(id),
  })
  .strict();
const plan = z
  .object({
    plan_id: id,
    revision: count,
    date,
    title: z.string(),
    source,
    start: instant,
    end: instant,
    state: z.enum(['ghost', 'missed', 'delayed', 'planned']),
    execution_started: z.boolean(),
    execution_completed: z.boolean(),
  })
  .strict();
const actual = z
  .object({
    key: z.string(),
    title: z.string(),
    source_type: z.enum(['habit', 'todo', 'manual']),
    source_id: id,
    occurrence_id: id.nullable(),
    execution_date: date,
    start: instant.nullable(),
    end: instant.nullable(),
    completed_at: instant.nullable(),
    plan_id: id.nullable(),
    note: z.string(),
  })
  .strict();
const candidate = z
  .object({
    candidate_key: z.string(),
    title: z.string(),
    source,
    scheduled_time: nullableText,
    duration_seconds: count,
  })
  .strict();
const pending = z
  .object({
    action_id: id,
    title: z.string(),
    state: z.literal('pending'),
    source_changed: z.boolean(),
  })
  .strict();
const agendaMetrics = z
  .object({
    planned_seconds: count,
    actual_seconds: count,
    completed_todos: count,
    incomplete_todos: count,
    week_completed_todos: count,
  })
  .strict();
const overview = z
  .object({
    prepared: z.boolean().nullable(),
    habits: page(habit).nullable(),
    todos: page(todo).nullable(),
    inbox: page(inbox).nullable(),
    plans: page(plan).nullable(),
    actuals: page(actual).nullable(),
    candidates: page(candidate).nullable(),
    priorities: z.array(id).max(3).nullable(),
    pending_actions: page(pending).nullable(),
    stats: agendaMetrics.nullable(),
  })
  .strict();
const rate = z
  .object({ completed: count, total: count, rate: z.number().min(0).max(100).nullable() })
  .strict();
const quotaRate = rate.extend({ successful_periods: count, total_periods: count });
const streak = z
  .object({
    habit_id: id,
    name: z.string(),
    current: count,
    unit: z.enum(['occurrences', 'weeks', 'months']),
    active: z.boolean(),
    longest: z.object({ occurrences: count, weeks: count, months: count }).strict(),
    provisional: z.boolean(),
  })
  .strict();
export const dataSchemas = {
  get_today: overview,
  get_agenda: overview,
  get_habits: z.object({ habits: page(habit), pending_definitions: page(habit) }).strict(),
  get_todos: z.object({ todos: page(todo) }).strict(),
  get_inbox: z.object({ inbox: page(inbox) }).strict(),
  get_projects: z.object({ projects: page(project) }).strict(),
  get_history: z.union([
    z
      .object({
        domain: z.literal('habit'),
        from: date,
        to: date,
        history: page(
          z
            .object({
              habit_id: id,
              date,
              name: z.string(),
              kind: z.enum(['scheduled', 'quota_activity']),
              status: z.enum(['completed', 'incomplete']).nullable(),
              execution: completion.nullable(),
            })
            .strict(),
        ),
        quota_periods: page(quota),
      })
      .strict(),
    z.object({ domain: z.literal('todo'), from: date, to: date, history: page(todo) }).strict(),
  ]),
  get_stats: z.union([
    z
      .object({
        domain: z.literal('agenda'),
        units: z.literal('seconds_and_counts'),
        metrics: agendaMetrics,
      })
      .strict(),
    z
      .object({
        domain: z.literal('habit'),
        from: date,
        to: date,
        rate_unit: z.literal('percent'),
        date_scheduled: rate,
        weekly_quota: quotaRate,
        monthly_quota: quotaRate,
        live_quotas: page(quota),
        heatmap: page(rate.extend({ date })),
        streaks: page(streak),
      })
      .strict(),
  ]),
};
const issue = z
  .object({
    module: z.enum(['habit', 'todo', 'timebox', 'agenda']),
    code: z.string(),
    message: z.string(),
  })
  .strict();
export const outputSchema = (name: ToolName) =>
  z
    .object({
      schema_version: z.literal('1'),
      status: z.enum(['ok', 'partial', 'unavailable', 'error']),
      date: date.nullable(),
      timezone: zone.nullable(),
      observed_at: instant,
      versions,
      agenda_etag: z.string().optional(),
      // Observations remain separate when endpoints were read at different times.
      observations: z
        .array(z.object({ endpoint: z.string(), etag: z.string(), date: date.nullable() }).strict())
        .max(10),
      data: dataSchemas[name].nullable(),
      warnings: z.array(z.string()).max(20),
      unavailable_modules: z.array(issue).max(4),
      error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
    })
    .strict();
