import { z } from 'zod';
import { LifebotError, shapeError } from './errors.js';

export const readPaths = [
  '/today',
  '/agenda',
  '/habits',
  '/todo',
  '/history',
  '/statistics',
  '/system/status',
  '/system/modules',
] as const;
export type ReadPath = (typeof readPaths)[number];
export interface TrackerReader {
  get<T extends z.ZodTypeAny>(
    path: ReadPath,
    schema: T,
    query?: Record<string, string>,
  ): Promise<z.infer<T>>;
}

export function scratchConnection(env: Record<string, string | undefined>) {
  if (env.LIFEBOT_SCRATCH_ONLY !== 'true')
    throw new LifebotError(
      'CONFIGURATION_ERROR',
      'Set LIFEBOT_SCRATCH_ONLY=true only for a scratch Tracker deployment.',
    );
  const url = new URL(env.LIFEBOT_TRACKER_URL ?? '');
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new LifebotError(
      'CONFIGURATION_ERROR',
      'V0.1 requires an explicit loopback HTTP origin, without credentials, path, query or fragment.',
    );
  return url.origin;
}

export class TrackerHttpClient implements TrackerReader {
  constructor(
    private origin: string,
    private fetcher: typeof fetch = fetch,
    private credential?: string,
  ) {
    scratchConnection({ LIFEBOT_SCRATCH_ONLY: 'true', LIFEBOT_TRACKER_URL: origin });
  }
  async get<T extends z.ZodTypeAny>(
    path: ReadPath,
    schema: T,
    query: Record<string, string> = {},
  ): Promise<z.infer<T>> {
    if (!(readPaths as readonly string[]).includes(path))
      throw new LifebotError(
        'FORBIDDEN_OPERATION',
        'Only allowlisted Tracker reads are supported.',
      );
    const url = new URL(`/api/v1${path}`, this.origin);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    try {
      const response = await this.fetcher(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: {
          Accept: 'application/json',
          ...(this.credential ? { Authorization: `Bearer ${this.credential}` } : {}),
        },
      });
      // Bound transport memory as well as the model-facing collections.
      if (Number(response.headers.get('content-length')) > 8 * 1024 * 1024) throw shapeError();
      const reader = response.body?.getReader();
      if (!reader) throw shapeError();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 8 * 1024 * 1024) throw shapeError();
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw shapeError();
      }
      if (!response.ok) {
        const parsed = z.object({ error: z.object({ code: z.string() }) }).safeParse(body);
        const code = parsed.success ? parsed.data.error.code : `HTTP_${response.status}`;
        // Upstream messages can contain paths or raw storage diagnostics.
        throw new LifebotError(
          code,
          'Tracker read is unavailable; inspect Tracker diagnostics if needed.',
          response.status,
        );
      }
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw shapeError();
      return parsed.data;
    } catch (e) {
      if (e instanceof LifebotError) throw e;
      throw new LifebotError(
        'CONNECTION_UNAVAILABLE',
        'Cannot read the scratch Tracker over HTTP.',
      );
    }
  }
}

import { validateFrozen, type FrozenCommand, type WriteResult } from './contracts/writes.js';
import { id, date } from './contracts/primitives.js';

