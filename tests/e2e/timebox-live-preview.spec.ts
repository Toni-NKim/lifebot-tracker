import { test, expect, type Page, type Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const date = '2026-09-29';
const agendaPath = `/api/v1/agenda?date=${date}`;
const agenda = async (page: Page) => (await (await page.request.get(agendaPath)).json()).data;
const blockFor = (page: Page, title: string) =>
  page.getByRole('button', { name: new RegExp(`${title} · 자유 일정`) }).locator('..');

async function createPlan(page: Page, title = `preview-${randomUUID()}`) {
  const data = await agenda(page);
  const placement = {
    date,
    candidate: null,
    title,
    start: `${date}T01:00:00Z`,
    end: `${date}T02:00:00Z`,
    color: null,
  };
  const response = await page.request.post('/api/v1/timebox/plans', {
    headers: {
      origin: 'http://127.0.0.1:4173',
      'if-match': data.versions.timebox,
      'idempotency-key': randomUUID(),
    },
    data: { placement, versions: data.versions },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return { id: (await response.json()).data.changes[0].id as string, title, placement };
}

async function openEditor(page: Page, title: string) {
  await page.goto(`/?date=${date}`);
  // The accessible list also works when independently created test Plans overlap.
  await page.getByText('Plan / Actual 목록 · 겹친 일정과 빠른 완료').click();
  await page
    .locator('details > div')
    .filter({ hasText: title })
    .getByRole('button', { name: '계획 열기', exact: true })
    .click();
}

async function position(block: Locator, start: string, end: string) {
  const minute = (time: string) => {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
  };
  await expect(block).toHaveCSS('top', `${minute(start) * 2}px`);
  await expect(block).toHaveCSS('height', `${(minute(end) - minute(start)) * 2}px`);
  await expect(block).toContainText(`${start}–${end}`);
}

for (const field of ['start', 'end'] as const) {
  test(`${field} time previews locally without writes or changes in another client`, async ({
    page,
    browser,
  }) => {
    const plan = await createPlan(page);
    await openEditor(page, plan.title);
    const before = await agenda(page);
    const writes: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/') && request.method() !== 'GET')
        writes.push(request.method());
    });
    await page
      .getByLabel(field === 'start' ? '계획 시작' : '계획 종료', { exact: true })
      .fill(`${date}T${field === 'start' ? '09:30' : '12:00'}`);
    await position(
      blockFor(page, plan.title),
      field === 'start' ? '09:30' : '10:00',
      field === 'start' ? '11:00' : '12:00',
    );
    const after = await agenda(page);
    expect(after.versions).toEqual(before.versions);
    expect(after.plans.find((p: { id: string }) => p.id === plan.id)).toEqual(
      before.plans.find((p: { id: string }) => p.id === plan.id),
    );
    const observer = await browser.newPage();
    try {
      await observer.goto(`http://127.0.0.1:4173/?date=${date}`);
      await position(blockFor(observer, plan.title), '10:00', '11:00');
    } finally {
      await observer.close();
    }
    expect(writes).toEqual([]);
  });
}

test('closing an unsaved draft restores the persisted position and duration', async ({ page }) => {
  const plan = await createPlan(page);
  await openEditor(page, plan.title);
  await page.getByLabel('계획 시작', { exact: true }).fill(`${date}T09:30`);
  await page.getByLabel('계획 종료', { exact: true }).fill(`${date}T12:00`);
  await position(blockFor(page, plan.title), '09:30', '12:00');
  await page
    .getByRole('region', { name: '시간 배치', exact: true })
    .getByRole('button', { name: '닫기', exact: true })
    .click();
  // No reload/refetch: this also detects accidental mutation of the query cache.
  await position(blockFor(page, plan.title), '10:00', '11:00');
  await page
    .locator('details > div')
    .filter({ hasText: plan.title })
    .getByRole('button', { name: '계획 열기', exact: true })
    .click();
  await expect(page.getByLabel('계획 시작', { exact: true })).toHaveValue(`${date}T10:00`);
  await expect(page.getByLabel('계획 종료', { exact: true })).toHaveValue(`${date}T11:00`);
});

test('successful save retains the previewed position after the editor closes and reloads', async ({
  page,
}) => {
  const plan = await createPlan(page);
  await openEditor(page, plan.title);
  await page.getByLabel('계획 시작', { exact: true }).fill(`${date}T09:30`);
  await page.getByLabel('계획 종료', { exact: true }).fill(`${date}T12:00`);
  await position(blockFor(page, plan.title), '09:30', '12:00');
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith(`/timebox/plans/${plan.id}`) && r.request().method() === 'PUT',
    ),
    page.getByRole('button', { name: '계획 저장', exact: true }).click(),
  ]);
  expect(response.ok()).toBe(true);
  await expect(page.getByLabel('계획 시작', { exact: true })).toHaveCount(0);
  await position(blockFor(page, plan.title), '09:30', '12:00');
  await page.reload();
  await position(blockFor(page, plan.title), '09:30', '12:00');
});

test('background refetch preserves preview and original concurrency base; stale save conflicts', async ({
  page,
}) => {
  const plan = await createPlan(page);
  await openEditor(page, plan.title);
  const base = await agenda(page);
  await page.getByLabel('계획 시작', { exact: true }).fill(`${date}T09:30`);
  await page.getByLabel('계획 종료', { exact: true }).fill(`${date}T12:00`);
  const remote = await page.request.put(`/api/v1/timebox/plans/${plan.id}`, {
    headers: {
      origin: 'http://127.0.0.1:4173',
      'if-match': base.versions.timebox,
      'idempotency-key': randomUUID(),
    },
    data: {
      placement: {
        ...plan.placement,
        start: `${date}T04:00:00Z`,
        end: `${date}T05:00:00Z`,
      },
      versions: base.versions,
    },
  });
  expect(remote.ok(), await remote.text()).toBe(true);
  const persisted = await agenda(page);
  expect(persisted.versions.timebox).not.toBe(base.versions.timebox);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(agendaPath) && r.request().method() === 'GET'),
    page.evaluate(() => {
      window.dispatchEvent(new Event('offline'));
      window.dispatchEvent(new Event('online'));
    }),
  ]);
  await expect(page.getByText(/수정 이력 2개/)).toBeVisible();
  await position(blockFor(page, plan.title), '09:30', '12:00');
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith(`/timebox/plans/${plan.id}`) && r.request().method() === 'PUT',
    ),
    page.getByRole('button', { name: '계획 저장', exact: true }).click(),
  ]);
  expect(response.request().headers()['if-match']).toBe(base.versions.timebox);
  expect(response.request().postDataJSON().versions).toEqual(base.versions);
  expect(response.status()).toBe(409);
  expect((await response.json()).error.code).toBe('REVISION_CONFLICT');
  await position(blockFor(page, plan.title), '09:30', '12:00');
  expect((await agenda(page)).plans.find((p: { id: string }) => p.id === plan.id)).toEqual(
    persisted.plans.find((p: { id: string }) => p.id === plan.id),
  );
  await page
    .getByRole('region', { name: '시간 배치', exact: true })
    .getByRole('button', { name: '닫기', exact: true })
    .click();
  await position(blockFor(page, plan.title), '13:00', '14:00');
});
