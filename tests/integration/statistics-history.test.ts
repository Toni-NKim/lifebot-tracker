// Statistics range rules and history paging on a small scenario with hand-computed
// expectations (see docs/decisions.md: dated rates include today, quota rates use
// finalized periods by their end date, a zero denominator is null).
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { harness, habitFields, execution } from '../helpers.js';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

// Mon 2026-09-21 start. D: daily. W: 2 per week.
// D completed on 21, 22, 24. W completed on 21, 22 (week 21–27 met) and 29 (week 28–Oct 4: 1 of 2).
async function scenario() {
  const t = await harness('2026-09-21');
  cleanups.push(t.cleanup);
  const at = (day: string) => t.setNow(`${day}T03:00:00Z`);
  const d = await t.create(habitFields({ name: 'D' }));
  const w = await t.create(
    habitFields({
      name: 'W',
      schedule: {
        mode: 'explicit',
        source_routine_revision: null,
        rule: { type: 'weekly_quota', count: 2 },
      },
    }),
  );
  const done: [string, string][] = [
    [d.id, '2026-09-21'],
    [w.id, '2026-09-21'],
    [d.id, '2026-09-22'],
    [w.id, '2026-09-22'],
    [d.id, '2026-09-24'],
    [w.id, '2026-09-29'],
  ];
  for (const [id, day] of done) {
    at(day);
    await t.service.execute(day, id, execution(), randomUUID(), t.etag());
  }
  at('2026-10-05'); // Monday: weeks ending Sep 27 and Oct 4 are closed.
  return { ...t, d, w };
}

describe('statistics range rules', () => {
  it('September: dated occurrences in range, quota weeks by end date', async () => {
    const t = await scenario();
    const s = (await t.service.stats('2026-09-01', '2026-09-30')).data;
    // D due 21–30 = 10 days, 3 completed.
    expect(s.date_scheduled).toEqual({ completed: 3, total: 10, rate: 30 });
    // Only the week ending Sep 27 ends in September; the week ending Oct 4 does not.
    expect(s.weekly_quota).toMatchObject({
      completed: 2,
      total: 2,
      rate: 100,
      successful_periods: 1,
      total_periods: 1,
    });
    expect(s.monthly_quota.rate).toBeNull();
    expect(s.heatmap.map((h) => h.date)).toHaveLength(10);
    expect(s.heatmap.find((h) => h.date === '2026-09-24')).toMatchObject({
      completed: 1,
      total: 1,
    });
  });

  it('October: today is included, open quota periods are only live progress', async () => {
    const t = await scenario();
    const s = (await t.service.stats('2026-10-01', '2026-12-31')).data;
    expect(s.to).toBe('2026-10-05'); // clamped to today
    // D due Oct 1–5 = 5 days including today (open), none completed.
    expect(s.date_scheduled).toEqual({ completed: 0, total: 5, rate: 0 });
    // The week ending Oct 4: 1 of 2 credited.
    expect(s.weekly_quota).toMatchObject({
      completed: 1,
      total: 2,
      rate: 50,
      successful_periods: 0,
      total_periods: 1,
    });
    expect(s.live_quotas.map((q) => [q.habit_id, q.start, q.actual_count])).toEqual([
      [t.w.id, '2026-10-05', 0],
    ]);
  });

  it('a Habit filter and an empty denominator', async () => {
    const t = await scenario();
    const w = (await t.service.stats('2026-09-01', '2026-10-31', t.w.id)).data;
    expect(w.date_scheduled).toEqual({ completed: 0, total: 0, rate: null });
    expect(w.weekly_quota).toMatchObject({ completed: 3, total: 4, rate: 75 });
    expect(w.habits.map((h) => h.id)).toEqual([t.w.id]);
    const d = (await t.service.stats('2026-09-21', '2026-09-21', t.d.id)).data;
    expect(d.date_scheduled).toEqual({ completed: 1, total: 1, rate: 100 });
    expect(d.weekly_quota.rate).toBeNull();
  });
});

describe('history', () => {
  it('pages through dated occurrences and quota activity in a stable order', async () => {
    const t = await scenario();
    const all = (await t.service.history('2026-09-21', '2026-10-05', 0, 200)).data;
    // D: 15 dated occurrences (Sep 21–Oct 5). W: activity only on days with a record (21, 22, 29).
    expect(all.total).toBe(18);
    expect(all.rows.filter((r) => r.kind === 'scheduled')).toHaveLength(15);
    expect(
      all.rows
        .filter((r) => r.kind === 'quota_activity')
        .map((r) => r.date)
        .sort(),
    ).toEqual(['2026-09-21', '2026-09-22', '2026-09-29']);
    // Newest first, then by Habit ID.
    const keys = all.rows.map((r) => `${r.date}/${r.habit_id}`);
    expect(keys).toEqual(
      [...keys].sort((a, b) => b.slice(0, 10).localeCompare(a.slice(0, 10)) || a.localeCompare(b)),
    );
    // Pages of 5 reassemble the full list without gaps or duplicates.
    const pages = [];
    for (let offset = 0; offset < all.total; offset += 5)
      pages.push(...(await t.service.history('2026-09-21', '2026-10-05', offset, 5)).data.rows);
    expect(pages.map((r) => r.id)).toEqual(all.rows.map((r) => r.id));
    expect((await t.service.history('2026-09-21', '2026-10-05', 18, 5)).data.rows).toEqual([]);
    // Closed quota periods ending in the range.
    expect(all.quota_periods.map((q) => [q.end, q.actual_count, q.status])).toEqual([
      ['2026-09-27', 2, 'completed'],
      ['2026-10-04', 1, 'incomplete'],
    ]);
    // Records keep their details; completed rows expose their execution.
    const row = all.rows.find((r) => r.habit_id === t.d.id && r.date === '2026-09-24')!;
    expect(row.execution).toMatchObject({
      status: 'completed',
      energy_note: execution().energy_note,
    });
  });
});
