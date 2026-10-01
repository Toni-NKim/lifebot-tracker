import { useEffect, useSyncExternalStore } from 'react';
import { koreanError } from './errors.js';

/**
 * State of today's executions that must outlive any one view: the unsaved details draft
 * of each Habit, the last failed write of each Habit, which Details sheets are open and
 * the dashboard's snackbar notice. Writes reconcile this state when they finish, whether
 * or not the sheet, snackbar or card that sent them is still on screen.
 */
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
// Mounted users of a key; `onLast` runs when the last one unmounts.
function useRegistration(counts: Map<string, number>, key: string, onLast?: () => void) {
  useEffect(() => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return () => {
      const left = (counts.get(key) ?? 1) - 1;
      if (left > 0) counts.set(key, left);
      else {
        counts.delete(key);
        onLast?.();
      }
    };
  }, [key]);
}

// Unsaved details for one Habit/date, shared by every view of it. Kept in memory only and
// dropped when the last view that uses it unmounts (leaving the dashboard).
const drafts = new Map<string, unknown>();
const draftUsers = new Map<string, number>();
export const getDraft = <T>(key: string) => (drafts.get(key) as T | undefined) ?? null;
export function setDraft<T>(key: string, value: T | null) {
  if (value === null) drafts.delete(key);
  else drafts.set(key, value);
  changed();
}
export function useSharedDraft<T>(key: string): [T | null, (value: T | null) => void] {
  const value = useSyncExternalStore(subscribe, () => getDraft<T>(key));
  useRegistration(draftUsers, key, () => drafts.delete(key));
  return [value, (next) => setDraft(key, next)];
}

// The last failed write of one Habit/date, until its next write or a discard.
const errors = new Map<string, Error>();
export function setWriteError(key: string, error: Error | null) {
  if (error) errors.set(key, error);
  else if (errors.has(key)) errors.delete(key);
  else return;
  changed();
}
export const useWriteError = (key: string) =>
  useSyncExternalStore(subscribe, () => errors.get(key) ?? null);

// Open Details sheets: a failure is shown in the sheet when one is open, otherwise in the
// snackbar, so it is never lost with the view that sent the write.
const openSheets = new Map<string, number>();
export const useDetailsOpen = (key: string) => useRegistration(openSheets, key);
export function reportWriteError(key: string, error: Error) {
  setWriteError(key, error);
  if (!openSheets.has(key)) postNotice({ kind: 'error', text: koreanError(error), detail: error });
}

export type NoticeInput =
  | { kind: 'done'; habitId: string; text: string }
  // `detail` keeps the original error (code and server message) for debugging.
  | { kind: 'error'; text: string; detail?: Error };
// `stamp` identifies a notice; `at` is when it was posted.
export type Notice = NoticeInput & { stamp: number; at: number };
let notice: Notice | null = null;
let stamps = 0;
export function postNotice(input: NoticeInput) {
  notice = { ...input, stamp: ++stamps, at: Date.now() };
  changed();
}
export function dismissNotice(stamp: number) {
  if (notice?.stamp !== stamp) return;
  notice = null;
  changed();
}
// After an Undo the "recorded" notice of that Habit no longer applies.
export function dismissDone(habitId: string) {
  if (notice?.kind === 'done' && notice.habitId === habitId) dismissNotice(notice.stamp);
}
export const useNotice = () => useSyncExternalStore(subscribe, () => notice);
