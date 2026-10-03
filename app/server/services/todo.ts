import { randomUUID } from 'node:crypto';
import { v5 as uuidv5 } from 'uuid';
import { AppError, validate, type PlanRef } from '../../shared/contracts/index.js';
import {
  TodoFieldsSchema,
  ProjectFieldsSchema,
  type TodoFields,
  type TodoData,
  type InboxData,
  type ProjectFields,
  type ProjectData,
  type OccurrenceData,
  type TodoExecutionData,
} from '../../shared/contracts/todo.js';
import type { RecordInput } from '../../shared/contracts/module.js';
import { latest, occurrence, todoExecutionId, todoView } from '../../shared/domain/todo.js';
import { todayAt, addDays } from '../../shared/domain/index.js';
import { ModuleService } from './module.js';
import type { ModuleSnapshot } from '../storage/markdown/module-vault.js';

export const newTodo = (title: string, day: string, patch: Partial<TodoFields> = {}): TodoData => ({
  title,
  description: '',
  workflow_status: 'next',
  importance: 'normal',
  project_id: null,
  do_date: null,
  due_at: null,
  scheduled_time: null,
  estimated_duration_seconds: null,
  recurrence: null,
  color: null,
  ...patch,
  recurrence_effective_on: day,
  recurrence_anchor: patch.do_date ?? day,
  active: true,
  deleted: false,
  discarded_at: null,
});
export class TodoService {
  constructor(public store: ModuleService) {}
  async read(referenceDate?: string) {
    const result = await this.store.read();
    return { ...result, data: todoView(result.data, this.store.clock(), referenceDate) };
  }
  private command(
    type: string,
    body: unknown,
    command: string,
    etag: string,
    build: (s: ModuleSnapshot, now: string) => RecordInput[],
  ) {
    return this.store.mutate({ id: command, etag, request: { type, body } }, build);
  }
  capture(title: string, command: string, etag: string) {
    return this.command('capture', { title }, command, etag, () => [
      {
        kind: 'inbox_item',
        id: randomUUID(),
        data: {
          title: title.trim(),
          processed_at: null,
          converted_todo_id: null,
          discarded_at: null,
        },
      },
    ]);
  }
  processInputs(
    s: ModuleSnapshot,
    now: string,
    id: string,
    when: 'today' | 'date' | 'someday' | 'discard',
    doDate: string | null,
  ): RecordInput[] {
    const inbox = latest<InboxData>(s, 'inbox_item').find((r) => r.id === id);
    if (!inbox || inbox.data.processed_at || inbox.data.discarded_at)
      throw new AppError('NOT_FOUND', 'Inbox item is already processed or missing', 404);
    if (when === 'discard')
      return [{ kind: 'inbox_item', id, data: { ...inbox.data, discarded_at: now } }];
    if (when === 'date' && !doDate)
      throw new AppError('VALIDATION_ERROR', 'A planned date is required');
    const today = todayAt(now, s.settings.timezone);
    const todoId = uuidv5(`inbox/${id}`, s.settings.id);
    return [
      {
        kind: 'inbox_item',
        id,
        data: { ...inbox.data, processed_at: now, converted_todo_id: todoId },
      },
      {
        kind: 'todo',
        id: todoId,
        data: newTodo(inbox.data.title, today, {
          workflow_status: when === 'someday' ? 'someday' : 'next',
          do_date: when === 'today' ? today : when === 'date' ? doDate : null,
        }),
      },
    ];
  }
  process(
    id: string,
    when: 'today' | 'date' | 'someday' | 'discard',
    doDate: string | null,
    command: string,
    etag: string,
  ) {
    return this.command('process_inbox', { id, when, doDate }, command, etag, (s, now) =>
      this.processInputs(s, now, id, when, doDate),
    );
  }
  create(fields: TodoFields, command: string, etag: string) {
    validate(TodoFieldsSchema, fields);
    return this.command('create_todo', fields, command, etag, (s, now) => {
      this.projectAvailable(s, fields.project_id);
      return [
        {
          kind: 'todo',
          id: randomUUID(),
          data: newTodo(fields.title.trim(), todayAt(now, s.settings.timezone), fields),
        },
      ];
    });
  }
  private projectAvailable(s: ModuleSnapshot, id: string | null) {
    if (
      id &&
      !latest<ProjectData>(s, 'project').some((p) => p.id === id && p.data.status === 'active')
    )
      throw new AppError('VALIDATION_ERROR', 'Project is unavailable or archived');
  }
  edit(id: string, patch: Partial<TodoFields>, command: string, etag: string) {
    return this.command('edit_todo', { id, patch }, command, etag, (s, now) => {
      const t = latest<TodoData>(s, 'todo').find((r) => r.id === id);
      if (!t || t.data.deleted) throw new AppError('NOT_FOUND', 'Todo not found', 404);
      const next = { ...t.data, ...patch };
      if ('project_id' in patch && next.project_id !== t.data.project_id)
        this.projectAvailable(s, next.project_id);
      if (
        'recurrence' in patch &&
        JSON.stringify(patch.recurrence) !== JSON.stringify(t.data.recurrence)
      ) {
        if ((patch.recurrence === null) !== (t.data.recurrence === null))
          throw new AppError(
            'VALIDATION_ERROR',
            'Create a new Todo when switching between single and repeating tasks',
          );
        next.recurrence_effective_on = addDays(todayAt(now, s.settings.timezone), 1);
      }
      const inputs: RecordInput[] = [{ kind: 'todo', id, data: next }];
      // Open occurrences follow workflow metadata; completed snapshots stay put.
      for (const o of latest<OccurrenceData>(s, 'todo_occurrence').filter(
        (r) => r.data.todo_id === id,
      )) {
        const done = latest<TodoExecutionData>(s, 'todo_execution').some(
          (e) => e.data.occurrence_id === o.id && e.data.completed_at,
        );
        if (!done)
          inputs.push({
            kind: 'todo_occurrence',
            id: o.id,
            data: {
              ...o.data,
              ...('title' in patch ? { title: next.title } : {}),
              ...('project_id' in patch ? { project_id: next.project_id } : {}),
              ...('workflow_status' in patch ? { workflow_status: next.workflow_status } : {}),
              ...(!next.recurrence ? { do_date: next.do_date, due_at: next.due_at } : {}),
            },
          });
      }
      return inputs;
    });
  }
  discard(id: string, command: string, etag: string) {
    return this.command('discard_todo', { id }, command, etag, (s, now) => {
      const t = latest<TodoData>(s, 'todo').find((r) => r.id === id);
      if (!t) throw new AppError('NOT_FOUND', 'Todo not found', 404);
      return [
        {
          kind: 'todo',
          id,
          data: {
            ...t.data,
            active: false,
            deleted: true,
            discarded_at: t.data.discarded_at ?? now,
          },
        },
      ];
    });
  }
  project(id: string | null, fields: ProjectFields, command: string, etag: string) {
    validate(ProjectFieldsSchema, fields);
    return this.command('project', { id, fields }, command, etag, (s, now) => {
      const old = id ? latest<ProjectData>(s, 'project').find((r) => r.id === id) : undefined;
      if (id && !old) throw new AppError('NOT_FOUND', 'Project not found', 404);
      return [
        {
          kind: 'project',
          id: id ?? randomUUID(),
          data: {
            ...fields,
            archived_at: fields.status === 'archived' ? (old?.data.archived_at ?? now) : null,
          },
        },
      ];
    });
  }
  execute(
    todoId: string,
    anchor: string | null,
    action: 'start' | 'complete' | 'undo',
    note: string | undefined,
    planRef: PlanRef | null,
    command: string,
    etag: string,
  ) {
    return this.command(
      'todo_execution',
      { todoId, anchor, action, note: note ?? null, planRef },
      command,
      etag,
      (s, now) => {
        const todo = latest<TodoData>(s, 'todo').find((r) => r.id === todoId);
        if (!todo || todo.data.deleted) throw new AppError('NOT_FOUND', 'Todo not found', 404);
        if (anchor && anchor > todayAt(now, s.settings.timezone))
          throw new AppError('DAY_LOCKED', 'Future occurrences cannot be executed', 409);
        const o = occurrence(s, todoId, anchor);
        const old = latest<TodoExecutionData>(s, 'todo_execution').find(
          (r) => r.data.occurrence_id === o.id,
        );
        if (action === 'start' && (old?.data.actual_start || old?.data.completed_at))
          throw new AppError(
            'EXECUTION_STARTED',
            'This occurrence was already started or completed',
            409,
          );
        if (action === 'undo' && !old)
          throw new AppError('NOT_FOUND', 'There is no execution to undo', 404);
        const start =
          action === 'undo' ? null : action === 'start' ? now : (old?.data.actual_start ?? null);
        const completed = action === 'complete' ? (old?.data.completed_at ?? now) : null;
        return [
          ...(!o.saved ? [{ kind: 'todo_occurrence', id: o.id, data: o.data }] : []),
          {
            kind: 'todo_execution',
            id: todoExecutionId(s.settings.id, o.id),
            data: {
              todo_id: todoId,
              occurrence_id: o.id,
              actual_start: start,
              actual_end: start && completed ? (old?.data.actual_end ?? completed) : null,
              completed_at: completed,
              plan_ref: action === 'undo' ? null : (old?.data.plan_ref ?? planRef),
              note: action === 'undo' ? '' : (note ?? old?.data.note ?? ''),
            },
          },
        ];
      },
    );
  }
  reschedule(
    todoId: string,
    anchor: string | null,
    doDate: string | null,
    dueAt: string | null,
    command: string,
    etag: string,
  ) {
    return this.command(
      'reschedule_occurrence',
      { todoId, anchor, doDate, dueAt },
      command,
      etag,
      (s) => {
        const o = occurrence(s, todoId, anchor);
        if (
          latest<TodoExecutionData>(s, 'todo_execution').some(
            (e) => e.data.occurrence_id === o.id && e.data.completed_at,
          )
        )
          throw new AppError(
            'VALIDATION_ERROR',
            'Undo completion before changing occurrence dates',
          );
        const template = latest<TodoData>(s, 'todo').find((r) => r.id === todoId)!;
        return [
          {
            kind: 'todo_occurrence',
            id: o.id,
            data: { ...o.data, do_date: doDate, due_at: dueAt },
          },
          ...(anchor === null
            ? [
                {
                  kind: 'todo',
                  id: todoId,
                  data: { ...template.data, do_date: doDate, due_at: dueAt },
                },
              ]
            : []),
        ];
      },
    );
  }
}
