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
    else {
      await expect(page.getByText(/수정 이력 2개/)).toBeVisible();
      await expect(page.getByRole('button', { name: new RegExp(`${name} ·`) })).toContainText(
        '10:00',
      );
    }
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

for (const kind of ['Inbox', 'Todo', 'Project', 'Plan', 'Manual Actual'] as const) {
  test(`successful ${kind} creation retry settles its form without duplicate creation`, async ({
    page,
  }) => {
    const name = `retry-${kind}-${randomUUID()}`;
    await page.goto(kind === 'Plan' || kind === 'Manual Actual' ? '/' : '/todos');
    const path = {
      Inbox: '/todo/inbox',
      Todo: '/todo/items',
      Project: '/todo/projects',
      Plan: '/timebox/plans',
      'Manual Actual': '/timebox/actuals',
    }[kind];
    const label = {
      Inbox: '빠른 생각 캡처',
      Todo: 'Todo 제목',
      Project: 'Project 이름',
      Plan: '일정 제목',
      'Manual Actual': '활동 제목',
    }[kind];
    const button = {
      Inbox: 'Inbox에 추가',
      Todo: 'Todo 저장',
      Project: 'Project 저장',
      Plan: '계획 저장',
      'Manual Actual': '실제 활동 저장',
    }[kind];
    if (kind === 'Project') {
      await page.getByRole('button', { name: 'Projects', exact: true }).click();
      await page.getByRole('button', { name: 'Project 만들기', exact: true }).click();
    }
    if (kind === 'Todo')
      await page.getByRole('button', { name: 'Todo 만들기', exact: true }).click();
    if (kind === 'Plan') await page.getByRole('button', { name: '계획 추가', exact: true }).click();
    if (kind === 'Manual Actual')
      await page.getByRole('button', { name: '실제 활동 추가', exact: true }).click();
    await page.getByLabel(label, { exact: true }).fill(name);
    const commands: string[] = [];
    page.on('request', (r) => {
      if (r.url().endsWith(`/api/v1${path}`) && r.method() === 'POST')
        commands.push(r.headers()['idempotency-key']);
    });
    await page.route(
      `**/api/v1${path}`,
      (r) =>
        r.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'TEST_FAILURE', message: 'Retry this creation' } }),
        }),
      { times: 1 },
    );
    await page.getByRole('button', { name: button, exact: true }).click();
    await page.getByRole('button', { name: '같은 요청 재시도', exact: true }).click();
    await expect(page.getByRole('button', { name: '같은 요청 재시도', exact: true })).toHaveCount(
      0,
    );
    if (kind === 'Inbox') {
      await expect(page.getByLabel(label, { exact: true })).toHaveValue('');
      await expect(page.getByRole('button', { name: button, exact: true })).toBeDisabled();
    } else await expect(page.getByRole('button', { name: button, exact: true })).toHaveCount(0);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toBe(commands[1]);
    const view = (
      await get(page, kind === 'Plan' || kind === 'Manual Actual' ? '/agenda' : '/todo')
    ).data;
    const records =
      kind === 'Inbox'
        ? view.inbox
        : kind === 'Todo'
          ? view.todos
          : kind === 'Project'
            ? view.projects
            : kind === 'Plan'
              ? view.plans
              : view.actuals;
    expect(
      records.filter((r: any) => (r.data?.title ?? r.data?.name ?? r.title) === name),
    ).toHaveLength(1);
  });
}

