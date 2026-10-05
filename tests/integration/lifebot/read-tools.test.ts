import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { harness, execution, habitFields } from '../../helpers.js';
import { createApp } from '../../../app/server/api.js';
import { moduleRegistry } from '../../../app/server/modules.js';
import { createModuleServices } from '../../../app/server/module-runtime.js';
import { TodoService } from '../../../app/server/services/todo.js';
import { TimeboxService } from '../../../app/server/services/timebox.js';
import { TrackerHttpClient } from '../../../app/integrations/lifebot/http-client.js';
import { ReadTools } from '../../../app/integrations/lifebot/tools/read-tools.js';
import { outputSchema, toolNames } from '../../../app/integrations/lifebot/contracts/tools.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function setup(initialized = true) {
  const h = await harness();
  const modules = createModuleServices(
    moduleRegistry(path.join(h.root, 'vault'), path.join(h.root, 'state'), 'Life/HabitTracker'),
  );
  for (const m of Object.values(modules)) {
    m.clock = h.service.clock;
    if (initialized) await m.initializeModule(h.vault.load().tracker);
  }
  const habit = await h.create();
  await h.service.execute('2026-09-21', habit.id, execution(), randomUUID(), h.etag());
  const app = await createApp(h.service, { modules });
  const todo = new TodoService(modules.todo);
  const box = new TimeboxService(h.service, modules.todo, modules.timebox);
  const requests: string[] = [];
  app.addHook('onRequest', async (req) => {
    requests.push(`${req.method} ${req.url}`);
  });
  let fields = {
    title: 'Read a book',
    description: 'Read-only fixture',
    workflow_status: 'next' as const,
    importance: 'normal' as const,
    project_id: null as string | null,
    do_date: '2026-09-21',
    due_at: null,
    scheduled_time: null,
    estimated_duration_seconds: 1800,
    recurrence: { type: 'daily' as const },
    color: null,
  };
  if (initialized) {
    const project = await todo.project(
      null,
      { name: 'Reading', description: '', color: null, status: 'active' },
      randomUUID(),
      (await todo.read()).etag,
    );
    fields.project_id = (await todo.read()).data.projects[0].id;
    await todo.create(fields, randomUUID(), (await todo.read()).etag);
    await todo.capture('Buy pencils', randomUUID(), (await todo.read()).etag);
  }
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  cleanup.push(async () => {
    await app.close();
    h.cleanup();
  });
  return {
    h,
    app,
    modules,
    todo,
    box,
    habit,
    origin,
    requests,
    tools: new ReadTools(new TrackerHttpClient(origin)),
  };
}

it('serves all eight tools through real HTTP with semantic, versioned results and no canonical read-side writes', async () => {
  const t = await setup();
  const before = [
    t.h.etag(),
    t.modules.todo.vault.fingerprint(),
    t.modules.timebox.vault.fingerprint(),
  ];
  for (const name of toolNames) {
    const args =
      name === 'get_history'
        ? { domain: 'habit', from: '2026-09-20', to: '2026-09-21' }
        : name === 'get_stats'
          ? { domain: 'habit' }
          : {};
    const result = await t.tools.call(name, args);
    expect(result, name).toMatchObject({
      schema_version: '1',
      status: 'ok',
      date: '2026-09-21',
      timezone: 'Asia/Seoul',
      unavailable_modules: [],
    });
    expect(outputSchema(name).safeParse(result).success).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(
      /request_sha256|command_id|vault_path|commit-intent|accepted-source|data_json/,
    );
  }
  expect(
    await t.tools.call('get_habits', { view: 'definitions', include_pending: true }),
  ).toMatchObject({ status: 'ok' });
  expect(await t.tools.call('get_stats', { domain: 'agenda' })).toMatchObject({
    status: 'ok',
    data: { units: 'seconds_and_counts' },
  });
  const today = await t.tools.call('get_today', {});
  expect(today).toMatchObject({
    versions: (await t.box.read()).data.versions,
    agenda_etag: (await t.box.read()).etag,
    data: { prepared: false, plans: { items: [], total: 0 } },
  });
  expect(t.requests.every((r) => r.startsWith('GET '))).toBe(true);
  expect(t.requests.join(' ')).not.toMatch(/prepare|resume|cancel|rebuild|initialize|validate/);
  expect([
    t.h.etag(),
    t.modules.todo.vault.fingerprint(),
    t.modules.timebox.vault.fingerprint(),
  ]).toEqual(before);
});

