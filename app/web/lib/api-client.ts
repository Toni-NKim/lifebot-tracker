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
    throw new Error('Mac mini에 연결할 수 없어요. 저장되지 않았어요. 다시 연결한 뒤 기록하세요.');
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? '요청을 처리하지 못했어요.');
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
    mutationFn: ({
      path,
      method = 'POST',
      body = {},
      etag,
    }: {
      path: string;
      method?: string;
      body?: unknown;
      etag?: string;
    }) =>
      request<Envelope<unknown>>(path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
          ...(etag ? { 'If-Match': etag } : {}),
        },
        body: JSON.stringify(body),
      }),
    onSettled: () => client.invalidateQueries(),
  });
}
