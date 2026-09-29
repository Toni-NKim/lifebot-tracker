import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { harness, habitFields, routineFields, execution } from '../helpers.js';
import { TrackerService } from '../../app/server/services/tracker.js';
import { Index } from '../../app/server/index/sqlite/index.js';
import { atomicWrite, serialize } from '../../app/server/storage/markdown/vault.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((f) => f());
  vi.restoreAllMocks();
});
async function setup() {
  const t = await harness();
  cleanups.push(t.cleanup);
  return t;
}
const restart = (t: Awaited<ReturnType<typeof setup>>) =>
  new TrackerService(t.vault, new Index(t.index.file), () => '2026-09-21T01:00:00Z');

it('a restart after a post-save index failure serves the saved record', async () => {
  const t = await setup();
  const h = await t.create();
  vi.spyOn(t.index, 'rebuild').mockImplementation(() => {
    throw new Error('disk full');
  });
  const saved = await t.service.execute('2026-09-21', h.id, execution(), randomUUID(), t.etag());
  expect(saved.index_warning).toBe('disk full');
  vi.restoreAllMocks();
  const service = restart(t);
  await service.initialize();
  const today = (await service.today()).data;
  expect(today.items[0].execution?.status).toBe('completed');
  expect((await service.status()).source_changed).toBe(false);
});

it('an external edit made while stopped still requires an explicit rebuild', async () => {
  const t = await setup();
  const h = await t.create();
  atomicWrite(
    path.join(t.vault.root, t.vault.definitionPath(h)),
    serialize({ ...h, name: 'Edited while stopped' }),
  );
  const service = restart(t);
  await service.initialize();
  await expect(service.today()).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
});

it('a rebuild by another process (CLI) unblocks a running server', async () => {
  const t = await setup();
  const h = await t.create();
  atomicWrite(
    path.join(t.vault.root, t.vault.definitionPath(h)),
    serialize({ ...h, name: 'Accepted by CLI' }),
  );
  await expect(t.service.today()).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
  await restart(t).rebuild();
  expect((await t.service.today()).data.items[0].habit.name).toBe('Accepted by CLI');
});

it('startup with an invalid Vault reports the error instead of crashing', async () => {
  const t = await setup();
  const h = await t.create();
  fs.writeFileSync(path.join(t.vault.root, t.vault.definitionPath(h)), 'broken');
  const service = restart(t);
  await expect(service.initialize()).resolves.toBeUndefined();
  expect((await service.status()).error).toMatch(/INVALID|frontmatter/i);
  await expect(service.today()).rejects.toMatchObject({ code: 'INVALID_VAULT' });
});

// A crash after the canonical write but before acceptance is recorded.
const crashBeforeAcceptance = (t: Awaited<ReturnType<typeof setup>>) =>
  vi.spyOn(t.service.accepted, 'write').mockImplementation(() => {
    throw new Error('process killed');
  });

it.each(['execution', 'definition'] as const)(
  'a crash right after a canonical %s commit recovers automatically on restart',
  async (kind) => {
    const t = await setup();
    const h = await t.create();
    crashBeforeAcceptance(t);
    if (kind === 'execution')
      await t.service.execute('2026-09-21', h.id, execution(), randomUUID(), t.etag());
    else await t.service.editHabit(h.id, { name: 'Renamed' }, randomUUID(), t.etag());
    vi.restoreAllMocks();
    const committed = t.etag();
    const service = restart(t);
    await service.initialize();
    expect((await service.status()).source_changed).toBe(false);
    const today = (await service.today()).data;
    // The canonical commit is kept, never rolled back.
    expect(t.etag()).toBe(committed);
    if (kind === 'execution') expect(today.items[0].execution?.status).toBe('completed');
    else expect((await service.list('habit')).data[0].pending[0].name).toBe('Renamed');
    await service.execute('2026-09-21', h.id, execution(), randomUUID(), t.etag());
  },
);

it('a crash before the manifest removes only the interrupted command revisions', async () => {
  const t = await setup();
  const r = await t.routine();
  await t.create(
    habitFields({
      parent_routine_id: r.id,
      schedule: { mode: 'routine', source_routine_revision: 1, rule: r.schedule },
    }),
  );
  const before = t.etag();
  const rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to).includes(`${path.sep}Commits${path.sep}`)) throw new Error('process killed');
    return rename(from, to);
  });
  vi.spyOn(fs, 'rmSync').mockImplementation(() => {
    throw new Error('process killed');
  });
  await expect(
    t.service.editRoutine(r.id, { schedule: { type: 'weekdays' } }, randomUUID(), before),
  ).rejects.toThrow('process killed');
  vi.restoreAllMocks();
  expect(t.vault.load().warnings).toHaveLength(2);
  const service = restart(t);
  await service.initialize();
  expect(t.etag()).toBe(before);
  expect(t.vault.load().warnings).toEqual([]);
  await expect(service.today()).resolves.toBeDefined();
});

