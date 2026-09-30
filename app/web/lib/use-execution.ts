import type { ExecutionInput } from '../../shared/contracts/index.js';
import { useBusy, useExecutionEtag, useWrite, type Base, type Today } from './api-client.js';
import { useSharedDraft } from './shared-draft.js';

export type Item = Today['items'][number];
export type Details = Omit<ExecutionInput, 'status'>;
export interface Draft {
  details: Details;
  base: Base;
}
export const NO_DETAILS: Details = {
  duration_seconds: null,
  actual_amount: null,
  difficulty_or_quality: null,
  energy_note: null,
};
// Same rules as the detail inputs (min="0", the decimal pattern).
const AMOUNT = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
export const detailsValid = (d: Details) =>
  (d.duration_seconds === null || d.duration_seconds >= 0) &&
  (d.actual_amount === null || AMOUNT.test(d.actual_amount));
interface Callbacks {
  onSuccess?: () => void;
  onError?: (error: Error) => void;
}

/**
 * Today's execution of one Habit: completion, details and Undo. Every view of the Habit
 * (card, snackbar, Details sheet) uses this hook, so they share one write queue key and
 * one draft. The draft remembers the execution it started from, so a stale draft cannot
 * overwrite a change made elsewhere: its write is sent with the original ETag and the
 * server rejects it as a conflict.
 */
export function useExecution(item: Item, date: string, etag: string) {
  const key = ['execution', date, item.habit_id];
  const write = useWrite(key);
  // Shared by every view of this Habit.
  const busy = useBusy(key) || write.isPending;
  const etagFor = useExecutionEtag();
  const e = item.execution;
  const complete = e?.status === 'completed';
  // Before completion the draft exists only in this browser; afterwards it holds unsaved
  // edits. Undo or completion clears it for every view.
  const [draft, setDraft] = useSharedDraft<Draft>(`${date}/${item.habit_id}`);
  const shown: Base = { execution: e, etag };
  const saved: Details = {
    duration_seconds: e?.duration_seconds ?? null,
    actual_amount: e?.actual_amount ?? null,
    difficulty_or_quality: e?.difficulty_or_quality ?? null,
    energy_note: e?.energy_note ?? null,
  };
  const details = draft?.details ?? saved;
  const edit = (patch: Partial<Details>) =>
    setDraft({ details: { ...details, ...patch }, base: draft?.base ?? shown });
  const put = (body: ExecutionInput, base: Base, callbacks: Callbacks = {}) =>
    write.mutate(
      {
        path: `/days/${date}/habits/${item.habit_id}/execution`,
        method: 'PUT',
        body,
        etag: etagFor(item.habit_id, base),
      },
      { onSuccess: callbacks.onSuccess, onError: callbacks.onError },
    );
  // One tap records completion together with the current draft, which may be empty.
  // Returns false without writing when the draft is invalid.
  const completeNow = (callbacks: Callbacks = {}) => {
    if (!detailsValid(details)) return false;
    put({ status: 'completed', ...details }, draft?.base ?? shown, {
      ...callbacks,
      onSuccess: () => {
        setDraft(null);
        callbacks.onSuccess?.();
      },
    });
    return true;
  };
  // A completed write keeps the original completion time on the server.
  const saveDetails = (callbacks: Callbacks = {}) => {
    if (!draft || !detailsValid(details)) return false;
    put({ status: 'completed', ...details }, draft.base, {
      ...callbacks,
      onSuccess: () => {
        setDraft(null);
        callbacks.onSuccess?.();
      },
    });
    return true;
  };
  // Undo cancels the completion: once it succeeds no details remain, not even as a draft.
  const undo = (callbacks: Callbacks = {}) => {
    // Fields show empty while Undo is pending; the draft is dropped only if it succeeds and
    // restored exactly, for every view, if it fails (for example on a conflict).
    const previous = draft;
    setDraft({ details: NO_DETAILS, base: shown });
    put({ status: 'incomplete', ...NO_DETAILS }, shown, {
      onSuccess: () => {
        setDraft(null);
        callbacks.onSuccess?.();
      },
      onError: (error) => {
        setDraft(previous);
        callbacks.onError?.(error);
      },
    });
  };
  const discard = () => {
    setDraft(null);
    write.reset();
  };
  return {
    complete,
    busy,
    error: write.error,
    draft,
    details,
    edit,
    completeNow,
    saveDetails,
    undo,
    discard,
  };
}
