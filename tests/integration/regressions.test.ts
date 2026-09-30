import { afterEach, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { harness, habitFields, routineFields, execution, undone } from '../helpers.js';
import { Vault } from '../../app/server/storage/markdown/vault.js';
import { Index } from '../../app/server/index/sqlite/index.js';
import { project, effective } from '../../app/shared/domain/index.js';
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));
async function setup() {
  const t = await harness();
  cleanups.push(t.cleanup);
  return t;
}
it('copies the synthetic fixture Vault and rebuilds without changing it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'habit-fixture-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync('tests/fixtures/obsidian-vault', path.join(root, 'vault'), { recursive: true });
  const v = new Vault(path.join(root, 'vault/Life/HabitTracker'));
  const s = v.load();
  const before = v.fingerprint();
  const index = new Index(path.join(root, 'state/index.sqlite'));
  index.rebuild(v, s, '2026-09-27T00:00:00Z');
  expect(index.read()).toEqual(project(s, '2026-09-27T00:00:00Z'));
  expect(v.fingerprint()).toBe(before);
  expect(s.habits).toHaveLength(2);
});
it('Routine schedule and time changes respect different quota boundaries', async () => {
  const t = await setup();
  const r = await t.routine(routineFields({ schedule: { type: 'weekly_quota', count: 3 } }));
  const h = await t.create(
    habitFields({
      parent_routine_id: r.id,
      schedule: { mode: 'routine', source_routine_revision: 1, rule: r.schedule },
      scheduled_time: { mode: 'routine', source_routine_revision: 1, value: r.scheduled_time },
    }),
  );
  await t.service.editRoutine(
    r.id,
    { schedule: { type: 'weekly_quota', count: 5 }, scheduled_time: '08:00' },
    randomUUID(),
    t.etag(),
  );
  await t.service.editHabit(h.id, { name: 'Tomorrow name' }, randomUUID(), t.etag());
  t.setNow('2026-09-22T00:00:00Z');
  let item = (await t.service.today()).data.items[0];
  expect(item.habit.name).toBe('Tomorrow name');
  expect(item.scheduled_time).toBe('08:00');
  expect(item.quota?.target_count).toBe(3);
  t.setNow('2026-09-28T00:00:00Z');
  item = (await t.service.today()).data.items[0];
  expect(item.quota?.target_count).toBe(5);
  expect(item.scheduled_time).toBe('08:00');
});
it('Routine updates preserve an explicitly overridden pending child setting', async () => {
  const t = await setup();
  const r = await t.routine();
  const h = await t.create(
    habitFields({
      parent_routine_id: r.id,
      scheduled_time: { mode: 'routine', source_routine_revision: 1, value: r.scheduled_time },
    }),
  );
  await t.service.editHabit(
    h.id,
    { scheduled_time: { mode: 'explicit', source_routine_revision: null, value: '09:00' } },
    randomUUID(),
    t.etag(),
  );
  await t.service.editRoutine(r.id, { scheduled_time: '08:00' }, randomUUID(), t.etag());
  t.setNow('2026-09-22T00:00:00Z');
  expect((await t.service.today()).data.items[0].scheduled_time).toBe('09:00');
});
it('Routine deletion does not cancel a pending move to a different Routine', async () => {
  const t = await setup();
  const a = await t.routine();
  const b = await t.routine(routineFields({ name: 'Other' }));
  const h = await t.create(habitFields({ parent_routine_id: a.id }));
  await t.service.editHabit(h.id, { parent_routine_id: b.id }, randomUUID(), t.etag());
  await t.service.editRoutine(a.id, { deleted: true }, randomUUID(), t.etag());
  t.setNow('2026-09-22T00:00:00Z');
  expect((await t.service.today()).data.items[0].routine_id).toBe(b.id);
});
it('rebuilds a corrupt derived database from valid canonical files', async () => {
  const t = await setup();
  const h = await t.create();
  fs.writeFileSync(t.index.file, 'corrupt sqlite');
  await t.service.rebuild();
  expect(t.index.read().occurrences[0].habit_id).toBe(h.id);
});
it('two simultaneous stale writes cannot silently overwrite each other', async () => {
  const t = await setup();
  const h = await t.create();
  const etag = t.etag();
  const results = await Promise.allSettled([
    t.service.execute('2026-09-21', h.id, execution(), randomUUID(), etag),
    t.service.execute(
      '2026-09-21',
      h.id,
      execution({ energy_note: 'different' }),
      randomUUID(),
      etag,
    ),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(t.vault.load().days[0].revision).toBe(1);
});
it('random completion/undo sequences preserve rebuild equivalence and canonical-only recovery', async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }), async (states) => {
      const t = await harness();
      try {
        const h = await t.create();
        for (const completed of states)
          await t.service.execute(
            '2026-09-21',
            h.id,
            completed ? execution() : undone(),
            randomUUID(),
            t.etag(),
          );
        const s = t.vault.load();
        expect(t.index.read()).toEqual(project(s, '2026-09-21T00:00:00Z'));
        const fingerprint = s.fingerprint;
        fs.unlinkSync(t.index.file);
        await t.service.rebuild();
        expect(t.etag()).toBe(fingerprint);
        expect(t.index.read().occurrences[0].status).toBe(
          states.at(-1) ? 'completed' : 'incomplete',
        );
      } finally {
        t.cleanup();
      }
    }),
    { numRuns: 10 },
  );
});
