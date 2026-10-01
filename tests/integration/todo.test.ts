import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { harness } from '../helpers.js';
import { createModuleServices } from '../../app/server/module-runtime.js';
import { moduleRegistry } from '../../app/server/modules.js';
import { TodoService } from '../../app/server/services/todo.js';
import type { TodoFields } from '../../app/shared/contracts/todo.js';
import { createApp } from '../../app/server/api.js';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));
const fields = (patch: Partial<TodoFields> = {}): TodoFields => ({
  title: '기사',
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
});
async function setup() {
  const h = await harness();
  cleanup.push(h.cleanup);
  const paths = moduleRegistry(
    path.join(h.root, 'vault'),
    path.join(h.root, 'state'),
    'Life/HabitTracker',
  );
  let now = '2026-09-21T00:00:00Z';
  const modules = createModuleServices(paths);
  modules.todo.clock = () => now;
  await modules.todo.initializeModule(h.vault.load().tracker);
  const todo = new TodoService(modules.todo);
  const etag = async () => (await modules.todo.read()).etag;
  const create = async (patch: Partial<TodoFields> = {}) => {
    await todo.create(fields(patch), randomUUID(), await etag());
    return (await todo.read()).data.todos.find((r) => r.data.title === (patch.title ?? '기사'))!;
  };
  return {
    h,
    modules,
    todo,
    etag,
    create,
    setNow: (value: string) => {
      now = value;
    },
  };
}

it('captures title-only Inbox and atomically processes it into one Next Todo with canonical retry receipts', async () => {
  const t = await setup();
  const app = await createApp(t.h.service, { modules: t.modules });
  try {
    const before = t.h.etag();
    const key = randomUUID();
    const capture = {
      method: 'POST' as const,
      url: '/api/v1/todo/inbox',
      headers: { 'idempotency-key': key, 'if-match': await t.etag() },
      payload: { title: '생각' },
    };
    expect((await app.inject(capture)).statusCode).toBe(200);
    expect((await app.inject(capture)).statusCode).toBe(200);
    t.setNow('2026-09-23T00:00:00Z');
    const inbox = (await t.todo.read()).data.inbox;
    expect(inbox).toHaveLength(1);
    expect(inbox[0].age_days).toBe(2);
    const cmd = randomUUID();
    const etag = await t.etag();
    await t.todo.process(inbox[0].id, 'today', null, cmd, etag);
    await t.todo.process(inbox[0].id, 'today', null, cmd, etag);
    const view = (await t.todo.read()).data;
    expect(view.inbox).toEqual([]);
    expect(view.todos).toHaveLength(1);
    expect(view.todos[0].data).toMatchObject({ workflow_status: 'next', do_date: '2026-09-23' });
    expect(
      t.modules.todo.vault
        .load()
        .records.filter((r) => r.command_id === cmd)
        .map((r) => r.kind)
        .sort(),
    ).toEqual(['inbox_item', 'todo']);
    expect(t.h.etag()).toBe(before);
  } finally {
    await app.close();
  }
});

it('keeps occurrence identity through rescheduling and separates do_date from due_at', async () => {
  const t = await setup();
  const todo = await t.create({ do_date: '2026-09-21', due_at: '2026-09-22T06:00:00Z' });
  const first = (await t.todo.read()).data.items[0];
  await t.todo.reschedule(
    todo.id,
    null,
    '2026-09-23',
    '2026-09-24T06:00:00Z',
    randomUUID(),
    await t.etag(),
  );
  const moved = (await t.todo.read()).data.items[0];
  expect(moved.id).toBe(first.id);
  expect(moved.data).toMatchObject({ do_date: '2026-09-23', due_at: '2026-09-24T06:00:00Z' });
  await t.todo.execute(todo.id, null, 'complete', undefined, null, randomUUID(), await t.etag());
  const done = (await t.todo.read()).data.history[0];
  expect(done.execution).toMatchObject({
    actual_start: null,
    actual_end: null,
    completed_at: '2026-09-21T00:00:00Z',
  });
  expect(done.actual_duration_seconds).toBeNull();
});