export function writeFailure(
  command: FrozenCommand | undefined,
  code: string,
  outcome: 'rejected' | 'unknown',
  category: NonNullable<WriteResult['error']>['category'],
  review = false,
): WriteResult {
  return {
    schema_version: '1',
    outcome,
    command_id: command?.command_id ?? null,
    ...(command ? { operation: command.operation } : {}),
    error: {
      code,
      category,
      message:
        outcome === 'unknown'
          ? 'Tracker did not establish whether this command committed. Preserve its identity.'
          : 'The request was rejected. Review the original intent and observed versions.',
      retry: review
        ? 'requires_user_review'
        : outcome === 'unknown'
          ? 'exact_request_only'
          : 'never',
      expected_versions: command?.expected_versions ?? {},
      resolution_options: review
        ? ['review_current', 'cancel_request']
        : outcome === 'unknown'
          ? ['retry_exact', 'review_current']
          : ['cancel_request'],
    },
  };
}
const conflictCodes = ['REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'SOURCE_CHANGED'];
const rejectionCodes = [
  'VALIDATION_ERROR',
  'DAY_LOCKED',
  'NOT_SCHEDULED',
  'NOT_FOUND',
  'EXECUTION_STARTED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'FORBIDDEN_OPERATION',
  'UNSUPPORTED_MEDIA_TYPE',
  ...conflictCodes,
];
export class TrackerWriteClient {
  constructor(
    readonly origin: string,
    private credential: string,
    private fetcher: typeof fetch = fetch,
  ) {
    scratchConnection({ LIFEBOT_SCRATCH_ONLY: 'true', LIFEBOT_TRACKER_URL: origin });
    if (!/^[a-f0-9]{64}$/.test(credential))
      throw new Error('Invalid machine credential configuration');
  }
  async send(command: FrozenCommand): Promise<WriteResult> {
    try {
      validateFrozen(command);
      if (command.origin !== this.origin) throw new Error();
    } catch {
      return writeFailure(command, 'COMMAND_BINDING_ERROR', 'rejected', 'validation');
    }
    try {
      const response = await this.fetcher(new URL(command.request.path, this.origin), {
        method: command.request.method,
        body: command.request.body,
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Bearer ${this.credential}`,
          ...command.request.headers,
        },
      });
      if (Number(response.headers.get('content-length')) > 8 * 1024 * 1024) throw new Error();
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 8 * 1024 * 1024) throw new Error();
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      // These endpoints use saved:true as an authoritative acknowledgement; status alone is insufficient.
      const saved = z
        .object({ data: z.object({ saved: z.literal(true) }), etag: z.string() })
        .safeParse(body);
      if (response.ok && saved.success) {
        const entities: NonNullable<WriteResult['entities']> = [];
        if (command.operation.endsWith('_habit')) {
          // Identity is returned by Tracker, never computed by this adapter.
          const parsed = z
            .object({
              data: z.object({ execution_changes: z.array(z.object({ id, habit_id: id, date })) }),
            })
            .safeParse(body);
          const item = parsed.success
            ? parsed.data.data.execution_changes.find(
                (h) =>
                  h.habit_id === command.arguments.habit_id && h.date === command.arguments.date,
              )
            : undefined;
          if (item) entities.push({ kind: 'habit_execution', ...item });
        } else {
          const parsed = z
            .object({
              data: z.object({
                changes: z.array(
                  z.object({
                    kind: z.enum(['inbox_item', 'todo', 'todo_occurrence', 'todo_execution']),
                    id,
                    data: z
                      .object({ todo_id: id.optional(), occurrence_id: id.optional() })
                      .optional(),
                  }),
                ),
              }),
            })
            .safeParse(body);
          if (parsed.success)
            for (const r of parsed.data.data.changes)
              entities.push({
                kind: r.kind,
                id: r.id,
                ...(r.data?.todo_id ? { todo_id: r.data.todo_id } : {}),
                ...(r.data?.occurrence_id ? { occurrence_id: r.data.occurrence_id } : {}),
              });
        }
        // No post-write refresh is necessary. Missing projection details cannot undo a confirmed commit.
        return {
          schema_version: '1',
          command_id: command.command_id,
          operation: command.operation,
          outcome: 'committed',
          entities,
        };
      }
      const error = z.object({ error: z.object({ code: z.string() }) }).safeParse(body);
      if (!response.ok && error.success && rejectionCodes.includes(error.data.error.code)) {
        const code = error.data.error.code;
        return writeFailure(
          command,
          code,
          'rejected',
          conflictCodes.includes(code)
            ? 'conflict'
            : ['UNAUTHORIZED', 'FORBIDDEN', 'FORBIDDEN_OPERATION'].includes(code)
              ? 'authorization'
              : 'validation',
          conflictCodes.includes(code),
        );
      }
      return writeFailure(command, 'UNCONFIRMED_RESPONSE', 'unknown', 'unavailable');
    } catch {
      return writeFailure(command, 'TRANSPORT_UNCERTAIN', 'unknown', 'transport');
    }
  }
}
