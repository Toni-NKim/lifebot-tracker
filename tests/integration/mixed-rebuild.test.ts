// Random sequences of real commands over several days, then two independent checks:
// the SQLite index equals a fresh projection of Markdown, and a cold service built
// from Markdown alone (state directory deleted) serves identical results.
import { expect, it } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { harness, habitFields, routineFields, execution, undone } from '../helpers.js';
import { AppError, type Schedule } from '../../app/shared/contracts/index.js';
import { project, addDays } from '../../app/shared/domain/index.js';
import { TrackerService } from '../../app/server/services/tracker.js';
import { Vault } from '../../app/server/storage/markdown/vault.js';
import { Index } from '../../app/server/index/sqlite/index.js';

const schedule = fc.oneof(
  fc.constant<Schedule>({ type: 'daily' }),
  fc.constant<Schedule>({ type: 'weekdays' }),
  fc.constant<Schedule>({ type: 'weekends' }),
  fc.constant<Schedule>({ type: 'selected_weekdays', weekdays: [1, 3, 5] }),
  fc.constant<Schedule>({ type: 'every_n_days', interval_days: 2, anchor_date: '2026-09-21' }),
  fc.integer({ min: 1, max: 7 }).map<Schedule>((count) => ({ type: 'weekly_quota', count })),
  fc.integer({ min: 1, max: 20 }).map<Schedule>((count) => ({ type: 'monthly_quota', count })),
);
const pick = fc.nat();
const command = fc.oneof(
  { weight: 3, arbitrary: schedule.map((s) => ({ kind: 'createHabit' as const, s })) },
  { weight: 1, arbitrary: fc.constant({ kind: 'createRoutine' as const }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('rename' as const), i: pick }) },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('reschedule' as const), i: pick, s: schedule }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('join' as const), i: pick, j: pick }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('deleteHabit' as const), i: pick }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('routineTime' as const), j: pick }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('deleteRoutine' as const), j: pick }) },
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('complete' as const), i: pick }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('undo' as const), i: pick }) },
  {
    weight: 3,
    arbitrary: fc.integer({ min: 1, max: 4 }).map((n) => ({ kind: 'nextDay' as const, n })),
  },
);
// Rejections a user can legitimately trigger with these commands; anything else,
// including other invalid proposals (a service bug), fails the property.
const legitimate = (e: unknown) =>
  e instanceof AppError &&
  (e.code === 'NOT_SCHEDULED' ||
    e.code === 'NOT_FOUND' ||
    (e.code === 'VALIDATION_ERROR' &&
      /Deleted Habits cannot be restored|membership references absent\/deleted Routine/.test(
        e.message,
      )));

it('mixed command sequences keep the index equal to Markdown and survive a cold rebuild', async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(command, { minLength: 5, maxLength: 30 }), async (commands) => {
      const t = await harness('2026-09-21');
      try {
        let day = '2026-09-21';
        t.setNow(`${day}T03:00:00Z`);
        const habits: string[] = [];
        const routines: string[] = [];
        const at = <T>(list: T[], i: number) => (list.length ? list[i % list.length] : undefined);
        for (const c of commands) {
          const id = 'i' in c ? at(habits, c.i) : undefined;
          const routine = 'j' in c ? at(routines, c.j) : undefined;
          try {
            switch (c.kind) {
              case 'createHabit':
                habits.push(
                  (
                    await t.create(
                      habitFields({
                        schedule: { mode: 'explicit', source_routine_revision: null, rule: c.s },
                      }),
                    )
                  ).id,
                );
                break;
              case 'createRoutine':
                routines.push((await t.routine(routineFields())).id);
                break;
              case 'rename':
                if (id) await t.service.editHabit(id, { name: `N${day}` }, randomUUID(), t.etag());
                break;
              case 'reschedule':
                if (id)
                  await t.service.editHabit(
                    id,
                    { schedule: { mode: 'explicit', source_routine_revision: null, rule: c.s } },
                    randomUUID(),
                    t.etag(),
                  );
                break;
              case 'join':
                if (id && routine)
                  await t.service.editHabit(id, { routine_ids: [routine] }, randomUUID(), t.etag());
                break;
              case 'deleteHabit':
                if (id)
                  await t.service.editHabit(
                    id,
                    { deleted: true, active: false },
                    randomUUID(),
                    t.etag(),
                  );
                break;
              case 'routineTime':
                if (routine)
                  await t.service.editRoutine(
                    routine,
                    { scheduled_time: '06:30' },
                    randomUUID(),
                    t.etag(),
                  );
                break;
              case 'deleteRoutine':
                if (routine)
                  await t.service.editRoutine(routine, { deleted: true }, randomUUID(), t.etag());
                break;
              case 'complete':
              case 'undo':
                if (id)
                  await t.service.execute(
                    day,
                    id,
                    c.kind === 'complete' ? execution() : undone(),
                    randomUUID(),
                    t.etag(),
                  );
                break;
              case 'nextDay':
                day = addDays(day, c.n);
                t.setNow(`${day}T03:00:00Z`);
                break;
            }
          } catch (e) {
            if (!legitimate(e)) throw e;
          }
        }
        const now = `${day}T03:00:00Z`;
        const views = async (service: TrackerService) => ({
          today: (await service.today()).data,
          stats: (await service.stats()).data,
          history: (await service.history('2026-09-01', '2026-12-31', 0, 200)).data,
        });
        const before = await views(t.service);
        // `cutoff` only records when the index was built; every derived row must match.
        expect({ ...t.index.read(), cutoff: now }).toEqual(project(t.vault.load(), now));
        // Markdown alone: delete every piece of derived and runtime state.
        fs.rmSync(path.dirname(t.index.file), { recursive: true, force: true });
        const cold = new TrackerService(
          new Vault(t.vault.root),
          new Index(t.index.file),
          () => now,
        );
        await cold.initialize();
        expect(await views(cold)).toEqual(before);
      } finally {
        t.cleanup();
      }
    }),
    { numRuns: 25 },
  );
}, 300_000);
