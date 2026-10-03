import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { NewModuleName } from './modules.js';
import type { ModuleServices } from './module-runtime.js';
import type { TrackerService } from './services/tracker.js';

export function registerModuleMaintenance(
  app: FastifyInstance,
  habit: TrackerService,
  modules: ModuleServices,
) {
  const params = Type.Object(
    { module: Type.Union([Type.Literal('todo'), Type.Literal('timebox')]) },
    { additionalProperties: false },
  );
  const body = Type.Object({}, { additionalProperties: false });
  app.get('/api/v1/system/modules', async () => ({
    habit: await habit.status(),
    todo: await modules.todo.status(),
    timebox: await modules.timebox.status(),
  }));
  for (const operation of ['initialize', 'validate', 'rebuild'] as const)
    app.post(
      `/api/v1/system/modules/:module/${operation}`,
      { schema: { params, body } },
      async (req, reply) => {
        const module = modules[(req.params as { module: NewModuleName }).module];
        const result =
          operation === 'initialize'
            ? await module.initializeModule((await habit.read((s) => s.tracker)).data)
            : operation === 'validate'
              ? await module.validateVault()
              : await module.rebuild();
        if ('etag' in result) reply.header('ETag', `"${result.etag}"`);
        return result;
      },
    );
}
