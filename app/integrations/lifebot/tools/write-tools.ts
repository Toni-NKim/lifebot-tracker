import {
  commandInput,
  validateFrozen,
  type WriteName,
  type WriteResult,
} from '../contracts/writes.js';
import { CommandJournal } from '../journal.js';
import { TrackerWriteClient, writeFailure } from '../http-client.js';

export class WriteTools {
  constructor(
    private journal: CommandJournal,
    private client: TrackerWriteClient,
  ) {}
  async call(operation: WriteName, input: unknown): Promise<WriteResult> {
    let command;
    try {
      const { command_id } = commandInput.parse(input);
      command = this.journal.load(command_id);
      validateFrozen(command);
      if (command.operation !== operation || command.origin !== this.client.origin)
        throw new Error();
    } catch {
      return writeFailure(command, 'COMMAND_BINDING_ERROR', 'rejected', 'validation');
    }
    try {
      const terminal = this.journal.terminal(command.command_id);
      if (terminal) return terminal;
      // Durable dispatch marker precedes network activity. A crash is always treated as uncertain.
      this.journal.attempt(command.command_id);
    } catch {
      return writeFailure(command, 'JOURNAL_UNAVAILABLE', 'unknown', 'unavailable');
    }
    const result = await this.client.send(command);
    try {
      this.journal.record(result);
    } catch {
      // In particular, do not turn a known committed response into a failed write.
    }
    return result;
  }
}
