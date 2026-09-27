import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import {
  addDays,
  bounds,
  isDue,
  todayAt,
  project,
  streaks,
  statistics,
  executionId,
} from '../../app/shared/domain/index.js';
import type { Snapshot, Habit, Schedule } from '../../app/shared/contracts/index.js';
import { habitFields, execution } from '../helpers.js';
function snapshot(schedule: Schedule, start = '2026-09-21') {
  const id = randomUUID();
  const hid = randomUUID();
  const created_at = `${start}T00:00:00Z`;
  const h: Habit = {
    ...habitFields({
      schedule: { mode: 'explicit', source_routine_revision: null, rule: schedule },
    }),
    schema_version: 1,
    kind: 'habit',
    id: hid,
    revision: 1,
    command_id: randomUUID(),
    created_at,
    recorded_at: created_at,
    effective_from: start,
  };
  const s: Snapshot = {
    tracker: {
      schema_version: 1,
      kind: 'tracker',
      id,
      created_at,
      tracking_started_on: start,
      timezone: 'Asia/Seoul',
      week_starts_on: 'monday',
    },
    habits: [h],
    routines: [],
    days: [],
    commits: [],
    sources: [],
    warnings: [],
    fingerprint: '',
  };
  const complete = (day: string) => {
    const at = `${day}T01:00:00Z`;
    s.days.push({
      schema_version: 1,
      kind: 'daily_execution',
      tracker_id: id,
      date: day,
      timezone: 'Asia/Seoul',
      revision: 1,
      created_at: at,
      updated_at: at,
      receipts: [],
      executions: [
        {
          ...execution(),
          id: executionId(id, hid, day),
          habit_id: hid,
          habit_revision: 1,
          routine_id: null,
          routine_revision: null,
          slot: 1,
          completed_at: at,
          recorded_at: at,
          updated_at: at,
          target_amount: '20',
          unit: 'pages',
        },
      ],
    });
  };
  return { s, h, complete };
}
describe('calendar scheduling', () => {
  it.each([
    [{ type: 'daily' }, '2026-09-27', true],
    [{ type: 'weekdays' }, '2026-09-27', false],
    [{ type: 'weekdays' }, '2026-09-28', true],
    [{ type: 'weekends' }, '2026-09-26', true],
    [{ type: 'weekends' }, '2026-09-28', false],
    [{ type: 'selected_weekdays', weekdays: [1, 3, 5] }, '2026-09-23', true],
    [{ type: 'selected_weekdays', weekdays: [1, 3, 5] }, '2026-09-24', false],
    [{ type: 'every_n_days', interval_days: 3, anchor_date: '2026-09-29' }, '2026-10-02', true],
    [{ type: 'every_n_days', interval_days: 3, anchor_date: '2026-09-29' }, '2026-09-26', false],
    [{ type: 'weekly_quota', count: 3 }, '2026-09-27', true],
    [{ type: 'monthly_quota', count: 5 }, '2026-09-27', true],
  ])('schedule %j on %s = %s', (schedule, day, result) =>
    expect(isDue(schedule as Schedule, day)).toBe(result),
  );
  it('uses calendar boundaries across year, leap day and DST', () => {
    expect(bounds('2027-01-01', 'weeks')).toEqual({
      start: '2026-12-28',
      end: '2027-01-03',
      days: 7,
    });
    expect(bounds('2028-02-03', 'months').days).toBe(29);
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(todayAt('2026-09-27T15:00:00Z', 'Asia/Seoul')).toBe('2026-09-28');
    expect(todayAt('2026-03-08T07:30:00Z', 'America/New_York')).toBe('2026-03-08');
  });
  it('every-N-days is periodic for arbitrary intervals', () =>
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), fc.integer({ min: 0, max: 100 }), (n, k) => {
        expect(
          isDue(
            { type: 'every_n_days', interval_days: n, anchor_date: '2026-01-01' },
            addDays('2026-01-01', n * k),
          ),
        ).toBe(true);
      }),
    ));
});
describe('streaks and rates', () => {
  it('open incomplete dates preserve a streak, closed misses break it', () => {
    const { s, h, complete } = snapshot({ type: 'daily' });
    complete('2026-09-21');
    complete('2026-09-22');
    expect(streaks(project(s, '2026-09-23T00:00:00Z'), h.id).current).toBe(2);
    expect(streaks(project(s, '2026-09-24T00:00:00Z'), h.id)).toMatchObject({
      current: 0,
      longest: { occurrences: 2 },
    });
    complete('2026-09-24');
    expect(streaks(project(s, '2026-09-24T02:00:00Z'), h.id).current).toBe(1);
  });
  it('unscheduled dates never count as misses', () => {
    const { s, h, complete } = snapshot({ type: 'selected_weekdays', weekdays: [1, 3, 5] });
    ['2026-09-21', '2026-09-23', '2026-09-25'].forEach(complete);
    const p = project(s, '2026-09-27T00:00:00Z');
    expect(p.occurrences).toHaveLength(3);
    expect(streaks(p, h.id).current).toBe(3);
  });
  it('prorates first periods and caps short months', () => {
    const w = snapshot({ type: 'weekly_quota', count: 3 }, '2026-09-25');
    expect(project(w.s, '2026-09-25T00:00:00Z').periods[0].target_count).toBe(2);
    const m = snapshot({ type: 'monthly_quota', count: 10 }, '2026-09-25');
    expect(project(m.s, '2026-09-25T00:00:00Z').periods[0].target_count).toBe(2);
    const f = snapshot({ type: 'monthly_quota', count: 31 }, '2028-02-01');
    expect(project(f.s, '2028-02-01T00:00:00Z').periods[0].target_count).toBe(29);
  });
  it('caps credits, increments quota streak once, and keeps live progress separate', () => {
    const { s, h, complete } = snapshot({ type: 'weekly_quota', count: 3 });
    ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24'].forEach(complete);
    let p = project(s, '2026-09-24T02:00:00Z');
    expect(p.occurrences).toHaveLength(0);
    expect(p.periods[0]).toMatchObject({ actual_count: 4, credited_count: 3, status: 'completed' });
    expect(streaks(p, h.id).current).toBe(1);
    expect(statistics(s, p, '2026-09-01', '2026-09-30').weekly_quota.rate).toBeNull();
    p = project(s, '2026-09-28T00:00:00Z');
    expect(statistics(s, p, '2026-09-01', '2026-09-30').weekly_quota.rate).toBe(100);
  });
  it('computes 5/6 credited quota occurrences, not successful-period average', () => {
    const { s, complete } = snapshot({ type: 'weekly_quota', count: 3 });
    ['2026-09-21', '2026-09-22', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01'].forEach(
      complete,
    );
    const stats = statistics(s, project(s, '2026-10-05T00:00:00Z'), '2026-09-01', '2026-10-31');
    expect(stats.weekly_quota.rate).toBeCloseTo(83.333);
    expect(stats.weekly_quota.successful_periods).toBe(1);
  });
  it('measurement shortfalls do not override explicit success', () => {
    const { s, complete } = snapshot({ type: 'daily' });
    complete('2026-09-21');
    const p = project(s, '2026-09-21T02:00:00Z');
    expect(statistics(s, p, '2026-09-21', '2026-09-21').date_scheduled.rate).toBe(100);
  });
  it('reactivation starts a new series, compatible schedule changes preserve one', () => {
    const { s, h, complete } = snapshot({ type: 'daily' });
    complete('2026-09-21');
    s.habits.push(
      { ...h, revision: 2, effective_from: '2026-09-22', active: false },
      { ...h, revision: 3, effective_from: '2026-09-24' },
    );
    expect(streaks(project(s, '2026-09-24T00:00:00Z'), h.id).current).toBe(0);
    expect(streaks(project(s, '2026-09-24T00:00:00Z'), h.id).longest.occurrences).toBe(1);
  });
});
