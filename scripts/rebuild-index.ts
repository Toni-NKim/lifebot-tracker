import { Temporal } from '@js-temporal/polyfill';
import { configuration } from '../app/server/config.js';
import { Vault } from '../app/server/storage/markdown/vault.js';
import { Index } from '../app/server/index/sqlite/index.js';
const config = configuration();
const v = new Vault(config.root);
const at = process.argv[2] ?? Temporal.Now.instant().toString();
Temporal.Instant.from(at);
await v.locked(() => {
  const s = v.load();
  const p = new Index(config.database).rebuild(v, s, at);
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
