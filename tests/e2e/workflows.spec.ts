import { test, expect } from '@playwright/test';
test('offline attempts fail immediately and never replay on reconnect', async ({
  page,
  context,
}, info) => {
  const name = `Offline ${info.project.name}`;
  await page.goto('/habits');
  await page.getByRole('button', { name: '+ New habit', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await context.setOffline(true);
  await page.getByRole('button', { name: `Complete ${name}`, exact: true }).click();
  await page.getByRole('button', { name: 'Save and complete', exact: true }).click();
  const card = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
  await expect(card.getByRole('alert').filter({ hasText: 'Nothing was saved' })).toBeVisible();
  await context.setOffline(false);
  await page.reload();
  await expect(page.getByRole('button', { name: `Complete ${name}`, exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});
test('complete with one details mutation, reload, inspect statistics and rebuild', async ({
  page,
}, info) => {
  const name = `Reading ${info.project.name}`;
  await page.goto('/habits');
  await page.getByRole('button', { name: '+ New habit', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Minimum duration (minutes)').fill('20');
  await page.getByLabel('Target amount').fill('20');
  await page.getByLabel('Unit', { exact: true }).fill('pages');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  const card = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
  const writes: unknown[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().endsWith('/execution'))
      writes.push(request.postDataJSON());
  });
  await card.getByRole('button', { name: `Complete ${name}`, exact: true }).click();
  await expect(card.getByRole('button', { name: `Complete ${name}`, exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(card.getByRole('button', { name: 'Save details', exact: true })).toHaveCount(0);
  await card.getByLabel('Duration (minutes)').fill('12.5');
  await card.getByLabel('Energy note').fill('A calm day.');
  await card.getByLabel('Difficulty or quality').fill('Comfortable');
  await card.getByLabel('Actual amount (pages)').fill('10');
  await card.getByRole('button', { name: 'Details −', exact: true }).click();
  await card.getByRole('button', { name: 'Details +', exact: true }).click();
  await expect(card.getByLabel('Actual amount (pages)')).toHaveValue('10');
  const before = await (await page.request.get('/api/v1/today')).json();
  expect(
    before.data.items.find((i: { habit: { name: string } }) => i.habit.name === name).execution,
  ).toBeNull();
  expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: `Complete ${name}`, exact: true }).click();
  expect(writes).toHaveLength(0);
  await card.getByRole('button', { name: 'Save and complete', exact: true }).click();
  await expect(page.getByRole('button', { name: `Undo ${name}`, exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
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
  await card.getByRole('button', { name: 'Details +', exact: true }).click();
  await expect(card.getByLabel('Duration (minutes)')).toHaveValue('12.5');
  await expect(card.getByLabel('Actual amount (pages)')).toHaveValue('10');
  await expect(card.getByLabel('Difficulty or quality')).toHaveValue('Comfortable');
  await expect(card.getByLabel('Energy note')).toHaveValue('A calm day.');
  await expect(card.getByLabel('Energy note')).toBeDisabled();
  // Undo must not leave completion-only context on an incomplete canonical record.
  await page.getByRole('button', { name: `Undo ${name}`, exact: true }).click();
  await expect(page.getByRole('button', { name: `Complete ${name}`, exact: true })).toBeEnabled();
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
  await expect(card.getByLabel('Energy note')).toHaveValue('A calm day.');
  await page.getByRole('button', { name: `Complete ${name}`, exact: true }).click();
  await card.getByRole('button', { name: 'Save and complete', exact: true }).click();
  await expect(page.getByRole('button', { name: `Undo ${name}`, exact: true })).toBeEnabled();
  await page.getByRole('link', { name: 'History', exact: true }).click();
  await expect(page.getByText('A calm day.', { exact: true }).first()).toBeVisible();
  await page.getByRole('link', { name: 'Statistics', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Daily consistency' })).toBeVisible();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Rebuild index', exact: true }).click();
  await expect(page.getByText('Index rebuilt from canonical Markdown.')).toBeVisible();
  await page.screenshot({ path: `test-results/${info.project.name}-system.png`, fullPage: true });
  await page.getByRole('link', { name: 'Today', exact: true }).click();
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
  await page.getByRole('button', { name: '+ New routine', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill(routine);
  await page.getByRole('combobox', { name: 'Frequency', exact: true }).selectOption('weekly_quota');
  await page.getByRole('spinbutton', { name: 'Times per week', exact: true }).fill('3');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('link', { name: 'Habits', exact: true }).click();
  await page.getByRole('button', { name: '+ New habit', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill(habit);
  await page.getByRole('checkbox', { name: routine, exact: true }).check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(page.getByRole('heading', { name: routine, exact: true })).toBeVisible();
  const card = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: habit, exact: true }) });
  await expect(
    card.getByText('0 / 1 this week · adjusted first period', { exact: true }),
  ).toBeVisible();
  await card.getByRole('button', { name: `Complete ${habit}`, exact: true }).click();
  await card.getByRole('button', { name: 'Save and complete', exact: true }).click();
  await expect(card.getByText(/1 \/ 1 this week/)).toBeVisible();
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
    await page.getByRole('button', { name: '+ New routine', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill(routine);
    await page.getByLabel('Scheduled time (optional)').fill(time);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  }
  await page.goto('/habits');
  await page.getByRole('button', { name: '+ New habit', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByRole('checkbox', { name: a, exact: true }).check();
  await page.getByRole('checkbox', { name: b, exact: true }).check();
  await page.getByRole('checkbox', { name: 'Inherit Routine schedule', exact: true }).uncheck();
  await page.getByRole('combobox', { name: 'Frequency', exact: true }).selectOption('daily');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  const groupA = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: a, exact: true }) });
  const groupB = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: b, exact: true }) });
  await expect(groupA.getByText('07:00', { exact: false })).toBeVisible();
  await expect(groupB.getByText('21:00', { exact: false })).toBeVisible();
  await groupA.getByRole('button', { name: `Complete ${name}`, exact: true }).click();
  await groupA.getByLabel('Energy note').fill('One shared completion');
  await groupA.getByRole('button', { name: 'Save and complete', exact: true }).click();
  for (const group of [groupA, groupB])
    await expect(group.getByRole('button', { name: `Undo ${name}`, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  await page.reload();
  await groupB.getByRole('button', { name: 'Details +', exact: true }).click();
  await expect(groupB.getByLabel('Energy note')).toHaveValue('One shared completion');
  const today = await (await page.request.get('/api/v1/today')).json();
  const items = today.data.items.filter((i: { habit: { name: string } }) => i.habit.name === name);
  expect(items).toHaveLength(1);
  expect(items[0].routine_contexts).toHaveLength(2);
  await groupB.getByRole('button', { name: `Undo ${name}`, exact: true }).click();
  for (const group of [groupA, groupB])
    await expect(
      group.getByRole('button', { name: `Complete ${name}`, exact: true }),
    ).toBeEnabled();
  // Adding an existing Habit from another Routine never moves it out of the first two.
  await page.goto('/routines');
  const extra = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: c, exact: true }) });
  await extra.getByRole('button', { name: 'Edit routine', exact: true }).click();
  await page.getByLabel('Add an existing habit').selectOption({ label: name });
  await page.getByRole('button', { name: 'Add to routine', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Close editor' }).click();
  await page.goto('/habits');
  const habit = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
  await habit.getByRole('button', { name: 'Edit habit', exact: true }).click();
  for (const routine of [a, b, c])
    await expect(page.getByRole('checkbox', { name: routine, exact: true })).toBeChecked();
  await page.getByRole('checkbox', { name: b, exact: true }).uncheck();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await habit.getByRole('button', { name: 'Edit habit', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: a, exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: b, exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: c, exact: true })).toBeChecked();
});

test('details remain an unsaved draft; completion without details still works', async ({
  page,
}, info) => {
  const name = `Draft ${info.project.name}`;
  await page.goto('/habits');
  await page.getByRole('button', { name: '+ New habit', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  const card = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
  await card.getByRole('button', { name: 'Details +', exact: true }).click();
  await card.getByLabel('Duration (minutes)').fill('8');
  await card.getByLabel('Actual amount', { exact: true }).fill('2');
  await card.getByLabel('Difficulty or quality').fill('Hard');
  await card.getByLabel('Energy note').fill('Unsaved note');
  await card.getByLabel('Actual amount', { exact: true }).press('Enter');
  await page.reload();
  await card.getByRole('button', { name: 'Details +', exact: true }).click();
  for (const label of [
    'Duration (minutes)',
    'Actual amount',
    'Difficulty or quality',
    'Energy note',
  ])
    await expect(card.getByLabel(label, { exact: true })).toHaveValue('');
  const before = await (await page.request.get('/api/v1/today')).json();
  expect(
    before.data.items.find((i: { habit: { name: string } }) => i.habit.name === name).execution,
  ).toBeNull();
  await page.getByRole('button', { name: `Complete ${name}`, exact: true }).click();
  await card.getByLabel('Energy note').fill('Cancelled note');
  await card.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(card.getByLabel('Energy note')).toHaveCount(0);
  const cancelled = await (await page.request.get('/api/v1/today')).json();
  expect(
    cancelled.data.items.find((i: { habit: { name: string } }) => i.habit.name === name).execution,
  ).toBeNull();
  await page.getByRole('button', { name: `Complete ${name}`, exact: true }).click();
  await expect(card.getByLabel('Energy note')).toHaveValue('');
  await card.getByRole('button', { name: 'Save and complete', exact: true }).click();
  await expect(page.getByRole('button', { name: `Undo ${name}`, exact: true })).toBeEnabled();
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
