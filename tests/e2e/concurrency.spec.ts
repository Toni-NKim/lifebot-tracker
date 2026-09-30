// Concurrency and offline safety of dashboard writes: one Habit seen from several places
// (its card, its Details sheet and each Routine filter), other devices changing the same
// record, and actions submitted while offline.
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
// A Habit in two Routines; each Routine is a filter chip over the same card.
async function shared(page: Page, label: string) {
  const suffix = randomUUID().slice(0, 6);
  const [ra, rb] = [`A ${label} ${suffix}`, `B ${label} ${suffix}`];
  const a = (await routine(page, ra, '07:00')).data.changes[0].id;
  const b = (await routine(page, rb, '21:00')).data.changes[0].id;
  const name = `Shared ${label} ${suffix}`;
  const h = await habit(page, name, [a, b]);
  await page.goto('/');
  const show = (routineName: string) =>
    page
      .getByRole('group', { name: '루틴 필터' })
      .getByRole('button', { name: new RegExp(`^${routineName}`) })
      .click();
  return { name, id: h.habit_id as string, showA: () => show(ra), showB: () => show(rb) };
}
const sheetOf = (page: Page, name: string) =>
  page.getByRole('complementary', { name: `${name} 세부 기록`, exact: true });
const openDetails = (page: Page, name: string) =>
  page.getByRole('button', { name: `${name} 세부 기록`, exact: true }).click();
const closeDetails = (page: Page, name: string) =>
  sheetOf(page, name).getByRole('button', { name: '세부 기록 닫기' }).click();

test('two rapid completions of one Habit keep the saved details', async ({ page }) => {
  const h = await shared(page, 'rapid');
  await openDetails(page, h.name);
  await sheetOf(page, h.name).getByLabel('에너지 메모').fill('note A');
  await closeDetails(page, h.name);
  // Two taps before either request finishes.
  await page.evaluate((name) => {
    const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${name} 완료"]`)!;
    button.click();
    button.click();
  }, h.name);
  for (const show of [h.showA, h.showB]) {
    await show();
    await expect(page.getByRole('button', { name: `${h.name} 완료`, exact: true })).toHaveCount(0);
  }
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
  await openDetails(page, name);
  const sheet = sheetOf(page, name);
  await sheet.getByLabel('에너지 메모').fill('local draft'); // draft still holds amount 1
  await complete(page, h.habit_id, { actual_amount: '7' }); // another device
  // Today refreshes in the background (for example when the tab regains focus).
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/v1/today') && r.status() === 200),
    page.evaluate(() => window.dispatchEvent(new Event('visibilitychange'))),
  ]);
  await sheet.getByRole('button', { name: '세부 기록 저장', exact: true }).click();
  const alert = sheet.getByRole('alert');
  await expect(alert).toHaveText('다른 기기에서 기록이 변경됐어요. 새로고침 후 다시 확인해주세요.');
  await expect(alert).toHaveAttribute('data-error-code', 'REVISION_CONFLICT');
  expect((await item(page, name)).execution).toMatchObject({
    actual_amount: '7',
    energy_note: null,
  });
  await expect(sheet.getByLabel('에너지 메모')).toHaveValue('local draft');
});

test('Undo under one Routine clears the details draft seen under every Routine', async ({
  page,
}) => {
  const h = await shared(page, 'undo');
  await complete(page, h.id);
  await page.reload();
  await h.showB();
  await openDetails(page, h.name);
  await sheetOf(page, h.name).getByLabel('에너지 메모').fill('B draft');
  await closeDetails(page, h.name);
  await h.showA();
  await openDetails(page, h.name);
  await sheetOf(page, h.name).getByRole('button', { name: '완료 취소', exact: true }).click();
  await expect(
    sheetOf(page, h.name).getByRole('button', { name: '완료', exact: true }),
  ).toBeEnabled();
  await closeDetails(page, h.name);
  await h.showB();
  await openDetails(page, h.name);
  await expect(sheetOf(page, h.name).getByLabel('에너지 메모')).toHaveValue('');
  await closeDetails(page, h.name);
  await page.getByRole('button', { name: `${h.name} 완료`, exact: true }).click();
  await expect(page.getByRole('button', { name: `${h.name} 완료`, exact: true })).toHaveCount(0);
  expect((await item(page, h.name)).execution).toMatchObject({
    status: 'completed',
    energy_note: null,
  });
});

test('an action taken offline behind a pending write is rejected, never replayed', async ({
  page,
  context,
}) => {
  const suffix = randomUUID().slice(0, 6);
  const [x, y] = [`Pending ${suffix}`, `Offline ${suffix}`];
  await habit(page, x);
  const offline = await habit(page, y);
  await page.goto('/');
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const sent: string[] = [];
  await page.route('**/execution', async (route) => {
    sent.push(route.request().url());
    if (sent.length === 1) await held; // keep the first write pending
    await route.continue();
  });
  await page.getByRole('button', { name: `${x} 완료`, exact: true }).click();
  await context.setOffline(true);
  await page.getByRole('button', { name: `${y} 완료`, exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('오프라인 상태에서는 기록할 수 없어요.');
  await context.setOffline(false);
  release();
  await expect(page.getByRole('button', { name: `${x} 완료`, exact: true })).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(sent.filter((url) => url.includes(offline.habit_id))).toEqual([]);
  expect((await item(page, y)).execution).toBeNull();
});

test('a failed Undo on a stale view keeps the shared draft under every Routine', async ({
  page,
}) => {
  const h = await shared(page, 'failed-undo');
  await complete(page, h.id, { actual_amount: '1' });
  await page.reload();
  await h.showA();
  await openDetails(page, h.name);
  await sheetOf(page, h.name).getByLabel('에너지 메모').fill('my draft');
  await closeDetails(page, h.name);
  await complete(page, h.id, { actual_amount: '7' }); // another device; this page is stale
  await h.showB();
  await openDetails(page, h.name);
  const sheet = sheetOf(page, h.name);
  await sheet.getByRole('button', { name: '완료 취소', exact: true }).click();
  await expect(sheet.getByRole('alert')).toHaveAttribute('data-error-code', 'REVISION_CONFLICT');
  await expect(sheet.getByRole('alert')).toContainText('다른 기기에서 기록이 변경됐어요');
  // Canonical data is untouched and the user's draft survives.
  expect((await item(page, h.name)).execution).toMatchObject({
    status: 'completed',
    actual_amount: '7',
    energy_note: null,
  });
  await expect(sheet.getByLabel('에너지 메모')).toHaveValue('my draft');
  await closeDetails(page, h.name);
  await h.showA();
  await openDetails(page, h.name);
  await expect(sheetOf(page, h.name).getByLabel('에너지 메모')).toHaveValue('my draft');
});
