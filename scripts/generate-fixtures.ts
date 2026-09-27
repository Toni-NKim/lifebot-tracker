// Fixed synthetic data only. This script does not use application environment variables.
import fs from 'node:fs';
import path from 'node:path';
import { serialize } from '../app/server/storage/markdown/vault.js';
import { executionId } from '../app/shared/domain/index.js';
import type {
  Tracker,
  Routine,
  Habit,
  Daily,
  Commit,
  Document,
} from '../app/shared/contracts/index.js';
const root = path.resolve('tests/fixtures/obsidian-vault/Life/HabitTracker');
const trackerId = '10000000-0000-4000-8000-000000000001';
const routineId = '20000000-0000-4000-8000-000000000001';
const habitId = '30000000-0000-4000-8000-000000000001';
const quotaId = '30000000-0000-4000-8000-000000000002';
const commandId = '40000000-0000-4000-8000-000000000001';
const at = '2026-09-21T00:00:00Z';
const day = '2026-09-21';
const tracker: Tracker = {
  schema_version: 1,
  kind: 'tracker',
  id: trackerId,
  created_at: at,
  tracking_started_on: day,
  timezone: 'Asia/Seoul',
  week_starts_on: 'monday',
};
const common = {
  schema_version: 1 as const,
  revision: 1,
  command_id: commandId,
  created_at: at,
  recorded_at: at,
  effective_from: day,
};
const routine: Routine = {
  ...common,
  kind: 'routine',
  id: routineId,
  name: 'Evening routine (fixture)',
  description: 'Synthetic example',
  deleted: false,
  schedule: { type: 'daily' },
  scheduled_time: '22:00',
  habit_order: [habitId],
};
const reading: Habit = {
  ...common,
  kind: 'habit',
  id: habitId,
  name: 'Reading (fixture)',
  description: '책 읽기 — synthetic data',
  active: true,
  deleted: false,
  parent_routine_id: routineId,
  schedule: { mode: 'routine', source_routine_revision: 1, rule: { type: 'daily' } },
  scheduled_time: { mode: 'routine', source_routine_revision: 1, value: '22:00' },
  minimum_duration_seconds: 1200,
  target_amount: '20',
  unit: 'pages',
};
const exercise: Habit = {
  ...reading,
  id: quotaId,
  name: 'Exercise (fixture)',
  parent_routine_id: null,
  schedule: {
    mode: 'explicit',
    source_routine_revision: null,
    rule: { type: 'weekly_quota', count: 3 },
  },
  scheduled_time: { mode: 'explicit', source_routine_revision: null, value: '19:00' },
  minimum_duration_seconds: 600,
  target_amount: null,
  unit: null,
};
const commit: Commit = {
  schema_version: 1,
  kind: 'definition_commit',
  id: commandId,
  recorded_at: at,
  request_sha256: '0'.repeat(64),
  files: [
    `Routines/${routineId}/000001.md`,
    `Habits/${habitId}/000001.md`,
    `Habits/${quotaId}/000001.md`,
  ],
};
const daily: Daily = {
  schema_version: 1,
  kind: 'daily_execution',
  tracker_id: trackerId,
  date: day,
  timezone: 'Asia/Seoul',
  revision: 1,
  created_at: at,
  updated_at: at,
  executions: [
    {
      id: executionId(trackerId, habitId, day),
      habit_id: habitId,
      habit_revision: 1,
      routine_id: routineId,
      routine_revision: 1,
      slot: 1,
      status: 'completed',
      completed_at: at,
      recorded_at: at,
      updated_at: at,
      duration_seconds: 300,
      target_amount: '20',
      actual_amount: '5',
      unit: 'pages',
      difficulty_or_quality: 'A short reading session.',
      energy_note: '조금 피곤했음\n그래도 읽었음',
    },
  ],
  receipts: [
    {
      command_id: '40000000-0000-4000-8000-000000000002',
      request_sha256: '1'.repeat(64),
      applied_revision: 1,
    },
  ],
};
for (const [relative, doc] of [
  ['Tracker.md', tracker],
  [`Routines/${routineId}/000001.md`, routine],
  [`Habits/${habitId}/000001.md`, reading],
  [`Habits/${quotaId}/000001.md`, exercise],
  [`Commits/${commandId}.md`, commit],
  [`Daily/2026/09/${day}.md`, daily],
] as [string, Document][]) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serialize(doc));
}
console.log('Wrote fixed synthetic test fixtures.');
