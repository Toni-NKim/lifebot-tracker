import { scratchConnection } from './http-client.js';
import { CommandJournal } from './journal.js';
export function writeConfiguration(env: Record<string, string | undefined>) {
  const origin = scratchConnection(env);
  if (
    env.LIFEBOT_ENABLE_WRITES !== 'scratch' ||
    !/^[a-f0-9]{64}$/.test(env.LIFEBOT_MACHINE_TOKEN ?? '') ||
    !env.LIFEBOT_COMMAND_JOURNAL
  )
    throw new Error('Explicit scratch write configuration required');
  return {
    origin,
    credential: env.LIFEBOT_MACHINE_TOKEN!,
    journal: new CommandJournal(env.LIFEBOT_COMMAND_JOURNAL),
  };
}
