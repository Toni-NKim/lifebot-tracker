// Spawned only with the synthetic test root; never loads .env or a personal Vault.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import { moduleRegistry } from '../../app/server/modules.js';
import { ModuleVault } from '../../app/server/storage/markdown/module-vault.js';
import { ModuleService } from '../../app/server/services/module.js';
import { ModuleIndex } from '../../app/server/index/sqlite/module-index.js';

const [root, point] = process.argv.slice(2);
const paths = moduleRegistry(
  path.join(root, 'vault'),
  path.join(root, 'state'),
  'Life/HabitTracker',
);
const service = new ModuleService(
  new ModuleVault(paths.todo.root, {
    name: 'todo',
    records: {
      entry: {
        directory: 'Entries',
        version: 1,
        schema: Type.Object({ title: Type.String() }, { additionalProperties: false }),
      },
    },
  }),
  new ModuleIndex(paths.todo),
  () => '2026-10-01T01:00:00Z',
);
const etag = (await service.read()).etag;
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  rename(from, to);
  if (String(to).includes(point === 'revision' ? '/Entries/' : '/Commits/'))
    process.kill(process.pid, 'SIGKILL');
};
await service.mutate({ id: randomUUID(), etag, request: { type: 'crash-probe' } }, () => [
  { kind: 'entry', id: randomUUID(), data: { title: 'first' } },
  { kind: 'entry', id: randomUUID(), data: { title: 'second' } },
]);
throw new Error('Crash point was not reached');
