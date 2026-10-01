import { test, expect } from '@playwright/test';
const unique = (s: string) => `${s}-${Date.now()}`;
test('captures Inbox, assigns a Plan with touch/keyboard, executes Todo and preserves history', async ({
  page,
}) => {
  const name = unique('취재');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Today LIFEbot' })).toBeVisible();
  const mobileRail = page.getByRole('button', { name: '후보 / Inbox 펼치기' });
  if (await mobileRail.isVisible()) await mobileRail.click();
  await page.getByLabel('빠른 생각 캡처').fill(name);
  await page.getByRole('button', { name: 'Inbox에 추가', exact: true }).click();
  const inbox = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name, exact: true }) })
    .first();
  await inbox.getByRole('button', { name: '시간 배치', exact: true }).click();
  await page.getByRole('button', { name: '계획 저장', exact: true }).click();
  await expect(page.getByRole('button', { name: new RegExp(`${name} · Todo`) })).toBeVisible();
  await page.getByRole('button', { name: new RegExp(`${name} · Todo`) }).click();
  const editor = page.getByRole('region', { name: '시간 배치', exact: true });
  await editor.getByRole('button', { name: '시작', exact: true }).click();
  await expect(page.getByRole('button', { name: new RegExp(`${name} · Actual`) })).toBeVisible();
  await page.getByRole('button', { name: new RegExp(`${name} · Actual`) }).click();
  await page
    .getByRole('region', { name: '시간 배치', exact: true })
    .getByRole('button', { name: '완료', exact: true })
    .click();
  await page.goto('/todos');
  await page.getByRole('button', { name: '완료 기록', exact: true }).click();
  const history = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
  await expect(history).toBeVisible();
  await history.getByRole('button', { name: '완료 취소', exact: true }).click();
  await expect(history).toHaveCount(0);
  await page.reload();
  await expect(
    page.locator('article').filter({ has: page.getByRole('heading', { name, exact: true }) }),
  ).toBeVisible();
});
test('edits Todo metadata, Project color, recurrence and workflow without mixing Inbox state', async ({
  page,
}) => {
  const name = unique('반복'),
    project = unique('Project');
  await page.goto('/todos');
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'Project 만들기' }).click();
  await page.getByLabel('Project 이름').fill(project);
  await page.getByLabel('HEX 색상').fill('#22A06B');
  await page.getByRole('button', { name: 'Project 저장' }).click();
  await expect(page.getByRole('heading', { name: project })).toBeVisible();
  await page.getByRole('button', { name: 'Todo 만들기' }).click();
  await page.getByLabel('Todo 제목').fill(name);
  await page
    .getByRole('combobox', { name: 'Project', exact: true })
    .selectOption({ label: project });
  await page.getByRole('combobox', { name: '반복', exact: true }).selectOption('daily');
  await page.getByLabel('Do date · 하기로 한 날').fill('2026-09-27');
  await page.getByLabel('Due date · 실제 마감').fill('2026-09-28T17:00');
  await page.getByRole('button', { name: 'Todo 저장' }).click();
  await page.getByRole('button', { name: 'Priorities', exact: true }).click();
  const item = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
  await expect(item).toContainText('2026-09-27');
  await expect(item).toContainText('2026-09-28');
  await item.getByRole('button', { name: '수정', exact: true }).click();
  await page.getByLabel('Workflow').selectOption('waiting');
  await page.getByRole('button', { name: 'Todo 저장' }).click();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(
    page
      .locator('article')
      .filter({ has: page.getByRole('heading', { name: project, exact: true }) }),
  ).toContainText('0 / 0');
});
test('records a past unsnapped Actual without fabricating Plans and lays out without horizontal overflow', async ({
  page,
}) => {
  const name = unique('실제통화');
  await page.goto('/?date=2026-09-26');
  await page.getByRole('button', { name: '실제 활동 추가', exact: true }).click();
  await page.getByLabel('활동 제목').fill(name);
  await page.getByLabel('실제 시작', { exact: true }).fill('2026-09-26T09:17:13');
  await page.getByLabel('실제 종료 · 비우면 실행 중').fill('2026-09-26T09:43:29');
  await page.getByRole('button', { name: '실제 활동 저장' }).click();
  await expect(page.getByRole('button', { name: new RegExp(`${name} · Actual`) })).toBeVisible();
  await expect(page.getByText('이 날짜에는 자동 계획을 준비한 기록이 없습니다.')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: `test-results/planner-${test.info().project.name}.png`,
    fullPage: true,
  });
});

test('Timebox Habit completion writes the original Habit execution and keeps its schedule', async ({
  page,
}) => {
  const name = unique('공유Habit');
  const today = await (await page.request.get('/api/v1/today')).json();
  const response = await page.request.post('/api/v1/habits', {
    headers: {
      origin: 'http://127.0.0.1:4173',
      'idempotency-key': crypto.randomUUID(),
      'if-match': today.etag,
    },
    data: {
      fields: {
        name,
        description: '',
        active: true,
        deleted: false,
        parent_routine_id: null,
        schedule: { mode: 'explicit', source_routine_revision: null, rule: { type: 'daily' } },
        scheduled_time: { mode: 'explicit', source_routine_revision: null, value: '14:00' },
        minimum_duration_seconds: 60,
        target_amount: null,
        unit: null,
      },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Today LIFEbot' })).toBeVisible();
  const mobileRail = page.getByRole('button', { name: '후보 / Inbox 펼치기' });
  if (await mobileRail.isVisible()) await mobileRail.click();
  const candidate = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
  await candidate.getByRole('button', { name: '시간 배치', exact: true }).click();
  await page.getByRole('button', { name: '계획 저장', exact: true }).click();
  // The accessible list is also available when many test Plans overlap.
  await page.getByText('Plan / Actual 목록 · 겹친 일정과 빠른 완료').click();
  await page
    .locator('details')
    .filter({ hasText: 'Plan / Actual 목록' })
    .locator('div')
    .filter({ has: page.getByRole('button', { name: '계획 열기' }) })
    .filter({ hasText: name })
    .getByRole('button', { name: '계획 열기' })
    .click();
  await page
    .getByRole('region', { name: '시간 배치', exact: true })
    .getByRole('button', { name: '완료', exact: true })
    .click();
  const after = await (await page.request.get('/api/v1/today')).json();
  const habit = after.data.items.find((i: { habit: { name: string } }) => i.habit.name === name);
  expect(habit.execution.status).toBe('completed');
  expect(habit.habit.scheduled_time.value).toBe('14:00');
  // Undo stays bound to the original Plan day even after navigating the calendar.
  await page.getByLabel('날짜', { exact: true }).fill('2026-09-28');
  await expect(page.getByRole('heading', { name: '2026-09-28 LIFEbot' })).toBeVisible();
  await page
    .getByRole('status')
    .filter({ hasText: '완료했습니다.' })
    .getByRole('button', { name: '실행 취소', exact: true })
    .click();
  await expect
    .poll(async () => {
      const current = await (await page.request.get('/api/v1/today')).json();
      return current.data.items.find((i: { habit: { name: string } }) => i.habit.name === name)
        .execution.status;
    })
    .toBe('incomplete');
  await page.goto('/habits/today');
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
});