it('copies original occurrence identity through rescheduling, execution and Todo history', async () => {
  const t = await setup();
  const item = (await t.todo.read()).data.items[0];
  const target = {
    todo_id: item.data.todo_id,
    occurrence_id: item.id,
    anchor_date: item.data.anchor_date,
  };
  await t.todo.reschedule(
    target.todo_id,
    target.anchor_date,
    '2026-09-23',
    null,
    randomUUID(),
    (await t.todo.read()).etag,
  );
  expect(await t.tools.call('get_todos', {})).toMatchObject({
    data: { todos: { items: [{ execution_target: target, do_date: '2026-09-23' }] } },
  });
  await t.todo.execute(
    target.todo_id,
    target.anchor_date,
    'complete',
    'Finished',
    null,
    randomUUID(),
    (await t.todo.read()).etag,
  );
  expect(
    await t.tools.call('get_history', { domain: 'todo', from: '2026-09-21', to: '2026-09-21' }),
  ).toMatchObject({
    status: 'ok',
    data: { history: { items: [{ execution_target: target, note: 'Finished' }] } },
  });
  expect(await t.tools.call('get_todos', {})).toMatchObject({
    data: { todos: { items: [], total: 0 } },
  });
  expect(await t.tools.call('get_projects', {})).toMatchObject({
    data: { projects: { items: [{ completion_rate: 1, rate_unit: 'fraction' }] } },
  });
  expect(await t.tools.call('get_stats', { domain: 'habit' })).toMatchObject({
    data: { rate_unit: 'percent', date_scheduled: { rate: 100 } },
  });
});

it('returns partial Today when modules are uninitialized, never presenting them as empty', async () => {
  const t = await setup(false);
  const result = await t.tools.call('get_today', {});
  expect(result).toMatchObject({
    status: 'partial',
    date: '2026-09-21',
    timezone: 'Asia/Seoul',
    data: { habits: { total: 1 }, todos: null, plans: null, prepared: null },
  });
  expect(result.unavailable_modules.map((i) => i.module)).toEqual(['agenda', 'todo', 'timebox']);
  expect(await t.tools.call('get_todos', {})).toMatchObject({
    status: 'unavailable',
    data: null,
    unavailable_modules: [{ module: 'todo', code: 'VAULT_UNAVAILABLE' }],
  });
  expect(await t.tools.call('get_agenda', { date: '2026-09-20' })).toMatchObject({
    status: 'unavailable',
    data: null,
  });
});

it('bounds collections at 50 by default and 200 maximum, retaining explicit page totals', async () => {
  const t = await setup();
  // Repeated API entries simulate a large response without creating hundreds of canonical commits.
  const real = await fetch(`${t.origin}/api/v1/todo`).then((r) => r.json());
  const expanded = structuredClone(real);
  for (const key of ['items', 'inbox', 'projects', 'history'])
    if (expanded.data[key].length)
      expanded.data[key] = Array.from({ length: 205 }, () => expanded.data[key][0]);
  const tools = new ReadTools(
    new TrackerHttpClient(t.origin, async () => new Response(JSON.stringify(expanded))),
  );
  for (const name of ['get_todos', 'get_inbox', 'get_projects'] as const) {
    for (const limit of [undefined, 200]) {
      const result = await tools.call(name, limit ? { limit } : {});
      const collection = Object.values(result.data!)[0] as { items: unknown[]; total: number };
      expect(collection.items).toHaveLength(limit ?? 50);
      expect(collection.total).toBe(205);
    }
    expect(await tools.call(name, { limit: 201 })).toMatchObject({
      status: 'error',
      error: { code: 'VALIDATION_ERROR' },
    });
    expect(await tools.call(name, { offset: 200, limit: 50 })).toMatchObject({
      data: { [name.slice(4)]: { items: expect.any(Array), total: 205, offset: 200, limit: 50 } },
    });
  }
});

