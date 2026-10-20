import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { harness, execution } from '../../helpers.js';
import { createApp } from '../../../app/server/api.js';
import { moduleRegistry } from '../../../app/server/modules.js';
import { createModuleServices } from '../../../app/server/module-runtime.js';
import { TodoService, newTodo } from '../../../app/server/services/todo.js';
import { machineOperations } from '../../../app/server/machine-auth.js';
import {
  TrackerHttpClient,
  TrackerWriteClient,
} from '../../../app/integrations/lifebot/http-client.js';
import { CommandJournal } from '../../../app/integrations/lifebot/journal.js';
import { prepareCommand } from '../../../app/integrations/lifebot/prepare.js';
import { WriteTools } from '../../../app/integrations/lifebot/tools/write-tools.js';
import { writeConfiguration } from '../../../app/integrations/lifebot/write-config.js';
import {
  resultSchema,
  type WriteName,
} from '../../../app/integrations/lifebot/contracts/writes.js';
import { envelope, todos } from '../../../app/integrations/lifebot/contracts/upstream.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function setup() {
  const h = await harness();
  const modules = createModuleServices(
    moduleRegistry(path.join(h.root, 'vault'), path.join(h.root, 'state'), 'Life/HabitTracker'),
  );
  for (const m of Object.values(modules)) {
    m.clock = h.service.clock;
    await m.initializeModule(h.vault.load().tracker);
  }
  const habit = await h.create();
  const todo = new TodoService(modules.todo);
  const token = randomBytes(32).toString('hex');
  const port = 20000 + Math.floor(Math.random() * 30000);
  const origin = `http://127.0.0.1:${port}`;
  const machine = { token, scopes: ['read' as const, ...machineOperations] };
  const app = await createApp(h.service, { modules, origin, machine });
  await app.listen({ host: '127.0.0.1', port });
  const journal = CommandJournal.create();
  const reader = new TrackerHttpClient(origin, fetch, token);
  const writer = new TrackerWriteClient(origin, token);
  const writes = new WriteTools(journal, writer);
  cleanup.push(async () => {
    await app.close();
    h.cleanup();
    fs.rmSync(journal.directory, { recursive: true, force: true });
  });
  const prepare = (op: WriteName, args: unknown) =>
    prepareCommand(op, args, reader, journal, origin);
  const capture = async (title = 'Same title') =>
    prepare('capture_inbox', { title, expected_versions: { todo: (await todo.read()).etag } });
  return {
    h,
    modules,
    habit,
    todo,
    token,
    machine,
    app,
    origin,
    journal,
    reader,
    writer,
    writes,
    prepare,
    capture,
  };
}

