import type { ModuleRegistry, NewModuleName } from './modules.js';
import { ModuleVault } from './storage/markdown/module-vault.js';
import { ModuleIndex } from './index/sqlite/module-index.js';
import { ModuleService } from './services/module.js';
import { todoContract } from '../shared/contracts/todo.js';

export type ModuleServices = Record<NewModuleName, ModuleService>;
export function createModuleServices(paths: ModuleRegistry): ModuleServices {
  const make = (name: NewModuleName) =>
    new ModuleService(
      new ModuleVault(paths[name].root, name === 'todo' ? todoContract : { name, records: {} }),
      new ModuleIndex(paths[name]),
    );
  // Construction never initializes canonical roots or establishes trust.
  return { todo: make('todo'), timebox: make('timebox') };
}
