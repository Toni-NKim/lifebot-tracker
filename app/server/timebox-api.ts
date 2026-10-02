import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { UUID, DateSchema, ColorSchema } from '../shared/contracts/index.js';
import { ModuleInstant } from '../shared/contracts/module.js';
import { strict, nullable, Title } from '../shared/contracts/module-fields.js';
import { ManualSchema, type ManualData } from '../shared/contracts/timebox.js';
import { TimeboxService, type Placement, type Versions } from './services/timebox.js';
const versions = strict({ habit: Type.String(), todo: Type.String(), timebox: Type.String() });
const placement = strict({
  date: DateSchema,
  candidate: nullable(Type.String()),
  title: Title,
  start: ModuleInstant,
  end: ModuleInstant,
  color: ColorSchema,
});
export function registerTimeboxApi(app: FastifyInstance, service: TimeboxService) {
  const headers = Type.Object({
    'idempotency-key': UUID,
    'if-match': Type.String({ minLength: 1 }),
  });
  const params = strict({ id: UUID });
  const command = (h: Record<string, unknown>) => String(h['idempotency-key']);
  const etag = (h: Record<string, unknown>) => String(h['if-match']).replace(/^"|"$/g, '');
  app.get(
    '/api/v1/agenda',
    { schema: { querystring: strict({ date: Type.Optional(DateSchema) }) } },
    async (req, reply) => {
      const result = await service.read((req.query as { date?: string }).date);
      reply.header('ETag', `"${result.etag}"`);
      return result;
    },
  );
  app.post(
    '/api/v1/timebox/prepare',
    { schema: { headers, body: strict({ date: DateSchema, versions }) } },
    (req) => {
      const b = req.body as { date: string; versions: Versions };
      return service.prepare(
        b.date,
        { ...b.versions, timebox: etag(req.headers) },
        command(req.headers),
      );
    },
  );
  for (const method of ['POST', 'PUT'] as const)
    app.route({
      method,
      url: `/api/v1/timebox/plans${method === 'PUT' ? '/:id' : ''}`,
      schema: {
        headers,
        ...(method === 'PUT' ? { params } : {}),
        body: strict({ placement, versions }),
      },
      handler: (req) => {
        const b = req.body as { placement: Placement; versions: Versions };
        return service.place(
          b.placement,
          method === 'PUT' ? (req.params as { id: string }).id : null,
          { ...b.versions, timebox: etag(req.headers) },
          command(req.headers),
        );
      },
    });
  app.post(
    '/api/v1/timebox/plans/:id/execute',
    {
      schema: {
        headers,
        params,
        body: strict({
          action: Type.Union(['start', 'complete', 'undo'].map((a) => Type.Literal(a))),
        }),
      },
    },
    (req) =>
      service.manualExecution(
        (req.params as { id: string }).id,
        (req.body as { action: 'start' | 'complete' | 'undo' }).action,
        etag(req.headers),
        command(req.headers),
      ),
  );
  app.delete(
    '/api/v1/timebox/plans/:id',
    { schema: { headers, params, body: strict({}) } },
    (req) =>
      service.cancel((req.params as { id: string }).id, etag(req.headers), command(req.headers)),
  );
  app.post(
    '/api/v1/timebox/priorities',
    {
      schema: {
        headers,
        body: strict({
          date: DateSchema,
          ids: Type.Array(UUID, { maxItems: 3, uniqueItems: true }),
          versions,
        }),
      },
    },
    (req) => {
      const b = req.body as { date: string; ids: string[]; versions: Versions };
      return service.priorities(
        b.date,
        b.ids,
        { ...b.versions, timebox: etag(req.headers) },
        command(req.headers),
      );
    },
  );
  for (const method of ['POST', 'PUT'] as const)
    app.route({
      method,
      url: `/api/v1/timebox/actuals${method === 'PUT' ? '/:id' : ''}`,
      schema: { headers, ...(method === 'PUT' ? { params } : {}), body: ManualSchema },
      handler: (req) =>
        service.manual(
          req.body as ManualData,
          method === 'PUT' ? (req.params as { id: string }).id : null,
          etag(req.headers),
          command(req.headers),
        ),
    });
  app.post(
    '/api/v1/timebox/inbox/:id/plan',
    { schema: { headers, params, body: strict({ placement, versions }) } },
    (req) => {
      const b = req.body as { placement: Placement; versions: Versions };
      return service.stageInbox(
        (req.params as { id: string }).id,
        b.placement,
        { ...b.versions, todo: etag(req.headers) },
        command(req.headers),
      );
    },
  );
  app.post(
    '/api/v1/timebox/actions/:id/cancel',
    { schema: { headers, params, body: strict({ versions }) } },
    (req) => {
      const b = req.body as { versions: Versions };
      return service.cancelAction(
        (req.params as { id: string }).id,
        { ...b.versions, todo: etag(req.headers) },
        command(req.headers),
      );
    },
  );
  app.post(
    '/api/v1/timebox/actions/:id/resume',
    { schema: { headers, params, body: strict({ versions, accept_current: Type.Boolean() }) } },
    (req) => {
      const b = req.body as { versions: Versions; accept_current: boolean };
      return service.resume(
        (req.params as { id: string }).id,
        { ...b.versions, todo: etag(req.headers) },
        command(req.headers),
        b.accept_current,
      );
    },
  );
}
