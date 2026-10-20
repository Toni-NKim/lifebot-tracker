import { scratchPrincipal } from '../app/server/machine-auth.js';
// Explicit operator-owned scratch deployment, separate from the read-only adapter.
// No .env or configured personal Vault is read. All data is created in a temp directory.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { harness } from '../tests/helpers.js';
import { moduleRegistry } from '../app/server/modules.js';
import { createModuleServices } from '../app/server/module-runtime.js';
import { createApp } from '../app/server/api.js';
import { TodoService, newTodo } from '../app/server/services/todo.js';

const port = Number(process.env.LIFEBOT_SCRATCH_PORT ?? 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid scratch port');
const now = Temporal.Now.instant().toString();
const day = Temporal.Instant.from(now).toZonedDateTimeISO('Asia/Seoul').toPlainDate().toString();
const t = await harness(day);
t.setNow(now);
const modules = createModuleServices(
  moduleRegistry(path.join(t.root, 'vault'), path.join(t.root, 'state'), 'Life/HabitTracker'),
);
let app: Awaited<ReturnType<typeof createApp>> | undefined;
try {
  await t.create();
  for (const m of Object.values(modules)) {
    m.clock = t.service.clock;
    await m.initializeModule(t.vault.load().tracker);
  }
  const todo = new TodoService(modules.todo);
  await todo.capture('Scratch Inbox example', randomUUID(), (await todo.read()).etag);
  const { recurrence_effective_on, recurrence_anchor, active, deleted, discarded_at, ...fields } =
    newTodo('Try the Lifebot read tools', day, { do_date: day });
  await todo.create(fields, randomUUID(), (await todo.read()).etag);
  app = await createApp(t.service, { modules, machine: scratchPrincipal(process.env), origin: `http://127.0.0.1:${port}`, webRoot: path.join(t.root, 'no-web-build') });
  await app.listen({ host: '127.0.0.1', port });
  console.log(
    `Scratch Tracker: http://127.0.0.1:${port}; fixed calendar clock: ${now}. Stop with Ctrl-C to remove synthetic data.`,
  );
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void app!.close().then(() => {
        t.cleanup();
        process.exit(0);
      });
    });
} catch (e) {
  await app?.close();
  t.cleanup();
  throw e;
}
