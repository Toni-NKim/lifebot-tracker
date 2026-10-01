import { Type, type Static } from '@sinclair/typebox';
import { Temporal } from '@js-temporal/polyfill';
import { v5 as uuidv5 } from 'uuid';
import { AppError, UUID, DateSchema, ColorSchema } from './index.js';
import { ModuleInstant, type ModuleContract } from './module.js';
import { strict, nullable, Title } from './module-fields.js';
export const SourceSchema = strict({
  type: Type.Union(['todo', 'habit', 'routine', 'manual'].map((s) => Type.Literal(s))),
  module_id: nullable(UUID),
  id: nullable(UUID),
  revision: nullable(Type.Integer({ minimum: 1 })),
  occurrence_id: nullable(UUID),
  anchor_date: nullable(DateSchema),
  habit_ids: Type.Array(UUID, { uniqueItems: true }),
});
export type PlanSource = Static<typeof SourceSchema>;
export const PlanSchema = strict({
  date: DateSchema,
  source: SourceSchema,
  title: Title,
  planned_start: ModuleInstant,
  planned_end: ModuleInstant,
  color_override: ColorSchema,
  inherited_color: ColorSchema,
  origin: Type.Union([Type.Literal('automatic'), Type.Literal('user')]),
  cancelled: Type.Boolean(),
});
export type PlanData = Static<typeof PlanSchema>;
export const DayPlanSchema = strict({
  date: DateSchema,
  prepared_at: ModuleInstant,
  priorities: Type.Array(UUID, { maxItems: 3, uniqueItems: true }),
});
export type DayPlanData = Static<typeof DayPlanSchema>;
export const ManualSchema = strict({
  date: DateSchema,
  title: Title,
  actual_start: ModuleInstant,
  actual_end: nullable(ModuleInstant),
  color: ColorSchema,
  note: Type.String({ maxLength: 10000 }),
  plan_id: nullable(UUID),
  deleted: Type.Boolean(),
});
export type ManualData = Static<typeof ManualSchema>;
export const timeboxContract: ModuleContract = {
  name: 'timebox',
  records: {
    plan: { directory: 'Plans', version: 1, schema: PlanSchema },
    day_plan: { directory: 'Days', version: 1, schema: DayPlanSchema },
    manual_actual: { directory: 'Actual', version: 1, schema: ManualSchema },
  },
  validate(records, settings) {
    for (const r of records) {
      const d = r.data as PlanData | DayPlanData | ManualData;
      Temporal.PlainDate.from(d.date);
      if (r.kind === 'day_plan' && r.id !== uuidv5(`day/${d.date}`, settings.id))
        throw new AppError('INVALID_VAULT', 'Day identity mismatch');
      if (r.kind === 'plan') {
        const p = d as PlanData;
        const start = Temporal.Instant.from(p.planned_start).toZonedDateTimeISO(settings.timezone);
        const end = Temporal.Instant.from(p.planned_end).toZonedDateTimeISO(settings.timezone);
        if (
          start.toPlainDate().toString() !== p.date ||
          Temporal.ZonedDateTime.compare(start, end) >= 0 ||
          Temporal.ZonedDateTime.compare(end, start.startOfDay().add({ days: 1 })) > 0
        )
          throw new AppError('INVALID_VAULT', 'Plan interval must stay inside its local day');
        if (
          p.origin === 'user' &&
          [start, end].some(
            (t) => t.minute % 15 || t.second || t.millisecond || t.microsecond || t.nanosecond,
          )
        )
          throw new AppError('INVALID_VAULT', 'Plans snap to 15 minutes');
        if (
          p.source.type !== 'manual' &&
          (!p.source.id || !p.source.module_id || !p.source.revision)
        )
          throw new AppError('INVALID_VAULT', 'Plan source identity is required');
        if (p.source.type === 'todo' && !p.source.occurrence_id)
          throw new AppError('INVALID_VAULT', 'Todo Plan needs an occurrence');
      }
      if (r.kind === 'manual_actual') {
        const a = d as ManualData;
        if (
          Temporal.Instant.from(a.actual_start)
            .toZonedDateTimeISO(settings.timezone)
            .toPlainDate()
            .toString() !== a.date ||
          (a.actual_end && Temporal.Instant.compare(a.actual_start, a.actual_end) > 0)
        )
          throw new AppError('INVALID_VAULT', 'Invalid Manual Actual interval');
        if (
          a.plan_id &&
          !records.some(
            (p) =>
              p.kind === 'plan' &&
              p.id === a.plan_id &&
              (p.data as PlanData).source.type === 'manual',
          )
        )
          throw new AppError('INVALID_VAULT', 'Only manual Plans may own a Manual Actual');
      }
    }
  },
};
