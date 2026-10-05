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
        headers: { Accept: 'application/json' },
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
