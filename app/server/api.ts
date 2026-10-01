import Fastify from 'fastify';
import staticPlugin from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { Type } from '@sinclair/typebox';
import {
  AppError,
  HabitInputSchema,
  RoutineInputSchema,
  PlanRefSchema,
  ExecutionInputSchema,
  DateSchema,
  UUID,
  validate,
  type HabitFields,
  type RoutineFields,
  type ExecutionInput,
} from '../shared/contracts/index.js';
import { date } from '../shared/domain/index.js';
import type { TrackerService } from './services/tracker.js';
import type { ModuleServices } from './module-runtime.js';
import { registerModuleMaintenance } from './module-api.js';
import { registerTodoApi } from './todo-api.js';
import { TodoService } from './services/todo.js';
export async function createApp(
  service: TrackerService,
  options: {
    origin?: string;
    production?: boolean;
    owner?: string;
    webRoot?: string;
    logger?: boolean;
    modules?: ModuleServices;
  } = {},
) {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 256 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  app.addHook('onRequest', async (req) => {
    const origin = options.origin;
    if (options.production && req.headers['tailscale-user-login'] !== options.owner)
      throw new AppError('FORBIDDEN', 'Access is restricted to the tracker owner', 403);
    if (origin && options.production && req.headers.host !== new URL(origin).host)
      throw new AppError('FORBIDDEN', 'Invalid host', 403);
    if (req.method !== 'GET' && req.method !== 'HEAD' && origin && req.headers.origin !== origin)
      throw new AppError('FORBIDDEN', 'Mutation origin does not match APP_ORIGIN', 403);
    if (
      req.method !== 'GET' &&
      req.method !== 'HEAD' &&
      !req.headers['content-type']?.startsWith('application/json')
    )
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Mutations require application/json', 415);
  });
  app.setErrorHandler((error, _req, reply) => {
    const e = error as AppError & { validation?: unknown; statusCode?: number };
    if (e.statusCode && e.statusCode >= 500) app.log.error(e);
    return reply.status(e.status ?? e.statusCode ?? 500).send({
      error: {
        code: e.code ?? (e.validation ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR'),
        message:
          e.status || e.validation || (e.statusCode && e.statusCode < 500)
            ? e.message
            : 'Unexpected server error; check server logs',
      },
    });
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    return payload;
  });
  const headers = Type.Object({
    'idempotency-key': UUID,
    'if-match': Type.String({ minLength: 1 }),
  });
  const idParams = Type.Object({ id: UUID });
  const auth = (h: Record<string, unknown>) =>
    [String(h['idempotency-key']), String(h['if-match']).replace(/^"|"$/g, '')] as const;
  const send = async (
    promise: Promise<unknown>,
    reply: { header: (key: string, value: string) => unknown },
  ) => {
    const value = (await promise) as { etag?: string };
    if (value.etag) reply.header('ETag', `"${value.etag}"`);
    return value;
  };
  app.get('/api/v1/today', (_r, reply) => send(service.today(), reply));
  for (const kind of ['habit', 'routine'] as const) {
    const route = `/api/v1/${kind}s`;
    const fields = kind === 'habit' ? HabitInputSchema : RoutineInputSchema;
    app.get(route, (_r, reply) => send(service.list(kind), reply));
    app.post(
      route,
      {
        schema: {
          headers,
          body: Type.Object(
            { fields, starts_on: Type.Optional(DateSchema) },
            { additionalProperties: false },
          ),
        },
      },
      (req, reply) => {
        const body = req.body as { fields: HabitFields & RoutineFields; starts_on?: string };
        const [cmd, etag] = auth(req.headers);
        return send(
          kind === 'habit'
            ? service.createHabit(body.fields, body.starts_on, cmd, etag)
            : service.createRoutine(body.fields, body.starts_on, cmd, etag),
          reply,
        );
      },
    );
    app.patch(
      `${route}/:id`,
      { schema: { headers, params: idParams, body: Type.Partial(fields) } },
      (req, reply) => {
        const id = (req.params as { id: string }).id;
        const [cmd, etag] = auth(req.headers);
        return send(
          kind === 'habit'
            ? service.editHabit(id, req.body as Partial<HabitFields>, cmd, etag)
            : service.editRoutine(id, req.body as Partial<RoutineFields>, cmd, etag),
          reply,
        );
      },
    );
    app.delete(
      `${route}/:id`,
      {
        schema: {
          headers,
          params: idParams,
          body: Type.Object({}, { additionalProperties: false }),
        },
      },
      (req, reply) => {
        const id = (req.params as { id: string }).id;
        const [cmd, etag] = auth(req.headers);
        return send(
          kind === 'habit'
            ? service.editHabit(id, { deleted: true, active: false }, cmd, etag)
            : service.editRoutine(id, { deleted: true }, cmd, etag),
          reply,
        );
      },
    );
  }
  app.put(
    '/api/v1/days/:date/habits/:id/execution',
    {
      schema: {
        headers,
        params: Type.Object({ date: DateSchema, id: UUID }),
        body: ExecutionInputSchema,
      },
    },
    (req, reply) => {
      const { id, date } = req.params as { id: string; date: string };
      const [cmd, etag] = auth(req.headers);
      return send(service.execute(date, id, req.body as ExecutionInput, cmd, etag), reply);
    },
  );
  app.post(
    '/api/v1/days/:date/habits/:id/start',
    {
      schema: {
        headers,
        params: Type.Object({ date: DateSchema, id: UUID }),
        body: Type.Object(
          { plan_ref: Type.Union([PlanRefSchema, Type.Null()]) },
          { additionalProperties: false },
        ),
      },
    },
    (req, reply) => {
      const { id, date } = req.params as { id: string; date: string };
      const [cmd, etag] = auth(req.headers);
      return send(
        service.startExecution(
          date,
          id,
          (req.body as { plan_ref: import('../shared/contracts/index.js').PlanRef | null })
            .plan_ref,
          cmd,
          etag,
        ),
        reply,
      );
    },
  );
  const query = Type.Object(
    {
      from: Type.Optional(DateSchema),
      to: Type.Optional(DateSchema),
      habit_id: Type.Optional(UUID),
      offset: Type.Optional(Type.String({ pattern: '^[0-9]+$' })),
      limit: Type.Optional(Type.String({ pattern: '^[0-9]+$' })),
    },
    { additionalProperties: false },
  );
  app.get('/api/v1/statistics', { schema: { querystring: query } }, (req, reply) => {
    const q = req.query as { from?: string; to?: string; habit_id?: string };
    checkRange(q);
    return send(service.stats(q.from, q.to, q.habit_id), reply);
  });
  app.get('/api/v1/history', { schema: { querystring: query } }, (req, reply) => {
    const q = req.query as { from?: string; to?: string; offset?: string; limit?: string };
    const offset = Number(q.offset ?? 0);
    const limit = Number(q.limit ?? 50);
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(limit) ||
      offset < 0 ||
      limit < 1 ||
      limit > 200
    )
      throw new AppError('VALIDATION_ERROR', 'Invalid pagination');
    checkRange(q);
    return send(
      service.history(q.from ?? '0001-01-01', q.to ?? '9999-12-31', offset, limit),
      reply,
    );
  });
  app.get('/api/v1/system/status', () => service.status());
  app.post(
    '/api/v1/system/validate',
    { schema: { body: Type.Object({}, { additionalProperties: false }) } },
    () => service.validateVault(),
  );
  app.post(
    '/api/v1/system/rebuild',
    { schema: { body: Type.Object({}, { additionalProperties: false }) } },
    (_req, reply) => send(service.rebuild(), reply),
  );
  const webRoot = options.webRoot ?? path.resolve('dist/web');
  if (options.modules) {
    registerModuleMaintenance(app, service, options.modules);
    registerTodoApi(app, new TodoService(options.modules.todo));
  }
  if (fs.existsSync(webRoot)) {
    await app.register(staticPlugin, { root: webRoot });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/')
        ? reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Unknown endpoint' } })
        : reply.sendFile('index.html'),
    );
  }
  return app;
}
function checkRange(q: { from?: string; to?: string }) {
  try {
    if (q.from) date(q.from);
    if (q.to) date(q.to);
  } catch {
    throw new AppError('VALIDATION_ERROR', 'Invalid calendar date');
  }
  if (q.from && q.to && q.from > q.to)
    throw new AppError('VALIDATION_ERROR', 'Range start must be before range end');
}
