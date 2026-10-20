import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../shared/contracts/index.js';

export const machineOperations = ['capture_inbox', 'create_todo', 'start_todo', 'complete_todo',
  'undo_todo', 'start_habit', 'complete_habit', 'undo_habit'] as const;
export type MachineScope = 'read' | typeof machineOperations[number];
export interface MachinePrincipal { token: string; scopes: MachineScope[]; revoked?: boolean }
export function scratchPrincipal(env: NodeJS.ProcessEnv): MachinePrincipal | undefined {
  if (!env.LIFEBOT_MACHINE_TOKEN) return undefined;
  const scopes = (env.LIFEBOT_MACHINE_SCOPES ?? 'read').split(',');
  if (!/^[a-f0-9]{64}$/.test(env.LIFEBOT_MACHINE_TOKEN) ||
      scopes.some(s => !(['read', ...machineOperations] as string[]).includes(s)))
    throw new Error('Invalid machine principal configuration');
  return { token: env.LIFEBOT_MACHINE_TOKEN, scopes: scopes as MachineScope[] };
}
const reads = new Set(['today', 'agenda', 'habits', 'todo', 'history', 'statistics', 'system/status', 'system/modules']
  .map(p => `/api/v1/${p}`));
const uuid = '[0-9a-f-]{36}';
export function installMachineAuth(app: FastifyInstance, principal: MachinePrincipal | undefined,
  origin: string | undefined, production: boolean | undefined) {
  if (principal && (production || !origin || !['127.0.0.1', '[::1]'].includes(new URL(origin).hostname) ||
      !/^[a-f0-9]{64}$/.test(principal.token))) throw new Error('Machine access requires isolated loopback scratch mode');
  const authenticated = new WeakSet<object>();
  app.addHook('onRequest', async req => {
    if (!req.headers.authorization) return;
    const supplied = req.headers.authorization;
    const expected = `Bearer ${principal?.token ?? ''}`;
    if (!principal || principal.revoked || supplied.length !== expected.length ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)))
      throw new AppError('UNAUTHORIZED', 'Machine credential is invalid or revoked', 401);
    if (req.headers.origin || req.headers.host !== new URL(origin!).host)
      throw new AppError('FORBIDDEN', 'Machine requests require the configured host and no browser Origin', 403);
    const route = req.url.split('?')[0];
    const read = req.method === 'GET' && reads.has(route);
    const write = !req.url.includes('?') && (
      (req.method === 'POST' && ['/api/v1/todo/inbox', '/api/v1/todo/items'].includes(route)) ||
      (req.method === 'POST' && new RegExp(`^/api/v1/todo/items/${uuid}/execute$`).test(route)) ||
      (req.method === 'POST' && new RegExp(`^/api/v1/days/\\d{4}-\\d{2}-\\d{2}/habits/${uuid}/start$`).test(route)) ||
      (req.method === 'PUT' && new RegExp(`^/api/v1/days/\\d{4}-\\d{2}-\\d{2}/habits/${uuid}/execution$`).test(route)));
    if ((!read && !write) || (read && !principal.scopes.includes('read')))
      throw new AppError('FORBIDDEN_OPERATION', 'Machine operation is not allowed', 403);
    authenticated.add(req);
  });
  app.addHook('preValidation', async req => {
    if (!authenticated.has(req) || req.method === 'GET') return;
    const body = req.body as Record<string, unknown> | null;
    const route = req.url;
    let operation: string | undefined;
    if (route === '/api/v1/todo/inbox') operation = 'capture_inbox';
    else if (route === '/api/v1/todo/items' && body?.recurrence === null) operation = 'create_todo';
    else if (route.endsWith('/execute') && ['start', 'complete', 'undo'].includes(String(body?.action)) && body?.plan_ref === null)
      operation = `${body!.action}_todo`;
    else if (route.endsWith('/start') && body?.plan_ref === null) operation = 'start_habit';
    else if (route.endsWith('/execution')) operation = body?.status === 'completed' ? 'complete_habit' : body?.status === 'incomplete' ? 'undo_habit' : undefined;
    if (!operation || !principal!.scopes.includes(operation as MachineScope))
      throw new AppError('FORBIDDEN_OPERATION', 'Machine operation is not allowed', 403);
  });
  return (req: object) => authenticated.has(req);
}
