import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  TrackerHttpClient,
  scratchConnection,
} from '../../../app/integrations/lifebot/http-client.js';

it('has no adapter imports or dynamic loading outside its HTTP-only boundary', () => {
  const root = path.resolve('app/integrations/lifebot');
  const allowed = new Set([
    'zod',
    'zod-to-json-schema',
    '@js-temporal/polyfill',
    '@modelcontextprotocol/sdk/server/index.js',
    '@modelcontextprotocol/sdk/server/stdio.js',
    '@modelcontextprotocol/sdk/types.js',
  ]);
  const files = fs
    .readdirSync(root, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts'));
  expect(files.length).toBeGreaterThan(5);
  for (const file of files) {
    const full = path.join(root, file);
    const source = fs.readFileSync(full, 'utf8');
    for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      const name = match[1];
      expect(
        name.startsWith('.')
          ? path.resolve(path.dirname(full), name).startsWith(root + path.sep)
          : allowed.has(name),
        `${file}: ${name}`,
      ).toBe(true);
    }
    expect(source).not.toMatch(
      /\b(require|eval|Function)\s*\(|process\.getBuiltinModule|\bimport\s*\(|\bimport\s*['"]/,
    );
    expect(source).not.toMatch(
      /OBSIDIAN_VAULT_PATH|TRACKER_STATE_PATH|dotenv|--env-file|sqlite|readFile|writeFile|child_process/,
    );
    if (file !== 'http-client.ts') expect(source).not.toMatch(/\bfetch\s*\(/);
  }
});

it('requires explicit scratch loopback configuration and rejects remote URLs and URL credentials', () => {
  expect(() => scratchConnection({ LIFEBOT_TRACKER_URL: 'http://127.0.0.1:4317' })).toThrow();
  for (const url of [
    'https://127.0.0.1',
    'http://localhost:4317',
    'http://example.org',
    'http://127.0.0.1/api',
    'http://a:b@127.0.0.1',
    'http://127.0.0.1/?x=y',
    'http://127.0.0.1/#x',
  ])
    expect(() =>
      scratchConnection({ LIFEBOT_SCRATCH_ONLY: 'true', LIFEBOT_TRACKER_URL: url }),
    ).toThrow();
  expect(
    scratchConnection({
      LIFEBOT_SCRATCH_ONLY: 'true',
      LIFEBOT_TRACKER_URL: 'http://127.0.0.1:4317',
    }),
  ).toBe('http://127.0.0.1:4317');
});

it('sends only allowlisted GETs, rejects redirects and limits upstream memory', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('{"ok":true}'));
  const client = new TrackerHttpClient('http://127.0.0.1:4317', fetcher);
  await client.get('/today', z.object({ ok: z.boolean() }));
  expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
  await expect(client.get('/timebox/prepare' as never, z.unknown())).rejects.toMatchObject({
    code: 'FORBIDDEN_OPERATION',
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  for (const response of [
    new Response('bad JSON'),
    new Response('{}', { headers: { 'content-length': String(9 * 1024 * 1024) } }),
    new Response(' '.repeat(8 * 1024 * 1024 + 1)),
  ]) {
    fetcher.mockImplementationOnce(async () => response);
    await expect(client.get('/today', z.object({ ok: z.boolean() }))).rejects.toMatchObject({
      code: 'UPSTREAM_CONTRACT_ERROR',
    });
  }
  fetcher.mockImplementationOnce(
    async () =>
      new Response(
        JSON.stringify({ error: { code: 'VAULT_UNAVAILABLE', message: '/private/secret/vault' } }),
        { status: 503 },
      ),
  );
  await expect(client.get('/today', z.unknown())).rejects.toMatchObject({
    code: 'VAULT_UNAVAILABLE',
    message: expect.not.stringContaining('/private'),
  });
});
