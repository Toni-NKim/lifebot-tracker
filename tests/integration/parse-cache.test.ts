import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { harness, habitFields, execution, routineFields } from '../helpers.js';
import { atomicWrite, serialize } from '../../app/server/storage/markdown/vault.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((f) => f());
  vi.restoreAllMocks();
});
async function setup() {
  const t = await harness();
  cleanups.push(t.cleanup);
  const r = await t.routine();
  const h = await t.create(habitFields({ parent_routine_id: r.id }));
  await t.service.execute('2026-09-21', h.id, execution(), randomUUID(), t.etag());
  return { ...t, r, h, file: (rel: string) => path.join(t.vault.root, rel) };
}
const files = (t: Awaited<ReturnType<typeof setup>>) => t.vault.inventory().length;

it('unchanged files are not parsed again on repeated reads', async () => {
  const t = await setup();
  t.vault.load();
  const parsed = t.vault.parseCount;
  expect(parsed).toBeGreaterThan(0);
  t.vault.load();
  await t.service.today();
  await t.service.stats();
  await t.service.history('2026-09-21', '2026-09-21');
  expect(t.vault.parseCount).toBe(parsed);
});

it('changing one Markdown file re-parses only that file', async () => {
  const t = await setup();
  t.vault.load();
  const parsed = t.vault.parseCount;
  atomicWrite(t.file(t.vault.definitionPath(t.h)), serialize({ ...t.h, name: 'Edited' }));
  expect(t.vault.load().habits.find((h) => h.id === t.h.id)!.name).toBe('Edited');
  expect(t.vault.parseCount).toBe(parsed + 1);
  // An app write replaces the daily file: one re-parse for it, none for the rest.
  await t.service.rebuild();
  const before = t.vault.parseCount;
  await t.service.execute(
    '2026-09-21',
    t.h.id,
    execution({ energy_note: 'x' }),
    randomUUID(),
    t.etag(),
  );
  expect(t.vault.parseCount).toBe(before + 1);
});

it('external modifications are still detected immediately', async () => {
  const t = await setup();
  await t.service.today();
  const file = t.file(t.vault.definitionPath(t.r));
  const stat = fs.statSync(file);
  // Same size and timestamps: detection must rely on content, not metadata.
  const text = fs.readFileSync(file, 'utf8').replace('Morning', 'Mornin9');
  fs.writeFileSync(file, text);
  fs.utimesSync(file, stat.atime, stat.mtime);
  await expect(t.service.today()).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
  expect(t.vault.load().routines[0].name).toBe('Mornin9');
});

it('failed writes do not leave stale cache state', async () => {
  const t = await setup();
  const before = t.vault.load();
  const original = t.vault.commit.bind(t.vault);
  vi.spyOn(t.vault, 'commit').mockImplementation((...args) => {
    t.setNow('2026-09-21T15:00:00Z');
    return original(...args);
  });
  await expect(
    t.service.editRoutine(
      t.r.id,
      { schedule: { type: 'weekdays' } },
      randomUUID(),
      before.fingerprint,
    ),
  ).rejects.toMatchObject({ code: 'DAY_LOCKED' });
  vi.restoreAllMocks();
  t.setNow('2026-09-21T00:00:00Z');
  const after = t.vault.load();
  expect(after.fingerprint).toBe(before.fingerprint);
  expect(after.routines).toEqual(before.routines);
  expect(t.vault.cacheSize).toBe(files(t));
  // A rejected execution leaves the cached daily document unchanged too.
  await expect(
    t.service.execute('2026-09-21', t.h.id, execution(), randomUUID(), 'stale'),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(t.vault.load().days).toEqual(before.days);
});

it('invalid Markdown fixed externally is read normally afterwards', async () => {
  const t = await setup();
  const file = t.file(t.vault.definitionPath(t.h));
  const good = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, 'broken');
  expect(() => t.vault.load()).toThrow(/frontmatter/);
  expect(() => t.vault.load()).toThrow(/frontmatter/);
  fs.writeFileSync(file, good);
  expect(t.vault.load().habits[0].name).toBe('Reading');
  fs.writeFileSync(file, good.replace('schema_version: 1', 'schema_version: 2'));
  expect(() => t.vault.load()).toThrow();
  fs.writeFileSync(file, good.replace('"Reading"', '"Fixed"'));
  expect(t.vault.load().habits[0].name).toBe('Fixed');
});

it('cached documents and snapshots cannot be mutated accidentally', async () => {
  const t = await setup();
  const s = t.vault.load();
  const h = s.habits[0] as { name: string; schedule: { rule: { type: string } } };
  expect(() => {
    h.name = 'mutated';
  }).toThrow(TypeError);
  expect(() => {
    h.schedule.rule.type = 'weekdays';
  }).toThrow(TypeError);
  expect(() => {
    (s.days[0].executions as unknown[]).push({});
  }).toThrow(TypeError);
  expect(() => {
    (s.habits as unknown[]).push({});
  }).toThrow(TypeError);
  expect(t.vault.load().habits[0].name).toBe('Reading');
});

it('the cache holds one entry per current file, not per historical version', async () => {
  const t = await setup();
  for (let i = 0; i < 5; i++)
    await t.service.execute(
      '2026-09-21',
      t.h.id,
      execution({ energy_note: `edit ${i}` }),
      randomUUID(),
      t.etag(),
    );
  t.vault.load();
  expect(t.vault.cacheSize).toBe(files(t));
  const extra = await t.routine(routineFields({ name: 'Extra' }));
  t.vault.load();
  expect(t.vault.cacheSize).toBe(files(t));
  // Removing files drops their entries.
  fs.rmSync(t.file(t.vault.definitionPath(extra)));
  fs.rmSync(t.file(`Commits/${extra.command_id}.md`));
  t.vault.load();
  expect(t.vault.cacheSize).toBe(files(t));
});

it('an unchanged Vault reuses its validated snapshot; any change produces a new one', async () => {
  const t = await setup();
  const first = t.vault.load();
  expect(t.vault.load()).toBe(first);
  atomicWrite(t.file(t.vault.definitionPath(t.h)), serialize({ ...t.h, name: 'Edited' }));
  const second = t.vault.load();
  expect(second).not.toBe(first);
  expect(second.habits[0].name).toBe('Edited');
  // An invalid state is never memoized.
  fs.writeFileSync(t.file(t.vault.definitionPath(t.h)), 'broken');
  expect(() => t.vault.load()).toThrow();
  expect(() => t.vault.load()).toThrow();
});
