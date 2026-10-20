// Operator-only allocation: never register this CLI as an agent shell tool in production.
import { CommandJournal } from '../app/integrations/lifebot/journal.js';
import { prepareCommand } from '../app/integrations/lifebot/prepare.js';
import { writeConfiguration } from '../app/integrations/lifebot/write-config.js';
import { TrackerHttpClient } from '../app/integrations/lifebot/http-client.js';
import { writeNames, type WriteName } from '../app/integrations/lifebot/contracts/writes.js';

try {
  const action = process.argv[2];
  if (action === 'init') console.log(CommandJournal.create().directory);
  else {
    const config = writeConfiguration(process.env);
    if (action === 'list') console.log(JSON.stringify(config.journal.list(), null, 2));
    else if (
      action === 'allocate' &&
      writeNames.includes(process.argv[3] as WriteName) &&
      process.argv[4] === '--approved'
    ) {
      let input = '';
      for await (const chunk of process.stdin) {
        input += chunk;
        if (input.length > 256 * 1024) throw new Error('Input too large');
      }
      const command = await prepareCommand(
        process.argv[3] as WriteName,
        JSON.parse(input),
        new TrackerHttpClient(config.origin, fetch, config.credential),
        config.journal,
        config.origin,
      );
      console.log(
        JSON.stringify({
          schema_version: '1',
          command_id: command.command_id,
          operation: command.operation,
          status: 'prepared',
        }),
      );
    } else throw new Error('Usage');
  }
} catch {
  console.error(
    'Command allocation unavailable. Check explicit scratch configuration, approved intent and original observed versions. Use list to recover existing command IDs before allocating again.',
  );
  process.exitCode = 1;
}
