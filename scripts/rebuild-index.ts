import { Temporal } from '@js-temporal/polyfill';
import { configuration } from '../app/server/config.js';
import { Vault } from '../app/server/storage/markdown/vault.js';
import { Index } from '../app/server/index/sqlite/index.js';
import { AcceptedSource } from '../app/server/storage/accepted-source.js';
import { CommitIntent } from '../app/server/storage/commit-intent.js';
const config = configuration();
const v = new Vault(config.root);
const at = process.argv[2] ?? Temporal.Now.instant().toString();
Temporal.Instant.from(at);
await v.locked(() => {
  const s = v.load();
  const p = new Index(config.database).rebuild(v, s, at);
  // An explicit rebuild accepts the current source, also for an already running server.
  AcceptedSource.beside(config.database).write(s.fingerprint);
  CommitIntent.beside(config.database).clear();
  console.log(
    JSON.stringify(
      {
        rebuilt: true,
        cutoff: p.cutoff,
        occurrences: p.occurrences.length,
        quota_periods: p.periods.length,
        warnings: s.warnings,
      },
      null,
      2,
    ),
  );
});
