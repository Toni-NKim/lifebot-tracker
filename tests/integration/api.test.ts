import { afterEach, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../app/server/api.js';
import { harness, habitFields, execution } from '../helpers.js';
import { configuration } from '../../app/server/config.js';
import { Vault } from '../../app/server/storage/markdown/vault.js';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function setup(options: Parameters<typeof createApp>[1] = {}) {
  const t = await harness();
  cleanup.push(t.cleanup);
  const app = await createApp(t.service, options);
  cleanup.push(() => app.close());
  return { ...t, app };
}
it.each([
  {
    duration_seconds: 750,
    actual_amount: '10',
    difficulty_or_quality: 'Comfortable',
    energy_note: 'A calm day.',
  },
  { duration_seconds: null, actual_amount: null, difficulty_or_quality: null, energy_note: null },
])('persists completion and optional details in one canonical write: %j', async (details) => {
  const t = await setup();
  const h = await t.create();
  const canonicalWrite = vi.spyOn(t.vault, 'writeDaily');
  const response = await t.app.inject({
    method: 'PUT',
    url: `/api/v1/days/2026-09-21/habits/${h.id}/execution`,
    headers: { 'idempotency-key': randomUUID(), 'if-match': t.etag() },
    payload: { status: 'completed', ...details },
  });
  expect(response.statusCode).toBe(200);
  expect(canonicalWrite).toHaveBeenCalledTimes(1);
  const persisted = new Vault(t.vault.root).load().days[0].executions[0];
  expect(persisted).toMatchObject({
    status: 'completed',
    completed_at: '2026-09-21T00:00:00Z',
    ...details,
    target_amount: '20',
    unit: 'pages',
  });
  expect(canonicalWrite.mock.calls[0][0].executions[0]).toEqual(persisted);
  const readIndexed = () => {
    const db = new Database(t.index.file, { readonly: true });
    try {
      return JSON.parse(
        (
          db
            .prepare('SELECT data_json FROM executions WHERE execution_id = ?')
            .get(persisted.id) as { data_json: string }
        ).data_json,
      );
    } finally {
      db.close();
    }
  };
  expect(readIndexed()).toEqual(persisted);
  await t.service.rebuild();
  expect(readIndexed()).toEqual(persisted);
  const reloaded = (await t.app.inject('/api/v1/today')).json();
  expect(
    reloaded.data.items.find((i: { habit_id: string }) => i.habit_id === h.id).execution,
  ).toEqual(persisted);
  t.setNow('2026-09-22T00:00:00Z');
  const locked = await t.app.inject({
    method: 'PUT',
    url: `/api/v1/days/2026-09-21/habits/${h.id}/execution`,
    headers: { 'idempotency-key': randomUUID(), 'if-match': t.etag() },
    payload: { status: 'completed', ...details },
  });
  expect(locked.statusCode).toBe(409);
  expect(locked.json().error.code).toBe('DAY_LOCKED');
  expect(canonicalWrite).toHaveBeenCalledTimes(1);
});
it('serves the full create/complete/history/statistics API', async () => {
  const t = await setup();
  const created = await t.app.inject({
    method: 'POST',
    url: '/api/v1/habits',
    headers: { 'idempotency-key': randomUUID(), 'if-match': t.etag() },
    payload: { fields: habitFields() },
  });
  expect(created.statusCode).toBe(200);
  expect(created.json().data.changes[0].effective_from).toBe('2026-09-21');
  const h = t.vault.load().habits[0];
  const complete = await t.app.inject({
    method: 'PUT',
    url: `/api/v1/days/2026-09-21/habits/${h.id}/execution`,
    headers: { 'idempotency-key': randomUUID(), 'if-match': t.etag() },
    payload: execution(),
  });
  expect(complete.statusCode).toBe(200);
  const stats = await t.app.inject('/api/v1/statistics');
  expect(stats.json().data.date_scheduled.rate).toBe(100);
  const history = await t.app.inject('/api/v1/history?from=2026-09-21&to=2026-09-21');
  expect(history.json().data.rows[0].execution.status).toBe('completed');
});
it('rejects unknown execution fields, invalid amounts, missing concurrency headers', async () => {
  const t = await setup();
  const h = await t.create();
  const url = `/api/v1/days/2026-09-21/habits/${h.id}/execution`;
  const headers = { 'idempotency-key': randomUUID(), 'if-match': t.etag() };
  expect(
    (
      await t.app.inject({
        method: 'PUT',
        url,
        headers,
        payload: { ...execution(), completed_at: '2026-09-21T00:00:00Z' },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await t.app.inject({
        method: 'PUT',
        url,
        headers,
        payload: execution({ actual_amount: '-2' }),
      })
    ).statusCode,
  ).toBe(400);
  expect((await t.app.inject({ method: 'PUT', url, payload: execution() })).statusCode).toBe(400);
  expect(t.vault.load().days).toHaveLength(0);
});
it('requires same origin for writes and owner/host in production', async () => {
  const t = await setup({
    origin: 'https://mini.example.ts.net',
    production: true,
    owner: 'owner@example.com',
  });
  expect((await t.app.inject('/api/v1/today')).statusCode).toBe(403);
  const headers = { host: 'mini.example.ts.net', 'tailscale-user-login': 'owner@example.com' };
  expect((await t.app.inject({ method: 'GET', url: '/api/v1/today', headers })).statusCode).toBe(
    200,
  );
  expect(
    (
      await t.app.inject({
        method: 'POST',
        url: '/api/v1/system/rebuild',
        headers: { ...headers, origin: 'https://evil.test' },
        payload: {},
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await t.app.inject({
        method: 'POST',
        url: '/api/v1/system/rebuild',
        headers: { ...headers, origin: 'https://mini.example.ts.net' },
        payload: {},
      })
    ).statusCode,
  ).toBe(200);
});
it('requires explicit Vault/state and refuses public binding or production test Vaults', () => {
  expect(() => configuration({})).toThrow('explicit absolute');
  expect(() =>
    configuration({ OBSIDIAN_VAULT_PATH: '/tmp/vault', TRACKER_STATE_PATH: '/tmp/vault/index' }),
  ).toThrow('outside');
  expect(() =>
    configuration({
      OBSIDIAN_VAULT_PATH: '/tmp/vault',
      TRACKER_STATE_PATH: '/tmp/state',
      HOST: '0.0.0.0',
    }),
  ).toThrow('loopback');
  expect(() =>
    configuration({
      OBSIDIAN_VAULT_PATH: process.cwd() + '/tests/fixtures/obsidian-vault',
      TRACKER_STATE_PATH: '/tmp/state',
      NODE_ENV: 'production',
      APP_ORIGIN: 'https://example.ts.net',
      TAILSCALE_OWNER: 'owner',
    }),
  ).toThrow('outside the repository');
});

it('preserves nullable numbers exactly and never coerces body types', async () => {
  const t = await setup();
  const response = await t.app.inject({
    method: 'POST',
    url: '/api/v1/habits',
    headers: { 'idempotency-key': randomUUID(), 'if-match': t.etag() },
    payload: { fields: habitFields({ minimum_duration_seconds: null }) },
  });
  expect(response.statusCode).toBe(200);
  const h = t.vault.load().habits[0];
  expect(h.minimum_duration_seconds).toBeNull();
  const completed = await t.app.inject({
    method: 'PUT',
    url: `/api/v1/days/2026-09-21/habits/${h.id}/execution`,
    headers: { 'idempotency-key': randomUUID(), 'if-match': t.etag() },
    payload: execution({ duration_seconds: null, actual_amount: null }),
  });
  expect(completed.statusCode).toBe(200);
  expect(t.vault.load().days[0].executions[0].duration_seconds).toBeNull();
  const bad = await t.app.inject({
    method: 'POST',
    url: '/api/v1/habits',
    headers: { 'idempotency-key': randomUUID(), 'if-match': t.etag() },
    payload: { fields: { ...habitFields(), active: 'true' } },
  });
  expect(bad.statusCode).toBe(400);
  expect((await t.app.inject('/api/v1/history?offset=0&limit=10')).statusCode).toBe(200);
  expect((await t.app.inject('/api/v1/history?limit=1000')).statusCode).toBe(400);
  expect((await t.app.inject('/api/v1/statistics?from=2026-02-30')).statusCode).toBe(400);
});
