import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { configuration } from '../../app/server/config.js';
import {
  moduleRegistry,
  withModuleLocks,
  moduleEtag,
  assertModuleEtag,
  agendaEtag,
} from '../../app/server/modules.js';
import { Vault } from '../../app/server/storage/markdown/vault.js';

const cleanup: string[] = [];
afterEach(() =>
  cleanup.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })),
);
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'module-boundaries-'));
  cleanup.push(dir);
  const vault = path.join(dir, 'vault');
  const state = path.join(dir, 'state');
  return { dir, vault, state, registry: moduleRegistry(vault, state, 'Life/HabitTracker') };
}

it('preserves all legacy Habit paths and isolates new DBs and recovery markers without creating files', () => {
  const t = setup();
  const c = configuration({ OBSIDIAN_VAULT_PATH: t.vault, TRACKER_STATE_PATH: t.state });
  expect(c.modules.habit).toEqual({
    name: 'habit',
    root: c.root,
    database: c.database,
    acceptedSource: path.join(t.state, 'accepted-source'),
    commitIntent: path.join(t.state, 'commit-intent.json'),
  });
  expect(c.modules.todo.database).toBe(path.join(t.state, 'todo/index.sqlite'));
  expect(c.modules.timebox.database).toBe(path.join(t.state, 'timebox/index.sqlite'));
  for (const key of ['root', 'database', 'acceptedSource', 'commitIntent'] as const)
    expect(new Set(Object.values(c.modules).map((m) => m[key])).size).toBe(3);
  expect(fs.readdirSync(t.dir)).toEqual([]);
});

it('rejects overlapping canonical roots and aliased state paths', () => {
  const t = setup();
  for (const rel of ['.', 'Life', 'Life/TodoTracker', 'Life/Timebox/nested', '../outside'])
    expect(() => moduleRegistry(t.vault, t.state, rel)).toThrow();
  fs.mkdirSync(t.vault);
  fs.symlinkSync(t.vault, t.state);
  expect(() => moduleRegistry(t.vault, t.state, 'Life/HabitTracker')).toThrow('separate');
  fs.unlinkSync(t.state);
  fs.mkdirSync(t.state);
  fs.symlinkSync(t.state, path.join(t.state, 'todo'));
  expect(() => moduleRegistry(t.vault, t.state, 'Life/HabitTracker')).toThrow('aliases');
});

it('serializes opposite-order multi-module requests using the same locks as Habit and releases on errors', async () => {
  const t = setup();
  Object.values(t.registry).forEach((m) => fs.mkdirSync(m.root, { recursive: true }));
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  const habit = new Vault(t.registry.habit.root).locked(async () => {
    events.push('habit');
    enter();
    await held;
  });
  await entered;
  const a = withModuleLocks(t.registry, ['timebox', 'habit', 'todo'], () => {
    events.push('a');
  });
  const b = withModuleLocks(t.registry, ['habit', 'todo', 'timebox', 'habit'], () => {
    events.push('b');
  });
  release();
  await Promise.all([habit, a, b]);
  expect(events[0]).toBe('habit');
  expect(events.slice(1).sort()).toEqual(['a', 'b']);
  await expect(
    withModuleLocks(t.registry, ['todo', 'habit'], () => {
      throw new Error('abort');
    }),
  ).rejects.toThrow('abort');
  await expect(withModuleLocks(t.registry, ['habit', 'todo'], () => 'released')).resolves.toBe(
    'released',
  );
});

it('scopes concurrency tokens by module and identity, keeping the aggregate token distinct', () => {
  const todo = moduleEtag('todo', 'one', 'hash');
  for (const other of [
    moduleEtag('timebox', 'one', 'hash'),
    moduleEtag('todo', 'two', 'hash'),
    moduleEtag('todo', 'one', 'next'),
  ])
    expect(() => assertModuleEtag(other, todo)).toThrow('changed');
  const versions = { habit: 'h', todo, timebox: 't' };
  const token = agendaEtag('2026-10-01', versions, 1);
  expect(token).not.toBe(todo);
  expect(agendaEtag('2026-10-02', versions, 1)).not.toBe(token);
  expect(agendaEtag('2026-10-01', { ...versions, habit: 'changed' }, 1)).not.toBe(token);
  expect(agendaEtag('2026-10-01', versions, 2)).not.toBe(token);
});
