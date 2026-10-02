import { useState, useRef } from 'react';
import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';
import { request } from './api-client.js';
import type { TimeboxService } from '../../server/services/timebox.js';
import type { TodoService } from '../../server/services/todo.js';
export type Agenda = Awaited<ReturnType<TimeboxService['read']>>['data'];
export type Todos = Awaited<ReturnType<TodoService['read']>>['data'];
interface Command {
  path: string;
  method: string;
  body: unknown;
  etag: string;
  id: string;
  onSuccess?: () => void;
}
export function usePlannerWrite() {
  const client = useQueryClient();
  const lastEtag = useRef('');
  const [failed, setFailed] = useState<Command | null>(null);
  const [notice, setNotice] = useState('');
  const pending = useIsMutating({ mutationKey: ['planner'] }) > 0;
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
      setFailed(null);
      setNotice(
        result.state === 'pending'
          ? `Todo는 저장됐습니다. 계획 배치는 재개가 필요합니다: ${result.error?.message ?? ''}`
          : (result.index_warning ?? '저장했습니다.'),
      );
    },
    onError: (e, c) => {
      setFailed(c);
      setNotice(e.message);
    },
    onSettled: () => client.invalidateQueries(),
  });
  const execute = async (c: Command) => {
    try {
      await mutation.mutateAsync(c);
      return true;
    } catch {
      return false;
    }
  };
  return {
    pending,
    lastEtag,
    notice,
    failed,
    run: (path: string, body: unknown, etag: string, method = 'POST', onSuccess?: () => void) =>
      execute({ path, body, etag, method, id: crypto.randomUUID(), onSuccess }),
    retry: () => failed && execute(failed),
    clear: () => {
      setNotice('');
      setFailed(null);
    },
  };
}
