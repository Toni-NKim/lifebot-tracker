// Property tests against an independent reference model. The reference below uses only
// native UTC date arithmetic and restates the documented rules (docs/decisions.md);
// it deliberately does not reuse app/shared/domain.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import { project, streaks, executionId } from '../../app/shared/domain/index.js';
import type { Habit, Schedule, Snapshot } from '../../app/shared/contracts/index.js';
import { habitFields, execution } from '../helpers.js';

// ---- Reference calendar -------------------------------------------------------------
const DAY = 86_400_000;
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const plus = (d: string, n: number) => iso(ms(d) + n * DAY);
const between = (a: string, b: string) => Math.round((ms(b) - ms(a)) / DAY);
const weekday = (d: string) => new Date(ms(d)).getUTCDay() || 7; // ISO: Mon=1 … Sun=7
const range = (from: string, to: string) =>
  Array.from({ length: between(from, to) + 1 }, (_, i) => plus(from, i));
const weekStart = (d: string) => plus(d, 1 - weekday(d));
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const monthEnd = (d: string) => {
  const [y, m] = d.split('-').map(Number);
  return iso(Date.UTC(y, m, 0));
};

function refDue(s: Schedule, d: string): boolean {
  switch (s.type) {
    case 'daily':
      return true;
    case 'weekdays':
      return weekday(d) <= 5;
    case 'weekends':
      return weekday(d) >= 6;
    case 'selected_weekdays':
      return s.weekdays.includes(weekday(d));
    case 'every_n_days':
      return d >= s.anchor_date && between(s.anchor_date, d) % s.interval_days === 0;
    default:
      throw new Error('quota schedules have no dated occurrences');
  }
}

// Streak over units in order. An open (last) unfinished unit is ignored; an open
// successful unit counts provisionally; a closed failure resets.
function refStreak(units: { ok: boolean; open: boolean }[]) {
  let run = 0;
  let longest = 0;
  for (const u of units) {
    if (u.ok) longest = Math.max(longest, ++run);
    else if (!u.open) run = 0;
  }
  return { current: run, longest };
}

// ---- Snapshot builder -----------------------------------------------------------------
function build(schedule: Schedule, start: string, completed: string[]): Snapshot {
  const tracker = randomUUID();
  const id = randomUUID();
  const at = `${start}T00:00:00Z`;
  const habit: Habit = {
    ...habitFields({
      schedule: { mode: 'explicit', source_routine_revision: null, rule: schedule },
    }),
    schema_version: 1,
    kind: 'habit',
    id,
    revision: 1,
    command_id: randomUUID(),
    created_at: at,
    recorded_at: at,
    effective_from: start,
  };
  return {
    tracker: {
      schema_version: 1,
      kind: 'tracker',
      id: tracker,
      created_at: at,
      tracking_started_on: start,
      timezone: 'Asia/Seoul',
      week_starts_on: 'monday',
    },
    habits: [habit],
    routines: [],
    commits: [],
    sources: [],
    warnings: [],
    fingerprint: '',
    days: completed.map((day) => {
      const t = `${day}T01:00:00Z`;
      return {
        schema_version: 1,
        kind: 'daily_execution',
        tracker_id: tracker,
        date: day,
        timezone: 'Asia/Seoul',
        revision: 1,
        created_at: t,
        updated_at: t,
        receipts: [],
        executions: [
          {
            ...execution(),
            id: executionId(tracker, id, day),
            habit_id: id,
            habit_revision: 1,
            routine_id: null,
            routine_revision: null,
            slot: 1,
            completed_at: t,
            recorded_at: t,
            updated_at: t,
            target_amount: '20',
            unit: 'pages',
          },
        ],
      };
    }),
  };
}
// Noon in Seoul on `today`.
const asOf = (today: string) => `${today}T03:00:00Z`;

// ---- Generators -----------------------------------------------------------------------
const startDate = fc.integer({ min: 0, max: 5 * 365 }).map((n) => plus('2024-01-01', n));
const datedSchedule = (start: string): fc.Arbitrary<Schedule> =>
  fc.oneof(
    fc.constant<Schedule>({ type: 'daily' }),
    fc.constant<Schedule>({ type: 'weekdays' }),
    fc.constant<Schedule>({ type: 'weekends' }),
    fc
      .subarray([1, 2, 3, 4, 5, 6, 7], { minLength: 1 })
      .map<Schedule>((weekdays) => ({ type: 'selected_weekdays', weekdays })),
    fc
      .record({ n: fc.integer({ min: 1, max: 10 }), shift: fc.integer({ min: -20, max: 20 }) })
      .map<Schedule>(({ n, shift }) => ({
        type: 'every_n_days',
        interval_days: n,
        anchor_date: plus(start, shift),
      })),
  );

