import { test, expect, type Page } from '@playwright/test';
const detailsOf = (page: Page, name: string) =>
  page.getByRole('complementary', { name: `${name} 세부 기록`, exact: true });
const isMobile = (projectName: string) => projectName.includes('mobile');
test('offline attempts fail immediately and never replay on reconnect', async ({
  page,
  context,
}, info) => {
  const name = `Offline ${info.project.name}`;
  await page.goto('/habits');
  await page.getByRole('button', { name: '새 습관', exact: true }).click();
  await page.getByLabel('이름', { exact: true }).fill(name);
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('link', { name: '오늘', exact: true }).click();
  await context.setOffline(true);
  await page.getByRole('button', { name: `${name} 완료`, exact: true }).click();
  const details = detailsOf(page, name);
  await details.getByRole('button', { name: '저장하고 완료', exact: true }).click();
  await expect(details.getByRole('alert').filter({ hasText: '저장되지 않았어요' })).toBeVisible();
  await context.setOffline(false);
  await page.reload();
  await expect(page.getByRole('button', { name: `${name} 완료`, exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});
test('complete with one details mutation, reload, inspect statistics and rebuild', async ({
  page,
}, info) => {
  const name = `Reading ${info.project.name}`;
  await page.goto('/habits');
  await page.getByRole('button', { name: '새 습관', exact: true }).click();
  await page.getByLabel('이름', { exact: true }).fill(name);
  await page.getByLabel('최소 수행 시간 (분)').fill('20');
  await page.getByLabel('목표량').fill('20');
  await page.getByLabel('단위', { exact: true }).fill('pages');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('link', { name: '오늘', exact: true }).click();
  const card = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
  const details = detailsOf(page, name);
  const writes: unknown[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().endsWith('/execution'))
      writes.push(request.postDataJSON());
  });
  await card.getByRole('button', { name: `${name} 완료`, exact: true }).click();
  await expect(card.getByRole('button', { name: `${name} 완료`, exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  // Details are only saved together with completion; there is no separate save.
  await expect(page.getByRole('button', { name: '저장', exact: true })).toHaveCount(0);
  await details.getByLabel('수행 시간 (분)').fill('12.5');
  await details.getByLabel('에너지 메모').fill('A calm day.');
  await details.getByLabel('난이도 또는 완성도').fill('Comfortable');
  await details.getByLabel('실제 수행량 (pages)').fill('10');
  await details.getByRole('button', { name: '세부 기록 닫기', exact: true }).click();
  await expect(details).toHaveCount(0);
  await card.getByRole('button', { name, exact: true }).click();
  await expect(details.getByLabel('실제 수행량 (pages)')).toHaveValue('10');
  const before = await (await page.request.get('/api/v1/today')).json();
  expect(
    before.data.items.find((i: { habit: { name: string } }) => i.habit.name === name).execution,
  ).toBeNull();
  expect(writes).toHaveLength(0);
  if (!isMobile(info.project.name)) {
    // On desktop the details column stays beside the list; the check only opens details.
    await card.getByRole('button', { name: `${name} 완료`, exact: true }).click();
    expect(writes).toHaveLength(0);
  }
  await details.getByRole('button', { name: '저장하고 완료', exact: true }).click();
  await expect(
    page.getByRole('button', { name: `${name} 완료 취소`, exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  expect(writes).toEqual([
    {
      status: 'completed',
      duration_seconds: 750,
      actual_amount: '10',
      difficulty_or_quality: 'Comfortable',
      energy_note: 'A calm day.',
    },
  ]);
  const saved = await (await page.request.get('/api/v1/today')).json();
  const completed = saved.data.items.find(
    (i: { habit: { name: string } }) => i.habit.name === name,
  ).execution;
  expect(completed).toMatchObject({
    status: 'completed',
    completed_at: '2026-09-27T00:00:00Z',
    duration_seconds: 750,
    actual_amount: '10',
    difficulty_or_quality: 'Comfortable',
    energy_note: 'A calm day.',
    target_amount: '20',
    unit: 'pages',
  });
  await page.reload();
  await card.getByRole('button', { name, exact: true }).click();
  await expect(details.getByLabel('수행 시간 (분)')).toHaveValue('12.5');
  await expect(details.getByLabel('실제 수행량 (pages)')).toHaveValue('10');
  await expect(details.getByLabel('난이도 또는 완성도')).toHaveValue('Comfortable');
  await expect(details.getByLabel('에너지 메모')).toHaveValue('A calm day.');
  await expect(details.getByLabel('에너지 메모')).toBeDisabled();
  // Undo must not leave completion-only context on an incomplete canonical record.
  await details.getByRole('button', { name: '완료 취소', exact: true }).click();
  await expect(page.getByRole('button', { name: `${name} 완료`, exact: true })).toBeEnabled();
  const undone = await (await page.request.get('/api/v1/today')).json();
  expect(
    undone.data.items.find((i: { habit: { name: string } }) => i.habit.name === name).execution,
  ).toMatchObject({
    status: 'incomplete',
    completed_at: null,
    duration_seconds: null,
    actual_amount: null,
    difficulty_or_quality: null,
    energy_note: null,
  });
  await expect(details.getByLabel('에너지 메모')).toHaveValue('A calm day.');
  await details.getByRole('button', { name: '저장하고 완료', exact: true }).click();
  await expect(page.getByRole('button', { name: `${name} 완료 취소`, exact: true })).toBeEnabled();
  await page.getByRole('link', { name: '기록', exact: true }).click();
  await expect(page.getByText('A calm day.', { exact: true }).first()).toBeVisible();
  await page.getByRole('link', { name: '통계', exact: true }).click();
  await expect(page.getByRole('heading', { name: '일별 달성' })).toBeVisible();
  if (isMobile(info.project.name))
    await page.getByRole('link', { name: '관리', exact: true }).click();
  await page.getByRole('link', { name: '설정', exact: true }).click();
  await page.getByRole('button', { name: '인덱스 재구축', exact: true }).click();
  await expect(page.getByText('원본 Markdown으로 인덱스를 재구축했어요.')).toBeVisible();
  await page.screenshot({ path: `test-results/${info.project.name}-system.png`, fullPage: true });
  await page.getByRole('link', { name: '오늘', exact: true }).click();
  await page.screenshot({ path: `test-results/${info.project.name}-today.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test('routine inheritance and a flexible weekly quota remain separate from daily tasks', async ({
  page,
}, info) => {
  const routine = `Morning ${info.project.name}`;
  const habit = `Exercise ${info.project.name}`;
  await page.goto('/routines');
  await page.getByRole('button', { name: '새 루틴', exact: true }).click();
  await page.getByLabel('이름', { exact: true }).fill(routine);
  await page.getByRole('button', { name: '주 N회', exact: true }).click();
  await page.getByRole('spinbutton', { name: '주당 횟수', exact: true }).fill('3');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('link', { name: '습관', exact: true }).click();
  await page.getByRole('button', { name: '새 습관', exact: true }).click();
  await page.getByLabel('이름', { exact: true }).fill(habit);
  await page.getByRole('checkbox', { name: routine, exact: true }).check();
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('link', { name: '오늘', exact: true }).click();
  await expect(page.getByRole('heading', { name: routine, exact: true })).toBeVisible();
  const card = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: habit, exact: true }) });
  await expect(card.getByText('이번 주 0 / 1 · 첫 주 조정', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: `${habit} 완료`, exact: true }).click();
  await detailsOf(page, habit).getByRole('button', { name: '저장하고 완료', exact: true }).click();
  await expect(card.getByText(/이번 주 1 \/ 1/)).toBeVisible();
});

test('a Habit belongs to multiple Routines with shared completion and independent membership controls', async ({
  page,
}, info) => {
  const a = `Morning shared ${info.project.name}`;
  const b = `Evening shared ${info.project.name}`;
  const c = `Extra shared ${info.project.name}`;
  const name = `108 bows ${info.project.name}`;
  for (const [routine, time] of [
    [a, '07:00'],
    [b, '21:00'],
    [c, ''],
  ]) {
    await page.goto('/routines');
    await page.getByRole('button', { name: '새 루틴', exact: true }).click();
    await page.getByLabel('이름', { exact: true }).fill(routine);
    await page.getByLabel('예정 시간 (선택)').fill(time);
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  }
  await page.goto('/habits');
  await page.getByRole('button', { name: '새 습관', exact: true }).click();
  await page.getByLabel('이름', { exact: true }).fill(name);
  await page.getByRole('checkbox', { name: a, exact: true }).check();
  await page.getByRole('checkbox', { name: b, exact: true }).check();
  await page.getByRole('checkbox', { name: '루틴 반복 주기 따르기', exact: true }).uncheck();
  await page.getByRole('button', { name: '매일', exact: true }).click();
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('link', { name: '오늘', exact: true }).click();
  const groupA = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: a, exact: true }) });
  const groupB = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: b, exact: true }) });
  const details = detailsOf(page, name);
  await expect(groupA.getByText('07:00').first()).toBeVisible();
  await expect(groupB.getByText('21:00').first()).toBeVisible();
  await groupA.getByRole('button', { name: `${name} 완료`, exact: true }).click();
  await details.getByLabel('에너지 메모').fill('One shared completion');
  await details.getByRole('button', { name: '저장하고 완료', exact: true }).click();
  for (const group of [groupA, groupB])
    await expect(
      group.getByRole('button', { name: `${name} 완료 취소`, exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  // Routines that are already finished start folded.
  await groupA.getByRole('button', { name: `${a} 펼치기`, exact: true }).click();
  await groupB.getByRole('button', { name: `${b} 펼치기`, exact: true }).click();
  await groupB.getByRole('button', { name, exact: true }).click();
  await expect(details.getByLabel('에너지 메모')).toHaveValue('One shared completion');
  const today = await (await page.request.get('/api/v1/today')).json();
  const items = today.data.items.filter((i: { habit: { name: string } }) => i.habit.name === name);
  expect(items).toHaveLength(1);
  expect(items[0].routine_contexts).toHaveLength(2);
  await details.getByRole('button', { name: '완료 취소', exact: true }).click();
  await details.getByRole('button', { name: '세부 기록 닫기', exact: true }).click();
  for (const group of [groupA, groupB])
    await expect(group.getByRole('button', { name: `${name} 완료`, exact: true })).toBeEnabled();
  // Adding an existing Habit from another Routine never moves it out of the first two.
  await page.goto('/routines');
  const extra = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: c, exact: true }) });
  await extra.getByRole('button', { name: c, exact: true }).click();
  await page.getByLabel('기존 습관 추가').selectOption({ label: name });
  await page.getByRole('button', { name: '루틴에 추가', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByRole('button', { name: '제거', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: '편집 닫기' }).click();
  await page.goto('/habits');
  const habit = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
  await habit.getByRole('button', { name, exact: true }).click();
  for (const routine of [a, b, c])
    await expect(page.getByRole('checkbox', { name: routine, exact: true })).toBeChecked();
  await page.getByRole('checkbox', { name: b, exact: true }).uncheck();
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await habit.getByRole('button', { name: `${name} 메뉴`, exact: true }).click();
  await page.getByRole('menuitem', { name: '습관 수정', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: a, exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: b, exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: c, exact: true })).toBeChecked();
});

test('details remain an unsaved draft; completion without details still works', async ({
  page,
}, info) => {
  const name = `Draft ${info.project.name}`;
  await page.goto('/habits');
  await page.getByRole('button', { name: '새 습관', exact: true }).click();
  await page.getByLabel('이름', { exact: true }).fill(name);
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('link', { name: '오늘', exact: true }).click();
  const card = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
  const details = detailsOf(page, name);
  await card.getByRole('button', { name, exact: true }).click();
  await details.getByLabel('수행 시간 (분)').fill('8');
  await details.getByLabel('실제 수행량', { exact: true }).fill('2');
  await details.getByLabel('난이도 또는 완성도').fill('Hard');
  await details.getByLabel('에너지 메모').fill('Unsaved note');
  await details.getByLabel('실제 수행량', { exact: true }).press('Enter');
  await page.reload();
  await card.getByRole('button', { name, exact: true }).click();
  for (const label of ['수행 시간 (분)', '실제 수행량', '난이도 또는 완성도', '에너지 메모'])
    await expect(details.getByLabel(label, { exact: true })).toHaveValue('');
  const before = await (await page.request.get('/api/v1/today')).json();
  expect(
    before.data.items.find((i: { habit: { name: string } }) => i.habit.name === name).execution,
  ).toBeNull();
  await details.getByRole('button', { name: '세부 기록 닫기', exact: true }).click();
  await page.getByRole('button', { name: `${name} 완료`, exact: true }).click();
  await details.getByLabel('에너지 메모').fill('Cancelled note');
  await details.getByRole('button', { name: '취소', exact: true }).click();
  await expect(details.getByLabel('에너지 메모')).toHaveCount(0);
  const cancelled = await (await page.request.get('/api/v1/today')).json();
  expect(
    cancelled.data.items.find((i: { habit: { name: string } }) => i.habit.name === name).execution,
  ).toBeNull();
  await page.getByRole('button', { name: `${name} 완료`, exact: true }).click();
  await expect(details.getByLabel('에너지 메모')).toHaveValue('');
  await details.getByRole('button', { name: '저장하고 완료', exact: true }).click();
  await expect(page.getByRole('button', { name: `${name} 완료 취소`, exact: true })).toBeEnabled();
  const after = await (await page.request.get('/api/v1/today')).json();
  expect(
    after.data.items.find((i: { habit: { name: string } }) => i.habit.name === name).execution,
  ).toMatchObject({
    status: 'completed',
    completed_at: '2026-09-27T00:00:00Z',
    duration_seconds: null,
    actual_amount: null,
    difficulty_or_quality: null,
    energy_note: null,
  });
});
