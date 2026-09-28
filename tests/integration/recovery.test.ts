import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { harness, execution } from '../helpers.js';
import { TrackerService } from '../../app/server/services/tracker.js';
import { Index } from '../../app/server/index/sqlite/index.js';
import { atomicWrite, serialize } from '../../app/server/storage/markdown/vault.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((f) => f());
  vi.restoreAllMocks();
});
async function setup() {
  const t = await harness();
  cleanups.push(t.cleanup);
  return t;
}
const restart = (t: Awaited<ReturnType<typeof setup>>) =>
  new TrackerService(t.vault, new Index(t.index.file), () => '2026-09-21T01:00:00Z');

it('a restart after a post-save index failure serves the saved record', async () => {
  const t = await setup();
  const h = await t.create();
  vi.spyOn(t.index, 'rebuild').mockImplementation(() => {
    throw new Error('disk full');
  });
  const saved = await t.service.execute('2026-09-21', h.id, execution(), randomUUID(), t.etag());
  expect(saved.index_warning).toBe('disk full');
  vi.restoreAllMocks();
  const service = restart(t);
  await service.initialize();
  const today = (await service.today()).data;
  expect(today.items[0].execution?.status).toBe('completed');
  expect((await service.status()).source_changed).toBe(false);
});

it('an external edit made while stopped still requires an explicit rebuild', async () => {
  const t = await setup();
  const h = await t.create();
  atomicWrite(
    path.join(t.vault.root, t.vault.definitionPath(h)),
    serialize({ ...h, name: 'Edited while stopped' }),
  );
  const service = restart(t);
  await service.initialize();
  await expect(service.today()).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
});

it('a rebuild by another process (CLI) unblocks a running server', async () => {
  const t = await setup();
  const h = await t.create();
  atomicWrite(
    path.join(t.vault.root, t.vault.definitionPath(h)),
    serialize({ ...h, name: 'Accepted by CLI' }),
  );
  await expect(t.service.today()).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
  await restart(t).rebuild();
  expect((await t.service.today()).data.items[0].habit.name).toBe('Accepted by CLI');
});

it('startup with an invalid Vault reports the error instead of crashing', async () => {
  const t = await setup();
  const h = await t.create();
  fs.writeFileSync(path.join(t.vault.root, t.vault.definitionPath(h)), 'broken');
  const service = restart(t);
  await expect(service.initialize()).resolves.toBeUndefined();
  expect((await service.status()).error).toMatch(/INVALID|frontmatter/i);
  await expect(service.today()).rejects.toMatchObject({ code: 'INVALID_VAULT' });
});
