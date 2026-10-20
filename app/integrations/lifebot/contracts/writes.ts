import { z } from 'zod';
import { date, id, instant, target, token, versions } from './primitives.js';
export const writeNames = [
  'capture_inbox',
  'create_todo',
  'start_todo',
  'complete_todo',
  'undo_todo',
  'start_habit',
  'complete_habit',
  'undo_habit',
] as const;
export type WriteName = (typeof writeNames)[number];
const title = z.string().min(1).max(200).regex(/\S/);
const text = z.string().max(10000);
const todoVersion = { expected_versions: z.object({ todo: token }).strict() };
const habitVersion = { expected_versions: z.object({ habit: token }).strict() };
const todoExecution = z.object({ ...todoVersion, target, note: text.optional() }).strict();
const habitExecution = z.object({ ...habitVersion, habit_id: id, date }).strict();
export const details = {
  duration_seconds: z.number().int().nonnegative().nullable(),
  actual_amount: z
    .string()
    .max(40)
    .regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/)
    .nullable(),
  difficulty_or_quality: text.nullable(),
  energy_note: text.nullable(),
};
export const intentSchemas = {
  capture_inbox: z.object({ ...todoVersion, title }).strict(),
  create_todo: z
    .object({
      ...todoVersion,
      title,
      description: text.default(''),
      workflow_status: z.enum(['next', 'waiting', 'someday']).default('next'),
      importance: z.enum(['high', 'normal', 'low']).default('normal'),
      project_id: id.nullable().default(null),
      do_date: date.nullable().default(null),
      due_at: instant.nullable().default(null),
      scheduled_time: z
        .string()
        .regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/)
        .nullable()
        .default(null),
      estimated_duration_seconds: z.number().int().min(0).max(86400).nullable().default(null),
      recurrence: z.null().default(null),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .nullable()
        .default(null),
    })
    .strict(),
  start_todo: todoExecution.omit({ note: true }),
  complete_todo: todoExecution,
  undo_todo: todoExecution.omit({ note: true }),
  start_habit: habitExecution,
  complete_habit: habitExecution.extend(
    Object.fromEntries(Object.entries(details).map(([k, v]) => [k, v.optional()])) as {
      [K in keyof typeof details]: z.ZodOptional<(typeof details)[K]>;
    },
  ),
  undo_habit: habitExecution,
};
export const commandInput = z.object({ command_id: id }).strict();
export const resultSchema = z
  .object({
    schema_version: z.literal('1'),
    outcome: z.enum(['committed', 'pending', 'rejected', 'unknown']),
    command_id: id.nullable(),
    operation: z.enum(writeNames).optional(),
    entities: z
      .array(
        z
          .object({
            kind: z.enum([
              'inbox_item',
              'todo',
              'todo_occurrence',
              'todo_execution',
              'habit_execution',
            ]),
            id,
            todo_id: id.optional(),
            occurrence_id: id.optional(),
            habit_id: id.optional(),
            date: date.optional(),
          })
          .strict(),
      )
      .optional(),
    error: z
      .object({
        code: z.string(),
        category: z.enum(['conflict', 'authorization', 'validation', 'transport', 'unavailable']),
        message: z.string(),
        retry: z.enum(['requires_user_review', 'exact_request_only', 'never']),
        expected_versions: versions,
        resolution_options: z.array(z.enum(['review_current', 'cancel_request', 'retry_exact'])),
      })
      .strict()
      .optional(),
  })
  .strict();
export type WriteResult = z.infer<typeof resultSchema>;
export const frozenSchema = z
  .object({
    schema_version: z.literal('1'),
    command_id: id,
    operation: z.enum(writeNames),
    origin: z.string().url(),
    arguments: z.record(z.unknown()),
    expected_versions: versions,
    request: z
      .object({
        method: z.enum(['POST', 'PUT']),
        path: z.string(),
        body: z.string(),
        if_match: token,
        headers: z
          .object({
            Accept: z.literal('application/json'),
            'Content-Type': z.literal('application/json'),
            'If-Match': token,
            'Idempotency-Key': id,
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export type FrozenCommand = z.infer<typeof frozenSchema>;

// Validate again on dispatch: journal corruption cannot turn a named tool into arbitrary HTTP.
export function validateFrozen(command: FrozenCommand) {
  if (
    command.request.headers['Idempotency-Key'] !== command.command_id ||
    command.request.headers['If-Match'] !== command.request.if_match
  )
    throw new Error('Header binding mismatch');
  const args = intentSchemas[command.operation].parse(command.arguments);
  if (JSON.stringify(args.expected_versions) !== JSON.stringify(command.expected_versions))
    throw new Error('Version binding mismatch');
  const version =
    'todo' in args.expected_versions ? args.expected_versions.todo : args.expected_versions.habit;
  if (command.request.if_match !== version) throw new Error('Precondition binding mismatch');
  let path: string;
  let method: 'POST' | 'PUT' = 'POST';
  const body = JSON.parse(command.request.body);
  let expectedBody: unknown;
  if (command.operation === 'capture_inbox') {
    path = '/api/v1/todo/inbox';
    expectedBody = { title: intentSchemas.capture_inbox.parse(args).title };
  } else if (command.operation === 'create_todo') {
    path = '/api/v1/todo/items';
    const { expected_versions: _, ...fields } = intentSchemas.create_todo.parse(args);
    expectedBody = fields;
  } else if ('target' in args) {
    path = `/api/v1/todo/items/${args.target.todo_id}/execute`;
    expectedBody = {
      anchor_date: args.target.anchor_date,
      action: command.operation.split('_')[0],
      ...('note' in args && args.note !== undefined ? { note: args.note } : {}),
      plan_ref: null,
    };
  } else {
    const a = intentSchemas.complete_habit.parse(args);
    path = `/api/v1/days/${a.date}/habits/${a.habit_id}/${command.operation === 'start_habit' ? 'start' : 'execution'}`;
    if (command.operation === 'start_habit') expectedBody = { plan_ref: null };
    else {
      method = 'PUT';
      const parsed = z
        .object({
          status: z.literal(command.operation === 'complete_habit' ? 'completed' : 'incomplete'),
          ...details,
        })
        .strict()
        .parse(body);
      for (const key of Object.keys(details) as (keyof typeof details)[]) {
        if (
          command.operation === 'undo_habit'
            ? parsed[key] !== null
            : a[key] !== undefined && parsed[key] !== a[key]
        )
          throw new Error('Habit details binding mismatch');
      }
      expectedBody = parsed;
    }
  }
  if (
    command.request.path !== path ||
    command.request.method !== method ||
    JSON.stringify(body) !== JSON.stringify(expectedBody)
  )
    throw new Error('Request binding mismatch');
}
