import { test, expect, type Page, type TestInfo } from '@playwright/test';

// Unique per project and repetition, so the suite can run repeatedly on one server.
const tag = (info: TestInfo) => `${info.project.name} ${info.repeatEachIndex}`;

// Creates a Habit through the management screen. `advanced` fills optional settings.
async function newHabit(page: Page, name: string, advanced?: (page: Page) => Promise<void>) {
  await page.goto('/habits');
  await page.getByRole('button', { name: '새 습관', exact: true }).click();
  await page.getByLabel('이름', { exact: true }).fill(name);
  await advanced?.(page);
  await page.getByRole('button', { name: '추가', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
}
async function newRoutine(page: Page, name: string, fill?: (page: Page) => Promise<void>) {
  await page.goto('/routines');
  await page.getByRole('button', { name: '새 루틴', exact: true }).click();
  await page.getByLabel('이름', { exact: true }).fill(name);
  await fill?.(page);
  await page.getByRole('button', { name: '추가', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
}
const execution = async (page: Page, name: string) =>
  (await (await page.request.get('/api/v1/today')).json()).data.items.find(
    (i: { habit: { name: string } }) => i.habit.name === name,
  ).execution;
const sheetOf = (page: Page, name: string) =>
  page.getByRole('complementary', { name: `${name} 세부 기록`, exact: true });
// A Routine filter chip; its accessible name also carries the progress count.
const chip = (page: Page, routine: string) =>
  page.getByRole('group', { name: '루틴 필터' }).getByRole('button', {
    name: new RegExp(`^${routine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  });

test('offline attempts fail immediately and never replay on reconnect', async ({
  page,
  context,
}, info) => {
  const name = `오프라인 ${tag(info)}`;
  await newHabit(page, name);
  await page.goto('/');
  await expect(page.getByRole('button', { name: `${name} 완료`, exact: true })).toBeEnabled();
  await context.setOffline(true);
  await page.getByRole('button', { name: `${name} 완료`, exact: true }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toHaveText('오프라인 상태에서는 기록할 수 없어요.');
  await expect(alert).toHaveAttribute('data-error-code', 'NETWORK');
  await context.setOffline(false);
  await page.reload();
  await expect(page.getByRole('button', { name: `${name} 완료`, exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  expect(await execution(page, name)).toBeNull();
});

test('one tap completes with the current draft; completed details stay editable', async ({
  page,
}, info) => {
  const name = `독서 ${tag(info)}`;
  await newHabit(page, name, async (p) => {
    await p.getByText('목표량 · 최소 수행 시간').click();
    await p.getByLabel('목표량', { exact: true }).fill('20');
    await p.getByLabel('단위', { exact: true }).fill('쪽');
    await p.getByLabel('최소 수행 시간 (분)').fill('20');
  });
  await page.goto('/');
  const writes: unknown[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().endsWith('/execution'))
      writes.push(request.postDataJSON());
  });
  const sheet = sheetOf(page, name);
  // Details entered before completion are a local draft only, opened from the ··· button.
  await page.getByRole('button', { name: `${name} 세부 기록`, exact: true }).click();
  await sheet.getByLabel('수행 시간 (분)').fill('12.5');
  await sheet.getByLabel('에너지 메모').fill('차분한 하루.');
  await sheet.getByLabel('난이도 또는 완성도').fill('편안함');
  await sheet.getByLabel('실제 수행량 (쪽)').fill('10');
  await sheet.getByRole('button', { name: '세부 기록 닫기' }).click();
  await page.getByRole('button', { name: `${name} 세부 기록`, exact: true }).click();
  await expect(sheet.getByLabel('실제 수행량 (쪽)')).toHaveValue('10');
  await sheet.getByRole('button', { name: '세부 기록 닫기' }).click();
  expect(await execution(page, name)).toBeNull();
  expect(writes).toHaveLength(0);
  // One tap on the card saves completion and the draft together.
  await page.getByRole('button', { name: `${name} 완료`, exact: true }).click();
  await expect(page.getByRole('button', { name: `${name} 완료`, exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('status').filter({ hasText: `${name} 기록됨 · 09:00` }),
  ).toBeVisible();
  expect(writes).toEqual([
    {
      status: 'completed',
      duration_seconds: 750,
      actual_amount: '10',
      difficulty_or_quality: '편안함',
      energy_note: '차분한 하루.',
    },
  ]);
  expect(await execution(page, name)).toMatchObject({
    status: 'completed',
    completed_at: '2026-09-27T00:00:00Z',
    duration_seconds: 750,
    actual_amount: '10',
    difficulty_or_quality: '편안함',
    energy_note: '차분한 하루.',
    target_amount: '20',
    unit: '쪽',
  });
  // A completed card opens Details instead of toggling.
  await page.reload();
  await page.getByRole('button', { name: `${name} 세부 기록`, exact: true }).click();
  await expect(sheet.getByText('09:00에 완료')).toBeVisible();
  await expect(sheet.getByLabel('수행 시간 (분)')).toHaveValue('12.5');
  await expect(sheet.getByLabel('실제 수행량 (쪽)')).toHaveValue('10');
  await expect(sheet.getByLabel('난이도 또는 완성도')).toHaveValue('편안함');
  await expect(sheet.getByLabel('에너지 메모')).toHaveValue('차분한 하루.');
  expect(await execution(page, name)).toMatchObject({ status: 'completed' });
  // Completed details are editable today with a single completed write that keeps the time.
  writes.splice(0);
  await sheet.getByLabel('에너지 메모').fill('나중에 고침.');
  await sheet.getByRole('button', { name: '세부 기록 저장', exact: true }).click();
  await expect(sheet.getByRole('button', { name: '세부 기록 저장', exact: true })).toBeDisabled();
  expect(writes).toEqual([
    {
      status: 'completed',
      duration_seconds: 750,
      actual_amount: '10',
      difficulty_or_quality: '편안함',
      energy_note: '나중에 고침.',
    },
  ]);
  expect(await execution(page, name)).toMatchObject({
    status: 'completed',
    completed_at: '2026-09-27T00:00:00Z',
    energy_note: '나중에 고침.',
  });
  // Undo in Details leaves no completion details on the incomplete canonical record.
  await sheet.getByRole('button', { name: '완료 취소', exact: true }).click();
  await expect(sheet.getByRole('button', { name: '완료', exact: true })).toBeEnabled();
  expect(await execution(page, name)).toMatchObject({
    status: 'incomplete',
    completed_at: null,
    duration_seconds: null,
    actual_amount: null,
    difficulty_or_quality: null,
    energy_note: null,
  });
  // Undo cancels the completion entirely: no details remain, not even as a local draft.
  for (const label of ['수행 시간 (분)', '실제 수행량 (쪽)', '난이도 또는 완성도', '에너지 메모'])
    await expect(sheet.getByLabel(label)).toHaveValue('');
  await sheet.getByRole('button', { name: '세부 기록 닫기' }).click();
  writes.splice(0);
  await page.getByRole('button', { name: `${name} 완료`, exact: true }).click();
  await expect(page.getByRole('button', { name: `${name} 완료`, exact: true })).toHaveCount(0);
  expect(writes).toEqual([
    {
      status: 'completed',
      duration_seconds: null,
      actual_amount: null,
      difficulty_or_quality: null,
      energy_note: null,
    },
  ]);
  await page.goto('/history');
  await expect(page.getByRole('heading', { name, exact: true }).first()).toBeVisible();
  await page.goto('/statistics');
  await expect(page.getByRole('heading', { name: '일별 달성' })).toBeVisible();
  await page.goto('/settings');
  await page.getByRole('button', { name: '인덱스 재구축', exact: true }).click();
  await expect(page.getByText('원본 Markdown으로 인덱스를 재구축했어요.')).toBeVisible();
  await page.screenshot({ path: `test-results/${info.project.name}-system.png`, fullPage: true });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '오늘의 기록' })).toBeVisible();
  await page.screenshot({ path: `test-results/${info.project.name}-today.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('the Undo snackbar cancels a completion for a few seconds', async ({ page }, info) => {
  const name = `스낵바 ${tag(info)}`;
  await newHabit(page, name);
  await page.goto('/');
  await page.getByRole('button', { name: `${name} 완료`, exact: true }).click();
  const snackbar = page.getByRole('status').filter({ hasText: `${name} 기록됨` });
  await snackbar.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect(page.getByRole('button', { name: `${name} 완료`, exact: true })).toBeEnabled();
  await expect(snackbar).toHaveCount(0);
  expect(await execution(page, name)).toMatchObject({ status: 'incomplete', completed_at: null });
  // Afterwards the snackbar disappears on its own; Undo stays available in Details.
  await page.getByRole('button', { name: `${name} 완료`, exact: true }).click();
  await expect(snackbar).toBeVisible();
  await expect(snackbar).toHaveCount(0, { timeout: 8000 });
  expect(await execution(page, name)).toMatchObject({ status: 'completed' });
});

test('routine inheritance and a flexible weekly quota remain separate from daily tasks', async ({
  page,
}, info) => {
  const routine = `아침 ${tag(info)}`;
  const habit = `운동 ${tag(info)}`;
  await newRoutine(page, routine, async (p) => {
    await p.getByRole('button', { name: '주 N회', exact: true }).click();
    await p.getByRole('spinbutton', { name: '주당 횟수', exact: true }).fill('3');
  });
  await newHabit(page, habit, async (p) => {
    await p.getByText('루틴에 넣기').click();
    await p.getByRole('checkbox', { name: routine, exact: true }).check();
  });
  await page.goto('/');
  await chip(page, routine).click();
  const card = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: habit, exact: true }) });
  await expect(card.getByText('이번 주 0/1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: `${habit} 완료`, exact: true }).click();
  await expect(card.getByText('이번 주 1/1', { exact: true })).toBeVisible();
});

test('a Habit belongs to multiple Routines with shared completion and independent membership controls', async ({
  page,
}, info) => {
  const a = `아침 공유 ${tag(info)}`;
  const b = `저녁 공유 ${tag(info)}`;
  const c = `추가 공유 ${tag(info)}`;
  const name = `108배 ${tag(info)}`;
  for (const [routine, time] of [
    [a, '07:00'],
    [b, '21:00'],
    [c, ''],
  ])
    await newRoutine(page, routine, async (p) => {
      await p.getByLabel('예정 시간 (선택)').fill(time);
    });
  await newHabit(page, name, async (p) => {
    await p.getByText('루틴에 넣기').click();
    await p.getByRole('checkbox', { name: a, exact: true }).check();
    await p.getByRole('checkbox', { name: b, exact: true }).check();
    await p.getByRole('checkbox', { name: '루틴 반복 주기 따르기', exact: true }).uncheck();
    await p.getByRole('button', { name: '매일', exact: true }).click();
  });
  await page.goto('/');
  const card = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
  const sheet = sheetOf(page, name);
  // Each Routine shows the Habit at its own time.
  await chip(page, a).click();
  await expect(card.getByText('07:00')).toBeVisible();
  await chip(page, b).click();
  await expect(card.getByText('21:00')).toBeVisible();
  // A draft written under one Routine is completed from another: one shared completion.
  await chip(page, a).click();
  await page.getByRole('button', { name: `${name} 세부 기록`, exact: true }).click();
  await sheet.getByLabel('에너지 메모').fill('하나의 완료');
  await sheet.getByRole('button', { name: '세부 기록 닫기' }).click();
  await chip(page, b).click();
  await page.getByRole('button', { name: `${name} 완료`, exact: true }).click();
  await expect(page.getByRole('button', { name: `${name} 완료`, exact: true })).toHaveCount(0);
  await chip(page, a).click();
  await expect(page.getByRole('button', { name: `${name} 완료`, exact: true })).toHaveCount(0);
  await page.reload();
  await chip(page, b).click();
  await page.getByRole('button', { name: `${name} 세부 기록`, exact: true }).click();
  await expect(sheet.getByLabel('에너지 메모')).toHaveValue('하나의 완료');
  const today = await (await page.request.get('/api/v1/today')).json();
  const items = today.data.items.filter((i: { habit: { name: string } }) => i.habit.name === name);
  expect(items).toHaveLength(1);
  expect(items[0].routine_contexts).toHaveLength(2);
  await sheet.getByRole('button', { name: '완료 취소', exact: true }).click();
  await expect(sheet.getByRole('button', { name: '완료', exact: true })).toBeEnabled();
  await sheet.getByRole('button', { name: '세부 기록 닫기' }).click();
  for (const routine of [a, b]) {
    await chip(page, routine).click();
    await expect(page.getByRole('button', { name: `${name} 완료`, exact: true })).toBeEnabled();
  }
  // Adding an existing Habit from another Routine never moves it out of the first two.
  await page.goto('/routines');
  await page.getByRole('button', { name: c, exact: true }).click();
  await page.getByLabel('기존 습관 추가').selectOption({ label: name });
  await page.getByRole('button', { name: '루틴에 추가', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByRole('button', { name: '제거', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: '편집 닫기' }).click();
  await page.goto('/habits');
  await page.getByRole('button', { name, exact: true }).click();
  // "루틴에 넣기" opens by itself once the Habit belongs to a Routine.
  for (const routine of [a, b, c])
    await expect(page.getByRole('checkbox', { name: routine, exact: true })).toBeChecked();
  await page.getByRole('checkbox', { name: b, exact: true }).uncheck();
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button', { name, exact: true }).click();
  // "루틴에 넣기" opens by itself once the Habit belongs to a Routine.
  await expect(page.getByRole('checkbox', { name: a, exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: b, exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: c, exact: true })).toBeChecked();
});

test('details remain an unsaved draft; one tap completes without details', async ({
  page,
}, info) => {
  const name = `초안 ${tag(info)}`;
  await newHabit(page, name);
  await page.goto('/');
  const sheet = sheetOf(page, name);
  const more = page.getByRole('button', { name: `${name} 세부 기록`, exact: true });
  await more.click();
  await sheet.getByLabel('수행 시간 (분)').fill('8');
  await sheet.getByLabel('실제 수행량', { exact: true }).fill('2');
  await sheet.getByLabel('난이도 또는 완성도').fill('힘듦');
  await sheet.getByLabel('에너지 메모').fill('저장 안 된 메모');
  await sheet.getByLabel('실제 수행량', { exact: true }).press('Enter');
  // A draft lives only in this page: a reload drops it and nothing was saved.
  await page.reload();
  await more.click();
  for (const label of ['수행 시간 (분)', '실제 수행량', '난이도 또는 완성도', '에너지 메모'])
    await expect(sheet.getByLabel(label, { exact: true })).toHaveValue('');
  expect(await execution(page, name)).toBeNull();
  // Cancel discards the draft.
  await sheet.getByLabel('에너지 메모').fill('취소한 메모');
  await sheet.getByRole('button', { name: '취소', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await more.click();
  await expect(sheet.getByLabel('에너지 메모')).toHaveValue('');
  expect(await execution(page, name)).toBeNull();
  // An invalid draft blocks completion instead of sending it, from the sheet or the card.
  await sheet.getByLabel('실제 수행량', { exact: true }).fill('abc');
  await sheet.getByRole('button', { name: '완료', exact: true }).click();
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: '세부 기록 닫기' }).click();
  await page.getByRole('button', { name: `${name} 완료`, exact: true }).click();
  await expect(page.getByRole('button', { name: `${name} 완료`, exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  expect(await execution(page, name)).toBeNull();
  await more.click();
  await sheet.getByRole('button', { name: '취소', exact: true }).click();
  // Completion without details is a single tap.
  await page.getByRole('button', { name: `${name} 완료`, exact: true }).click();
  await expect(page.getByRole('button', { name: `${name} 완료`, exact: true })).toHaveCount(0);
  expect(await execution(page, name)).toMatchObject({
    status: 'completed',
    completed_at: '2026-09-27T00:00:00Z',
    duration_seconds: null,
    actual_amount: null,
    difficulty_or_quality: null,
    energy_note: null,
  });
});

test('completing two Habits back to back saves both without a conflict', async ({ page }, info) => {
  const run = `${info.project.name} ${info.repeatEachIndex}`;
  const names = [`첫 번째 ${run}`, `두 번째 ${run}`];
  for (const name of names) await newHabit(page, name);
  await page.goto('/');
  for (const name of names)
    await expect(page.getByRole('button', { name: `${name} 완료`, exact: true })).toBeEnabled();
  // Both taps happen before the first write finishes.
  await page.evaluate((names) => {
    for (const name of names)
      document.querySelector<HTMLButtonElement>(`button[aria-label="${name} 완료"]`)!.click();
  }, names);
  for (const name of names)
    await expect(page.getByRole('button', { name: `${name} 완료`, exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  for (const name of names) expect((await execution(page, name)).status).toBe('completed');
});

test('the dashboard loads with a fixed number of requests, not one per Habit', async ({ page }) => {
  const statistics: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/statistics')) statistics.push(r.url());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '오늘의 기록' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(statistics.every((url) => !url.includes('habit_id'))).toBe(true);
  expect(statistics.length).toBeLessThanOrEqual(3);
  // Collapsed by default: Habits not due today.
  const collapsed = page.getByRole('button', { name: /^오늘 예정 없음/ });
  if (await collapsed.count()) await expect(collapsed).toHaveAttribute('aria-expanded', 'false');
});
