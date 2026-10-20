// Transport bookkeeping only. This module can access only its separately created scratch journal.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { id } from './contracts/primitives.js';
import {
  frozenSchema,
  resultSchema,
  type FrozenCommand,
  type WriteResult,
} from './contracts/writes.js';

// Use the platform's stable temp root, independent of the MCP client's filtered TMPDIR.
const journalRoot = () => fs.realpathSync(process.platform === 'win32' ? os.tmpdir() : '/tmp');
function syncDirectory(directory: string) {
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export class CommandJournal {
  readonly directory: string;
  static create() {
    const directory = fs.mkdtempSync(path.join(journalRoot(), 'lifebot-commands-'));
    fs.chmodSync(directory, 0o700);
    syncDirectory(path.dirname(directory));
    return new CommandJournal(directory);
  }
  constructor(directory: string) {
    const resolved = path.resolve(directory);
    const stat = fs.lstatSync(resolved);
    // Phase 2A permits only a dedicated, private, direct child of the OS temp root.
    // Neither repository, synthetic Vault nor Tracker state can be used as a journal.
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      fs.realpathSync(resolved) !== resolved ||
      path.dirname(resolved) !== journalRoot() ||
      !/^lifebot-commands-[A-Za-z0-9]+$/.test(path.basename(resolved)) ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error('Invalid private scratch command journal');
    this.directory = resolved;
  }
  private write(name: string, value: unknown) {
    const temp = path.join(this.directory, `.${randomUUID()}.tmp`);
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      // Link publishes an already synced complete file without replacing an existing entry.
      fs.linkSync(temp, path.join(this.directory, name));
      syncDirectory(this.directory);
    } finally {
      fs.unlinkSync(temp);
    }
  }
  private read(name: string): unknown {
    const fd = fs.openSync(
      path.join(this.directory, name),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).size > 1024 * 1024)
        throw new Error('Invalid journal entry');
      return JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally {
      fs.closeSync(fd);
    }
  }
  allocate(
    command: Omit<FrozenCommand, 'command_id' | 'request'> & {
      request: Omit<FrozenCommand['request'], 'headers'>;
    },
  ) {
    const command_id = randomUUID();
    const frozen = frozenSchema.parse({
      ...command,
      command_id,
      request: {
        ...command.request,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'If-Match': command.request.if_match,
          'Idempotency-Key': command_id,
        },
      },
    });
    this.write(`${frozen.command_id}.request.json`, frozen);
    return frozen;
  }
  load(commandId: string) {
    id.parse(commandId);
    const frozen = frozenSchema.parse(this.read(`${commandId}.request.json`));
    if (frozen.command_id !== commandId) throw new Error('Invalid command identity');
    return frozen;
  }
  attempt(commandId: string) {
    id.parse(commandId);
    this.write(`${commandId}.${randomUUID()}.attempt.json`, { command_id: commandId });
  }
  record(result: WriteResult) {
    id.parse(result.command_id);
    this.write(`${result.command_id}.${randomUUID()}.result.json`, resultSchema.parse(result));
  }
  terminal(commandId: string): WriteResult | undefined {
    id.parse(commandId);
    const results = fs
      .readdirSync(this.directory)
      .filter((n) => n.startsWith(commandId + '.') && n.endsWith('.result.json'))
      .map((n) => resultSchema.parse(this.read(n)));
    // A confirmed commit dominates an earlier transport failure from simultaneous delivery.
    return (
      results.find((r) => r.outcome === 'committed') ??
      results.find((r) => r.outcome === 'rejected')
    );
  }
  list() {
    return fs
      .readdirSync(this.directory)
      .filter((n) => n.endsWith('.request.json'))
      .map((n) => {
        const command = this.load(n.slice(0, -'.request.json'.length));
        const terminal = this.terminal(command.command_id);
        const attempted = fs
          .readdirSync(this.directory)
          .some((f) => f.startsWith(command.command_id + '.') && f.endsWith('.attempt.json'));
        return {
          command_id: command.command_id,
          operation: command.operation,
          status: terminal?.outcome ?? (attempted ? 'unknown' : 'prepared'),
        };
      });
  }
}
