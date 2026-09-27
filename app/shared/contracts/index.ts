import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { Temporal } from '@js-temporal/polyfill';
import { routineIds } from '../domain/membership.js';

const obj = <T extends Record<string, TSchema>>(fields: T) =>
  Type.Object(fields, { additionalProperties: false });
export const UUID = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
export const DateSchema = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const Instant = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$',
});
const Time = Type.Union([
  Type.String({ pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' }),
  Type.Null(),
]);
const nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);
const Int = Type.Integer({ minimum: 1 });
const Text = Type.String({ maxLength: 10000 });
const Amount = Type.String({ pattern: '^(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$', maxLength: 40 });
export const ScheduleSchema = Type.Union([
  obj({ type: Type.Literal('daily') }),
  obj({ type: Type.Literal('weekdays') }),
  obj({ type: Type.Literal('weekends') }),
  obj({
    type: Type.Literal('selected_weekdays'),
    weekdays: Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), {
      minItems: 1,
      maxItems: 7,
      uniqueItems: true,
    }),
  }),
  obj({ type: Type.Literal('weekly_quota'), count: Type.Integer({ minimum: 1, maximum: 7 }) }),
  obj({ type: Type.Literal('monthly_quota'), count: Type.Integer({ minimum: 1, maximum: 31 }) }),
  obj({ type: Type.Literal('every_n_days'), interval_days: Int, anchor_date: DateSchema }),
]);
export type Schedule = Static<typeof ScheduleSchema>;
const Mode = Type.Union([Type.Literal('explicit'), Type.Literal('routine')]);
const common = {
  schema_version: Type.Literal(1),
  id: UUID,
  revision: Int,
  command_id: UUID,
  created_at: Instant,
  recorded_at: Instant,
  effective_from: DateSchema,
};
export const HabitFieldsSchema = obj({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  description: Text,
  active: Type.Boolean(),
  deleted: Type.Boolean(),
  parent_routine_id: nullable(UUID),
  routine_ids: Type.Optional(Type.Array(UUID, { uniqueItems: true })),
  schedule: obj({ mode: Mode, source_routine_revision: nullable(Int), rule: ScheduleSchema }),
  scheduled_time: obj({ mode: Mode, source_routine_revision: nullable(Int), value: Time }),
  minimum_duration_seconds: nullable(Type.Integer({ minimum: 0 })),
  target_amount: nullable(Amount),
  unit: nullable(Type.String({ minLength: 1, maxLength: 100 })),
});
export const HabitSchema = obj({
  ...common,
  kind: Type.Literal('habit'),
  ...HabitFieldsSchema.properties,
});
export type Habit = Static<typeof HabitSchema>;
export type HabitFields = Static<typeof HabitFieldsSchema>;
export const RoutineFieldsSchema = obj({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  description: Text,
  deleted: Type.Boolean(),
  schedule: ScheduleSchema,
  scheduled_time: Time,
  habit_order: Type.Array(UUID, { uniqueItems: true }),
});
export const RoutineSchema = obj({
  ...common,
  kind: Type.Literal('routine'),
  ...RoutineFieldsSchema.properties,
});
export type Routine = Static<typeof RoutineSchema>;
export type RoutineFields = Static<typeof RoutineFieldsSchema>;
export const TrackerSchema = obj({
  schema_version: Type.Literal(1),
  kind: Type.Literal('tracker'),
  id: UUID,
  created_at: Instant,
  tracking_started_on: DateSchema,
  timezone: Type.String(),
  week_starts_on: Type.Literal('monday'),
});
export type Tracker = Static<typeof TrackerSchema>;
export const ContextSchema = obj({
  duration_seconds: nullable(Type.Integer({ minimum: 0 })),
  actual_amount: nullable(Amount),
  difficulty_or_quality: nullable(Text),
  energy_note: nullable(Text),
});
export const ExecutionInputSchema = obj({
  status: Type.Union([Type.Literal('completed'), Type.Literal('incomplete')]),
  ...ContextSchema.properties,
});
export type ExecutionInput = Static<typeof ExecutionInputSchema>;
export const ExecutionSchema = obj({
  ...ExecutionInputSchema.properties,
  id: UUID,
  habit_id: UUID,
  habit_revision: Int,
  routine_id: nullable(UUID),
  routine_revision: nullable(Int),
  slot: Type.Literal(1),
  completed_at: nullable(Instant),
  recorded_at: Instant,
  updated_at: Instant,
  target_amount: nullable(Amount),
  unit: nullable(Type.String({ minLength: 1, maxLength: 100 })),
});
export type Execution = Static<typeof ExecutionSchema>;
const ReceiptSchema = obj({
  command_id: UUID,
  request_sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  applied_revision: Int,
});
export const DailySchema = obj({
  schema_version: Type.Literal(1),
  kind: Type.Literal('daily_execution'),
  tracker_id: UUID,
  date: DateSchema,
  timezone: Type.String(),
  revision: Int,
  created_at: Instant,
  updated_at: Instant,
  executions: Type.Array(ExecutionSchema),
  receipts: Type.Array(ReceiptSchema),
});
export type Daily = Static<typeof DailySchema>;
export const CommitSchema = obj({
  schema_version: Type.Literal(1),
  kind: Type.Literal('definition_commit'),
  id: UUID,
  recorded_at: Instant,
  request_sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  files: Type.Array(Type.String({ pattern: '^(Habits|Routines)/[0-9a-f-]{36}/[0-9]{6,}\\.md$' }), {
    minItems: 1,
    uniqueItems: true,
  }),
});
export type Commit = Static<typeof CommitSchema>;
export type Document = Habit | Routine | Tracker | Daily | Commit;
export interface Snapshot {
  tracker: Tracker;
  habits: Habit[];
  routines: Routine[];
  days: Daily[];
  commits: Commit[];
  sources: { path: string; kind: string; sha256: string }[];
  fingerprint: string;
  warnings: string[];
}
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function validate<T>(schema: TSchema, value: unknown): T {
  if (!Value.Check(schema, value)) {
    const e = [...Value.Errors(schema, value)][0];
    throw new AppError('VALIDATION_ERROR', `${e?.path || '/'}: ${e?.message}`);
  }
  walk(value);
  return value as T;
}
function walk(value: unknown, key = ''): void {
  if (typeof value === 'string') {
    try {
      if (['date', 'effective_from', 'tracking_started_on', 'anchor_date'].includes(key))
        Temporal.PlainDate.from(value);
      if (key.endsWith('_at')) Temporal.Instant.from(value);
      if (key === 'timezone') Temporal.Now.instant().toZonedDateTimeISO(value);
    } catch {
      throw new AppError('VALIDATION_ERROR', `Invalid ${key}: ${value}`);
    }
  } else if (Array.isArray(value)) {
    value.forEach((v) => walk(v));
  } else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) walk(v, k);
}
export function parseDocument(value: unknown): Document {
  const kind = (value as { kind?: string })?.kind;
  const schemas: Record<string, TSchema> = {
    habit: HabitSchema,
    routine: RoutineSchema,
    tracker: TrackerSchema,
    daily_execution: DailySchema,
    definition_commit: CommitSchema,
  };
  if (!kind || !schemas[kind]) throw new AppError('INVALID_VAULT', 'Unknown document kind');
  const doc = validate<Document>(schemas[kind], value);
  if (doc.kind === 'habit') {
    if (doc.parent_routine_id && !routineIds(doc).includes(doc.parent_routine_id))
      throw new AppError('INVALID_VAULT', 'Inherited defaults source must be a member Routine');
    if (doc.deleted && doc.active)
      throw new AppError('INVALID_VAULT', 'Deleted Habit cannot be active');
    if (doc.target_amount !== null && (!doc.unit || !/[1-9]/.test(doc.target_amount)))
      throw new AppError('INVALID_VAULT', 'Target requires positive amount and unit');
    for (const field of [doc.schedule, doc.scheduled_time])
      if (
        field.mode === 'routine'
          ? !doc.parent_routine_id || field.source_routine_revision === null
          : field.source_routine_revision !== null
      )
        throw new AppError('INVALID_VAULT', 'Invalid inheritance provenance');
  }
  if (doc.kind === 'daily_execution')
    for (const e of doc.executions)
      if ((e.status === 'completed') !== (e.completed_at !== null))
        throw new AppError('INVALID_VAULT', 'Completion timestamp does not match status');
  const schedule =
    doc.kind === 'habit' ? doc.schedule.rule : doc.kind === 'routine' ? doc.schedule : null;
  if (
    schedule?.type === 'selected_weekdays' &&
    schedule.weekdays.some((d, i) => i > 0 && d <= schedule.weekdays[i - 1])
  )
    throw new AppError('INVALID_VAULT', 'Weekdays must be sorted');
  return doc;
}
