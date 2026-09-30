import { useEffect, useSyncExternalStore } from 'react';

// Unsaved details for one Habit/date, shared by every copy of it on the page (one per
// Routine group). Kept in memory only and dropped when the last copy unmounts, like the
// component state it replaces.
const drafts = new Map<string, unknown>();
const mounted = new Map<string, number>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useSharedDraft<T>(key: string): [T | null, (value: T | null) => void] {
  const value = useSyncExternalStore(subscribe, () => (drafts.get(key) as T | undefined) ?? null);
  useEffect(() => {
    mounted.set(key, (mounted.get(key) ?? 0) + 1);
    return () => {
      const left = (mounted.get(key) ?? 1) - 1;
      if (left > 0) mounted.set(key, left);
      else {
        mounted.delete(key);
        drafts.delete(key);
      }
    };
  }, [key]);
  const set = (next: T | null) => {
    if (next === null) drafts.delete(key);
    else drafts.set(key, next);
    notify();
  };
  return [value, set];
}
