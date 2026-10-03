import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { harness, habitFields, execution, undone } from '../helpers.js';
import { Vault, serialize, parse } from '../../app/server/storage/markdown/vault.js';
import { TrackerService } from '../../app/server/services/tracker.js';
import { Index } from '../../app/server/index/sqlite/index.js';
import { executionTiming } from '../../app/shared/contracts/index.js';
import { createApp } from '../../app/server/api.js';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));
async function setup() {
  const t = await harness();
  cleanup.push(t.cleanup);
  return t;
}

it('reads and rebuilds a v1 fixture byte-for-byte, then upgrades only the current Daily on a v2 write', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'habit-v2-'));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync('tests/fixtures/obsidian-vault', path.join(root, 'vault'), { recursive: true });
  const vault = new Vault(path.join(root, 'vault/Life/HabitTracker'));
  const index = new Index(path.join(root, 'state/tracker.sqlite'));
  const service = new TrackerService(vault, index, () => '2026-09-21T02:00:00Z');
  const original = new Map(vault.inventory().map((f) => [f.path, f.text]));
  await service.initialize();
  await service.rebuild();
  expect(new Map(vault.inventory().map((f) => [f.path, f.text]))).toEqual(original);
  const old = vault.load().days[0].executions[0];
  expect(executionTiming(old)).toEqual({ actual_start: null, actual_end: null, plan_ref: null });
  const item = (await service.today()).data.items.find((i) => !i.execution)!;
  await service.startExecution(
    '2026-09-21',
    item.habit_id,
    null,
    randomUUID(),
    vault.fingerprint(),
  );
  const daily = vault.load().days[0];
  expect(daily.schema_version).toBe(2);
  expect(daily.executions.find((e) => e.id === old.id)).toEqual({
    ...old,
    ...executionTiming(old),
  });
  for (const f of vault.inventory())
    if (!f.path.startsWith('Daily/')) expect(f.text).toBe(original.get(f.path));
  expect(index.metadata().projector_version).toBe('3');
  fs.rmSync(index.file);
  await service.rebuild();
  expect(vault.load().days[0]).toEqual(daily);
});

it('starts without completion credit, closes through the legacy API, preserves measured timing on details edits and clears it on Undo', async () => {
  const t = await setup();
  const h = await t.create();
  const app = await createApp(t.service);
  try {
    const plan = { module_id: randomUUID(), plan_id: randomUUID(), revision: 2 };
    const key = randomUUID();
    const start = (etag: string) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/days/2026-09-21/habits/${h.id}/start`,
        headers: { 'idempotency-key': key, 'if-match': etag },
        payload: { plan_ref: plan },
      });
    const before = t.etag();
    expect((await start(before)).statusCode).toBe(200);
    t.setNow('2026-09-21T00:02:00Z');
    expect((await start(before)).statusCode).toBe(200); // same receipt, not a second session
    let e = t.vault.load().days[0].executions[0];
    expect(e).toMatchObject({
      status: 'incomplete',
      actual_start: '2026-09-21T00:00:00Z',
      actual_end: null,
      completed_at: null,
      duration_seconds: null,
      plan_ref: plan,
    });
    expect((await t.service.today()).data.items[0].execution?.status).toBe('incomplete');
    await expect(
      t.service.startExecution('2026-09-21', h.id, null, randomUUID(), t.etag()),
    ).rejects.toMatchObject({ code: 'EXECUTION_STARTED' });
    t.setNow('2026-09-21T00:20:03Z');
    const complete = await app.inject({
      method: 'PUT',
      url: `/api/v1/days/2026-09-21/habits/${h.id}/execution`,
      headers: { 'idempotency-key': randomUUID(), 'if-match': t.etag() },
      payload: execution({ duration_seconds: 10 }),
    });
    expect(complete.statusCode).toBe(200);
    e = t.vault.load().days[0].executions[0];
    expect(e.actual_end).toBe('2026-09-21T00:20:03Z');
    expect(e.completed_at).toBe(e.actual_end);
    expect(e.duration_seconds).toBe(10); // reported duration remains distinct from measured duration
    const timing = executionTiming(e);
    t.setNow('2026-09-21T00:30:00Z');
    await t.service.execute(
      '2026-09-21',
      h.id,
      execution({ energy_note: 'edited' }),
      randomUUID(),
      t.etag(),
    );
    expect(executionTiming(t.vault.load().days[0].executions[0])).toEqual(timing);
    await t.service.execute('2026-09-21', h.id, undone(), randomUUID(), t.etag());
    expect(executionTiming(t.vault.load().days[0].executions[0])).toEqual({
      actual_start: null,
      actual_end: null,
      plan_ref: null,
    });
    await t.service.execute('2026-09-21', h.id, execution(), randomUUID(), t.etag());
    expect(executionTiming(t.vault.load().days[0].executions[0])).toEqual({
      actual_start: null,
      actual_end: null,
      plan_ref: null,
    });
  } finally {
    await app.close();
  }
});

it('keeps an unfinished prior-day execution locked and never invents an end at midnight', async () => {
  const t = await setup();
  const h = await t.create();
  t.setNow('2026-09-21T14:59:30Z');
  await t.service.startExecution('2026-09-21', h.id, null, randomUUID(), t.etag());
  const bytes = fs.readFileSync(path.join(t.vault.root, t.vault.dailyPath('2026-09-21')));
  t.setNow('2026-09-21T15:00:01Z');
  await expect(
    t.service.execute('2026-09-21', h.id, execution(), randomUUID(), t.etag()),
  ).rejects.toMatchObject({ code: 'DAY_LOCKED' });
  await expect(
    t.service.startExecution('2026-09-21', h.id, null, randomUUID(), t.etag()),
  ).rejects.toMatchObject({ code: 'DAY_LOCKED' });
  await t.service.today();
  expect(fs.readFileSync(path.join(t.vault.root, t.vault.dailyPath('2026-09-21')))).toEqual(bytes);
  expect(t.vault.load().days[0].executions[0].actual_end).toBeNull();
});

it('writes versioned colors and can explicitly clear a pending color without changing effective-date rules', async () => {
  const t = await setup();
  const h = await t.create(habitFields({ color: '#AABBCC' }));
  expect(h.schema_version).toBe(2);
  await t.service.editHabit(h.id, { color: '#123456' }, randomUUID(), t.etag());
  expect((await t.service.today()).data.items[0].habit.color).toBe('#AABBCC');
  await t.service.editHabit(h.id, { color: null }, randomUUID(), t.etag());
  t.setNow('2026-09-22T00:00:00Z');
  expect((await t.service.today()).data.items[0].habit.color).toBeNull();
  expect(() => parse(serialize({ ...h, schema_version: 1 }))).toThrow();
  expect(() => parse(serialize({ ...h, color: 'red' }))).toThrow();
});

it('rejects invalid actual intervals and timestamps outside the execution day', async () => {
  const t = await setup();
  const h = await t.create();
  await t.service.startExecution('2026-09-21', h.id, null, randomUUID(), t.etag());
  const day = structuredClone(t.vault.load().days[0]);
  day.executions[0].actual_end = '2026-09-21T00:01:00Z';
  expect(() => serialize(day)).toThrow('interval');
  day.executions[0].actual_end = null;
  day.executions[0].actual_start = '2026-09-20T14:59:59Z';
  t.vault.writeDaily(day);
  expect(() => t.vault.load()).toThrow('outside its date');
});
