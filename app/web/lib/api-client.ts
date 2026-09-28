import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
export function useWrite() {
  const client = useQueryClient();
  return useMutation({
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
// The newest Today ETag, for writes that only depend on the Habit they change.
export function useTodayEtag() {
  const client = useQueryClient();
  return () => client.getQueryData<Envelope<Today>>(['/today'])?.etag;
}
