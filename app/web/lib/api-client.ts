import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TrackerService } from '../../server/services/tracker.js';
export type Today = Awaited<ReturnType<TrackerService['today']>>['data'];
export type Stats = Awaited<ReturnType<TrackerService['stats']>>['data'];
export type HistoryData = Awaited<ReturnType<TrackerService['history']>>['data'];
export type DefinitionRows = Awaited<ReturnType<TrackerService['list']>>['data'];
export interface Envelope<T> {
  data: T;
  etag: string;
  index_warning?: string | null;
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, init);
  } catch {
    throw new Error('Cannot reach your Mac mini. Nothing was saved. Reconnect before recording.');
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? 'Request failed');
  return body;
}
export function useData<T>(path: string) {
  return useQuery({ queryKey: [path], queryFn: () => request<Envelope<T>>(path) });
}
export function useRaw<T>(path: string) {
  return useQuery({ queryKey: [path], queryFn: () => request<T>(path) });
}
// `key` groups writes to one record, so every UI copy of it sees them as pending.
export function useWrite(key?: unknown[]) {
  const client = useQueryClient();
  return useMutation({
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
    }: {
      path: string;
      method?: string;
      body?: unknown;
      // A function is resolved when the request is sent, after any earlier write finished.
      etag?: string | (() => string | undefined);
    }) => {
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
    onSuccess: (response) => {
      // The response's Today view and ETag describe the same saved state.
      if (response.data?.today)
        client.setQueryData<Envelope<Today>>(['/today'], {
          data: response.data.today,
          etag: response.etag,
          index_warning: response.index_warning,
        });
    },
    onSettled: () => client.invalidateQueries(),
  });
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
