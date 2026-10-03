import { configuration } from '../app/server/config.js';
import { createModuleServices } from '../app/server/module-runtime.js';
import { TrackerService } from '../app/server/services/tracker.js';
import { Vault } from '../app/server/storage/markdown/vault.js';
import { Index } from '../app/server/index/sqlite/index.js';

const [operation, name] = process.argv.slice(2);
if (
  !['initialize', 'validate', 'rebuild', 'status'].includes(operation) ||
  !['todo', 'timebox'].includes(name)
)
  throw new Error(
    'Usage: npm run module:maintain -- <initialize|validate|rebuild|status> <todo|timebox>',
  );
const config = configuration();
const module = createModuleServices(config.modules)[name as 'todo' | 'timebox'];
const habit = new TrackerService(new Vault(config.root), new Index(config.database));
const result =
  operation === 'initialize'
    ? await module.initializeModule((await habit.read((s) => s.tracker)).data)
    : operation === 'validate'
      ? await module.validateVault()
      : operation === 'rebuild'
        ? await module.rebuild()
        : await module.status();
console.log(JSON.stringify(result, null, 2));