it('durably freezes two intentionally identical captures as distinct commands and replays exactly once across adapter/Tracker restart', async () => {
  const t = await setup();
  const first = await t.capture();
  const before = fs.readFileSync(
    path.join(t.journal.directory, `${first.command_id}.request.json`),
    'utf8',
  );
  expect(await t.writes.call('capture_inbox', { command_id: first.command_id })).toMatchObject({
    outcome: 'committed',
    entities: [{ kind: 'inbox_item' }],
  });
  const second = await t.capture();
  expect(second.command_id).not.toBe(first.command_id);
  expect(await t.writes.call('capture_inbox', { command_id: second.command_id })).toMatchObject({
    outcome: 'committed',
  });
  const restarted = new WriteTools(new CommandJournal(t.journal.directory), t.writer);
  expect(await restarted.call('capture_inbox', { command_id: first.command_id })).toMatchObject({
    outcome: 'committed',
  });
  // Force a server receipt replay, independently of local terminal caching.
  await t.app.close();
  const child = spawn(
    process.execPath,
    [
      path.resolve('node_modules/tsx/dist/cli.mjs'),
      path.resolve('tests/support/lifebot-server-worker.ts'),
    ],
    {
      env: {
        PATH: process.env.PATH,
        SYNTHETIC_ROOT: t.h.root,
        SYNTHETIC_ORIGIN: t.origin,
        LIFEBOT_MACHINE_TOKEN: t.token,
        LIFEBOT_MACHINE_SCOPES: ['read', ...machineOperations].join(','),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  cleanup.push(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('exit', () => reject(new Error('Synthetic Tracker failed to start')));
  });
  const replay = await t.writer.send(first);
  // A stale pooled TCP socket may fail on server restart. Explicitly retry the same frozen ID.
  expect(replay.outcome === 'unknown' ? await t.writer.send(first) : replay).toMatchObject({
    outcome: 'committed',
  });
  expect((await t.todo.read()).data.inbox).toHaveLength(2);
  expect(
    fs.readFileSync(path.join(t.journal.directory, `${first.command_id}.request.json`), 'utf8'),
  ).toBe(before);
  expect(before).not.toContain(t.token);
  const modified = structuredClone(first);
  modified.arguments.title = 'Different';
  modified.request.body = JSON.stringify({ title: 'Different' });
  expect(await t.writer.send(modified)).toMatchObject({
    outcome: 'rejected',
    error: { code: 'IDEMPOTENCY_CONFLICT', retry: 'requires_user_review' },
  });
});

it('stops stale Todo/Habit and wrong-module versions without silently rebasing, including browser competition', async () => {
  const t = await setup();
  const command = await t.capture();
  const browser = await fetch(`${t.origin}/api/v1/todo/inbox`, {
    method: 'POST',
    headers: {
      Origin: t.origin,
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
      'If-Match': command.request.if_match,
    },
    body: JSON.stringify({ title: 'Browser update' }),
  });
  expect(browser.status).toBe(200);
  const result = await t.writes.call('capture_inbox', { command_id: command.command_id });
  expect(result).toMatchObject({
    outcome: 'rejected',
    error: {
      code: 'REVISION_CONFLICT',
      retry: 'requires_user_review',
      expected_versions: command.expected_versions,
    },
  });
  expect(await t.writes.call('capture_inbox', { command_id: command.command_id })).toEqual(result);
  await expect(
    t.prepare('capture_inbox', { title: 'Wrong', expected_versions: { todo: t.h.etag() } }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  const habit = await t.prepare('start_habit', {
    habit_id: t.habit.id,
    date: '2026-09-21',
    expected_versions: { habit: t.h.etag() },
  });
  await t.h.service.execute('2026-09-21', t.habit.id, execution(), randomUUID(), t.h.etag());
  expect(await t.writes.call('start_habit', { command_id: habit.command_id })).toMatchObject({
    outcome: 'rejected',
    error: { code: 'REVISION_CONFLICT' },
  });
  // Bypass observation only to exercise Tracker's wrong-module protection.
  const wrong = await t.capture();
  wrong.expected_versions.todo = t.h.etag();
  wrong.arguments.expected_versions = wrong.expected_versions;
  wrong.request.if_match = t.h.etag();
  wrong.request.headers['If-Match'] = t.h.etag();
  expect(await t.writer.send(wrong)).toMatchObject({ outcome: 'rejected' });
});

it('keeps timeout-before/after-dispatch and reset unknown and retries the immutable request after lost commit response', async () => {
  const t = await setup();
  const command = await t.capture();
  const requests: RequestInit[] = [];
  const dropped = new TrackerWriteClient(t.origin, t.token, async (url, init) => {
    requests.push(init!);
    await fetch(url, init);
    throw new Error('response lost /private/secret');
  });
  const first = await new WriteTools(t.journal, dropped).call('capture_inbox', {
    command_id: command.command_id,
  });
  expect(first).toMatchObject({ outcome: 'unknown', command_id: command.command_id });
  expect((await t.todo.read()).data.inbox).toHaveLength(1);
  expect(t.journal.list()[0].status).toBe('unknown');
  const restarted = new WriteTools(
    new CommandJournal(t.journal.directory),
    new TrackerWriteClient(t.origin, t.token, async (url, init) => {
      requests.push(init!);
      return fetch(url, init);
    }),
  );
  expect(await restarted.call('capture_inbox', { command_id: command.command_id })).toMatchObject({
    outcome: 'committed',
  });
  expect(requests[1]).toMatchObject({
    method: requests[0].method,
    body: requests[0].body,
    headers: requests[0].headers,
  });
  expect((await t.todo.read()).data.inbox).toHaveLength(1);
  for (const error of [new DOMException('timeout', 'TimeoutError'), new Error('ECONNRESET')]) {
    const c = await t.capture();
    const failed = new WriteTools(
      t.journal,
      new TrackerWriteClient(t.origin, t.token, async () => {
        throw error;
      }),
    );
    expect(await failed.call('capture_inbox', { command_id: c.command_id })).toMatchObject({
      outcome: 'unknown',
      command_id: c.command_id,
    });
  }
  expect(t.journal.list()).toHaveLength(3);
  expect(JSON.stringify(first)).not.toMatch(/private|secret/);
});

it('does not infer commit from HTTP status or internal errors, and a failed refresh cannot erase a saved acknowledgement', async () => {
  const t = await setup();
  const c = await t.capture();
  for (const [status, body] of [
    [200, {}],
    [500, { error: { code: 'INTERNAL_ERROR', message: '/secret' } }],
    [409, { error: { code: 'EXTERNAL_CHANGE' } }],
  ] as const) {
    const w = new TrackerWriteClient(
      t.origin,
      t.token,
      async () => new Response(JSON.stringify(body), { status }),
    );
    expect(await w.send(c)).toMatchObject({ outcome: 'unknown' });
  }
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (init?.method === 'GET') throw new Error('refresh failed');
    return fetch(url, init);
  });
  expect(await new TrackerWriteClient(t.origin, t.token, fetcher).send(c)).toMatchObject({
    outcome: 'committed',
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('creates only nonrecurring Todos and uses Tracker occurrence identities through start, completion, Undo and rescheduling', async () => {
  const t = await setup();
  const initialTimebox = t.modules.timebox.vault.fingerprint();
  const command = await t.prepare('create_todo', {
    title: 'Todo',
    do_date: '2026-09-21',
    due_at: '2026-09-23T03:00:00Z',
    expected_versions: { todo: (await t.todo.read()).etag },
  });
  expect(await t.writes.call('create_todo', { command_id: command.command_id })).toMatchObject({
    outcome: 'committed',
    entities: [{ kind: 'todo' }],
  });
  for (const bad of [
    { importance: 'critical' },
    { recurrence: { type: 'daily' } },
    { project_id: randomUUID() },
    { do_date: '2026-02-30' },
  ])
    await expect(
      t.prepare('create_todo', {
        title: 'No',
        expected_versions: { todo: (await t.todo.read()).etag },
        ...bad,
      }),
    ).rejects.toThrow();
  const {
    recurrence_effective_on,
    recurrence_anchor,
    active,
    deleted,
    discarded_at,
    ...recurring
  } = newTodo('Recurring', '2026-09-21', { recurrence: { type: 'daily' }, do_date: '2026-09-21' });
  await t.todo.create(recurring, randomUUID(), (await t.todo.read()).etag);
  for (const item of (await t.todo.read()).data.items) {
    const target = {
      todo_id: item.data.todo_id,
      occurrence_id: item.id,
      anchor_date: item.data.anchor_date,
    };
    await t.todo.reschedule(
      target.todo_id,
      target.anchor_date,
      '2026-09-22',
      null,
      randomUUID(),
      (await t.todo.read()).etag,
    );
    for (const op of ['start_todo', 'complete_todo', 'undo_todo'] as const) {
      const c = await t.prepare(op, {
        target,
        expected_versions: { todo: (await t.todo.read()).etag },
      });
      expect(await t.writes.call(op, { command_id: c.command_id })).toMatchObject({
        outcome: 'committed',
      });
      const after = (await t.todo.read()).data.items.find((x) => x.id === target.occurrence_id)!;
      expect(after.id).toBe(target.occurrence_id);
    }
    await expect(
      t.prepare('start_todo', {
        target: { ...target, occurrence_id: randomUUID() },
        expected_versions: { todo: (await t.todo.read()).etag },
      }),
    ).rejects.toThrow();
  }
  expect(t.modules.timebox.vault.fingerprint()).toBe(initialTimebox);
});

it('starts Habits without completion, preserves omitted details, clears explicit null, undoes, and locks past days at Seoul midnight', async () => {
  const t = await setup();
  const prepare = (op: WriteName, extra = {}) =>
    t.prepare(op, {
      habit_id: t.habit.id,
      date: '2026-09-21',
      expected_versions: { habit: t.h.etag() },
      ...extra,
    });
  const start = await prepare('start_habit');
  const started = await t.writes.call('start_habit', { command_id: start.command_id });
  expect(started).toMatchObject({ outcome: 'committed', entities: [{ kind: 'habit_execution' }] });
  expect((await t.h.service.today()).data.items[0].execution).toMatchObject({
    status: 'incomplete',
    actual_start: '2026-09-21T00:00:00Z',
    completed_at: null,
  });
  for (const details of [
    { energy_note: 'Keep', actual_amount: '2' },
    {},
    { actual_amount: null },
  ]) {
    const c = await prepare('complete_habit', details);
    expect(await t.writes.call('complete_habit', { command_id: c.command_id })).toMatchObject({
      outcome: 'committed',
    });
    expect((await t.h.service.today()).data.items[0].execution).toMatchObject({
      energy_note: 'Keep',
    });
  }
  expect((await t.h.service.today()).data.items[0].execution?.actual_amount).toBeNull();
  const undo = await prepare('undo_habit');
  expect(await t.writes.call('undo_habit', { command_id: undo.command_id })).toMatchObject({
    outcome: 'committed',
  });
  expect((await t.h.service.today()).data.items[0].execution).toMatchObject({
    status: 'incomplete',
    energy_note: null,
    actual_start: null,
  });
  const midnight = await prepare('complete_habit');
  t.h.setNow('2026-09-21T15:00:00Z');
  expect(await t.writes.call('complete_habit', { command_id: midnight.command_id })).toMatchObject({
    outcome: 'rejected',
    error: { code: 'DAY_LOCKED' },
  });
  await expect(prepare('complete_habit')).rejects.toMatchObject({ code: 'DAY_LOCKED' });
  expect(await t.writer.send(start)).toMatchObject({
    outcome: 'committed',
    entities: [{ kind: 'habit_execution', habit_id: t.habit.id, date: '2026-09-21' }],
  });
});

it('rejects tampered requests, payload substitutions, arbitrary IDs/paths and unsafe journal configuration before HTTP', async () => {
  const t = await setup();
  const c = await t.capture();
  const fetcher = vi.fn<typeof fetch>();
  const client = new TrackerWriteClient(t.origin, t.token, fetcher);
  expect(
    await client.send({ ...c, request: { ...c.request, path: '/api/v1/system/rebuild' } }),
  ).toMatchObject({ outcome: 'rejected' });
  expect(fetcher).not.toHaveBeenCalled();
  expect(await t.writes.call('create_todo', { command_id: c.command_id })).toMatchObject({
    outcome: 'rejected',
  });
  expect(
    await t.writes.call('capture_inbox', { command_id: c.command_id, title: 'changed' }),
  ).toMatchObject({ outcome: 'rejected' });
  expect(await t.writes.call('capture_inbox', { command_id: randomUUID() })).toMatchObject({
    outcome: 'rejected',
  });
  expect(() => new CommandJournal(t.h.root)).toThrow();
  expect(() =>
    writeConfiguration({ LIFEBOT_TRACKER_URL: t.origin, LIFEBOT_SCRATCH_ONLY: 'true' }),
  ).toThrow();
  const link = path.join(t.journal.directory, `${randomUUID()}.request.json`);
  fs.symlinkSync(path.join(t.journal.directory, `${c.command_id}.request.json`), link);
  expect(() => t.journal.load(path.basename(link).slice(0, 36))).toThrow();
});

it('exposes eight approved write operations over real SDK stdio only when explicitly enabled and resumes the same ID after process restart', async () => {
  const t = await setup();
  const c = await t.capture();
  for (let attempt = 0; attempt < 2; attempt++) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        path.resolve('node_modules/tsx/dist/cli.mjs'),
        path.resolve('app/integrations/lifebot/mcp/main.ts'),
      ],
      env: {
        PATH: process.env.PATH ?? '',
        LIFEBOT_SCRATCH_ONLY: 'true',
        LIFEBOT_TRACKER_URL: t.origin,
        LIFEBOT_ENABLE_WRITES: 'scratch',
        LIFEBOT_MACHINE_TOKEN: t.token,
        LIFEBOT_COMMAND_JOURNAL: t.journal.directory,
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'scratch-write-acceptance', version: '1' });
    let stderr = '';
    transport.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toHaveLength(16);
      const response = await client.callTool({
        name: 'capture_inbox',
        arguments: { command_id: c.command_id },
      });
      expect(resultSchema.parse(response.structuredContent)).toMatchObject({
        outcome: 'committed',
        command_id: c.command_id,
      });
      expect(stderr).toBe('');
      expect(JSON.stringify(response)).not.toContain(t.token);
    } finally {
      await client.close();
    }
  }
  expect((await t.todo.read()).data.inbox).toHaveLength(1);
  expect((await t.reader.get('/todo', envelope(todos))).data.inbox).toHaveLength(1);
});

it('handles concurrent exact delivery and never dispatches when durable bookkeeping fails', async () => {
  const t = await setup();
  const command = await t.capture();
  const deliveries = await Promise.all([
    t.writes.call('capture_inbox', { command_id: command.command_id }),
    new WriteTools(new CommandJournal(t.journal.directory), t.writer).call('capture_inbox', {
      command_id: command.command_id,
    }),
  ]);
  expect(deliveries.map((r) => r.outcome)).toEqual(['committed', 'committed']);
  expect((await t.todo.read()).data.inbox).toHaveLength(1);
  const next = await t.capture();
  const send = vi.spyOn(t.writer, 'send');
  vi.spyOn(t.journal, 'attempt').mockImplementation(() => {
    throw new Error('disk full');
  });
  expect(await t.writes.call('capture_inbox', { command_id: next.command_id })).toMatchObject({
    outcome: 'unknown',
    error: { code: 'JOURNAL_UNAVAILABLE' },
  });
  expect(send).not.toHaveBeenCalled();
});

it('denies a real read-only machine write and returns a confirmed commit even if result bookkeeping fails', async () => {
  const t = await setup();
  const command = await t.capture();
  t.machine.scopes = ['read'];
  expect(await t.writer.send(command)).toMatchObject({
    outcome: 'rejected',
    error: { category: 'authorization' },
  });
  expect((await t.todo.read()).data.inbox).toHaveLength(0);
  t.machine.scopes.push('capture_inbox');
  vi.spyOn(t.journal, 'record').mockImplementation(() => {
    throw new Error('disk full');
  });
  expect(await t.writes.call('capture_inbox', { command_id: command.command_id })).toMatchObject({
    outcome: 'committed',
  });
  expect(new CommandJournal(t.journal.directory).list()[0].status).toBe('unknown');
  expect(
    await new WriteTools(new CommandJournal(t.journal.directory), t.writer).call('capture_inbox', {
      command_id: command.command_id,
    }),
  ).toMatchObject({ outcome: 'committed' });
  expect((await t.todo.read()).data.inbox).toHaveLength(1);
});

it('accepts the documented synthetic launcher → approved CLI allocation → HTTP write workflow without repository credentials', async () => {
  const token = randomBytes(32).toString('hex');
  const port = 20000 + Math.floor(Math.random() * 30000);
  const origin = `http://127.0.0.1:${port}`;
  const journal = CommandJournal.create();
  const env = {
    PATH: process.env.PATH,
    LIFEBOT_SCRATCH_PORT: String(port),
    LIFEBOT_MACHINE_TOKEN: token,
    LIFEBOT_MACHINE_SCOPES: 'read,capture_inbox',
    LIFEBOT_TRACKER_URL: origin,
    LIFEBOT_SCRATCH_ONLY: 'true',
    LIFEBOT_ENABLE_WRITES: 'scratch',
    LIFEBOT_COMMAND_JOURNAL: journal.directory,
  };
  const launcher = spawn(
    process.execPath,
    [path.resolve('node_modules/tsx/dist/cli.mjs'), path.resolve('scripts/lifebot-scratch.ts')],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  cleanup.push(async () => {
    if (launcher.exitCode === null) {
      launcher.kill('SIGTERM');
      await once(launcher, 'exit');
    }
    fs.rmSync(journal.directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    launcher.stdout.once('data', (chunk) => {
      expect(String(chunk)).not.toContain(token);
      resolve();
    });
    launcher.once('exit', () => reject(new Error('Synthetic launcher failed')));
  });
  const observed = await new TrackerHttpClient(origin, fetch, token).get('/todo', envelope(todos));
  const allocator = spawn(
    process.execPath,
    [
      path.resolve('node_modules/tsx/dist/cli.mjs'),
      path.resolve('scripts/lifebot-command.ts'),
      'allocate',
      'capture_inbox',
      '--approved',
    ],
    { env, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  allocator.stdout.on('data', (c) => {
    stdout += c;
  });
  allocator.stderr.on('data', (c) => {
    stderr += c;
  });
  allocator.stdin.end(
    JSON.stringify({ title: 'CLI approved capture', expected_versions: { todo: observed.etag } }),
  );
  expect((await once(allocator, 'exit'))[0]).toBe(0);
  expect(stderr).toBe('');
  expect(stdout).not.toContain(token);
  const allocated = JSON.parse(stdout);
  expect(
    await new WriteTools(journal, new TrackerWriteClient(origin, token)).call('capture_inbox', {
      command_id: allocated.command_id,
    }),
  ).toMatchObject({ outcome: 'committed' });
  const saved = await new TrackerHttpClient(origin, fetch, token).get('/todo', envelope(todos));
  expect(saved.data.inbox).toHaveLength(observed.data.inbox.length + 1);
});
