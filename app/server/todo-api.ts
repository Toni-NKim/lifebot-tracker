import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { UUID, DateSchema, PlanRefSchema, type PlanRef } from '../shared/contracts/index.js';
import { ModuleInstant } from '../shared/contracts/module.js';
import {
  strict,
  nullable,
  Title,
  TodoFieldsSchema,
  ProjectFieldsSchema,
  type TodoFields,
  type ProjectFields,
} from '../shared/contracts/todo.js';
import { TodoService } from './services/todo.js';

export function registerTodoApi(app: FastifyInstance, service: TodoService) {
  const headers = Type.Object({
    'idempotency-key': UUID,
    'if-match': Type.String({ minLength: 1 }),
  });
  const params = strict({ id: UUID });
  const auth = (h: Record<string, unknown>) =>
    [String(h['idempotency-key']), String(h['if-match']).replace(/^"|"$/g, '')] as const;
  const send = async (
    result: Promise<unknown>,
    reply: { header: (key: string, value: string) => unknown },
  ) => {
    const value = (await result) as { etag: string };
    reply.header('ETag', `"${value.etag}"`);
    return value;
  };
  app.get(
    '/api/v1/todo',
    { schema: { querystring: strict({ date: Type.Optional(DateSchema) }) } },
    (req, reply) => send(service.read((req.query as { date?: string }).date), reply),
  );
  app.post(
    '/api/v1/todo/inbox',
    { schema: { headers, body: strict({ title: Title }) } },
    (req, reply) =>
      send(service.capture((req.body as { title: string }).title, ...auth(req.headers)), reply),
  );
  app.post(
    '/api/v1/todo/inbox/:id/process',
    {
      schema: {
        headers,
        params,
        body: strict({
          when: Type.Union(['today', 'date', 'someday', 'discard'].map((s) => Type.Literal(s))),
          do_date: nullable(DateSchema),
        }),
      },
    },
    (req, reply) => {
      const body = req.body as {
        when: 'today' | 'date' | 'someday' | 'discard';
        do_date: string | null;
      };
      return send(
        service.process(
          (req.params as { id: string }).id,
          body.when,
          body.do_date,
          ...auth(req.headers),
        ),
        reply,
      );
    },
  );
  app.post('/api/v1/todo/items', { schema: { headers, body: TodoFieldsSchema } }, (req, reply) =>
    send(service.create(req.body as TodoFields, ...auth(req.headers)), reply),
  );
  app.patch(
    '/api/v1/todo/items/:id',
    { schema: { headers, params, body: Type.Partial(TodoFieldsSchema) } },
    (req, reply) =>
      send(
        service.edit(
          (req.params as { id: string }).id,
          req.body as Partial<TodoFields>,
          ...auth(req.headers),
        ),
        reply,
      ),
  );
  app.delete(
    '/api/v1/todo/items/:id',
    { schema: { headers, params, body: strict({}) } },
    (req, reply) =>
      send(service.discard((req.params as { id: string }).id, ...auth(req.headers)), reply),
  );
  for (const method of ['POST', 'PUT'] as const)
    app.route({
      method,
      url: `/api/v1/todo/projects${method === 'PUT' ? '/:id' : ''}`,
      schema: { headers, ...(method === 'PUT' ? { params } : {}), body: ProjectFieldsSchema },
      handler: (req, reply) =>
        send(
          service.project(
            method === 'PUT' ? (req.params as { id: string }).id : null,
            req.body as ProjectFields,
            ...auth(req.headers),
          ),
          reply,
        ),
    });
  app.post(
    '/api/v1/todo/items/:id/execute',
    {
      schema: {
        headers,
        params,
        body: strict({
          anchor_date: nullable(DateSchema),
          action: Type.Union(['start', 'complete', 'undo'].map((s) => Type.Literal(s))),
          note: Type.Optional(Type.String({ maxLength: 10000 })),
          plan_ref: nullable(PlanRefSchema),
        }),
      },
    },
    (req, reply) => {
      const b = req.body as {
        anchor_date: string | null;
        action: 'start' | 'complete' | 'undo';
        note?: string;
        plan_ref: PlanRef | null;
      };
      return send(
        service.execute(
          (req.params as { id: string }).id,
          b.anchor_date,
          b.action,
          b.note,
          b.plan_ref,
          ...auth(req.headers),
        ),
        reply,
      );
    },
  );
  app.post(
    '/api/v1/todo/items/:id/reschedule',
    {
      schema: {
        headers,
        params,
        body: strict({
          anchor_date: nullable(DateSchema),
          do_date: nullable(DateSchema),
          due_at: nullable(ModuleInstant),
        }),
      },
    },
    (req, reply) => {
      const b = req.body as {
        anchor_date: string | null;
        do_date: string | null;
        due_at: string | null;
      };
      return send(
        service.reschedule(
          (req.params as { id: string }).id,
          b.anchor_date,
          b.do_date,
          b.due_at,
          ...auth(req.headers),
        ),
        reply,
      );
    },
  );
}
