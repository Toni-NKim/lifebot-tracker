import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { UUID, DateSchema, ColorSchema, PlanRefSchema, AppError } from './index.js';
import { ModuleInstant, type ModuleRecord, type ModuleContract } from './module.js';
import { PlanSchema } from './timebox.js';
import { v5 as uuidv5 } from 'uuid';
import { Temporal } from '@js-temporal/polyfill';

import { strict, nullable, Title } from './module-fields.js';
export { strict, nullable, Title } from './module-fields.js';
const Text = Type.String({ maxLength: 10000 });
export const Workflow = Type.Union([
  Type.Literal('next'),
  Type.Literal('waiting'),
  Type.Literal('someday'),
]);
export const Recurrence = nullable(
  Type.Union([
    strict({ type: Type.Literal('daily') }),
    strict({ type: Type.Literal('weekdays') }),
    strict({ type: Type.Literal('weekends') }),
    strict({
      type: Type.Literal('selected_weekdays'),
      weekdays: Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), {
        minItems: 1,
        maxItems: 7,
        uniqueItems: true,
      }),
    }),
    strict({
      type: Type.Literal('every_n_days'),
      interval_days: Type.Integer({ minimum: 1, maximum: 366 }),
      anchor_date: DateSchema,
    }),
  ]),
);
export const TodoFieldsSchema = strict({
  title: Title,
  description: Text,
  workflow_status: Workflow,
  importance: Type.Union([Type.Literal('high'), Type.Literal('normal'), Type.Literal('low')]),
  project_id: nullable(UUID),
  do_date: nullable(DateSchema),
  due_at: nullable(ModuleInstant),
  scheduled_time: nullable(Type.String({ pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' })),
  estimated_duration_seconds: nullable(Type.Integer({ minimum: 0, maximum: 86400 })),
  recurrence: Recurrence,
  color: ColorSchema,
});
export type TodoFields = Static<typeof TodoFieldsSchema>;
export const TodoDataSchema = strict({
  ...TodoFieldsSchema.properties,
  recurrence_effective_on: DateSchema,
  recurrence_anchor: DateSchema,
  active: Type.Boolean(),
  deleted: Type.Boolean(),
  discarded_at: nullable(ModuleInstant),
});
export type TodoData = Static<typeof TodoDataSchema>;
export const InboxSchema = strict({
  title: Title,
  processed_at: nullable(ModuleInstant),
  converted_todo_id: nullable(UUID),
  discarded_at: nullable(ModuleInstant),
});
export type InboxData = Static<typeof InboxSchema>;
export const ProjectFieldsSchema = strict({
  name: Title,
  description: Text,
  color: ColorSchema,
  status: Type.Union([Type.Literal('active'), Type.Literal('archived')]),
});
export type ProjectFields = Static<typeof ProjectFieldsSchema>;
export const ProjectSchema = strict({
  ...ProjectFieldsSchema.properties,
  archived_at: nullable(ModuleInstant),
});
export type ProjectData = Static<typeof ProjectSchema>;
export const OccurrenceSchema = strict({
  todo_id: UUID,
  template_revision: Type.Integer({ minimum: 1 }),
  anchor_date: nullable(DateSchema),
  do_date: nullable(DateSchema),
  due_at: nullable(ModuleInstant),
  title: Title,
  project_id: nullable(UUID),
  workflow_status: Workflow,
});
export type OccurrenceData = Static<typeof OccurrenceSchema>;
export const TodoExecutionSchema = strict({
  todo_id: UUID,
  occurrence_id: UUID,
  actual_start: nullable(ModuleInstant),
  actual_end: nullable(ModuleInstant),
  completed_at: nullable(ModuleInstant),
  plan_ref: nullable(PlanRefSchema),
  note: Text,
});
export type TodoExecutionData = Static<typeof TodoExecutionSchema>;
export type RecordOf<T> = Omit<ModuleRecord, 'data'> & { data: T };

export const ActionSchema = strict({
  inbox_id: UUID,
  todo_id: UUID,
  plan_id: UUID,
  target_module_id: UUID,
  target_etag: Type.String(),
  target_command: UUID,
  plan: PlanSchema,
  state: Type.Union([Type.Literal('pending'), Type.Literal('done')]),
});
export type ActionData = Static<typeof ActionSchema>;

export const todoContract: ModuleContract = {
  name: 'todo',
  records: {
    staged_action: { directory: 'Actions', version: 1, schema: ActionSchema },
    inbox_item: { directory: 'Inbox', version: 1, schema: InboxSchema },
    todo: { directory: 'Todos', version: 1, schema: TodoDataSchema },
    project: { directory: 'Projects', version: 1, schema: ProjectSchema },
    todo_occurrence: { directory: 'Occurrences', version: 1, schema: OccurrenceSchema },
    todo_execution: { directory: 'Executions', version: 1, schema: TodoExecutionSchema },
  },
  validate(records, settings) {
    const has = (kind: string, id: string) => records.some((r) => r.kind === kind && r.id === id);
    for (const r of records) {
      const d = r.data as Record<string, unknown>;
      for (const k of ['do_date', 'anchor_date', 'recurrence_anchor', 'recurrence_effective_on'])
        if (typeof d[k] === 'string') Temporal.PlainDate.from(d[k] as string);
      if (typeof d.project_id === 'string' && !has('project', d.project_id))
        throw new AppError('INVALID_VAULT', 'Unknown Project');
      if (
        r.kind === 'staged_action' &&
        (!has('todo', (r.data as ActionData).todo_id) ||
          !has('inbox_item', (r.data as ActionData).inbox_id))
      )
        throw new AppError('INVALID_VAULT', 'Staged action source missing');
      if (r.kind === 'todo') {
        const t = r.data as TodoData;
        if (t.deleted && t.active)
          throw new AppError('INVALID_VAULT', 'Deleted Todo must be inactive');
        if (t.recurrence?.type === 'every_n_days')
          Temporal.PlainDate.from(t.recurrence.anchor_date);
      }
      if (r.kind === 'inbox_item') {
        const i = r.data as InboxData;
        if (
          (i.processed_at !== null) !== (i.converted_todo_id !== null) ||
          (i.processed_at && i.discarded_at) ||
          (i.converted_todo_id && !has('todo', i.converted_todo_id))
        )
          throw new AppError('INVALID_VAULT', 'Invalid Inbox processing state');
      }
      if (r.kind === 'todo_occurrence') {
        const o = r.data as OccurrenceData;
        if (r.id !== uuidv5(`${o.todo_id}/${o.anchor_date ?? 'single'}`, settings.id))
          throw new AppError('INVALID_VAULT', 'Occurrence identity mismatch');
        if (
          !records.some(
            (t) => t.kind === 'todo' && t.id === o.todo_id && t.revision === o.template_revision,
          )
        )
          throw new AppError('INVALID_VAULT', 'Occurrence template revision missing');
      }
      if (r.kind === 'todo_execution') {
        const e = r.data as TodoExecutionData;
        if (r.id !== uuidv5(`execution/${e.occurrence_id}`, settings.id))
          throw new AppError('INVALID_VAULT', 'Execution identity mismatch');
        if (
          !records.some(
            (o) =>
              o.kind === 'todo_occurrence' &&
              o.id === e.occurrence_id &&
              (o.data as OccurrenceData).todo_id === e.todo_id,
          )
        )
          throw new AppError('INVALID_VAULT', 'Execution occurrence missing');
        if (
          (e.actual_end &&
            (!e.actual_start || !e.completed_at || e.actual_end !== e.completed_at)) ||
          (e.actual_start && e.completed_at && !e.actual_end) ||
          (e.actual_start &&
            e.actual_end &&
            Temporal.Instant.compare(e.actual_start, e.actual_end) > 0)
        )
          throw new AppError('INVALID_VAULT', 'Invalid Todo execution interval');
      }
    }
  },
};
