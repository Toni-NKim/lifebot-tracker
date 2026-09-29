// Concurrency and offline safety of Today writes: several copies of one Habit, other
// devices changing the same record, and actions submitted while offline.
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const origin = 'http://127.0.0.1:4173';
// Writes through the API, as another device would.
async function api(page: Page, method: string, url: string, data: unknown) {
  const { etag } = await (await page.request.get('/api/v1/today')).json();
  const response = await page.request.fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      origin,
      'idempotency-key': randomUUID(),
      'if-match': etag,
    },
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
const routine = (page: Page, name: string, time: string) =>
  api(page, 'POST', '/api/v1/routines', {
    fields: {
      name,
      description: '',
      deleted: false,
      schedule: { type: 'daily' },
      scheduled_time: time,
      habit_order: [],
    },
  });
async function habit(page: Page, name: string, routineIds: string[] = []) {
  await api(page, 'POST', '/api/v1/habits', {
    fields: {
      name,
      description: '',
      active: true,
      deleted: false,
      parent_routine_id: null,
      routine_ids: routineIds,
      schedule: { mode: 'explicit', source_routine_revision: null, rule: { type: 'daily' } },
      scheduled_time: { mode: 'explicit', source_routine_revision: null, value: null },
      minimum_duration_seconds: null,
      target_amount: null,
      unit: null,
    },
  });
  return item(page, name);
}
async function item(page: Page, name: string) {
  const today = await (await page.request.get('/api/v1/today')).json();
  return today.data.items.find((i: { habit: { name: string } }) => i.habit.name === name);
}
const complete = (page: Page, id: string, details: Record<string, unknown> = {}) =>
  api(page, 'PUT', `/api/v1/days/2026-09-27/habits/${id}/execution`, {
    status: 'completed',
    duration_seconds: null,
    actual_amount: null,
    difficulty_or_quality: null,
    energy_note: null,
    ...details,
  });
// A Habit shown in two Routine groups.
async function shared(page: Page, label: string) {
  const suffix = randomUUID().slice(0, 6);
  const a = (await routine(page, `A ${label} ${suffix}`, '07:00')).data.changes[0].id;
  const b = (await routine(page, `B ${label} ${suffix}`, '21:00')).data.changes[0].id;
  const name = `Shared ${label} ${suffix}`;
  const h = await habit(page, name, [a, b]);
  await page.goto('/');
  const group = (routineName: string) =>
    page.locator('section').filter({ has: page.getByRole('heading', { name: routineName }) });
  return {
    name,
    id: h.habit_id as string,
    groupA: group(`A ${label} ${suffix}`),
    groupB: group(`B ${label} ${suffix}`),
  };
}

test('two rapid completions of one Habit in two Routine copies keep the saved details', async ({
  page,
}) => {
  const h = await shared(page, 'rapid');
  await h.groupA.getByRole('button', { name: 'Details +', exact: true }).click();
  await h.groupA.getByLabel('Energy note').fill('note A');
  // Both copies clicked before either request finishes.
  await page.evaluate((name) => {
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      `button[aria-label="Complete ${name}"]`,
    ))
      button.click();
  }, h.name);
  for (const group of [h.groupA, h.groupB])
    await expect(
      group.getByRole('button', { name: `Undo ${h.name}`, exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
  await expect(async () =>
    expect((await item(page, h.name)).execution).toMatchObject({
      status: 'completed',
      energy_note: 'note A',
    }),
  ).toPass();
});

test('a stale details draft is not saved over a change from another device', async ({ page }) => {
  const name = `Other device ${randomUUID().slice(0, 6)}`;
  const h = await habit(page, name);
  await complete(page, h.habit_id, { actual_amount: '1' });
  await page.goto('/');
  const card = page.locator('article').filter({ has: page.getByRole('heading', { name }) });
  await card.getByRole('button', { name: 'Details +', exact: true }).click();
  await card.getByLabel('Energy note').fill('local draft'); // draft still holds amount 1
  await complete(page, h.habit_id, { actual_amount: '7' }); // another device
  // Today refreshes in the background (for example when the tab regains focus).
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/v1/today') && r.status() === 200),
    page.evaluate(() => window.dispatchEvent(new Event('visibilitychange'))),
  ]);
  await card.getByRole('button', { name: 'Save details', exact: true }).click();
  await expect(card.getByRole('alert')).toContainText(/changed/i);
  expect((await item(page, name)).execution).toMatchObject({
    actual_amount: '7',
    energy_note: null,
  });
});

test('Undo in one Routine copy clears the details draft of every copy', async ({ page }) => {
  const h = await shared(page, 'undo');
  await complete(page, h.id);
  await page.reload();
  await h.groupB.getByRole('button', { name: 'Details +', exact: true }).click();
  await h.groupB.getByLabel('Energy note').fill('B draft');
  await h.groupA.getByRole('button', { name: `Undo ${h.name}`, exact: true }).click();
  await expect(
    h.groupB.getByRole('button', { name: `Complete ${h.name}`, exact: true }),
  ).toBeEnabled();
  await expect(h.groupB.getByLabel('Energy note')).toHaveValue('');
  await h.groupB.getByRole('button', { name: `Complete ${h.name}`, exact: true }).click();
  await expect(h.groupB.getByRole('button', { name: `Undo ${h.name}`, exact: true })).toBeEnabled();
  expect((await item(page, h.name)).execution).toMatchObject({
    status: 'completed',
    energy_note: null,
  });
});
