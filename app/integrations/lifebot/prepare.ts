import type { TrackerReader } from './http-client.js';
import type { CommandJournal } from './journal.js';
import { intentSchemas, type FrozenCommand, type WriteName } from './contracts/writes.js';
import { envelope, todos, today } from './contracts/upstream.js';
import { LifebotError } from './errors.js';

export async function prepareCommand(
  operation: WriteName,
  input: unknown,
  reader: TrackerReader,
  journal: CommandJournal,
  origin: string,
) {
  const schema = intentSchemas[operation];
  if (!schema) throw new LifebotError('FORBIDDEN_OPERATION', 'Unsupported operation');
  const args = schema.parse(input);
  const expected = args.expected_versions;
  let request: Omit<FrozenCommand['request'], 'headers'>;
  if ('todo' in expected) {
    const observed = await reader.get(
      '/todo',
      envelope(todos),
      'target' in args && args.target.anchor_date ? { date: args.target.anchor_date } : undefined,
    );
    if (observed.etag !== expected.todo)
      throw new LifebotError(
        'REVISION_CONFLICT',
        'Todo observation changed; review before allocating a command.',
      );
    if (operation === 'capture_inbox') {
      const a = intentSchemas.capture_inbox.parse(args);
      request = {
        method: 'POST',
        path: '/api/v1/todo/inbox',
        body: JSON.stringify({ title: a.title }),
        if_match: expected.todo,
      };
    } else if (operation === 'create_todo') {
      const { expected_versions: _, ...body } = intentSchemas.create_todo.parse(args);
      if (
        body.project_id &&
        !observed.data.projects.some((p) => p.id === body.project_id && p.data.status === 'active')
      )
        throw new LifebotError('VALIDATION_ERROR', 'Choose an existing active Project explicitly.');
      request = {
        method: 'POST',
        path: '/api/v1/todo/items',
        body: JSON.stringify(body),
        if_match: expected.todo,
      };
    } else {
      const a = intentSchemas[operation as 'complete_todo'].parse(args);
      const t = a.target;
      if (
        ![...observed.data.items, ...observed.data.history].some(
          (o) =>
            !o.todo.data.deleted &&
            o.id === t.occurrence_id &&
            o.data.todo_id === t.todo_id &&
            o.data.anchor_date === t.anchor_date,
        )
      )
        throw new LifebotError('VALIDATION_ERROR', 'Select a Tracker-provided execution target.');
      request = {
        method: 'POST',
        path: `/api/v1/todo/items/${t.todo_id}/execute`,
        if_match: expected.todo,
        body: JSON.stringify({
          anchor_date: t.anchor_date,
          action: operation.split('_')[0],
          ...(a.note === undefined ? {} : { note: a.note }),
          plan_ref: null,
        }),
      };
    }
  } else {
    const a = intentSchemas.complete_habit.parse(args);
    const observed = await reader.get('/today', envelope(today));
    if (observed.etag !== expected.habit)
      throw new LifebotError(
        'REVISION_CONFLICT',
        'Habit observation changed; review before allocating a command.',
      );
    if (observed.data.date !== a.date)
      throw new LifebotError('DAY_LOCKED', 'Only today can be edited.');
    const item = observed.data.items.find((h) => h.habit_id === a.habit_id);
    if (!item) throw new LifebotError('NOT_SCHEDULED', 'Choose a scheduled Habit for today.');
    const body: Record<string, unknown> =
      operation === 'start_habit'
        ? { plan_ref: null }
        : {
            status: operation === 'complete_habit' ? 'completed' : 'incomplete',
          };
    if (operation !== 'start_habit')
      for (const key of [
        'duration_seconds',
        'actual_amount',
        'difficulty_or_quality',
        'energy_note',
      ] as const)
        body[key] =
          operation === 'undo_habit'
            ? null
            : a[key] === undefined
              ? (item.execution?.[key] ?? null)
              : a[key];
    request = {
      method: operation === 'start_habit' ? 'POST' : 'PUT',
      path: `/api/v1/days/${a.date}/habits/${a.habit_id}/${operation === 'start_habit' ? 'start' : 'execution'}`,
      body: JSON.stringify(body),
      if_match: expected.habit,
    };
  }
  return journal.allocate({
    schema_version: '1',
    operation,
    origin,
    arguments: args as Record<string, unknown>,
    expected_versions: expected,
    request,
  });
}
