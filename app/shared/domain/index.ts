import { Temporal } from '@js-temporal/polyfill';
import { v5 as uuidv5 } from 'uuid';
import type { Habit, Routine, Schedule, Snapshot, Execution } from '../contracts/index.js';
import { routineIds } from './membership.js';
export const date = (d: string) => Temporal.PlainDate.from(d);
export const addDays = (d: string, n: number) => date(d).add({ days: n }).toString();
export const todayAt = (instant: string, zone: string) =>
  Temporal.Instant.from(instant).toZonedDateTimeISO(zone).toPlainDate().toString();
export const isQuota = (s: Schedule) => s.type === 'weekly_quota' || s.type === 'monthly_quota';
export const unitOf = (s: Schedule): Unit =>
  s.type === 'weekly_quota' ? 'weeks' : s.type === 'monthly_quota' ? 'months' : 'occurrences';
export type Unit = 'occurrences' | 'weeks' | 'months';
export function effective<T extends { effective_from: string; revision: number }>(
  versions: T[],
  day: string,
): T | undefined {
  return versions
    .filter((v) => v.effective_from <= day)
    .sort((a, b) => a.effective_from.localeCompare(b.effective_from) || a.revision - b.revision)
    .at(-1);
}
export function bounds(day: string, unit: 'weeks' | 'months') {
  const d = date(day);
  const start = unit === 'weeks' ? d.subtract({ days: d.dayOfWeek - 1 }) : d.with({ day: 1 });
  const end =
    unit === 'weeks' ? start.add({ days: 6 }) : start.add({ months: 1 }).subtract({ days: 1 });
  return { start: start.toString(), end: end.toString(), days: start.until(end).days + 1 };
}
export function isDue(s: Schedule, day: string) {
  const d = date(day);
  switch (s.type) {
    case 'daily':
    case 'weekly_quota':
    case 'monthly_quota':
      return true;
    case 'weekdays':
      return d.dayOfWeek <= 5;
    case 'weekends':
      return d.dayOfWeek >= 6;
    case 'selected_weekdays':
      return s.weekdays.includes(d.dayOfWeek);
    case 'every_n_days':
      return day >= s.anchor_date && date(s.anchor_date).until(d).days % s.interval_days === 0;
  }
}
export function changeDate(habit: Habit, day: string, structural: boolean) {
  const unit = unitOf(habit.schedule.rule);
  return structural && unit !== 'occurrences' ? addDays(bounds(day, unit).end, 1) : addDays(day, 1);
}
export const executionId = (tracker: string, habit: string, day: string) =>
  uuidv5(`${habit}/${day}/1`, tracker);