it('an external edit after an interrupted commit is still detected', async () => {
  const t = await setup();
  const h = await t.create();
  const other = await t.routine(routineFields({ name: 'Other' }));
  crashBeforeAcceptance(t);
  await t.service.execute('2026-09-21', h.id, execution(), randomUUID(), t.etag());
  vi.restoreAllMocks();
  atomicWrite(
    path.join(t.vault.root, t.vault.definitionPath(other)),
    serialize({ ...other, name: 'Edited in Obsidian' }),
  );
  const service = restart(t);
  await service.initialize();
  await expect(service.today()).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
  expect(t.vault.load().days[0].executions[0].status).toBe('completed');
});

it('a leftover intent never accepts later external edits', async () => {
  const t = await setup();
  const h = await t.create();
  crashBeforeAcceptance(t);
  await t.service.execute('2026-09-21', h.id, execution(), randomUUID(), t.etag());
  vi.restoreAllMocks();
  const service = restart(t);
  await service.initialize();
  await service.today();
  atomicWrite(
    path.join(t.vault.root, t.vault.definitionPath(h)),
    serialize({ ...h, name: 'Edited in Obsidian' }),
  );
  await expect(service.today()).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
  const again = restart(t);
  await again.initialize();
  await expect(again.today()).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
});

it.each(['execution', 'definition'] as const)(
  'a %s write fails closed when the commit intent cannot be recorded',
  async (kind) => {
    const t = await setup();
    const h = await t.create();
    const before = t.etag();
    vi.spyOn(t.service.intent, 'write').mockImplementation(() => {
      throw new Error('EACCES: state directory is read-only');
    });
    const write =
      kind === 'execution'
        ? t.service.execute('2026-09-21', h.id, execution(), randomUUID(), before)
        : t.service.editHabit(h.id, { name: 'Renamed' }, randomUUID(), before);
    await expect(write).rejects.toMatchObject({ code: 'STATE_UNAVAILABLE', status: 503 });
    // Nothing canonical was started: same bytes, no orphan revisions.
    expect(t.etag()).toBe(before);
    expect(t.vault.load().warnings).toEqual([]);
    // Reads do not need the state directory to be writable.
    expect((await t.service.today()).data.items[0].execution).toBeNull();
  },
);

it('repeated acceptance failures never destroy the recovery proof (A → B → C)', async () => {
  const t = await setup();
  const a = await t.create(); // durable marker: A
  const b = await t.create(habitFields({ name: 'Second' }));
  crashBeforeAcceptance(t);
  // A → B is saved, but its acceptance cannot be recorded.
  const first = await t.service.execute('2026-09-21', a.id, execution(), randomUUID(), t.etag());
  expect(first.data.saved).toBe(true);
  const afterB = t.etag();
  // B → C must not overwrite the only proof of B: it is refused until B is recorded.
  await expect(
    t.service.execute('2026-09-21', b.id, execution(), randomUUID(), t.etag()),
  ).rejects.toMatchObject({ code: 'STATE_UNAVAILABLE', status: 503 });
  expect(t.etag()).toBe(afterB);
  // Reads keep working meanwhile.
  expect((await t.service.today()).data.items.length).toBe(2);
  vi.restoreAllMocks();
  const service = restart(t);
  await service.initialize();
  const today = (await service.today()).data;
  expect(today.items.find((i) => i.habit_id === a.id)?.execution?.status).toBe('completed');
  expect((await service.status()).source_changed).toBe(false);
});

it('once acceptance can be recorded again, the next write resumes the chain', async () => {
  const t = await setup();
  const a = await t.create();
  const b = await t.create(habitFields({ name: 'Second' }));
  const failing = crashBeforeAcceptance(t);
  await t.service.execute('2026-09-21', a.id, execution(), randomUUID(), t.etag());
  failing.mockRestore();
  // The pending acceptance of B is recorded first, then B → C proceeds.
  await t.service.execute('2026-09-21', b.id, execution(), randomUUID(), t.etag());
  const service = restart(t);
  await service.initialize();
  const today = (await service.today()).data;
  expect(today.items.every((i) => i.execution?.status === 'completed')).toBe(true);
});

