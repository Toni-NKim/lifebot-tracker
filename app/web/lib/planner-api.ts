import { useMemo, useRef, useSyncExternalStore } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { request } from './api-client.js';
import type { TimeboxService } from '../../server/services/timebox.js';
import type { TodoService } from '../../server/services/todo.js';
export type Agenda = Awaited<ReturnType<TimeboxService['read']>>['data'];
export type Todos = Awaited<ReturnType<TodoService['read']>>['data'];
import {
  usePlannerState,
  beginPlannerCommand,
  failPlannerCommand,
  settlePlannerCommand,
  clearPlannerNotice,
  plannerPendingStore,
  type PlannerCommand as Command,
  type SubmittedDraft,
} from './planner-store.js';
export function usePlannerWrite(scope = 'modules') {
  const client = useQueryClient();
  const lastEtag = useRef('');
  const state = usePlannerState(scope);
  const failure = state.entries.find((e) => e.error !== null);
  const failed = failure?.command ?? null;
  const notice = failure?.error ?? state.notice;
  const pendingStore = useMemo(() => plannerPendingStore(client), [client]);
  const pending = useSyncExternalStore(pendingStore.subscribe, pendingStore.getSnapshot);
  const mutation = useMutation({
    mutationKey: ['planner'],
    networkMode: 'always',
    retry: false,
    mutationFn: async (c: Command) => {
      if (!navigator.onLine)
        throw new Error('연결 후 다시 시도해 주세요. 오프라인 작업은 예약하지 않습니다.');
      return request<{
        etag?: string;
        state?: string;
        error?: { message: string };
        index_warning?: string;
      }>(c.path, {
        method: c.method,
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': c.id,
          'If-Match': c.etag,
        },
        body: JSON.stringify(c.body),
      });
    },
    onSuccess: (result, command) => {
      command.onSuccess?.();
      lastEtag.current = result.etag ?? '';
      settlePlannerCommand(
        scope,
        command,
        result.state === 'pending'
          ? `Todo는 저장됐습니다. 계획 배치는 재개가 필요합니다: ${result.error?.message ?? ''}`
          : (result.index_warning ?? '저장했습니다.'),
      );
    },
    onError: (e, c) => {
      failPlannerCommand(scope, c, e.message);
    },
    onSettled: () => client.invalidateQueries(),
  });
  const execute = async (c: Command) => {
    beginPlannerCommand(scope, c);
    try {
      await mutation.mutateAsync(c);
      return true;
    } catch {
      return false;
    }
  };
  return {
    scope,
    pending,
    lastEtag,
    notice,
    failed,
    run: (
      path: string,
      body: unknown,
      etag: string,
      method = 'POST',
      onSuccess?: () => void,
      draft?: SubmittedDraft,
    ) =>
      execute({
        path,
        body: structuredClone(body),
        etag,
        method,
        id: crypto.randomUUID(),
        onSuccess,
        draft,
      }),
    retry: () => failed && execute(failed),
    clear: () => {
      if (failed) settlePlannerCommand(scope, failed);
      else clearPlannerNotice(scope);
    },
  };
}