for (const kind of ['Inbox', 'Todo', 'Project', 'Plan', 'Manual Actual'] as const) {
  test(`submitted ${kind} draft survives navigation before failure and settles on retry`, async ({
    page,
  }) => {
    const name = `navigation-${kind}-${randomUUID()}`;
    const routePath = kind === 'Plan' || kind === 'Manual Actual' ? '/' : '/todos';
    await page.goto(routePath);
    const path = {
      Inbox: '/todo/inbox',
      Todo: '/todo/items',
      Project: '/todo/projects',
      Plan: '/timebox/plans',
      'Manual Actual': '/timebox/actuals',
    }[kind];
    const label = {
      Inbox: '빠른 생각 캡처',
      Todo: 'Todo 제목',
      Project: 'Project 이름',
      Plan: '일정 제목',
      'Manual Actual': '활동 제목',
    }[kind];
    const button = {
      Inbox: 'Inbox에 추가',
      Todo: 'Todo 저장',
      Project: 'Project 저장',
      Plan: '계획 저장',
      'Manual Actual': '실제 활동 저장',
    }[kind];
    if (kind === 'Project') {
      await page.getByRole('button', { name: 'Projects', exact: true }).click();
      await page.getByRole('button', { name: 'Project 만들기', exact: true }).click();
    }
    if (kind === 'Todo')
      await page.getByRole('button', { name: 'Todo 만들기', exact: true }).click();
    if (kind === 'Plan') await page.getByRole('button', { name: '계획 추가', exact: true }).click();
    if (kind === 'Manual Actual')
      await page.getByRole('button', { name: '실제 활동 추가', exact: true }).click();
    await page.getByLabel(label, { exact: true }).fill(name);
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((r) => (release = r)),
      started = new Promise<void>((r) => (entered = r));
    const commands: string[] = [];
    page.on('request', (r) => {
      if (r.url().endsWith(`/api/v1${path}`) && r.method() === 'POST')
        commands.push(r.headers()['idempotency-key']);
    });
    await page.route(
      `**/api/v1${path}`,
      async (r) => {
        entered();
        await held;
        await r.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'TEST_FAILURE', message: 'Delayed navigation failure' },
          }),
        });
      },
      { times: 1 },
    );
    await page.getByRole('button', { name: button, exact: true }).click();
    await started;
    await page.locator('nav a[href="/habits/today"]:visible').first().click();
    await expect(page.getByRole('heading', { name: '오늘의 기록' })).toBeVisible();
    const response = page.waitForResponse(
      (r) => r.url().endsWith(`/api/v1${path}`) && r.status() === 503,
    );
    release();
    await response;
    await page.locator(`nav a[href="${routePath}"]:visible`).first().click();
    await expect(page.getByLabel(label, { exact: true })).toHaveValue(name);
    await expect(page.getByRole('alert')).toContainText('Delayed navigation failure');
    await page.getByRole('button', { name: '같은 요청 재시도', exact: true }).click();
    await expect(page.getByRole('button', { name: '같은 요청 재시도', exact: true })).toHaveCount(
      0,
    );
    if (kind === 'Inbox') await expect(page.getByLabel(label, { exact: true })).toHaveValue('');
    else await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toBe(commands[1]);
  });
}
for (const outcome of ['failure', 'success'] as const) {
  test(`submitted Todo edit ${outcome} reconciles after navigation`, async ({ page }) => {
    const name = `edit-${randomUUID()}`;
    const result = await save(page, '/todo/items', fields(name), (await get(page, '/todo')).etag),
      id = result.data.changes[0].id;
    await page.goto('/todos');
    await page
      .locator('article')
      .filter({ has: page.getByRole('heading', { name, exact: true }) })
      .getByRole('button', { name: '수정', exact: true })
      .click();
    await page.getByLabel('Todo 제목').fill(`${name}-draft`);
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((r) => (release = r)),
      started = new Promise<void>((r) => (entered = r));
    await page.route(
      `**/api/v1/todo/items/${id}`,
      async (route) => {
        entered();
        await held;
        if (outcome === 'success') await route.continue();
        else
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({
              error: { code: 'TEST_FAILURE', message: 'Edit failed while away' },
            }),
          });
      },
      { times: 1 },
    );
    await page.getByRole('button', { name: 'Todo 저장', exact: true }).click();
    await started;
    await page.locator('nav a[href="/"]:visible').first().click();
    await expect(page.getByRole('heading', { name: 'Today LIFEbot' })).toBeVisible();
    const response = page.waitForResponse(
      (r) => r.url().endsWith(`/todo/items/${id}`) && r.request().method() === 'PATCH',
    );
    release();
    await response;
    await page.locator('nav a[href="/todos"]:visible').first().click();
    if (outcome === 'failure') {
      await expect(page.getByLabel('Todo 제목')).toHaveValue(`${name}-draft`);
      await expect(page.getByRole('alert')).toContainText('Edit failed while away');
      await page.getByRole('button', { name: '같은 요청 재시도', exact: true }).click();
    }
    await expect(page.getByLabel('Todo 제목')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: `${name}-draft`, exact: true })).toBeVisible();
  });
}
