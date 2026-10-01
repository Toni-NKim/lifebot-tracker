// The Details sheet is modal: while it is open, keyboard and pointer stay inside it and
// the dashboard behind it cannot be focused or activated. Runs as a bottom sheet on the
// mobile project and as a side panel on the desktop project.
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const origin = 'http://127.0.0.1:4173';
async function habit(page: Page, name: string) {
  const { etag } = await (await page.request.get('/api/v1/today')).json();
  const response = await page.request.post('/api/v1/habits', {
    headers: { origin, 'idempotency-key': randomUUID(), 'if-match': etag },
    data: {
      fields: {
        name,
        description: '',
        active: true,
        deleted: false,
        parent_routine_id: null,
        routine_ids: [],
        schedule: { mode: 'explicit', source_routine_revision: null, rule: { type: 'daily' } },
        scheduled_time: { mode: 'explicit', source_routine_revision: null, value: null },
        minimum_duration_seconds: null,
        target_amount: null,
        unit: null,
      },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
}
const execution = async (page: Page, name: string) =>
  (await (await page.request.get('/api/v1/today')).json()).data.items.find(
    (i: { habit: { name: string } }) => i.habit.name === name,
  ).execution;
// Accessible name of the focused element and whether it is inside the open sheet.
const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return {
      label: el?.getAttribute('aria-label') ?? el?.textContent?.trim() ?? '',
      inSheet: !!el?.closest('[data-details-sheet]'),
    };
  });
const focusables = (page: Page) =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '[data-details-sheet] :is(button, input, textarea, select, summary, a[href])',
      ),
    ]
      .filter((el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null)
      .map((el) => el.getAttribute('aria-label') ?? el.textContent?.trim() ?? ''),
  );

async function setup(page: Page) {
  const suffix = randomUUID().slice(0, 6);
  const [a, b] = [`Modal A ${suffix}`, `Modal B ${suffix}`];
  await habit(page, a);
  await habit(page, b);
  await page.goto('/habits/today');
  const more = page.getByRole('button', { name: `${a} 세부 기록`, exact: true });
  await expect(page.getByRole('button', { name: `${b} 완료`, exact: true })).toBeEnabled();
  // The other Habit's card stays on screen so a tap can be aimed at it later.
  await page.getByRole('button', { name: `${b} 완료`, exact: true }).scrollIntoViewIfNeeded();
  // Opened from the keyboard, so the opener is the focused ··· button.
  await more.evaluate((el) => el.focus({ preventScroll: true }));
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog', { name: `${a} 세부 기록`, exact: true });
  await expect(sheet).toBeVisible();
  return { a, b, sheet };
}

test('Tab and Shift+Tab stay inside the Details sheet and wrap around', async ({ page }) => {
  const { a } = await setup(page);
  const order = await focusables(page);
  expect(order.length).toBeGreaterThan(3);
  for (let i = 0; i < order.length + 3; i++) {
    await page.keyboard.press('Tab');
    expect(await focused(page)).toMatchObject({ inSheet: true });
  }
  for (let i = 0; i < order.length + 3; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(await focused(page)).toMatchObject({ inSheet: true });
  }
  // From the last control Tab goes to the first, and Shift+Tab back to the last.
  await page
    .locator('[data-details-sheet] :is(button, input, textarea, summary)')
    .filter({ visible: true })
    .and(page.locator(':not([disabled])'))
    .last()
    .focus();
  expect((await focused(page)).label).toBe(order.at(-1));
  await page.keyboard.press('Tab');
  expect((await focused(page)).label).toBe(order[0]);
  await page.keyboard.press('Shift+Tab');
  expect((await focused(page)).label).toBe(order.at(-1));
  expect(await execution(page, a)).toBeNull();
});

test('the dashboard behind the open sheet cannot be focused or activated', async ({
  page,
  browserName,
}) => {
  const { a, b, sheet } = await setup(page);
  // Background controls are inert: the browser's accessibility tree leaves them out...
  await expect(page.locator('dialog[data-details-sheet]')).toHaveJSProperty('open', true);
  expect(await page.evaluate(() => !!document.querySelector('dialog:modal'))).toBe(true);
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    const { nodes } = await cdp.send('Accessibility.queryAXTree', {
      backendNodeId: (
        await cdp.send('DOM.describeNode', {
          objectId: (
            await cdp.send('Runtime.evaluate', {
              expression: `document.querySelector('button[aria-label="${b} 완료"]')`,
            })
          ).result.objectId,
        })
      ).node.backendNodeId,
    });
    expect(nodes.every((node) => node.ignored)).toBe(true);
  }
  // ...and they cannot take focus.
  const focusedB = await page.evaluate((name) => {
    const button = document.querySelector<HTMLElement>(`button[aria-label="${name} 완료"]`)!;
    button.focus();
    return document.activeElement === button;
  }, b);
  expect(focusedB).toBe(false);
  // Keyboard: no number of Tabs reaches another Habit's completion button.
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    expect((await focused(page)).label).not.toBe(`${b} 완료`);
  }
  // Pointer: a tap where the other card is shown completes nothing.
  const box = await page.evaluate((name) => {
    const r = document.querySelector(`button[aria-label="${name} 완료"]`)!.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, b);
  const viewport = page.viewportSize()!;
  expect(box.y).toBeGreaterThan(0);
  expect(box.y).toBeLessThan(viewport.height);
  const r = (await sheet.boundingBox())!;
  const underSheet =
    box.x >= r.x && box.x <= r.x + r.width && box.y >= r.y && box.y <= r.y + r.height;
  await page.mouse.click(box.x, box.y);
  await page.waitForTimeout(300);
  expect(await execution(page, b)).toBeNull();
  expect(await execution(page, a)).toBeNull();
  // A tap outside the sheet only closes it; one on the sheet keeps it open.
  if (underSheet) await expect(sheet).toBeVisible();
  else await expect(sheet).toHaveCount(0);
});

test('Escape closes the sheet and focus returns to the control that opened it', async ({
  page,
}) => {
  const { a, sheet } = await setup(page);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  expect((await focused(page)).label).toBe(`${a} 세부 기록`);
  // The close button restores focus the same way.
  await page.keyboard.press('Enter');
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: '세부 기록 닫기' }).click();
  await expect(sheet).toHaveCount(0);
  expect((await focused(page)).label).toBe(`${a} 세부 기록`);
});

test('after completing in the sheet focus returns to the Habit card', async ({ page }) => {
  const { a, sheet } = await setup(page);
  await sheet.getByRole('button', { name: '완료', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  // The ··· opener is gone once the Habit is complete; focus lands on its card instead.
  await expect(page.getByRole('button', { name: `${a} 완료`, exact: true })).toHaveCount(0);
  expect(await focused(page)).toMatchObject({ label: `${a} 세부 기록`, inSheet: false });
});
