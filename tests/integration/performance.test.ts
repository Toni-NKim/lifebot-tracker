import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { harness, habitFields, execution } from '../helpers.js';
import { addDays, executionId } from '../../app/shared/domain/index.js';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

// One year of synthetic history: 20 daily Habits, every day completed.
async function year() {
  const start = '2025-09-22';
  const t = await harness(start);
  cleanups.push(t.cleanup);
  const ids: string[] = [];
  for (let i = 0; i < 20; i++) ids.push((await t.create(habitFields({ name: `H${i}` }))).id);
  const tracker = t.vault.load().tracker;
  for (let day = start; day < '2026-09-21'; day = addDays(day, 1)) {
    const at = `${day}T01:00:00Z`;
    t.vault.writeDaily({
      schema_version: 1,
      kind: 'daily_execution',
      tracker_id: tracker.id,
      date: day,
      timezone: tracker.timezone,
      revision: ids.length,
      created_at: at,
      updated_at: at,
      receipts: ids.map((_, i) => ({
        command_id: randomUUID(),
        request_sha256: 'a'.repeat(64),
        applied_revision: i + 1,
      })),
      executions: ids.map((id) => ({
        ...execution(),
        id: executionId(tracker.id, id, day),
        habit_id: id,
        habit_revision: 1,
        routine_id: null,
        routine_revision: null,
        slot: 1 as const,
        completed_at: at,
        recorded_at: at,
        updated_at: at,
        target_amount: '20',
        unit: 'pages',
      })),
    });
  }
  t.setNow('2026-09-21T00:00:00Z');
  await t.service.rebuild();
  return { ...t, ids };
}
const timed = async <T>(f: () => Promise<T>) => {
  const start = performance.now();
  await f();
  return performance.now() - start;
};

it('reads and writes stay within budget on a year of history', async () => {
  const t = await year();
  await t.service.today();
  // Deterministic: a warm read parses nothing, a completion parses only its daily file.
  const parsed = t.vault.parseCount;
  const read = await timed(() => t.service.today());
  expect(t.vault.parseCount).toBe(parsed);
  const write = await timed(() =>
    t.service.execute('2026-09-21', t.ids[0], execution(), randomUUID(), t.etag()),
  );
  expect(t.vault.parseCount).toBe(parsed + 1);
  expect((await t.service.today()).data.items.filter((i) => i.execution)).toHaveLength(1);
  // Generous limits: they only catch a return to re-parsing the whole Vault per request
  // (previously about 2.7 s per read and 10 s per write for this dataset).
  expect(read).toBeLessThan(1500);
  expect(write).toBeLessThan(6000);
}, 120_000);
