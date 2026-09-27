// Synthetic browser-test server. Never reads a user Vault or .env configuration.
import { harness } from '../tests/helpers.js';
import { createApp } from '../app/server/api.js';
const t = await harness('2026-09-27');
const app = await createApp(t.service, { origin: 'http://127.0.0.1:4173', logger: true });
await app.listen({ host: '127.0.0.1', port: 4173 });
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    void app.close().then(() => {
      t.cleanup();
      process.exit(0);
    });
  });
