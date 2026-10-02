import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
const fields = (title: string) => ({
  title,
  description: '',
  workflow_status: 'next',
  importance: 'normal',
  project_id: null,
  do_date: null,
  due_at: null,
  scheduled_time: null,
  estimated_duration_seconds: null,
  recurrence: null,
  color: null,
});
const get = async (page: Page, path: string) => (await page.request.get(`/api/v1${path}`)).json();
async function save(page: Page, path: string, data: unknown, etag: string, method = 'POST') {
  const response = await page.request.fetch(`/api/v1${path}`, {
    method,
    data,
    headers: { origin: 'http://127.0.0.1:4173', 'if-match': etag, 'idempotency-key': randomUUID() },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function refetch(page: Page, path: string) {
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith(`/api/v1${path}`) && r.request().method() === 'GET',
    ),
    page.evaluate(() => {
      window.dispatchEvent(new Event('offline'));
      window.dispatchEvent(new Event('online'));
    }),
  ]);
  // The refreshed token must reach React before the stale draft is submitted.
  await expect(page.getByRole('button', { name: /저장$/, exact: false }).first()).toBeEnabled();
}
for (const kind of ['Todo', 'Project', 'Plan', 'Manual Actual'] as const) {
  test(`stale ${kind} editor conflicts after remote change and refetch`, async ({ page }) => {
    const name = `${kind}-${randomUUID()}`;
    let path: string,
      payload: Record<string, any>,
      id: string,
      readPath: string,
      remote: Record<string, any>;
    if (kind === 'Todo' || kind === 'Project') {
      readPath = '/todo';
      path = kind === 'Todo' ? '/todo/items' : '/todo/projects';
      payload =
        kind === 'Todo' ? fields(name) : { name, description: '', color: null, status: 'active' };
      const result = await save(page, path, payload, (await get(page, readPath)).etag);
      id = result.data.changes[0].id;
      await page.goto('/todos');
      if (kind === 'Project')
        await page.getByRole('button', { name: 'Projects', exact: true }).click();
      await page
        .locator('article')
        .filter({ has: page.getByRole('heading', { name, exact: true }) })
        .getByRole('button', { name: kind === 'Todo' ? '수정' : 'Project 수정', exact: true })
        .click();
      remote = {
        ...payload,
        description: 'Remote change',
        [kind === 'Todo' ? 'title' : 'name']: `${name}-remote`,
      };
      await save(
        page,
        `${path}/${id}`,
        remote,
        (await get(page, readPath)).etag,
        kind === 'Todo' ? 'PATCH' : 'PUT',
      );
    } else {
      readPath = kind === 'Plan' ? '/agenda' : '/agenda?date=2026-09-26';
      const agenda = (await get(page, readPath)).data;
      path = kind === 'Plan' ? '/timebox/plans' : '/timebox/actuals';
      payload =
        kind === 'Plan'
          ? {
              placement: {
                date: '2026-09-27',
                candidate: null,
                title: name,
                start: '2026-09-27T01:00:00Z',
                end: '2026-09-27T01:30:00Z',
                color: null,
              },
              versions: agenda.versions,
            }
          : {
              date: '2026-09-26',
              title: name,
              actual_start: '2026-09-26T01:00:00Z',
              actual_end: '2026-09-26T01:30:00Z',
              color: null,
              note: '',
              plan_id: null,
              deleted: false,
            };
      const result = await save(page, path, payload, agenda.versions.timebox);
      id = result.data.changes[0].id;
      await page.goto(kind === 'Plan' ? '/' : '/?date=2026-09-26');
      await page.getByRole('button', { name: new RegExp(`${name} ·`) }).click();
      const versions = (await get(page, readPath)).data.versions;
      remote =
        kind === 'Plan'
          ? {
              placement: {
                ...payload.placement,
                color: '#22A06B',
                start: '2026-09-27T02:00:00Z',
                end: '2026-09-27T02:30:00Z',
              },
              versions,
            }
          : { ...payload, title: `${name}-remote`, note: 'Remote change' };
      await save(page, `${path}/${id}`, remote, versions.timebox, 'PUT');
    }
    await refetch(page, readPath);
    if (kind === 'Todo' || kind === 'Project')
      await expect(
        page.getByRole('heading', { name: `${name}-remote`, exact: true }),
      ).toBeVisible();
    else if (kind === 'Manual Actual')
      await expect(
        page.getByRole('button', { name: new RegExp(`${name}-remote · Actual`) }),
      ).toBeVisible();
    else
      await expect(page.getByRole('button', { name: new RegExp(`${name} ·`) })).toContainText(
        '11:00',
      );
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith(`${path}/${id}`) && ['PATCH', 'PUT'].includes(r.request().method()),
      ),
      page
        .getByRole('button', {
          name: {
            Todo: 'Todo 저장',
            Project: 'Project 저장',
            Plan: '계획 저장',
            'Manual Actual': '실제 활동 저장',
          }[kind],
          exact: true,
        })
        .click(),
    ]);
    expect(response.status()).toBe(409);
    expect((await response.json()).error.code).toBe('REVISION_CONFLICT');
    const view = (await get(page, readPath)).data;
    if (kind === 'Todo' || kind === 'Project')
      expect(
        view[kind === 'Todo' ? 'todos' : 'projects'].find((r: any) => r.id === id).data.description,
      ).toBe('Remote change');
    else if (kind === 'Plan')
      expect(view.plans.find((r: any) => r.id === id).data.color_override).toBe('#22A06B');
    else expect(view.actuals.find((r: any) => r.source_id === id).note).toBe('Remote change');
  });
}
