import { randomBytes, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { harness } from '../../helpers.js';
import { createApp } from '../../../app/server/api.js';
import { type MachinePrincipal } from '../../../app/server/machine-auth.js';

it('enforces revocation, route/method/operation scopes and preserves browser Origin/Host authentication', async () => {
  const t = await harness();
  const machine: MachinePrincipal = { token: randomBytes(32).toString('hex'), scopes: ['read'] };
  const app = await createApp(t.service, { origin: 'http://127.0.0.1:4317', machine });
  const headers = { host: '127.0.0.1:4317', authorization: `Bearer ${machine.token}` };
  try {
    expect((await app.inject({ url: '/api/v1/today', headers })).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          url: '/api/v1/today',
          headers: { ...headers, authorization: 'Bearer invalid' },
        })
      ).statusCode,
    ).toBe(401);
    machine.revoked = true;
    expect((await app.inject({ url: '/api/v1/today', headers })).statusCode).toBe(401);
    machine.revoked = false;
    for (const url of [
      '/api/v1/system/rebuild',
      '/api/v1/habits',
      '/api/v1/timebox/prepare',
      '/api/v1/todo/items',
    ]) {
      expect(
        (await app.inject({ method: 'POST', url, headers, payload: { recurrence: null } }))
          .statusCode,
      ).toBe(403);
    }
    machine.scopes.push('create_todo');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/todo/items',
          headers,
          payload: { recurrence: { type: 'daily' } },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: '/api/v1/today',
          headers: { ...headers, origin: 'http://evil.test' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: '/api/v1/today', headers: { ...headers, host: 'evil.test' } }))
        .statusCode,
    ).toBe(403);
    const h = await t.create();
    const write = {
      method: 'POST' as const,
      url: `/api/v1/days/2026-09-21/habits/${h.id}/start`,
      headers: { 'idempotency-key': randomUUID(), 'if-match': t.etag() },
      payload: { plan_ref: null },
    };
    expect((await app.inject(write)).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          ...write,
          headers: { ...write.headers, origin: 'http://127.0.0.1:4317' },
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    await app.close();
    t.cleanup();
  }
});

it('leaves production browser owner/Host protection intact and refuses production machine enablement', async () => {
  const t = await harness();
  const app = await createApp(t.service, {
    production: true,
    owner: 'owner',
    origin: 'https://tracker.test',
  });
  try {
    expect((await app.inject({ url: '/api/v1/today' })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          url: '/api/v1/today',
          headers: { host: 'tracker.test', 'tailscale-user-login': 'owner' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          url: '/api/v1/today',
          headers: { host: 'evil.test', 'tailscale-user-login': 'owner' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: '/api/v1/today', headers: { authorization: 'Bearer invalid' } }))
        .statusCode,
    ).toBe(401);
    await expect(
      createApp(t.service, {
        production: true,
        origin: 'http://127.0.0.1',
        machine: { token: randomBytes(32).toString('hex'), scopes: ['read'] },
      }),
    ).rejects.toThrow();
  } finally {
    await app.close();
    t.cleanup();
  }
});
