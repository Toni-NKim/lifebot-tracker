import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { configuration } from '../app/server/config.js';
import { Vault } from '../app/server/storage/markdown/vault.js';
import { todayAt } from '../app/shared/domain/index.js';
const config = configuration();
const now = Temporal.Now.instant().toString();
new Vault(config.root).initialize({
  schema_version: 1,
  kind: 'tracker',
  id: randomUUID(),
  created_at: now,
  tracking_started_on: todayAt(now, 'Asia/Seoul'),
  timezone: 'Asia/Seoul',
  week_starts_on: 'monday',
});
console.log(`Initialized ${config.root}. No sample Habits were added.`);
