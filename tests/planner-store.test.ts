import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { QueryClient } from '@tanstack/react-query';
import { getDraft, setDraft } from '../app/web/lib/execution-store.js';
import {
  beginPlannerCommand,
  failPlannerCommand,
  settlePlannerCommand,
  plannerPendingStore,
} from '../app/web/lib/planner-store.js';
it('observes a write settled between route render and subscription without another cache event', async () => {
  const client = new QueryClient(),
    store = plannerPendingStore(client);
  let reject!: (error: Error) => void;
  const response = new Promise<void>((_, no) => (reject = no));
  const command = client.getMutationCache().build(client, {
    mutationKey: ['planner'],
    mutationFn: () => response,
    retry: false,
  });
  const result = command.execute(undefined).catch(() => {});
  expect(store.getSnapshot()).toBe(true); // New route's initial render.
  reject(new Error('failed while switching routes'));
  await result;
  let notifications = 0;
  const unsubscribe = store.subscribe(() => notifications++);
  // React rechecks after subscribing even when settlement preceded subscription.
  expect(store.getSnapshot()).toBe(false);
  expect(notifications).toBe(0);
  unsubscribe();
  client.clear();
});
it('restores a dismissed submitted draft on failure without advancing its original token', () => {
  const key = randomUUID(),
    value = { title: 'draft', etag: 'original' };
  const command = {
    id: randomUUID(),
    path: '/todo/items',
    method: 'POST',
    body: { title: 'draft' },
    etag: 'original',
    draft: { key, value },
  };
  beginPlannerCommand(key, command);
  setDraft(key, null);
  failPlannerCommand(key, command, 'failed');
  expect(getDraft(key)).toBe(value);
  settlePlannerCommand(key, command);
  expect(getDraft(key)).toBeNull();
});
it('a late success or failure cannot clear or replace a different draft', () => {
  const key = randomUUID(),
    original = { title: 'submitted' },
    replacement = { title: 'new explicit draft' };
  const command = {
    id: randomUUID(),
    path: '/todo/items',
    method: 'POST',
    body: original,
    etag: 'original',
    draft: { key, value: original },
  };
  beginPlannerCommand(key, command);
  setDraft(key, replacement);
  failPlannerCommand(key, command, 'failed');
  expect(getDraft(key)).toBe(replacement);
  settlePlannerCommand(key, command);
  expect(getDraft(key)).toBe(replacement);
  setDraft(key, null);
});