it('bounds nested agenda and statistics collections as well as outer pages', async () => {
  const t = await setup();
  const raw = await fetch(`${t.origin}/api/v1/agenda`).then((r) => r.json());
  for (const key of ['items'])
    raw.data.habits[key] = Array.from({ length: 205 }, () => raw.data.habits[key][0]);
  raw.data.todo.items = Array.from({ length: 205 }, () => raw.data.todo.items[0]);
  raw.data.todo.inbox = Array.from({ length: 205 }, () => raw.data.todo.inbox[0]);
  raw.data.candidates = Array.from({ length: 205 }, () => raw.data.candidates[0]);
  raw.data.habits.items[0].habit.routine_ids = Array.from({ length: 205 }, () => randomUUID());
  const tools = new ReadTools(
    new TrackerHttpClient(t.origin, async () => new Response(JSON.stringify(raw))),
  );
  const r = await tools.call('get_today', {});
  expect(r.status).toBe('ok');
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      expect(value.length).toBeLessThanOrEqual(50);
      value.forEach(walk);
    } else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(r);
});

it('fails closed for malformed upstream shapes, preserves opaque tokens and strips unknown fields', async () => {
  const t = await setup();
  const raw = await fetch(`${t.origin}/api/v1/todo`).then((r) => r.json());
  raw.etag = 'opaque/version:with-non-hash-content';
  raw.private_path = '/secret';
  const tools = new ReadTools(
    new TrackerHttpClient(t.origin, async () => new Response(JSON.stringify(raw))),
  );
  expect(await tools.call('get_todos', {})).toMatchObject({
    status: 'ok',
    versions: { todo: raw.etag },
  });
  raw.data.items[0].data.anchor_date = 42;
  expect(await tools.call('get_todos', {})).toMatchObject({
    status: 'error',
    data: null,
    error: { code: 'UPSTREAM_CONTRACT_ERROR' },
  });
  const malformed = new ReadTools(new TrackerHttpClient(t.origin, async () => new Response('{}')));
  expect(await malformed.call('get_today', {})).toMatchObject({
    status: 'error',
    data: null,
    error: { code: 'UPSTREAM_CONTRACT_ERROR' },
  });
});

it('reads saved Plans and cross-midnight Actuals without inventing historical Plans', async () => {
  const t = await setup();
  await t.box.place(
    {
      date: '2026-09-21',
      candidate: null,
      title: 'Manual',
      start: '2026-09-21T01:00:00Z',
      end: '2026-09-21T01:30:00Z',
      color: null,
    },
    null,
    (await t.box.read()).data.versions,
    randomUUID(),
  );
  await t.box.manual(
    {
      date: '2026-09-20',
      title: 'Past work',
      actual_start: '2026-09-20T14:59:00Z',
      actual_end: '2026-09-20T15:01:00Z',
      color: null,
      note: 'Actual',
      plan_id: null,
      deleted: false,
    },
    null,
    (await t.box.read()).data.versions.timebox,
    randomUUID(),
  );
  expect(await t.tools.call('get_today', {})).toMatchObject({
    status: 'ok',
    data: { plans: { total: 1 }, actuals: { total: 2 } },
  });
  expect(await t.tools.call('get_agenda', { date: '2026-09-20' })).toMatchObject({
    status: 'ok',
    data: { plans: { total: 0 }, actuals: { total: 1 } },
  });
});

it('keeps a staged action pending while serving its read-only summary', async () => {
  const t = await setup();
  const inbox = (await t.todo.read()).data.inbox[0].id;
  const failure = vi.spyOn(t.modules.timebox, 'mutateLocked').mockImplementationOnce(() => {
    throw new Error('synthetic target failure');
  });
  await t.box.stageInbox(
    inbox,
    {
      date: '2026-09-21',
      candidate: null,
      title: 'Pending',
      start: '2026-09-21T01:00:00Z',
      end: '2026-09-21T01:30:00Z',
      color: null,
    },
    (await t.box.read()).data.versions,
    randomUUID(),
  );
  failure.mockRestore();
  const before = [t.modules.todo.vault.fingerprint(), t.modules.timebox.vault.fingerprint()];
  expect(await t.tools.call('get_today', {})).toMatchObject({
    status: 'ok',
    data: {
      pending_actions: { total: 1, items: [{ state: 'pending', source_changed: false }] },
      plans: { total: 0 },
    },
  });
  expect([t.modules.todo.vault.fingerprint(), t.modules.timebox.vault.fingerprint()]).toEqual(
    before,
  );
});

