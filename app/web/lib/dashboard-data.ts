import { useQuery } from '@tanstack/react-query';
import { addDays, bounds } from '../../shared/domain/index.js';
import {
  request,
  useData,
  type Envelope,
  type HistoryData,
  type Stats,
  type Today,
} from './api-client.js';

export const STRIP_DAYS = 14;
// One day of a Habit's recent history: done, a missed scheduled day, today still open,
// or nothing scheduled (also flexible quota days without activity).
export type Cell = 'done' | 'missed' | 'open' | 'none';
type Row = HistoryData['rows'][number];

// All history rows of a date range, fetched page by page (the API caps a page at 200).
function useHistoryRange(from: string | undefined, to: string | undefined) {
  return useQuery({
    queryKey: ['/history-range', from, to],
    enabled: !!from && !!to,
    queryFn: async () => {
      const rows: Row[] = [];
      for (let offset = 0; ; offset += 200) {
        const page = await request<Envelope<HistoryData>>(
          `/history?${new URLSearchParams({ from: from!, to: to!, offset: String(offset), limit: '200' })}`,
        );
        rows.push(...page.data.rows);
        if (offset + 200 >= page.data.total) return rows;
      }
    },
  });
}

/**
 * Shared data behind every card, independent of the number of Habits: this week's and
 * this month's statistics (rates and each Habit's streak) and the last 14 days of history.
 */
export function useDashboardData(today: Today | undefined) {
  const date = today?.date;
  const week = date ? bounds(date, 'weeks') : null;
  const month = date ? bounds(date, 'months') : null;
  const range = (start: string | undefined) =>
    `/statistics?${new URLSearchParams({ from: start ?? '', to: date ?? '' })}`;
  const weekStats = useData<Stats>(range(week?.start), !!date);
  const monthStats = useData<Stats>(range(month?.start), !!date);
  const from = date ? addDays(date, -(STRIP_DAYS - 1)) : undefined;
  const history = useHistoryRange(from, date);
  const days = from ? Array.from({ length: STRIP_DAYS }, (_, i) => addDays(from, i)) : [];
  const strip = (habitId: string): Cell[] => {
    const rows = (history.data ?? []).filter((r) => r.habit_id === habitId);
    const item = today?.items.find((i) => i.habit_id === habitId);
    return days.map((day) => {
      // Today's cell follows the live Today view, which updates right after a write.
      if (day === date && item)
        return item.execution?.status === 'completed' ? 'done' : item.quota ? 'none' : 'open';
      const row = rows.find((r) => r.date === day);
      if (!row) return 'none';
      if (row.kind === 'quota_activity')
        return row.execution?.status === 'completed' ? 'done' : 'none';
      return row.status === 'completed' ? 'done' : day < date! ? 'missed' : 'open';
    });
  };
  // Recorded amounts of the same 14 days (null where nothing was recorded).
  const amounts = (habitId: string): (string | null)[] => {
    const rows = (history.data ?? []).filter((r) => r.habit_id === habitId);
    const item = today?.items.find((i) => i.habit_id === habitId);
    return days.map((day) =>
      day === date && item
        ? (item.execution?.actual_amount ?? null)
        : (rows.find((r) => r.date === day)?.execution?.actual_amount ?? null),
    );
  };
  const streak = (habitId: string) =>
    monthStats.data?.data.habits.find((h) => h.id === habitId) ?? null;
  return {
    week: weekStats.data?.data.date_scheduled ?? null,
    month: monthStats.data?.data.date_scheduled ?? null,
    habits: monthStats.data?.data.habits ?? [],
    strip,
    amounts,
    streak,
    ready: !!monthStats.data && !!history.data,
  };
}
