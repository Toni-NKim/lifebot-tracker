import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { harness, habitFields, routineFields, execution } from '../helpers.js';
import { moduleRegistry } from '../../app/server/modules.js';
import { createModuleServices } from '../../app/server/module-runtime.js';
import { TimeboxService, type Placement } from '../../app/server/services/timebox.js';
import { TodoService } from '../../app/server/services/todo.js';
import { latest } from '../../app/shared/domain/todo.js';
import type { ActionData, TodoData } from '../../app/shared/contracts/todo.js';
import type { PlanData } from '../../app/shared/contracts/timebox.js';
const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanup.splice(0).forEach((f) => f());
});
async function setup() {
  const h = await harness();
  cleanup.push(h.cleanup);
  let now = '2026-09-21T00:00:00Z';
  const paths = moduleRegistry(
    path.join(h.root, 'vault'),
    path.join(h.root, 'state'),
    'Life/HabitTracker',
  );
  const modules = createModuleServices(paths);
  for (const m of Object.values(modules)) {
    m.clock = () => now;
    await m.initializeModule(h.vault.load().tracker);
  }
  const box = new TimeboxService(h.service, modules.todo, modules.timebox),
    todo = new TodoService(modules.todo);
  const view = async (day?: string) => (await box.read(day)).data;
  const versions = async () => (await view()).versions;
  const capture = async () => {
    await todo.capture('기사', randomUUID(), (await versions()).todo);
    return (await todo.read()).data.inbox[0].id;
  };
  return {
    h,
    paths,
    modules,
    box,
    todo,
    view,
    versions,
    capture,
    setNow: (n: string) => {
      now = n;
      h.setNow(n);
    },
  };
}
const placement = (patch: Partial<Placement> = {}): Placement => ({
  date: '2026-09-21',
  candidate: null,
  title: '회의',
  start: '2026-09-21T01:00:00Z',
  end: '2026-09-21T01:30:00Z',
  color: null,
  ...patch,
});
it('never fabricates historical Plans; prepares once and deduplicates Routine children with 30-minute fallback', async () => {
  const t = await setup();
  const r = await t.h.routine(routineFields());
  await t.h.create(habitFields({ parent_routine_id: r.id, minimum_duration_seconds: 60 }));
  await t.h.create(habitFields({ name: 'Standalone', minimum_duration_seconds: 300 }));
  expect((await t.view()).plans).toHaveLength(0);
  await expect(t.box.prepare('2026-09-20', await t.versions(), randomUUID())).rejects.toMatchObject(
    { code: 'DAY_LOCKED' },
  );
  await t.box.prepare('2026-09-21', await t.versions(), randomUUID());
  let view = await t.view();
  expect(view.plans.map((p) => p.data.source.type).sort()).toEqual(['habit', 'routine']);
  expect(view.stats.planned_seconds).toBe(3600);
  const snapshot = t.h.vault.fingerprint();
  const plan = view.plans[0];
  await t.box.place(
    placement({ candidate: null, start: '2026-09-21T02:00:00Z', end: '2026-09-21T03:00:00Z' }),
    plan.id,
    view.versions,
    randomUUID(),
  );
  await t.box.prepare('2026-09-21', await t.versions(), randomUUID());
  view = await t.view();
  expect(view.plans).toHaveLength(2);
  expect(view.plans.find((p) => p.id === plan.id)?.revision_count).toBe(2);
  expect(t.h.vault.fingerprint()).toBe(snapshot);
  expect((await t.view('2026-09-20')).plans).toEqual([]);
});
it('keeps aggregate ETags distinct, detects stale dependencies, and enforces snapped Plans', async () => {
  const t = await setup();
  const versions = await t.versions();
  await t.capture();
  await expect(t.box.place(placement(), null, versions, randomUUID())).rejects.toMatchObject({
    code: 'REVISION_CONFLICT',
  });
  await expect(
    t.box.place(
      placement({ start: '2026-09-21T01:07:00Z' }),
      null,
      await t.versions(),
      randomUUID(),
    ),
  ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  const aggregate = await t.box.read();
  await expect(
    t.box.place(
      placement(),
      null,
      { ...(await t.versions()), timebox: aggregate.etag },
      randomUUID(),
    ),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});
it('reads shared Habit execution once, ghosts all Routine contexts, and keeps unexecuted old Plans gray', async () => {
  const t = await setup();
  const r = await t.h.routine();
  const habit = await t.h.create(habitFields({ parent_routine_id: r.id }));
  await t.box.prepare('2026-09-21', await t.versions(), randomUUID());
  await t.h.service.startExecution('2026-09-21', habit.id, null, randomUUID(), t.h.etag());
  t.setNow('2026-09-21T00:10:00Z');
  await t.h.service.execute('2026-09-21', habit.id, execution(), randomUUID(), t.h.etag());
  expect((await t.view()).actuals).toHaveLength(1);
  expect((await t.view()).plans[0].state).toBe('ghost');
  expect((await t.view()).stats.actual_seconds).toBe(600);
  await t.box.place(placement(), null, await t.versions(), randomUUID());
  t.setNow('2026-09-22T00:00:00Z');
  expect(
    (await t.view('2026-09-21')).plans.find((p) => p.data.source.type === 'manual')?.state,
  ).toBe('missed');
});
it('keeps unsnapped past Manual Actuals and clips cross-midnight statistics without changing Habit', async () => {
  const t = await setup();
  t.setNow('2026-09-22T00:00:00Z');
  const hash = t.h.etag();
  await t.box.manual(
    {
      date: '2026-09-21',
      title: '통화',
      actual_start: '2026-09-21T14:57:13Z',
      actual_end: '2026-09-21T15:03:17Z',
      color: '#123456',
      note: '',
      plan_id: null,
      deleted: false,
    },
    null,
    (await t.versions()).timebox,
    randomUUID(),
  );
  expect((await t.view('2026-09-21')).stats.actual_seconds).toBe(167);
  expect((await t.view('2026-09-22')).stats.actual_seconds).toBe(197);
  expect(t.h.etag()).toBe(hash);
});
it('recovers Inbox → Todo → Plan after target failure with canonical command receipts', async () => {
  const t = await setup();
  const inbox = await t.capture(),
    command = randomUUID(),
    versions = await t.versions();
  const failure = vi.spyOn(t.modules.timebox, 'mutateLocked').mockImplementationOnce(() => {
    throw new Error('process interrupted before target');
  });
  expect((await t.box.stageInbox(inbox, placement(), versions, command)).state).toBe('pending');
  failure.mockRestore();
  expect((await t.todo.read()).data.inbox).toEqual([]);
  expect((await t.todo.read()).data.todos).toHaveLength(1);
  // Restart and remove both disposable indexes: recovery data lives in Markdown.
  for (const m of Object.values(t.modules)) fs.rmSync(m.index.file, { force: true });
  const modules = createModuleServices(t.paths);
  const restarted = new TimeboxService(t.h.service, modules.todo, modules.timebox);
  expect((await restarted.stageInbox(inbox, placement(), versions, command)).state).toBe('done');
  expect((await restarted.stageInbox(inbox, placement(), versions, command)).state).toBe('done');
  expect(latest<TodoData>(modules.todo.vault.load(), 'todo')).toHaveLength(1);
  expect(latest<PlanData>(modules.timebox.vault.load(), 'plan')).toHaveLength(1);
});
it('does not rebase a staged action after unrelated target writes without explicit review', async () => {
  const t = await setup();
  const inbox = await t.capture();
  const failure = vi.spyOn(t.modules.timebox, 'mutateLocked').mockImplementationOnce(() => {
    throw new Error('interrupted');
  });
  const id = randomUUID();
  await t.box.stageInbox(inbox, placement(), await t.versions(), id);
  failure.mockRestore();
  await t.box.place(placement({ title: '다른 계획' }), null, await t.versions(), randomUUID());
  expect((await t.box.resume(id, await t.versions(), randomUUID(), false)).state).toBe('pending');
  expect((await t.box.resume(id, await t.versions(), randomUUID(), true)).state).toBe('done');
  expect((await t.view()).plans).toHaveLength(2);
});
it('recovers a target saved before the source completion receipt without duplicate Plans', async () => {
  const t = await setup();
  const inbox = await t.capture();
  const original = t.modules.todo.mutateLocked.bind(t.modules.todo);
  const fail = vi
    .spyOn(t.modules.todo, 'mutateLocked')
    .mockImplementation((command, build, guard) => {
      if ((command.request as { type: string }).type === 'finish_action')
        throw new Error('crash after target manifest');
      return original(command, build, guard);
    });
  const id = randomUUID();
  expect((await t.box.stageInbox(inbox, placement(), await t.versions(), id)).state).toBe(
    'pending',
  );
  fail.mockRestore();
  expect((await t.view()).plans).toHaveLength(1);
  expect((await t.box.resume(id, await t.versions(), randomUUID(), false)).state).toBe('done');
  expect((await t.view()).plans).toHaveLength(1);
  expect(latest<ActionData>(t.modules.todo.vault.load(), 'staged_action')[0].data.state).toBe(
    'done',
  );
});
