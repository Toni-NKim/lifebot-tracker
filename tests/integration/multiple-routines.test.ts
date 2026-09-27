import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { harness, habitFields, routineFields, execution } from '../helpers.js';
import { routineIds, membershipPatch } from '../../app/shared/domain/membership.js';
import { effective, project } from '../../app/shared/domain/index.js';
import { TrackerService } from '../../app/server/services/tracker.js';
import { createApp } from '../../app/server/api.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const t = await harness();
  cleanups.push(t.cleanup);
  return t;
}

it('shows one daily Habit in weekday/weekend contexts with their own times', async () => {
  const t = await setup();
  const evening = await t.routine(
    routineFields({
      name: 'Weekday evening',
      schedule: { type: 'weekdays' },
      scheduled_time: '21:00',
    }),
  );
  const weekend = await t.routine(
    routineFields({ name: 'Weekend', schedule: { type: 'weekends' }, scheduled_time: null }),
  );
  const h = await t.create(
    habitFields({
      name: '108배',
      routine_ids: [evening.id, weekend.id],
      parent_routine_id: evening.id,
      scheduled_time: { mode: 'routine', source_routine_revision: 1, value: '21:00' },
    }),
  );
  let today = (await t.service.today()).data;
  expect(today.items).toHaveLength(1);
  expect(today.items[0].routine_contexts).toEqual([
    { routine_id: evening.id, routine_revision: 1, scheduled_time: '21:00' },
  ]);
  t.setNow('2026-09-26T00:00:00Z');
  today = (await t.service.today()).data;
  expect(today.items).toHaveLength(1);
  expect(today.items[0].routine_contexts).toEqual([
    { routine_id: weekend.id, routine_revision: 1, scheduled_time: null },
  ]);
  await t.service.execute(today.date, h.id, execution(), randomUUID(), t.etag());
  const stats = (await t.service.stats(today.date, today.date)).data;
  expect(stats.date_scheduled).toEqual({ completed: 1, total: 1, rate: 100 });
  expect(t.vault.load().days[0].executions).toHaveLength(1);
});

it('shares completion across overlapping Routines and rebuilds all memberships from Markdown', async () => {
  const t = await setup();
  const a = await t.routine();
  const b = await t.routine(routineFields({ name: 'Evening', scheduled_time: '21:00' }));
  const app = await createApp(t.service);
  cleanups.push(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/habits',
    headers: { 'idempotency-key': randomUUID(), 'if-match': t.etag() },
    payload: { fields: habitFields({ routine_ids: [a.id, b.id] }) },
  });
  expect(response.statusCode).toBe(200);
  const h = t.vault.load().habits[0];
  expect(routineIds(h)).toEqual([a.id, b.id]);
  await t.service.execute('2026-09-21', h.id, execution(), randomUUID(), t.etag());
  const today = (await t.service.today()).data;
  expect(today.items).toHaveLength(1);
  expect(today.items[0].routine_contexts.map((r) => r.routine_id).sort()).toEqual(
    [a.id, b.id].sort(),
  );
  expect(today.items[0].execution?.status).toBe('completed');
  expect((await t.service.history('2026-09-21', '2026-09-21')).data.total).toBe(1);
  expect((await t.service.stats()).data.habits[0].current).toBe(1);
  const indexed = () => {
    const db = new Database(t.index.file, { readonly: true });
    try {
      return db
        .prepare('SELECT * FROM habit_routines ORDER BY habit_id,habit_revision,routine_id')
        .all();
    } finally {
      db.close();
    }
  };
  const rows = indexed();
  expect(rows).toHaveLength(2);
  const fingerprint = t.etag();
  const stats = (await t.service.stats()).data;
  fs.unlinkSync(t.index.file);
  await t.service.rebuild();
  expect(t.etag()).toBe(fingerprint);
  expect(indexed()).toEqual(rows);
  expect((await t.service.today()).data).toEqual(today);
  expect((await t.service.stats()).data).toEqual(stats);
  expect(t.index.read()).toEqual(project(t.vault.load(), '2026-09-21T00:00:00Z'));
});

it('preserves legacy membership and upgrades an older derived index without rewriting Markdown', async () => {
  const t = await setup();
  const r = await t.routine();
  const h = await t.create(habitFields({ parent_routine_id: r.id }));
  expect(h.routine_ids).toBeUndefined();
  const fingerprint = t.etag();
  const db = new Database(t.index.file);
  db.exec(
    "DROP TABLE habit_routines; UPDATE index_metadata SET value = '1' WHERE key IN ('schema_version', 'projector_version')",
  );
  db.close();
  const restarted = new TrackerService(t.vault, t.index, () => '2026-09-21T00:00:00Z');
  await restarted.initialize();
  expect(t.index.metadata().projector_version).toBe('2');
  expect(t.etag()).toBe(fingerprint);
  expect((await restarted.today()).data.items[0].routine_contexts[0].routine_id).toBe(r.id);
});

