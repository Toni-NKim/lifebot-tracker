import { configuration } from '../app/server/config.js';
import { Vault } from '../app/server/storage/markdown/vault.js';
const v = new Vault(configuration().root);
await v.locked(() => {
  const s = v.load();
  console.log(
    JSON.stringify(
      {
        valid: true,
        habits: new Set(s.habits.map((h) => h.id)).size,
        days: s.days.length,
        fingerprint: s.fingerprint,
        warnings: s.warnings,
      },
      null,
      2,
    ),
  );
});