it('startup of an install without the marker establishes it from the trusted baseline', async () => {
  const t = await setup();
  const h = await t.create();
  const accepted = path.join(path.dirname(t.index.file), 'accepted-source');
  fs.rmSync(accepted); // an install that predates the marker: only SQLite metadata
  const service = restart(t);
  await service.initialize();
  expect(fs.readFileSync(accepted, 'utf8').trim()).toBe(t.etag());
  // Deleting only SQLite no longer resets trust.
  fs.rmSync(t.index.file);
  atomicWrite(
    path.join(t.vault.root, t.vault.definitionPath(h)),
    serialize({ ...h, name: 'Edited in Obsidian' }),
  );
  const again = restart(t);
  await again.initialize();
  await expect(again.today()).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
  expect((await again.status()).source_changed).toBe(true);
});

it('if the marker cannot be established at startup, reads work and writes are refused', async () => {
  const t = await setup();
  const h = await t.create();
  fs.rmSync(path.join(path.dirname(t.index.file), 'accepted-source'));
  const service = restart(t);
  vi.spyOn(service.accepted, 'write').mockImplementation(() => {
    throw new Error('EACCES');
  });
  await service.initialize();
  await expect(service.today()).resolves.toBeDefined();
  const before = t.etag();
  await expect(
    service.execute('2026-09-21', h.id, execution(), randomUUID(), before),
  ).rejects.toMatchObject({ code: 'STATE_UNAVAILABLE' });
  expect(t.etag()).toBe(before);
});

it('orphan cleanup interrupted part-way is completed on the next start', async () => {
  const t = await setup();
  const r = await t.routine();
  await t.create(
    habitFields({
      parent_routine_id: r.id,
      schedule: { mode: 'routine', source_routine_revision: 1, rule: r.schedule },
    }),
  );
  const before = t.etag();
  const rename = fs.renameSync;
  const rm = fs.rmSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to).includes(`${path.sep}Commits${path.sep}`)) throw new Error('process killed');
    return rename(from, to);
  });
  vi.spyOn(fs, 'rmSync').mockImplementation(() => {
    throw new Error('process killed');
  });
  await expect(
    t.service.editRoutine(r.id, { schedule: { type: 'weekdays' } }, randomUUID(), before),
  ).rejects.toThrow('process killed');
  vi.restoreAllMocks();
  expect(t.vault.load().warnings).toHaveLength(2);
  // Recovery deletes the first orphan, then the process dies before the second.
  let calls = 0;
  vi.spyOn(fs, 'rmSync').mockImplementation((file, options) => {
    if (++calls > 1) throw new Error('process killed');
    return rm(file, options);
  });
  const interrupted = restart(t);
  await interrupted.initialize();
  vi.restoreAllMocks();
  expect(t.vault.load().warnings).toHaveLength(1); // only a suffix of the orphans is left
  const service = restart(t);
  await service.initialize();
  expect(t.etag()).toBe(before);
  expect(t.vault.load().warnings).toEqual([]);
  await expect(service.today()).resolves.toBeDefined();
});

it('a pending acceptance never overwrites a newer state accepted by another process', async () => {
  const t = await setup();
  const h = await t.create(); // accepted: A
  crashBeforeAcceptance(t);
  await t.service.execute('2026-09-21', h.id, execution(), randomUUID(), t.etag()); // B, unrecorded
  const stale = t.etag();
  // Another process (CLI-equivalent) explicitly accepts newer canonical state C.
  atomicWrite(
    path.join(t.vault.root, t.vault.definitionPath(h)),
    serialize({ ...h, name: 'Accepted elsewhere' }),
  );
  await restart(t).rebuild();
  const c = t.etag();
  const marker = path.join(path.dirname(t.index.file), 'accepted-source');
  expect(fs.readFileSync(marker, 'utf8').trim()).toBe(c);
  // The running service adopts C; its pending B must not be persisted afterwards.
  vi.restoreAllMocks();
  expect((await t.service.today()).data.items[0].habit.name).toBe('Accepted elsewhere');
  await expect(
    t.service.execute('2026-09-21', h.id, execution({ energy_note: 'x' }), randomUUID(), stale),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(fs.readFileSync(marker, 'utf8').trim()).toBe(c);
  expect(t.etag()).toBe(c);
  const service = restart(t);
  await service.initialize();
  expect((await service.today()).data.items[0].habit.name).toBe('Accepted elsewhere');
  expect((await service.status()).source_changed).toBe(false);
});