it('fails every tool closed when its consumed response changes shape', async () => {
  const t = await setup();
  for (const name of toolNames) {
    const endpoint = (
      {
        get_today: '/agenda',
        get_agenda: '/agenda',
        get_habits: '/today',
        get_todos: '/todo',
        get_inbox: '/todo',
        get_projects: '/todo',
        get_history: '/history',
        get_stats: '/statistics',
      } as const
    )[name];
    const tools = new ReadTools(
      new TrackerHttpClient(t.origin, async (url, init) => {
        if (new URL(String(url)).pathname.endsWith(endpoint))
          return new Response(
            JSON.stringify({ etag: 'valid-opaque-token', data: { future_shape: true } }),
          );
        return fetch(url, init);
      }),
    );
    const args =
      name === 'get_history'
        ? { domain: 'habit', from: '2026-09-21', to: '2026-09-21' }
        : name === 'get_stats'
          ? { domain: 'habit' }
          : {};
    expect(await tools.call(name, args), name).toMatchObject({
      status: 'error',
      data: null,
      error: { code: 'UPSTREAM_CONTRACT_ERROR' },
    });
  }
});

it('does not use machine time or silently combine Habit versions across multiple reads', async () => {
  const t = await setup();
  const tools = new ReadTools(
    new TrackerHttpClient(t.origin, async (url, init) => {
      const response = await fetch(url, init);
      const body = await response.json();
      if (new URL(String(url)).pathname.endsWith('/system/status')) body.etag = 'changed';
      return new Response(JSON.stringify(body));
    }),
  );
  expect(await tools.call('get_habits', { view: 'definitions' })).toMatchObject({
    status: 'error',
    data: null,
    error: { code: 'READ_CHANGED' },
  });
  expect(
    await tools.call('get_history', { domain: 'habit', from: '2026-09-21', to: '2026-09-21' }),
  ).toMatchObject({ status: 'error', data: null, error: { code: 'READ_CHANGED' } });
  expect(await t.tools.call('get_today', {})).toMatchObject({
    date: '2026-09-21',
    timezone: 'Asia/Seoul',
  });
});

it('performs a successful read through the real stdio executable and real scratch HTTP server', async () => {
  const t = await setup();
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
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'hermes-scratch-test', version: '1' });
  try {
    await client.connect(transport);
    expect(await client.callTool({ name: 'get_today', arguments: {} })).toMatchObject({
      isError: false,
      structuredContent: {
        schema_version: '1',
        status: 'ok',
        date: '2026-09-21',
        data: { prepared: false },
      },
    });
  } finally {
    await client.close();
  }
});

it('rejects a midnight split of Habit definitions even when the source ETag is unchanged', async () => {
  const t = await setup();
  let statuses = 0;
  const tools = new ReadTools(
    new TrackerHttpClient(t.origin, async (url, init) => {
      const body = await fetch(url, init).then((r) => r.json());
      if (new URL(String(url)).pathname.endsWith('/system/status') && ++statuses === 2)
        body.date = '2026-09-22';
      return new Response(JSON.stringify(body));
    }),
  );
  expect(await tools.call('get_habits', { view: 'definitions' })).toMatchObject({
    status: 'error',
    data: null,
    error: { code: 'READ_CHANGED' },
  });
});

it('does not label unavailable historical data with a date supplied only by the caller', async () => {
  const t = await setup(false);
  expect(await t.tools.call('get_agenda', { date: '2026-09-20' })).toMatchObject({
    status: 'unavailable',
    date: null,
    data: null,
  });
});