describe('dated schedules match the reference calendar', () => {
  it('occurrences, statuses and streaks over random ranges (2024–2029)', () =>
    fc.assert(
      fc.property(
        startDate.chain((start) =>
          fc.record({
            start: fc.constant(start),
            schedule: datedSchedule(start),
            length: fc.integer({ min: 1, max: 150 }),
            done: fc.array(fc.boolean(), { minLength: 150, maxLength: 150 }),
          }),
        ),
        ({ start, schedule, length, done }) => {
          const today = plus(start, length - 1);
          const due = range(start, today).filter((d) => refDue(schedule, d));
          const completed = due.filter((d) => done[between(start, d)]);
          const s = build(schedule, start, completed);
          const p = project(s, asOf(today));
          expect(p.occurrences.map((o) => o.date)).toEqual(due);
          expect(p.occurrences.map((o) => o.status === 'completed')).toEqual(
            due.map((d) => completed.includes(d)),
          );
          const ref = refStreak(due.map((d) => ({ ok: completed.includes(d), open: d === today })));
          const actual = streaks(p, s.habits[0].id);
          expect(actual.current).toBe(ref.current);
          expect(actual.longest.occurrences).toBe(ref.longest);
          expect(actual.provisional).toBe(due.at(-1) === today && completed.includes(today));
        },
      ),
      { numRuns: 200 },
    ));

  it('every-N-days streaks are not broken by non-due days', () => {
    const schedule: Schedule = {
      type: 'every_n_days',
      interval_days: 3,
      anchor_date: '2026-09-21',
    };
    const s = build(schedule, '2026-09-21', ['2026-09-21', '2026-09-24', '2026-09-27']);
    // 28th and 29th are not due: the streak of 3 stands; the 30th is due and open.
    for (const today of ['2026-09-28', '2026-09-29', '2026-09-30'])
      expect(streaks(project(s, asOf(today)), s.habits[0].id).current).toBe(3);
    expect(streaks(project(s, asOf('2026-10-01')), s.habits[0].id).current).toBe(0);
  });
});

// Reference quota periods for a Habit active from `start` to `today`.
function refPeriods(
  unit: 'weeks' | 'months',
  count: number,
  start: string,
  today: string,
  completed: string[],
) {
  const periods: { start: string; target: number; actual: number; ok: boolean; open: boolean }[] =
    [];
  for (let p = unit === 'weeks' ? weekStart(start) : monthStart(start); p <= today;) {
    const end = unit === 'weeks' ? plus(p, 6) : monthEnd(p);
    const length = between(p, end) + 1;
    const eligible = between(p > start ? p : start, end) + 1;
    const target = Math.min(eligible, Math.ceil((count * eligible) / length));
    const actual = completed.filter((d) => d >= p && d <= end).length;
    periods.push({ start: p, target, actual, ok: actual >= target, open: end >= today });
    p = plus(end, 1);
  }
  return periods;
}

describe.each([
  ['weeks', 'weekly_quota', 7, 120],
  ['months', 'monthly_quota', 31, 420],
] as const)('%s quotas match the reference', (unit, type, max, span) => {
  it(`targets, credits and streaks across many ${unit}`, () =>
    fc.assert(
      fc.property(
        startDate,
        fc.integer({ min: 1, max }),
        fc.integer({ min: 1, max: span }),
        fc.array(fc.boolean(), { minLength: span, maxLength: span }),
        (start, count, length, done) => {
          const today = plus(start, length - 1);
          const completed = range(start, today).filter((d) => done[between(start, d)]);
          const s = build({ type, count } as Schedule, start, completed);
          const p = project(s, asOf(today));
          const ref = refPeriods(unit, count, start, today, completed);
          expect(
            p.periods.map((q) => [q.start, q.target_count, q.actual_count, q.status, q.is_final]),
          ).toEqual(
            ref.map((r) => [
              r.start,
              r.target,
              r.actual,
              r.ok ? 'completed' : 'incomplete',
              !r.open,
            ]),
          );
          // Credits are capped at the target.
          expect(p.periods.map((q) => q.credited_count)).toEqual(
            ref.map((r) => Math.min(r.actual, r.target)),
          );
          const streak = refStreak(ref);
          const actual = streaks(p, s.habits[0].id);
          expect(actual.unit).toBe(unit);
          expect(actual.current).toBe(streak.current);
          expect(actual.longest[unit]).toBe(streak.longest);
          expect(p.occurrences).toEqual([]);
        },
      ),
      { numRuns: 150 },
    ));
});

describe('quota streak examples', () => {
  it('weekly: three met weeks, a missed week resets, the open week counts only when met', () => {
    // Mon 2026-09-07 … ; 2 per week.
    const done = [
      '2026-09-07',
      '2026-09-08', // met
      '2026-09-14',
      '2026-09-20', // met
      '2026-09-21', // week of 21st: only 1 → missed
      '2026-09-28',
      '2026-09-29', // met
      '2026-10-05', // open week, 1 of 2 so far
    ];
    const s = build({ type: 'weekly_quota', count: 2 }, '2026-09-07', done);
    const at = (d: string) => streaks(project(s, asOf(d)), s.habits[0].id);
    expect(at('2026-09-27')).toMatchObject({ current: 2, longest: { weeks: 2 } }); // open week not met yet
    expect(at('2026-09-28')).toMatchObject({ current: 0 }); // week of 21st closed as missed
    expect(at('2026-10-05')).toMatchObject({ current: 1, longest: { weeks: 2 } });
    expect(at('2026-10-07')).toMatchObject({ current: 1, provisional: false });
  });
  it('monthly: a short month uses its own length, and months chain', () => {
    const feb = range('2027-02-01', '2027-02-28');
    const s = build({ type: 'monthly_quota', count: 30 }, '2027-01-01', [
      ...range('2027-01-01', '2027-01-30'),
      ...feb,
    ]);
    const p = project(s, asOf('2027-03-01'));
    expect(p.periods.map((q) => [q.start, q.target_count, q.status])).toEqual([
      ['2027-01-01', 30, 'completed'],
      ['2027-02-01', 28, 'completed'], // capped at 28 available days
      ['2027-03-01', 30, 'incomplete'],
    ]);
    expect(streaks(p, s.habits[0].id)).toMatchObject({ current: 2, longest: { months: 2 } });
  });
});
