import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Type } from '@sinclair/typebox';
import { afterEach, expect, it, vi } from 'vitest';
import { harness, execution } from '../helpers.js';
import { moduleRegistry, type NewModuleName } from '../../app/server/modules.js';
import { ModuleVault, moduleMarkdown } from '../../app/server/storage/markdown/module-vault.js';
import { ModuleIndex } from '../../app/server/index/sqlite/module-index.js';
import { ModuleService } from '../../app/server/services/module.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanup.splice(0).forEach((f) => f());
});
async function setup() {
  const habit = await harness('2026-10-01');
  cleanup.push(habit.cleanup);
  const registry = moduleRegistry(
    path.join(habit.root, 'vault'),
    path.join(habit.root, 'state'),
    'Life/HabitTracker',
  );
  const make = (name: NewModuleName) =>
    new ModuleService(
      new ModuleVault(registry[name].root, {
        name,
        records: {
          entry: {
            directory: 'Entries',
            version: 1,
            schema: Type.Object({ title: Type.String() }, { additionalProperties: false }),
          },
        },
      }),
      new ModuleIndex(registry[name]),
      () => '2026-10-01T01:00:00Z',
    );
  const todo = make('todo');
  const timebox = make('timebox');
  const settings = habit.vault.load().tracker;
  await todo.initializeModule(settings);
  await timebox.initializeModule(settings);
  const save = async (
    service: ModuleService,
    title = 'entry',
    id = randomUUID(),
    cmd = randomUUID(),
    etag?: string,
  ) =>
    service.mutate(
      { id: cmd, etag: etag ?? (await service.read()).etag, request: { type: 'entry', id, title } },
      () => [{ kind: 'entry', id, data: { title } }],
    );
  return { habit, todo, timebox, registry, make, save };
}
function failAcceptance(service: ModuleService) {
  return vi.spyOn(service.accepted, 'write').mockImplementation(() => {
    throw new Error('read-only state');
  });
}
function external(service: ModuleService, title = 'external') {
  const snapshot = service.vault.load();
  const r = snapshot.records[0];
  fs.writeFileSync(
    service.vault.safe(service.vault.recordPath(r)),
    moduleMarkdown({ ...r, data: { title } }),
  );
}

it('keeps all three canonical roots, indexes and recovery markers independent across writes/rebuilds', async () => {
  const t = await setup();
  const h = await t.habit.create();
  const habitBytes = fs.readFileSync(t.habit.index.file);
  const habitHash = t.habit.etag();
  const habitMarker = fs.readFileSync(t.registry.habit.acceptedSource);
  await t.save(t.todo);
  await t.save(t.timebox);
  await t.todo.rebuild();
  await t.timebox.rebuild();
  expect(t.habit.etag()).toBe(habitHash);
  expect(fs.readFileSync(t.habit.index.file)).toEqual(habitBytes);
  expect(fs.readFileSync(t.registry.habit.acceptedSource)).toEqual(habitMarker);
  const todoBytes = fs.readFileSync(t.todo.index.file);
  const timeboxBytes = fs.readFileSync(t.timebox.index.file);
  await t.habit.service.execute('2026-10-01', h.id, execution(), randomUUID(), t.habit.etag());
  await t.habit.service.rebuild();
  expect(fs.readFileSync(t.todo.index.file)).toEqual(todoBytes);
  expect(fs.readFileSync(t.timebox.index.file)).toEqual(timeboxBytes);
});

it('replays canonical command receipts after DB/state loss without duplicating revisions', async () => {
  const t = await setup();
  const id = randomUUID();
  const cmd = randomUUID();
  const before = (await t.todo.read()).etag;
  await t.save(t.todo, 'first', id, cmd, before);
  await t.save(t.todo, 'latest', id);
  const files = t.todo.vault.fingerprint();
  fs.rmSync(path.dirname(t.todo.index.file), { recursive: true });
  const fresh = t.make('todo');
  const replay = await t.save(fresh, 'first', id, cmd, before);
  expect(replay.data.current[0].data).toEqual({ title: 'latest' });
  expect(fresh.vault.fingerprint()).toBe(files);
  expect(fresh.index.read()).toEqual([...fresh.vault.load().records]);
  await expect(t.save(fresh, 'different', id, cmd)).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
});

