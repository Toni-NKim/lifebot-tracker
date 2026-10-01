import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../shared/contracts/index.js';
import { withVaultLock } from './storage/lock.js';
import { canonical, sha } from './storage/markdown/vault.js';

export const MODULE_ORDER = ['habit', 'todo', 'timebox'] as const;
export type ModuleName = (typeof MODULE_ORDER)[number];
export type NewModuleName = Exclude<ModuleName, 'habit'>;
export interface ModulePaths {
  name: ModuleName;
  root: string;
  database: string;
  acceptedSource: string;
  commitIntent: string;
}
export type ModuleRegistry = Record<ModuleName, ModulePaths>;

// Resolve existing ancestors too: two non-existent children of symlink aliases must
// not accidentally share a canonical root or put disposable state inside the Vault.
function physical(file: string): string {
  if (fs.existsSync(file)) return fs.realpathSync(file);
  const parent = path.dirname(file);
  return parent === file ? file : path.join(physical(parent), path.basename(file));
}
const contains = (parent: string, child: string) =>
  parent === child || child.startsWith(parent + path.sep);

export function moduleRegistry(
  vault: string,
  state: string,
  habitRelative: string,
): ModuleRegistry {
  const roots = {
    habit: path.resolve(vault, habitRelative),
    todo: path.resolve(vault, 'Life/TodoTracker'),
    timebox: path.resolve(vault, 'Life/Timebox'),
  };
  const physicalVault = physical(path.resolve(vault));
  const physicalState = physical(path.resolve(state));
  if (contains(physicalVault, physicalState) || contains(physicalState, physicalVault))
    throw new AppError(
      'CONFIGURATION_ERROR',
      'State directory must be outside and separate from the entire Vault',
    );
  for (const name of MODULE_ORDER) {
    const root = physical(roots[name]);
    if (root === physicalVault || !contains(physicalVault, root))
      throw new AppError('CONFIGURATION_ERROR', `${name} root must stay inside the Vault`);
    for (const other of MODULE_ORDER)
      if (other !== name && contains(root, physical(roots[other])))
        throw new AppError('CONFIGURATION_ERROR', 'Module canonical roots must not overlap');
  }
  const entries = MODULE_ORDER.map((name) => {
    const dir = name === 'habit' ? path.resolve(state) : path.resolve(state, name);
    if (physical(dir) !== path.join(physicalState, ...(name === 'habit' ? [] : [name])))
      throw new AppError(
        'CONFIGURATION_ERROR',
        'Module state directories must not be symlink aliases',
      );
    return [
      name,
      {
        name,
        root: roots[name],
        database: path.join(dir, name === 'habit' ? 'tracker.sqlite' : 'index.sqlite'),
        acceptedSource: path.join(dir, 'accepted-source'),
        commitIntent: path.join(dir, 'commit-intent.json'),
      } satisfies ModulePaths,
    ] as const;
  });
  return Object.fromEntries(entries) as ModuleRegistry;
}

// All multi-module callers acquire the same existing per-root locks in this order.
// The callback must call lock-held operations, never re-enter a public service lock.
export async function withModuleLocks<T>(
  registry: ModuleRegistry,
  names: readonly ModuleName[],
  work: () => T | Promise<T>,
): Promise<T> {
  const ordered = MODULE_ORDER.filter((name) => names.includes(name));
  const acquire = (i: number): Promise<T> =>
    i === ordered.length
      ? Promise.resolve().then(work)
      : withVaultLock(registry[ordered[i]].root, () => acquire(i + 1));
  return acquire(0);
}

// Habit retains its existing unqualified fingerprint for API compatibility.
// New tokens include canonical module identity so they cannot cross modules/Vaults.
export function moduleEtag(module: NewModuleName, id: string, fingerprint: string) {
  return `${module}:${id}:${fingerprint}`;
}
export function assertModuleEtag(actual: string, expected: string) {
  if (actual !== expected)
    throw new AppError('REVISION_CONFLICT', 'This module changed. Refresh before saving.', 409);
}
export function agendaEtag(
  date: string,
  versions: Record<ModuleName, string>,
  projectorVersion: number,
) {
  return `agenda:${sha(canonical({ date, versions, projectorVersion }))}`;
}
