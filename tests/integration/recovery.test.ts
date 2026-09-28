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