it('detects same-module stale writes without conflicts from another module', async () => {
  const t = await setup();
  const token = (await t.todo.read()).etag;
  await t.save(t.timebox);
  await t.save(t.todo, 'a', randomUUID(), randomUUID(), token);
  await expect(t.save(t.todo, 'b', randomUUID(), randomUUID(), token)).rejects.toMatchObject({
    code: 'REVISION_CONFLICT',
  });
  await expect(
    t.save(t.todo, 'c', randomUUID(), randomUUID(), (await t.timebox.read()).etag),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});

it('refuses canonical writes before intent failure and keeps reads available', async () => {
  const t = await setup();
  const before = t.todo.vault.fingerprint();
  vi.spyOn(t.todo.intent, 'write').mockImplementation(() => {
    throw new Error('disk full');
  });
  await expect(t.save(t.todo)).rejects.toMatchObject({ code: 'STATE_UNAVAILABLE' });
  expect(t.todo.vault.fingerprint()).toBe(before);
  expect((await t.todo.read()).data.current).toEqual([]);
});

it('recovers a committed write with failed acceptance and prevents A-B-C proof loss', async () => {
  const t = await setup();
  failAcceptance(t.todo);
  const first = await t.save(t.todo);
  expect(first.index_warning).toContain('acceptance');
  const committed = t.todo.vault.fingerprint();
  await expect(t.save(t.todo, 'blocked')).rejects.toMatchObject({ code: 'STATE_UNAVAILABLE' });
  expect(t.todo.vault.fingerprint()).toBe(committed);
  expect((await t.todo.read()).data.current).toHaveLength(1);
  const fresh = t.make('todo');
  expect((await fresh.read()).data.current).toHaveLength(1);
  expect(fs.readFileSync(fresh.accepted.file, 'utf8').trim()).toBe(committed);
});

it('never lets a pending acceptance overwrite newer explicit acceptance by another process', async () => {
  const t = await setup();
  failAcceptance(t.todo);
  await t.save(t.todo);
  external(t.todo);
  const fresh = t.make('todo');
  await fresh.rebuild();
  const accepted = fs.readFileSync(fresh.accepted.file);
  expect((await t.todo.read()).data.current[0].data).toEqual({ title: 'external' });
  expect(fs.readFileSync(fresh.accepted.file)).toEqual(accepted);
});

it('keeps committed data when indexing fails and rebuilds after SQLite deletion alone', async () => {
  const t = await setup();
  vi.spyOn(t.todo.index, 'rebuild').mockImplementation(() => {
    throw new Error('index disk failure');
  });
  const saved = await t.save(t.todo);
  expect(saved.index_warning).toBe('index disk failure');
  vi.restoreAllMocks();
  fs.rmSync(t.todo.index.file);
  expect((await t.make('todo').read()).data.current).toHaveLength(1);
  expect(t.todo.index.read()).toEqual([...t.todo.vault.load().records]);
});

it('requires explicit module rebuild for external edits and never auto-accepts an edit beside an interrupted commit', async () => {
  const t = await setup();
  failAcceptance(t.todo);
  await t.save(t.todo);
  external(t.todo);
  await expect(t.make('todo').read()).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
  expect((await t.timebox.read()).data.current).toHaveLength(0);
  await t.make('todo').rebuild();
  expect((await t.todo.read()).data.current[0].data).toEqual({ title: 'external' });
});

it('cleans any subset of unpublished revisions after repeated interruptions', async () => {
  const t = await setup();
  const etag = (await t.todo.read()).etag;
  const before = t.todo.vault.fingerprint();
  const rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to).includes('/Commits/')) throw new Error('crash before manifest');
    rename(from, to);
  });
  vi.spyOn(t.todo.vault, 'removeUncommitted').mockImplementation(() => {
    throw new Error('cleanup interrupted');
  });
  await expect(
    t.todo.mutate({ id: randomUUID(), etag, request: { type: 'batch' } }, () => [
      { kind: 'entry', id: randomUUID(), data: { title: 'a' } },
      { kind: 'entry', id: randomUUID(), data: { title: 'b' } },
    ]),
  ).rejects.toThrow('crash');
  expect(t.todo.vault.load().warnings).toHaveLength(2);
  vi.restoreAllMocks();
  const rm = fs.rmSync;
  let calls = 0;
  vi.spyOn(fs, 'rmSync').mockImplementation((file, options) => {
    if (++calls > 1) throw new Error('second cleanup interrupted');
    rm(file, options);
  });
  await expect(t.make('todo').read()).rejects.toThrow('interrupted');
  vi.restoreAllMocks();
  expect(t.todo.vault.load().warnings).toHaveLength(1);
  expect((await t.make('todo').read()).data.current).toEqual([]);
  expect(t.todo.vault.fingerprint()).toBe(before);
});

