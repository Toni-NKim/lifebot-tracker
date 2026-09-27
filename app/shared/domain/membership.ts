import type { HabitFields } from '../contracts/index.js';

// Older documents encode their sole membership in parent_routine_id.
// In new documents that field identifies the source of inherited defaults.
export const routineIds = (
  habit: Pick<HabitFields, 'routine_ids' | 'parent_routine_id'>,
): string[] => habit.routine_ids ?? (habit.parent_routine_id ? [habit.parent_routine_id] : []);

export function membershipPatch(habit: HabitFields, ids: string[]): Partial<HabitFields> {
  return {
    routine_ids: ids,
    ...(habit.parent_routine_id && !ids.includes(habit.parent_routine_id)
      ? {
          parent_routine_id: null,
          schedule: { ...habit.schedule, mode: 'explicit' as const, source_routine_revision: null },
          scheduled_time: {
            ...habit.scheduled_time,
            mode: 'explicit' as const,
            source_routine_revision: null,
          },
        }
      : {}),
  };
}
