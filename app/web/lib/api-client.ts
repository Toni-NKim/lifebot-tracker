import { useState } from 'react';
import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
  type MutateOptions,
} from '@tanstack/react-query';
import type { TrackerService } from '../../server/services/tracker.js';
import { ApiError, NETWORK } from './errors.js';
export type Today = Awaited<ReturnType<TrackerService['today']>>['data'];
export type Stats = Awaited<ReturnType<TrackerService['stats']>>['data'];
export type HistoryData = Awaited<ReturnType<TrackerService['history']>>['data'];
export type DefinitionRows = Awaited<ReturnType<TrackerService['list']>>['data'];
export interface Envelope<T> {
  data: T;
  etag: string;
  index_warning?: string | null;
}
const unreachable = () =>
  new ApiError(
    NETWORK,
    'Cannot reach your Mac mini. Nothing was saved. Reconnect before recording.',
  );
// When the server was last unreachable; writes queued before that are never sent later.
let lastNetworkFailure = 0;
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, init);
  } catch {
    lastNetworkFailure = Date.now();
    throw unreachable();
  }
  if (!response.ok) {
    // Keep the server's error code; a body that is not JSON still reports the status.
    const body = await response.json().catch(() => null);
    throw new ApiError(
      body?.error?.code ?? `HTTP_${response.status}`,
      body?.error?.message ?? 'Request failed',
      response.status,
    );
  }
  const body = await response.json();
  return body;
}
export function useData<T>(path: string, enabled = true) {
  return useQuery({ queryKey: [path], queryFn: () => request<Envelope<T>>(path), enabled });
}
export function useRaw<T>(path: string) {
  return useQuery({ queryKey: [path], queryFn: () => request<T>(path) });
}
// `key` groups writes to one record, so every UI copy of it sees them as pending.
export interface Write {
  path: string;
  method?: string;
  body?: unknown;
  // A function is resolved when the request is sent, after any earlier write finished.
  etag?: string | (() => string | undefined);
  // Reconciliation that must happen whatever becomes of the view that sent the write. It
  // runs from the mutation itself, unlike `mutate` callbacks, which TanStack Query drops
  // once the sending component has unmounted.
  settle?: {
    onSuccess?: (response: Envelope<{ today?: Today }>) => void;
    onError?: (error: Error) => void;
  };
}
export function useWrite(key?: unknown[]) {
  const client = useQueryClient();
  const [rejected, setRejected] = useState<Error | null>(null);
  const mutation = useMutation({
    mutationKey: key,
    // Never queue offline writes: they may resume after the historical lock boundary.
    networkMode: 'always',
    // Run writes one at a time so a later write can use the ETag the previous one returned.
    scope: { id: 'tracker-write' },
    mutationFn: ({
      path,
      method = 'POST',
      body = {},
      etag,
      submittedAt,
    }: Write & { submittedAt: number }) => {
      // Waited behind a write that found the server unreachable: never send it later.
      if (submittedAt <= lastNetworkFailure) return Promise.reject(unreachable());
      const current = typeof etag === 'function' ? etag() : etag;
      return request<Envelope<{ today?: Today }>>(path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
          ...(current ? { 'If-Match': current } : {}),
        },
        body: JSON.stringify(body),
      });
    },
    onSuccess: (response, write) => {
      // The response's Today view and ETag describe the same saved state.
      if (response.data?.today)
        client.setQueryData<Envelope<Today>>(['/today'], {
          data: response.data.today,
          etag: response.etag,
          index_warning: response.index_warning,
        });
      write.settle?.onSuccess?.(response);
    },
    onError: (error, write) => write.settle?.onError?.(error),
    onSettled: () => client.invalidateQueries(),
  });
  type Options = MutateOptions<Envelope<{ today?: Today }>, Error, Write & { submittedAt: number }>;
  // Offline actions are rejected when submitted, so none waits in the queue for reconnect.
  const offline = () => {
    if (typeof navigator === 'undefined' || navigator.onLine !== false) return null;
    const error = unreachable();
    setRejected(error);
    return error;
  };
  const submit = (write: Write) => ({ ...write, submittedAt: Date.now() });
  return {
    ...mutation,
    error: rejected ?? mutation.error,
    reset: () => {
      setRejected(null);
      mutation.reset();
    },
    mutate: (write: Write, options?: Options) => {
      const error = offline();
      if (error) {
        write.settle?.onError?.(error);
        options?.onError?.(error, submit(write), undefined, undefined as never);
        options?.onSettled?.(undefined, error, submit(write), undefined, undefined as never);
        return;
      }
      setRejected(null);
      mutation.mutate(submit(write), options);
    },
    mutateAsync: (write: Write, options?: Options) => {
      const error = offline();
      if (error) {
        write.settle?.onError?.(error);
        return Promise.reject(error);
      }
      setRejected(null);
      return mutation.mutateAsync(submit(write), options);
    },
  };
}
export const useBusy = (key: unknown[]) => useIsMutating({ mutationKey: key }) > 0;
type Execution = Today['items'][number]['execution'];
// The version of one Habit's execution a write is based on, with the ETag of the same view.
export interface Base {
  execution: Execution;
  etag: string;
}
const stable = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(stable).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value)
          .sort()
          .map((k) => `${k}:${stable((value as Record<string, unknown>)[k])}`)
          .join(',')}}`
      : JSON.stringify(value);
// Resolves the ETag when the write is sent. Earlier writes to other Habits may have
// advanced the ETag; the newest one is used only while this Habit's execution in that
// same view is still the one the write was based on. Otherwise the original ETag makes
// the server reject the write as a conflict instead of overwriting newer data.
export function useExecutionEtag() {
  const client = useQueryClient();
  return (habitId: string, base: Base) => () => {
    const latest = client.getQueryData<Envelope<Today>>(['/today']);
    const current = latest?.data.items.find((i) => i.habit_id === habitId)?.execution ?? null;
    return latest && stable(current) === stable(base.execution) ? latest.etag : base.etag;
  };
}
