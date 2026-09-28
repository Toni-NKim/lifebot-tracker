import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Vault } from '../app/server/storage/markdown/vault.js';
import { Index } from '../app/server/index/sqlite/index.js';
import { TrackerService } from '../app/server/services/tracker.js';
import type { HabitFields, RoutineFields, ExecutionInput } from '../app/shared/contracts/index.js';
export const habitFields = (patch: Partial<HabitFields> = {}): HabitFields => ({
  name: 'Reading',
  description: '책 읽기',
  active: true,
  deleted: false,
  parent_routine_id: null,
  schedule: { mode: 'explicit', source_routine_revision: null, rule: { type: 'daily' } },
  scheduled_time: { mode: 'explicit', source_routine_revision: null, value: '22:00' },
  minimum_duration_seconds: 1200,
  target_amount: '20',
  unit: 'pages',
  ...patch,
});
export const routineFields = (patch: Partial<RoutineFields> = {}): RoutineFields => ({
  name: 'Morning',
  description: '',
  deleted: false,
  schedule: { type: 'daily' },
  scheduled_time: '07:00',
  habit_order: [],
  ...patch,
});
export const execution = (patch: Partial<ExecutionInput> = {}): ExecutionInput => ({
  status: 'completed',
  duration_seconds: 60,
  actual_amount: '1',
  difficulty_or_quality: null,
  energy_note: '피곤했음\n하지만 완료',
  ...patch,
});
// Undo: an incomplete execution never carries completion details.
export const undone = (): ExecutionInput => ({
  status: 'incomplete',
  duration_seconds: null,
  actual_amount: null,
  difficulty_or_quality: null,
  energy_note: null,
});
export async function harness(start = '2026-09-21') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'habit-test-'));
  const vault = new Vault(path.join(root, 'vault/Life/HabitTracker'));
  let now = `${start}T00:00:00Z`;
  vault.initialize({
    schema_version: 1,
    kind: 'tracker',
    id: randomUUID(),
    created_at: now,
    tracking_started_on: start,
    timezone: 'Asia/Seoul',
    week_starts_on: 'monday',
  });
  const index = new Index(path.join(root, 'state/index.sqlite'));
  const service = new TrackerService(vault, index, () => now);
  await service.initialize();
  const etag = () => vault.load().fingerprint;
  return {
    root,
    vault,
    index,
    service,
    etag,
    setNow: (at: string) => {
      now = at;
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    create: async (fields = habitFields()) => {
      const command = randomUUID();
      await service.createHabit(fields, undefined, command, etag());
      return vault.load().habits.find((h) => h.command_id === command)!;
    },
    routine: async (fields = routineFields()) => {
      const command = randomUUID();
      await service.createRoutine(fields, undefined, command, etag());
      return vault.load().routines.find((r) => r.command_id === command)!;
    },
  };
}