it('adding/removing membership takes effect tomorrow without changing cadence or prior history', async () => {
  const t = await setup();
  const a = await t.routine();
  const b = await t.routine(routineFields({ schedule: { type: 'weekends' } }));
  const h = await t.create(habitFields({ parent_routine_id: a.id }));
  await t.service.execute('2026-09-21', h.id, execution(), randomUUID(), t.etag());
  await t.service.editHabit(h.id, { routine_ids: [a.id, b.id] }, randomUUID(), t.etag());
  expect(routineIds((await t.service.today()).data.items[0].habit)).toEqual([a.id]);
  t.setNow('2026-09-22T00:00:00Z');
  const current = (await t.service.today()).data.items[0].habit;
  expect(routineIds(current)).toEqual([a.id, b.id]);
  expect(current.schedule.rule).toEqual({ type: 'daily' });
  await t.service.editHabit(h.id, membershipPatch(current, [b.id]), randomUUID(), t.etag());
  t.setNow('2026-09-23T00:00:00Z');
  const next = (await t.service.today()).data.items[0];
  expect(routineIds(next.habit)).toEqual([b.id]);
  // A due Habit remains available ungrouped when none of its Routines is scheduled.
  expect(next.routine_contexts).toEqual([]);
  expect(t.vault.load().days[0].executions[0].habit_revision).toBe(1);
  expect((await t.service.history('2026-09-21', '2026-09-21')).data.rows[0].execution?.status).toBe(
    'completed',
  );
});

it.each(['primary', 'secondary'] as const)(
  'deleting the %s Routine preserves other memberships and pending edits',
  async (which) => {
    const t = await setup();
    const a = await t.routine();
    const b = await t.routine(routineFields({ name: 'Other' }));
    const c = await t.routine(routineFields({ name: 'Future membership' }));
    const h = await t.create(
      habitFields({
        routine_ids: [a.id, b.id],
        parent_routine_id: a.id,
        schedule: { mode: 'routine', source_routine_revision: 1, rule: a.schedule },
      }),
    );
    await t.service.editHabit(
      h.id,
      { routine_ids: [a.id, b.id, c.id], name: 'Pending name' },
      randomUUID(),
      t.etag(),
    );
    const removed = which === 'primary' ? a : b;
    await t.service.editRoutine(removed.id, { deleted: true }, randomUUID(), t.etag());
    t.setNow('2026-09-22T00:00:00Z');
    const next = effective(t.vault.load().habits, '2026-09-22')!;
    expect(routineIds(next)).toEqual([a.id, b.id, c.id].filter((id) => id !== removed.id));
    expect(next.name).toBe('Pending name');
    expect(next.schedule.mode).toBe(which === 'primary' ? 'explicit' : 'routine');
    expect(next.schedule.rule).toEqual({ type: 'daily' });
    expect((await t.service.today()).data.items).toHaveLength(1);
  },
);

it('secondary Routine edits do not change the Habit cadence or duplicate quota credit', async () => {
  const t = await setup();
  const a = await t.routine();
  const b = await t.routine();
  const h = await t.create(
    habitFields({
      routine_ids: [a.id, b.id],
      parent_routine_id: a.id,
      schedule: {
        mode: 'explicit',
        source_routine_revision: null,
        rule: { type: 'weekly_quota', count: 3 },
      },
      scheduled_time: { mode: 'routine', source_routine_revision: 1, value: a.scheduled_time },
    }),
  );
  await t.service.editRoutine(
    b.id,
    { scheduled_time: '23:00', schedule: { type: 'weekdays' } },
    randomUUID(),
    t.etag(),
  );
  t.setNow('2026-09-22T00:00:00Z');
  await t.service.execute('2026-09-22', h.id, execution(), randomUUID(), t.etag());
  const item = (await t.service.today()).data.items[0];
  expect(item.habit.revision).toBe(1);
  expect(item.routine_contexts.find((r) => r.routine_id === b.id)?.scheduled_time).toBe('23:00');
  expect(item.quota?.actual_count).toBe(1);
  expect(item.quota?.target_count).toBe(3);
});

it('rejects invalid memberships instead of losing them in the projection', async () => {
  const t = await setup();
  const a = await t.routine();
  const b = await t.routine();
  const fingerprint = t.etag();
  for (const fields of [
    habitFields({ routine_ids: [a.id, a.id] }),
    habitFields({ routine_ids: [randomUUID()] }),
    habitFields({ routine_ids: [b.id], parent_routine_id: a.id }),
  ])
    await expect(t.create(fields)).rejects.toThrow();
  expect(t.etag()).toBe(fingerprint);
});