it('preserves recurring template workflow and supports cross-midnight timing plus historical Undo revisions', async () => {
  const t = await setup();
  const todo = await t.create({ recurrence: { type: 'weekdays' } });
  t.setNow('2026-09-21T14:55:00Z');
  await t.todo.execute(
    todo.id,
    '2026-09-21',
    'start',
    undefined,
    null,
    randomUUID(),
    await t.etag(),
  );
  await expect(
    t.todo.execute(todo.id, '2026-09-21', 'start', undefined, null, randomUUID(), await t.etag()),
  ).rejects.toMatchObject({ code: 'EXECUTION_STARTED' });
  t.setNow('2026-09-21T15:05:00Z');
  await t.todo.execute(
    todo.id,
    '2026-09-21',
    'complete',
    'note',
    null,
    randomUUID(),
    await t.etag(),
  );
  let view = (await t.todo.read()).data;
  expect(view.history[0].actual_duration_seconds).toBe(600);
  expect(view.todos[0].data.workflow_status).toBe('next');
  expect(view.items.filter((i) => i.workflow_status === 'next')).toHaveLength(1);
  const prior = t.modules.todo.vault.load().records.filter((r) => r.kind === 'todo_execution');
  await t.todo.execute(
    todo.id,
    '2026-09-21',
    'undo',
    undefined,
    null,
    randomUUID(),
    await t.etag(),
  );
  view = (await t.todo.read()).data;
  expect(view.history).toEqual([]);
  expect(
    t.modules.todo.vault.load().records.filter((r) => r.kind === 'todo_execution'),
  ).toHaveLength(prior.length + 1);
  for (const r of prior) expect(t.modules.todo.vault.load().records).toContainEqual(r);
});

it('changes recurrence prospectively and counts only eligible project work through the reference date', async () => {
  const t = await setup();
  await t.todo.project(
    null,
    { name: '취재', description: '', color: '#112233', status: 'active' },
    randomUUID(),
    await t.etag(),
  );
  const project = (await t.todo.read()).data.projects[0];
  await t.create({ title: '단발', project_id: project.id });
  await t.create({ title: '대기', project_id: project.id, workflow_status: 'waiting' });
  await t.create({ title: '언젠가', project_id: project.id, workflow_status: 'someday' });
  const recurring = await t.create({
    title: '일보',
    project_id: project.id,
    recurrence: { type: 'weekdays' },
  });
  await t.todo.execute(
    recurring.id,
    '2026-09-21',
    'complete',
    undefined,
    null,
    randomUUID(),
    await t.etag(),
  );
  expect((await t.todo.read()).data.projects[0]).toMatchObject({
    total: 2,
    completed: 1,
    completion_rate: 0.5,
  });
  await t.todo.edit(
    recurring.id,
    { recurrence: { type: 'weekends' } },
    randomUUID(),
    await t.etag(),
  );
  t.setNow('2026-09-22T00:00:00Z');
  expect((await t.todo.read()).data.items.filter((i) => i.todo.id === recurring.id)).toHaveLength(
    1,
  );
  t.setNow('2026-09-26T00:00:00Z');
  expect((await t.todo.read()).data.projects[0]).toMatchObject({ total: 3, completed: 1 });
});

it('rebuilds identical Todo views from Markdown alone and preserves completed history on deletion', async () => {
  const t = await setup();
  const todo = await t.create();
  await t.todo.execute(todo.id, null, 'complete', undefined, null, randomUUID(), await t.etag());
  await t.todo.discard(todo.id, randomUUID(), await t.etag());
  const view = await t.todo.read();
  expect(view.data.history).toHaveLength(1);
  const hash = t.modules.todo.vault.fingerprint();
  fs.rmSync(path.dirname(t.modules.todo.index.file), { recursive: true });
  await t.modules.todo.read();
  expect((await t.todo.read()).data).toEqual(view.data);
  expect(t.modules.todo.vault.fingerprint()).toBe(hash);
});
