import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getDraft, setDraft } from '../app/web/lib/execution-store.js';
import {
  beginPlannerCommand,
  failPlannerCommand,
  settlePlannerCommand,
} from '../app/web/lib/planner-store.js';
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