it('does not delete externally changed unpublished revisions during rejected-command cleanup', async () => {
  const t = await setup();
  const id = randomUUID();
  const etag = (await t.todo.read()).etag;
  await expect(
    t.todo.mutate(
      { id: randomUUID(), etag, request: { type: 'guard' } },
      () => [{ kind: 'entry', id, data: { title: 'own' } }],
      () => {
        fs.writeFileSync(t.todo.vault.safe(`Entries/${id}/000001.md`), 'external bytes');
        throw new Error('aborted');
      },
    ),
  ).rejects.toThrow('aborted');
  expect(fs.readFileSync(t.todo.vault.safe(`Entries/${id}/000001.md`), 'utf8')).toBe(
    'external bytes',
  );
  await expect(t.make('todo').read()).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
});

it('rejects invalid records, unknown versions and missing committed source without touching a good index', async () => {
  const t = await setup();
  await expect(
    t.todo.mutate({ id: randomUUID(), etag: (await t.todo.read()).etag, request: {} }, () => [
      { kind: 'entry', id: randomUUID(), data: { title: 4 } },
    ]),
  ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  await t.save(t.todo);
  const index = fs.readFileSync(t.todo.index.file);
  const record = t.todo.vault.load().records[0];
  const file = t.todo.vault.safe(t.todo.vault.recordPath(record));
  fs.writeFileSync(file, moduleMarkdown({ ...record, schema_version: 2 }));
  await expect(t.todo.rebuild()).rejects.toMatchObject({ code: 'INVALID_VAULT' });
  expect(fs.readFileSync(t.todo.index.file)).toEqual(index);
  fs.rmSync(file);
  await expect(t.todo.rebuild()).rejects.toMatchObject({ code: 'INVALID_VAULT' });
});

it('a missing or malformed acceptance marker is not a silent trust reset for existing state', async () => {
  const t = await setup();
  await t.save(t.todo);
  external(t.todo);
  fs.rmSync(t.todo.accepted.file);
  await expect(t.make('todo').read()).rejects.toMatchObject({ code: 'STATE_UNAVAILABLE' });
  fs.writeFileSync(t.todo.accepted.file, 'broken');
  await expect(t.make('todo').read()).rejects.toMatchObject({ code: 'STATE_UNAVAILABLE' });
  await t.todo.rebuild();
  expect((await t.todo.read()).data.current[0].data).toEqual({ title: 'external' });
});

it.each(['revision', 'manifest'])(
  'recovers after a real SIGKILL immediately after %s publication',
  async (point) => {
    const t = await setup();
    const before = t.todo.vault.fingerprint();
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'tests/support/module-crash-worker.ts', t.habit.root, point],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 15000,
      },
    );
    expect(child.signal, child.stderr).toBe('SIGKILL');
    // The owner is confirmed dead. Simulate the five-minute stale-lock interval
    // on this test directory only, without slowing every regression run by minutes.
    const old = new Date(Date.now() - 600000);
    fs.utimesSync(`${t.registry.todo.root}.lock`, old, old);
    const fresh = t.make('todo');
    const view = await fresh.read();
    expect(view.data.current).toHaveLength(point === 'revision' ? 0 : 2);
    if (point === 'revision') expect(fresh.vault.fingerprint()).toBe(before);
    expect(view.data.warnings).toEqual([]);
  },
);

it('validating source does not accept changes; explicit rebuild does', async () => {
  const t = await setup();
  await t.save(t.todo);
  external(t.todo);
  expect((await t.todo.validateVault()).valid).toBe(true);
  await expect(t.todo.read()).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
  await t.todo.rebuild();
  expect((await t.todo.read()).data.current[0].data).toEqual({ title: 'external' });
});
