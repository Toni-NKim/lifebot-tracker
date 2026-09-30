// Definition changes over time, driven through the service with an advancing clock.
// Expected values are written out from the documented rules (docs/decisions.md).
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { harness, habitFields, execution } from '../helpers.js';
import type { Schedule } from '../../app/shared/contracts/index.js';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));
async function setup(start = '2026-09-21') {
  const t = await harness(start);
  cleanups.push(t.cleanup);
  const at = (day: string) => t.setNow(`${day}T03:00:00Z`); // noon in Seoul
  const complete = async (id: string, day: string) => {
    at(day);
    await t.service.execute(day, id, execution(), randomUUID(), t.etag());
  };
  const edit = async (
    id: string,
    day: string,
    patch: Parameters<typeof t.service.editHabit>[1],
  ) => {
    at(day);
    return (await t.service.editHabit(id, patch, randomUUID(), t.etag())).data.changes;
  };
  const rule = (schedule: Schedule) => ({
    schedule: { mode: 'explicit' as const, source_routine_revision: null, rule: schedule },
  });
  const habit = async (schedule: Schedule) => t.create(habitFields(rule(schedule)));
  const occurrences = async (id: string) =>
    (await t.service.history('2000-01-01', '2999-12-31', 0, 200)).data.rows
      .filter((r) => r.habit_id === id && r.kind === 'scheduled')
      .map((r) => r.date)
      .sort();
  const streak = async (id: string) =>
    (await t.service.stats()).data.habits.find((h) => h.id === id)!;
  const dueToday = async (id: string) =>
    (await t.service.today()).data.items.some((i) => i.habit_id === id);
  return { ...t, at, complete, edit, rule, habit, occurrences, streak, dueToday };
}

describe('every N days', () => {
  it('an anchor/interval change applies from tomorrow and keeps the streak series', async () => {
    const t = await setup(); // Mon 2026-09-21
    const h = await t.habit({ type: 'every_n_days', interval_days: 3, anchor_date: '2026-09-21' });
    await t.complete(h.id, '2026-09-21');
    const changes = await t.edit(
      h.id,
      '2026-09-22',
      t.rule({ type: 'every_n_days', interval_days: 2, anchor_date: '2026-09-23' }),
    );
    expect(changes.map((c) => c.effective_from)).toEqual(['2026-09-23']);
    for (const day of ['2026-09-23', '2026-09-25', '2026-09-27']) await t.complete(h.id, day);
    t.at('2026-09-28');
    // Old rule (21) then new rule (23, 25, 27); 24 would have been due under the old rule.
    expect(await t.occurrences(h.id)).toEqual([
      '2026-09-21',
      '2026-09-23',
      '2026-09-25',
      '2026-09-27',
    ]);
    expect(await t.streak(h.id)).toMatchObject({ current: 4, unit: 'occurrences' });
    t.at('2026-09-29'); // due and open: streak still 4
    expect(await t.streak(h.id)).toMatchObject({ current: 4 });
    t.at('2026-09-30'); // 29th closed incomplete
    expect(await t.streak(h.id)).toMatchObject({ current: 0, longest: { occurrences: 4 } });
  });
});

describe('daily ↔ quota transitions', () => {
  it('daily → weekly quota starts tomorrow with a prorated week and a new streak series', async () => {
    const t = await setup(); // Mon
    const h = await t.habit({ type: 'daily' });
    await t.complete(h.id, '2026-09-21');
    await t.complete(h.id, '2026-09-22');
    const changes = await t.edit(h.id, '2026-09-22', t.rule({ type: 'weekly_quota', count: 3 }));
    expect(changes.map((c) => c.effective_from)).toEqual(['2026-09-23']);
    for (const day of ['2026-09-23', '2026-09-24', '2026-09-25']) await t.complete(h.id, day);
    t.at('2026-09-26');
    const item = (await t.service.today()).data.items.find((i) => i.habit_id === h.id)!;
    // Wed–Sun = 5 eligible days: min(5, ceil(3 × 5 / 7)) = 3.
    expect(item.quota).toMatchObject({
      start: '2026-09-21',
      eligible_start: '2026-09-23',
      target_count: 3,
      actual_count: 3,
      status: 'completed',
      is_final: false,
    });
    expect(await t.occurrences(h.id)).toEqual(['2026-09-21', '2026-09-22']);
    expect(await t.streak(h.id)).toMatchObject({
      unit: 'weeks',
      current: 1,
      provisional: true,
      longest: { occurrences: 2, weeks: 1 },
    });
  });

  it('weekly quota → daily waits for the next week', async () => {
    const t = await setup();
    const h = await t.habit({ type: 'weekly_quota', count: 2 });
    const changes = await t.edit(h.id, '2026-09-23', t.rule({ type: 'daily' }));
    expect(changes.map((c) => c.effective_from)).toEqual(['2026-09-28']);
    t.at('2026-09-27');
    expect((await t.service.today()).data.items[0].quota?.unit).toBe('weeks');
    t.at('2026-09-28');
    const item = (await t.service.today()).data.items[0];
    expect(item.quota).toBeNull();
    expect(await t.occurrences(h.id)).toEqual(['2026-09-28']);
  });
});

describe('mid-period deletion and deactivation', () => {
  it('deleting a weekly quota mid-week keeps it until Sunday and keeps its history', async () => {
    const t = await setup();
    const h = await t.habit({ type: 'weekly_quota', count: 2 });
    await t.complete(h.id, '2026-09-21');
    const changes = await t.edit(h.id, '2026-09-23', { deleted: true, active: false });
    expect(changes.map((c) => c.effective_from)).toEqual(['2026-09-28']);
    await t.complete(h.id, '2026-09-27');
    expect(await t.dueToday(h.id)).toBe(true);
    t.at('2026-09-28');
    expect(await t.dueToday(h.id)).toBe(false);
    const stats = (await t.service.stats('2026-09-01', '2026-09-30')).data;
    expect(stats.weekly_quota).toMatchObject({ completed: 2, total: 2, successful_periods: 1 });
    expect(stats.habits.find((x) => x.id === h.id)).toMatchObject({
      active: false,
      current: 0,
      longest: { weeks: 1 },
    });
  });

  it('deactivating a monthly quota mid-month waits for the 1st', async () => {
    const t = await setup('2026-09-01');
    const h = await t.habit({ type: 'monthly_quota', count: 10 });
    const changes = await t.edit(h.id, '2026-09-15', { active: false });
    expect(changes.map((c) => c.effective_from)).toEqual(['2026-10-01']);
    t.at('2026-09-30');
    expect(await t.dueToday(h.id)).toBe(true);
    t.at('2026-10-01');
    expect(await t.dueToday(h.id)).toBe(false);
    const september = (await t.service.stats('2026-09-01', '2026-09-30')).data.monthly_quota;
    expect(september).toMatchObject({ completed: 0, total: 10, total_periods: 1 });
  });

  it('deactivating a daily Habit takes effect tomorrow; today stays editable', async () => {
    const t = await setup();
    const h = await t.habit({ type: 'daily' });
    const changes = await t.edit(h.id, '2026-09-22', { active: false });
    expect(changes.map((c) => c.effective_from)).toEqual(['2026-09-23']);
    await t.complete(h.id, '2026-09-22');
    t.at('2026-09-23');
    expect(await t.dueToday(h.id)).toBe(false);
    expect(await t.occurrences(h.id)).toEqual(['2026-09-21', '2026-09-22']);
  });
});
