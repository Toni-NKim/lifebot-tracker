import { configuration } from './config.js';
import { Vault } from './storage/markdown/vault.js';
import { Index } from './index/sqlite/index.js';
import { TrackerService } from './services/tracker.js';
import { createApp } from './api.js';
const config = configuration();
const service = new TrackerService(new Vault(config.root), new Index(config.database));
await service.initialize();
const app = await createApp(service, { ...config, logger: true });
await app.listen({ host: config.host, port: config.port });
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