export interface Occurrence {
  id: string;
  habit_id: string;
  habit_revision: number;
  date: string;
  routine_id: string | null;
  routine_revision: number | null;
  scheduled_time: string | null;
  status: 'completed' | 'incomplete';
  execution_id: string | null;
  is_final: boolean;
  streak_series_id: string;
}
export interface QuotaPeriod {
  id: string;
  habit_id: string;
  unit: 'weeks' | 'months';
  start: string;
  end: string;
  eligible_start: string;
  eligible_end: string;
  target_count: number;
  actual_count: number;
  credited_count: number;
  status: 'completed' | 'incomplete';
  is_final: boolean;
  streak_series_id: string;
}
export interface QuotaDay extends Omit<Occurrence, 'status' | 'is_final' | 'streak_series_id'> {
  period_id: string;
}
export interface Projection {
  cutoff: string;
  today: string;
  occurrences: Occurrence[];
  periods: QuotaPeriod[];
  quotaDays: QuotaDay[];
  series: Record<string, { id: string; unit: Unit; active: boolean }>;
}
export function project(s: Snapshot, asOf: string): Projection {
  const today = todayAt(asOf, s.tracker.timezone);
  const p: Projection = {
    cutoff: asOf,
    today,
    occurrences: [],
    periods: [],
    quotaDays: [],
    series: {},
  };
  const executions = new Map(
    s.days
      .filter((d) => d.date <= today)
      .flatMap((d) => d.executions.map((e) => [`${e.habit_id}/${d.date}`, e] as const)),
  );
  for (const habitId of [...new Set(s.habits.map((h) => h.id))].sort()) {
    const versions = s.habits.filter((h) => h.id === habitId);
    let prev: Habit | undefined;
    let series = '';
    let familyStart = '';
    let lastUnit: Unit | undefined;
    for (let day = s.tracker.tracking_started_on; day <= today; day = addDays(day, 1)) {
      const h = effective(versions, day);
      const active = !!h?.active && !h.deleted;
      if (!h || !active) {
        if (p.series[habitId]) p.series[habitId].active = false;
        prev = h;
        continue;
      }
      const unit = unitOf(h.schedule.rule);
      if (!prev?.active || prev.deleted || lastUnit !== unit) {
        series = uuidv5(`${habitId}/series/${day}/${unit}`, s.tracker.id);
        familyStart = day;
      }
      lastUnit = unit;
      p.series[habitId] = { id: series, unit, active: true };
      prev = h;
      if (!isDue(h.schedule.rule, day)) continue;
      const r = effective(
        s.routines.filter((r) => r.id === h.parent_routine_id),
        day,
      );
      const e = executions.get(`${habitId}/${day}`);
      const common = {
        id: executionId(s.tracker.id, habitId, day),
        habit_id: habitId,
        habit_revision: h.revision,
        date: day,
        routine_id: h.parent_routine_id,
        routine_revision: r?.revision ?? null,
        scheduled_time: h.scheduled_time.value,
        execution_id: e?.id ?? null,
      };
      if (unit === 'occurrences')
        p.occurrences.push({
          ...common,
          status: e?.status ?? 'incomplete',
          is_final: day < today,
          streak_series_id: series,
        });
      else {
        const b = bounds(day, unit);
        const id = uuidv5(`${habitId}/${unit}/${b.start}/${series}`, s.tracker.id);
        let period = p.periods.find((q) => q.id === id);
        if (!period) {
          const start = familyStart > b.start ? familyStart : b.start;
          const a = date(start).until(date(b.end)).days + 1;
          const rule = h.schedule.rule as Extract<Schedule, { count: number }>;
          period = {
            id,
            habit_id: habitId,
            unit,
            start: b.start,
            end: b.end,
            eligible_start: start,
            eligible_end: b.end,
            target_count: Math.min(a, Math.ceil((rule.count * a) / b.days)),
            actual_count: 0,
            credited_count: 0,
            status: 'incomplete',
            is_final: b.end < today,
            streak_series_id: series,
          };
          p.periods.push(period);
        }
        if (e?.status === 'completed') period.actual_count++;
        period.credited_count = Math.min(period.actual_count, period.target_count);
        period.status = period.credited_count >= period.target_count ? 'completed' : 'incomplete';
        p.quotaDays.push({ ...common, period_id: id });
      }
    }
  }
  return p;
}
export function streaks(p: Projection, habitId: string) {
  const rows = [
    ...p.occurrences
      .filter((o) => o.habit_id === habitId)
      .map((o) => ({ ...o, unit: 'occurrences' as Unit, end: o.date })),
    ...p.periods.filter((q) => q.habit_id === habitId),
  ].sort((a, b) => a.end.localeCompare(b.end));
  const longest: Record<Unit, number> = { occurrences: 0, weeks: 0, months: 0 };
  let n = 0;
  let series = '';
  let provisional = false;
  for (const row of rows) {
    if (series !== row.streak_series_id) {
      n = 0;
      series = row.streak_series_id;
    }
    if (row.status === 'completed') {
      n++;
      longest[row.unit] = Math.max(longest[row.unit], n);
    } else if (row.is_final) n = 0;
    provisional = !row.is_final && row.status === 'completed';
  }
  const active = p.series[habitId];
  return {
    current: active && active.id !== series ? 0 : n,
    unit: active?.unit ?? 'occurrences',
    active: active?.active ?? false,
    longest,
    provisional,
  };
}
export const rate = (completed: number, total: number) => ({
  completed,
  total,
  rate: total === 0 ? null : (completed / total) * 100,
});
export function statistics(s: Snapshot, p: Projection, from: string, to: string, habitId?: string) {
  const os = p.occurrences.filter(
    (o) => o.date >= from && o.date <= to && (!habitId || o.habit_id === habitId),
  );
  const qs = p.periods.filter((q) => !habitId || q.habit_id === habitId);
  const quota = (unit: Unit) => {
    const rows = qs.filter((q) => q.unit === unit && q.is_final && q.end >= from && q.end <= to);
    return {
      ...rate(
        rows.reduce((n, q) => n + q.credited_count, 0),
        rows.reduce((n, q) => n + q.target_count, 0),
      ),
      successful_periods: rows.filter((q) => q.status === 'completed').length,
      total_periods: rows.length,
    };
  };
  const heatmap = [...new Set(os.map((o) => o.date))].sort().map((day) => {
    const rows = os.filter((o) => o.date === day);
    return { date: day, ...rate(rows.filter((o) => o.status === 'completed').length, rows.length) };
  });
  return {
    from,
    to: to > p.today ? p.today : to,
    date_scheduled: rate(os.filter((o) => o.status === 'completed').length, os.length),
    weekly_quota: quota('weeks'),
    monthly_quota: quota('months'),
    live_quotas: qs.filter((q) => !q.is_final),
    heatmap,
    habits: [...new Set(s.habits.map((h) => h.id))]
      .filter((id) => !habitId || id === habitId)
      .map((id) => ({
        id,
        name:
          effective(
            s.habits.filter((h) => h.id === id),
            p.today,
          )?.name ?? s.habits.find((h) => h.id === id)!.name,
        ...streaks(p, id),
      })),
  };
}
export function todayView(s: Snapshot, p: Projection) {
  const day = s.days.find((d) => d.date === p.today);
  const routines = [...new Set(s.routines.map((r) => r.id))]
    .map((id) =>
      effective(
        s.routines.filter((r) => r.id === id),
        p.today,
      ),
    )
    .filter((r): r is Routine => !!r && !r.deleted)
    // Snapshot order follows random command IDs; show groups in the order of the day.
    .sort(
      (a, b) =>
        (a.scheduled_time ?? '99:99').localeCompare(b.scheduled_time ?? '99:99') ||
        a.created_at.localeCompare(b.created_at) ||
        a.id.localeCompare(b.id),
    );
  const items = [
    ...p.occurrences.filter((o) => o.date === p.today),
    ...p.quotaDays.filter((o) => o.date === p.today),
  ].map((o) => {
    const habit = effective(
      s.habits.filter((h) => h.id === o.habit_id),
      p.today,
    )!;
    return {
      ...o,
      habit,
      routine_contexts: routines
        .filter((r) => routineIds(habit).includes(r.id) && isDue(r.schedule, p.today))
        .map((r) => ({
          routine_id: r.id,
          routine_revision: r.revision,
          scheduled_time:
            habit.scheduled_time.mode === 'routine' ? r.scheduled_time : habit.scheduled_time.value,
        })),
      execution: day?.executions.find((e) => e.habit_id === o.habit_id) ?? null,
      quota: 'period_id' in o ? p.periods.find((q) => q.id === o.period_id)! : null,
    };
  });
  items.sort(
    (a, b) =>
      (a.scheduled_time ?? '99:99').localeCompare(b.scheduled_time ?? '99:99') ||
      a.habit.created_at.localeCompare(b.habit.created_at) ||
      a.habit_id.localeCompare(b.habit_id),
  );
  return {
    date: p.today,
    timezone: s.tracker.timezone,
    items,
    routines,
    day_revision: day?.revision ?? 0,
  };
}
