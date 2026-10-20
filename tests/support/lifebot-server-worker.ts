// Test-only process restart fixture. Receives an already-created synthetic harness root.
import path from 'node:path';
import { Vault } from '../../app/server/storage/markdown/vault.js';
import { Index } from '../../app/server/index/sqlite/index.js';
import { TrackerService } from '../../app/server/services/tracker.js';
import { createApp } from '../../app/server/api.js';
import { moduleRegistry } from '../../app/server/modules.js';
import { createModuleServices } from '../../app/server/module-runtime.js';
import { scratchPrincipal } from '../../app/server/machine-auth.js';
const root = process.env.SYNTHETIC_ROOT!;
if (!path.basename(root).startsWith('habit-test-')) throw new Error('Synthetic fixture required');
const clock = () => '2026-09-21T00:00:00Z';
const service = new TrackerService(
  new Vault(path.join(root, 'vault/Life/HabitTracker')),
  new Index(path.join(root, 'state/index.sqlite')),
  clock,
);
await service.initialize();
const modules = createModuleServices(
  moduleRegistry(path.join(root, 'vault'), path.join(root, 'state'), 'Life/HabitTracker'),
);
for (const module of Object.values(modules)) module.clock = clock;
const origin = process.env.SYNTHETIC_ORIGIN!;
const app = await createApp(service, { modules, origin, machine: scratchPrincipal(process.env) });
await app.listen({ host: '127.0.0.1', port: Number(new URL(origin).port) });
console.log('ready');
process.once('SIGTERM', () => {
  void app.close().then(() => process.exit(0));
});
