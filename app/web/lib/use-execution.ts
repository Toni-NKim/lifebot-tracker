import type { ExecutionInput } from '../../shared/contracts/index.js';
import {
  useBusy,
  useExecutionEtag,
  useWrite,
  type Base,
  type Today,
  type Write,
} from './api-client.js';
import {
  dismissDone,
  getDraft,
  postNotice,
  reportWriteError,
  setDraft,
  setWriteError,
  useSharedDraft,
  useWriteError,
} from './execution-store.js';

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
// Presentation only (closing a sheet); runs only while the calling view is mounted.
interface Callbacks {
  onSuccess?: () => void;
}
type Saved = Parameters<NonNullable<NonNullable<Write['settle']>['onSuccess']>>[0];

/**
 * Today's execution of one Habit: completion, details and Undo. Every view of the Habit
 * (card, snackbar, Details sheet) uses this hook, so they share one write queue key and
 * one draft. The draft remembers the execution it started from, so a stale draft cannot
 * overwrite a change made elsewhere: its write is sent with the original ETag and the
 * server rejects it as a conflict.
 *
 * What a finished write does to the draft and how its error is shown is decided here,
 * when the write is sent, and carried out by the write itself: it happens the same way
 * after the sheet is closed, the snackbar has expired or the Routine filter changed.
 */
export function useExecution(item: Item, date: string, etag: string) {
  const key = ['execution', date, item.habit_id];
  const id = `${date}/${item.habit_id}`;
  const write = useWrite(key);
  // Shared by every view of this Habit.
  const busy = useBusy(key);
  const etagFor = useExecutionEtag();
  const e = item.execution;
  const complete = e?.status === 'completed';
  // Before completion the draft exists only in this browser; afterwards it holds unsaved
  // edits. Undo or completion clears it for every view.
  const [draft, setShared] = useSharedDraft<Draft>(id);
  const error = useWriteError(id);
  const shown: Base = { execution: e, etag };
  const saved: Details = {
    duration_seconds: e?.duration_seconds ?? null,
    actual_amount: e?.actual_amount ?? null,
    difficulty_or_quality: e?.difficulty_or_quality ?? null,
    energy_note: e?.energy_note ?? null,
  };
  const details = draft?.details ?? saved;
  const edit = (patch: Partial<Details>) =>
    setShared({ details: { ...details, ...patch }, base: draft?.base ?? shown });
  const put = (
    body: ExecutionInput,
    base: Base,
    settle: { onSuccess?: (response: Saved) => void; onError?: () => void },
    callbacks: Callbacks = {},
  ) => {
    setWriteError(id, null);
    write.mutate(
      {
        path: `/days/${date}/habits/${item.habit_id}/execution`,
        method: 'PUT',
        body,
        etag: etagFor(item.habit_id, base),
        settle: {
          onSuccess: settle.onSuccess,
          onError: (failure) => {
            settle.onError?.();
            reportWriteError(id, failure);
          },
        },
      },
      { onSuccess: callbacks.onSuccess },
    );
  };
  // After a saved write the submitted draft is done. A draft changed meanwhile is kept,
  // now based on the saved execution so that saving it is not a false conflict.
  const reconcileSaved = (submitted: Draft | null, response: Saved) => {
    const current = getDraft<Draft>(id);
    if (current === submitted) return setDraft(id, null);
    const savedItem = response.data.today?.items.find((i) => i.habit_id === item.habit_id);
    if (current && savedItem)
      setDraft<Draft>(id, {
        details: current.details,
        base: { execution: savedItem.execution, etag: response.etag },
      });
  };
  // One tap records completion together with the current draft, which may be empty.
  // Returns false without writing when the draft is invalid.
  const completeNow = (callbacks: Callbacks = {}) => {
    if (!detailsValid(details)) return false;
    const submitted = draft;
    put(
      { status: 'completed', ...details },
      draft?.base ?? shown,
      {
        onSuccess: (response) => {
          reconcileSaved(submitted, response);
          postNotice({ kind: 'done', habitId: item.habit_id, text: item.habit.name });
        },
      },
      callbacks,
    );
    return true;
  };
  // A completed write keeps the original completion time on the server. On failure the
  // draft is left as it is, with its original base.
  const saveDetails = (callbacks: Callbacks = {}) => {
    if (!draft || !detailsValid(details)) return false;
    const submitted = draft;
    put(
      { status: 'completed', ...details },
      draft.base,
      { onSuccess: (response) => reconcileSaved(submitted, response) },
      callbacks,
    );
    return true;
  };
  // Undo cancels the completion: once it succeeds no details remain, not even as a draft.
  const undo = (callbacks: Callbacks = {}) => {
    // Fields show empty while Undo is pending; the draft is dropped only if it succeeds and
    // restored exactly, for every view, if it fails (for example on a conflict).
    const previous = draft;
    const pending: Draft = { details: NO_DETAILS, base: shown };
    setShared(pending);
    put(
      { status: 'incomplete', ...NO_DETAILS },
      shown,
      {
        onSuccess: () => {
          if (getDraft(id) === pending) setDraft(id, null);
          dismissDone(item.habit_id);
        },
        onError: () => {
          if (getDraft(id) === pending) setDraft(id, previous);
        },
      },
      callbacks,
    );
  };
  const discard = () => {
    setShared(null);
    setWriteError(id, null);
  };
  return {
    complete,
    busy,
    error,
    draft,
    details,
    edit,
    completeNow,
    saveDetails,
    undo,
    discard,
  };
}
