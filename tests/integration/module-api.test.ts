import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { harness } from '../helpers.js';
import { moduleRegistry } from '../../app/server/modules.js';
import { createModuleServices } from '../../app/server/module-runtime.js';
import { createApp } from '../../app/server/api.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

it('starts Habit without initializing new modules and exposes explicit scoped maintenance with existing security', async () => {
  const t = await harness();
  const paths = moduleRegistry(
    path.join(t.root, 'vault'),
    path.join(t.root, 'state'),
    'Life/HabitTracker',
  );
  const modules = createModuleServices(paths);
  const app = await createApp(t.service, { modules, origin: 'http://localhost:3000' });
  cleanup.push(async () => {
    await app.close();
    t.cleanup();
  });
  const before = t.etag();
  const status = await app.inject('/api/v1/system/modules');
  expect(status.statusCode).toBe(200);
  expect(status.json().todo.initialized).toBe(false);
  expect(fs.existsSync(paths.todo.root)).toBe(false);
  expect(fs.existsSync(paths.timebox.root)).toBe(false);
  expect((await app.inject('/api/v1/today')).statusCode).toBe(200);
  const request = {
    method: 'POST' as const,
    url: '/api/v1/system/modules/todo/initialize',
    headers: { origin: 'http://localhost:3000' },
    payload: {},
  };
  expect((await app.inject({ ...request, headers: { origin: 'http://other' } })).statusCode).toBe(
    403,
  );
  const initialized = await app.inject(request);
  expect(initialized.statusCode).toBe(200);
  expect(initialized.headers.etag).toContain('todo:');
  expect(initialized.json().data.settings.habit_tracker_id).toBe(t.vault.load().tracker.id);
  expect((await app.inject(request)).statusCode).toBe(400);
  const hash = modules.todo.vault.fingerprint();
  fs.rmSync(modules.todo.index.file);
  for (const operation of ['validate', 'rebuild'])
    expect(
      (await app.inject({ ...request, url: `/api/v1/system/modules/todo/${operation}` }))
        .statusCode,
    ).toBe(200);
  expect(modules.todo.vault.fingerprint()).toBe(hash);
  expect(t.etag()).toBe(before);
  expect(fs.existsSync(paths.timebox.root)).toBe(false);
  expect(
    (await app.inject({ ...request, url: '/api/v1/system/modules/unknown/rebuild' })).statusCode,
  ).toBe(400);
});
