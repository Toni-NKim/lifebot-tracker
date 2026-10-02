import { useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { getDraft, setDraft, holdDraft, useSharedDraft } from './execution-store.js';

export interface SubmittedDraft {
  key: string;
  value: unknown;
}
export interface PlannerCommand {
  path: string;
  method: string;
  body: unknown;
  etag: string;
  id: string;
  onSuccess?: () => void;
  draft?: SubmittedDraft;
}
interface Entry {
  command: PlannerCommand;
  error: string | null;
  release: () => void;
}
interface State {
  entries: readonly Entry[];
  notice: string;
}
const empty: State = { entries: [], notice: '' };
const states = new Map<string, State>();
const listeners = new Set<() => void>();
// Read live cache state on every snapshot check, including the check React makes
// after subscribing. A command can settle between a route's render and subscription.
export function plannerPendingStore(client: QueryClient) {
  return {
    subscribe: (notify: () => void) => client.getMutationCache().subscribe(notify),
    getSnapshot: () => client.isMutating({ mutationKey: ['planner'] }) > 0,
  };
}
const state = (scope: string) => states.get(scope) ?? empty;
const publish = (scope: string, value: State) => {
  states.set(scope, value);
  listeners.forEach((fn) => fn());
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const usePlannerState = (scope: string) =>
  useSyncExternalStore(subscribe, () => state(scope));

// Reuse the Habit draft store: unsubmitted drafts disappear on route unmount,
// while submitted drafts stay held through a failure until success or discard.
export function usePlannerDraft<T>(key: string) {
  const [value, set] = useSharedDraft<T>(key);
  return [value, set] as const;
}
export function beginPlannerCommand(scope: string, command: PlannerCommand) {
  const current = state(scope);
  if (current.entries.some((e) => e.command.id === command.id)) return;
  let release = () => {};
  if (command.draft) {
    setDraft(command.draft.key, command.draft.value);
    release = holdDraft(command.draft.key);
  }
  publish(scope, { ...current, entries: [...current.entries, { command, error: null, release }] });
}
export function failPlannerCommand(scope: string, command: PlannerCommand, message: string) {
  if (command.draft && getDraft(command.draft.key) === null)
    setDraft(command.draft.key, command.draft.value);
  const current = state(scope);
  publish(scope, {
    ...current,
    entries: current.entries.map((e) =>
      e.command.id === command.id ? { ...e, error: message } : e,
    ),
  });
}
export function settlePlannerCommand(scope: string, command: PlannerCommand, notice = '') {
  const current = state(scope),
    entry = current.entries.find((e) => e.command.id === command.id);
  const draft = command.draft;
  // A late response must not clear a different draft opened in the meantime.
  if (draft && getDraft(draft.key) === draft.value) setDraft(draft.key, null);
  entry?.release();
  publish(scope, { entries: current.entries.filter((e) => e.command.id !== command.id), notice });
}
export function clearPlannerNotice(scope: string) {
  const current = state(scope);
  publish(scope, { ...current, notice: '' });
}
