import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Snapshot } from '../../../shared/contracts/index.js';
import { AppError } from '../../../shared/contracts/index.js';
import { routineIds } from '../../../shared/domain/membership.js';
import { project, type Projection } from '../../../shared/domain/index.js';
import { Vault, canonical } from '../../storage/markdown/vault.js';

export const schema = `
PRAGMA foreign_keys=ON;
CREATE TABLE source_files(relative_path TEXT PRIMARY KEY, kind TEXT NOT NULL, sha256 TEXT NOT NULL);
CREATE TABLE tracker_settings(tracker_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, timezone TEXT NOT NULL, week_starts_on TEXT NOT NULL, tracking_started_on TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE definition_commits(command_id TEXT PRIMARY KEY, recorded_at TEXT NOT NULL, request_sha256 TEXT NOT NULL, source_path TEXT NOT NULL REFERENCES source_files(relative_path));
CREATE TABLE habits(habit_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE routines(routine_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE routine_versions(routine_id TEXT NOT NULL REFERENCES routines, revision INTEGER NOT NULL, command_id TEXT NOT NULL REFERENCES definition_commits, effective_from TEXT NOT NULL, recorded_at TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, color TEXT, deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), schedule_json TEXT NOT NULL, scheduled_time TEXT, source_path TEXT NOT NULL REFERENCES source_files, data_json TEXT NOT NULL, PRIMARY KEY(routine_id,revision));
CREATE TABLE habit_versions(habit_id TEXT NOT NULL REFERENCES habits, revision INTEGER NOT NULL, command_id TEXT NOT NULL REFERENCES definition_commits, effective_from TEXT NOT NULL, recorded_at TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, color TEXT, active INTEGER NOT NULL CHECK(active IN (0,1)), deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), parent_routine_id TEXT REFERENCES routines, schedule_mode TEXT NOT NULL, schedule_source_revision INTEGER, schedule_json TEXT NOT NULL, time_mode TEXT NOT NULL, time_source_revision INTEGER, scheduled_time TEXT, minimum_duration_seconds INTEGER CHECK(minimum_duration_seconds >= 0), target_amount TEXT, unit TEXT, source_path TEXT NOT NULL REFERENCES source_files, data_json TEXT NOT NULL, PRIMARY KEY(habit_id,revision), FOREIGN KEY(parent_routine_id,schedule_source_revision) REFERENCES routine_versions(routine_id,revision), FOREIGN KEY(parent_routine_id,time_source_revision) REFERENCES routine_versions(routine_id,revision));
CREATE TABLE routine_order(routine_id TEXT NOT NULL, routine_revision INTEGER NOT NULL, habit_id TEXT NOT NULL REFERENCES habits, position INTEGER NOT NULL, PRIMARY KEY(routine_id,routine_revision,habit_id), UNIQUE(routine_id,routine_revision,position), FOREIGN KEY(routine_id,routine_revision) REFERENCES routine_versions(routine_id,revision));
CREATE TABLE habit_routines(habit_id TEXT NOT NULL, habit_revision INTEGER NOT NULL, routine_id TEXT NOT NULL REFERENCES routines, PRIMARY KEY(habit_id,habit_revision,routine_id), FOREIGN KEY(habit_id,habit_revision) REFERENCES habit_versions(habit_id,revision));
CREATE INDEX habit_routines_by_routine ON habit_routines(routine_id,habit_id,habit_revision);
CREATE TABLE daily_documents(date TEXT PRIMARY KEY, revision INTEGER NOT NULL, timezone TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, source_path TEXT NOT NULL REFERENCES source_files);
CREATE TABLE executions(execution_id TEXT PRIMARY KEY, date TEXT NOT NULL REFERENCES daily_documents, habit_id TEXT NOT NULL, habit_revision INTEGER NOT NULL, routine_id TEXT, routine_revision INTEGER, slot INTEGER NOT NULL CHECK(slot=1), status TEXT NOT NULL CHECK(status IN ('completed','incomplete')), completed_at TEXT, recorded_at TEXT NOT NULL, updated_at TEXT NOT NULL, duration_seconds INTEGER CHECK(duration_seconds>=0), target_amount TEXT, actual_amount TEXT, unit TEXT, difficulty_or_quality TEXT, energy_note TEXT, actual_start TEXT, actual_end TEXT, plan_ref_json TEXT NOT NULL, data_json TEXT NOT NULL, UNIQUE(habit_id,date,slot), FOREIGN KEY(habit_id,habit_revision) REFERENCES habit_versions(habit_id,revision), FOREIGN KEY(routine_id,routine_revision) REFERENCES routine_versions(routine_id,revision), CHECK((status='completed' AND completed_at IS NOT NULL) OR (status='incomplete' AND completed_at IS NULL)));
CREATE TABLE command_receipts(command_id TEXT PRIMARY KEY, date TEXT NOT NULL REFERENCES daily_documents, request_sha256 TEXT NOT NULL, applied_revision INTEGER NOT NULL);
CREATE TABLE scheduled_occurrences(occurrence_id TEXT PRIMARY KEY, habit_id TEXT NOT NULL, habit_revision INTEGER NOT NULL, date TEXT NOT NULL, routine_id TEXT, routine_revision INTEGER, scheduled_time TEXT, status TEXT NOT NULL CHECK(status IN ('completed','incomplete')), execution_id TEXT REFERENCES executions, is_final INTEGER NOT NULL CHECK(is_final IN (0,1)), streak_series_id TEXT NOT NULL, data_json TEXT NOT NULL, UNIQUE(habit_id,date), FOREIGN KEY(habit_id,habit_revision) REFERENCES habit_versions(habit_id,revision), FOREIGN KEY(routine_id,routine_revision) REFERENCES routine_versions(routine_id,revision));
CREATE TABLE quota_periods(period_id TEXT PRIMARY KEY, habit_id TEXT NOT NULL REFERENCES habits, unit TEXT NOT NULL CHECK(unit IN ('weeks','months')), period_start TEXT NOT NULL, period_end TEXT NOT NULL, eligible_start TEXT NOT NULL, eligible_end TEXT NOT NULL, target_count INTEGER NOT NULL CHECK(target_count>0), actual_count INTEGER NOT NULL CHECK(actual_count>=0), credited_count INTEGER NOT NULL CHECK(credited_count>=0 AND credited_count<=target_count), status TEXT NOT NULL CHECK(status IN ('completed','incomplete')), is_final INTEGER NOT NULL CHECK(is_final IN (0,1)), streak_series_id TEXT NOT NULL, data_json TEXT NOT NULL);
CREATE TABLE quota_eligible_days(period_id TEXT NOT NULL REFERENCES quota_periods, date TEXT NOT NULL, habit_id TEXT NOT NULL, habit_revision INTEGER NOT NULL, routine_id TEXT, routine_revision INTEGER, scheduled_time TEXT, execution_id TEXT REFERENCES executions, data_json TEXT NOT NULL, PRIMARY KEY(period_id,date), FOREIGN KEY(habit_id,habit_revision) REFERENCES habit_versions(habit_id,revision), FOREIGN KEY(routine_id,routine_revision) REFERENCES routine_versions(routine_id,revision));
CREATE TABLE index_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX habit_effective ON habit_versions(habit_id,effective_from);
CREATE INDEX routine_effective ON routine_versions(routine_id,effective_from);
CREATE INDEX occurrences_date ON scheduled_occurrences(date);
CREATE INDEX occurrences_routine ON scheduled_occurrences(routine_id,date);
CREATE INDEX executions_habit_date ON executions(habit_id,date);
CREATE INDEX executions_completed ON executions(completed_at);
CREATE INDEX quota_habit_end ON quota_periods(habit_id,unit,period_end);
`;
export class Index {
  constructor(public file: string) {}
  metadata(): Record<string, string> {
    if (!fs.existsSync(this.file)) return {};
    let db: Database.Database | undefined;
    try {
      db = new Database(this.file, { readonly: true });
      return Object.fromEntries(
        (
          db.prepare('SELECT key,value FROM index_metadata').all() as {
            key: string;
            value: string;
          }[]
        ).map((r) => [r.key, r.value]),
      );
    } catch {
      return {};
    } finally {
      db?.close();
    }
  }
  read(): Projection {
    const db = new Database(this.file, { readonly: true });
    try {
      const meta = Object.fromEntries(
        (
          db.prepare('SELECT key,value FROM index_metadata').all() as {
            key: string;
            value: string;
          }[]
        ).map((r) => [r.key, r.value]),
      );
      const rows = <T>(table: string) =>
        (
          db.prepare(`SELECT data_json FROM ${table} ORDER BY rowid`).all() as {
            data_json: string;
          }[]
        ).map((r) => JSON.parse(r.data_json) as T);
      return {
        today: meta.today,
        cutoff: meta.cutoff,
        series: JSON.parse(meta.series),
        occurrences: rows('scheduled_occurrences'),
        periods: rows('quota_periods'),
        quotaDays: rows('quota_eligible_days'),
      };
    } finally {
      db.close();
    }
  }
  rebuild(vault: Vault, s: Snapshot, asOf: string) {
    const p = project(s, asOf);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    const db = new Database(tmp);
    try {
      db.exec(schema);
      // Preparing a statement per row dominated rebuild time; reuse one per table and columns.
      const statements = new Map<string, Database.Statement>();
      const insert = (table: string, row: Record<string, unknown>) => {
        const cols = Object.keys(row);
        const key = `${table}(${cols.join(',')})`;
        let statement = statements.get(key);
        if (!statement) {
          statement = db.prepare(
            `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((c) => `@${c}`).join(',')})`,
          );
          statements.set(key, statement);
        }
        statement.run(
          Object.fromEntries(
            Object.entries(row).map(([k, v]) => [k, typeof v === 'boolean' ? Number(v) : v]),
          ),
        );
      };
      db.transaction(() => {
        for (const f of s.sources)
          insert('source_files', { relative_path: f.path, kind: f.kind, sha256: f.sha256 });
        const { kind, id, ...tracker } = s.tracker;
        insert('tracker_settings', { tracker_id: id, ...tracker });
        for (const c of s.commits)
          insert('definition_commits', {
            command_id: c.id,
            recorded_at: c.recorded_at,
            request_sha256: c.request_sha256,
            source_path: `Commits/${c.id}.md`,
          });
        for (const id of new Set(s.habits.map((h) => h.id)))
          insert('habits', {
            habit_id: id,
            created_at: s.habits.find((h) => h.id === id)!.created_at,
          });
        for (const id of new Set(s.routines.map((r) => r.id)))
          insert('routines', {
            routine_id: id,
            created_at: s.routines.find((r) => r.id === id)!.created_at,
          });
        for (const r of s.routines)
          insert('routine_versions', {
            routine_id: r.id,
            revision: r.revision,
            command_id: r.command_id,
            effective_from: r.effective_from,
            recorded_at: r.recorded_at,
            name: r.name,
            description: r.description,
            color: r.color ?? null,
            deleted: r.deleted,
            schedule_json: canonical(r.schedule),
            scheduled_time: r.scheduled_time,
            source_path: vault.definitionPath(r),
            data_json: canonical(r),
          });
        for (const h of s.habits)
          insert('habit_versions', {
            habit_id: h.id,
            revision: h.revision,
            command_id: h.command_id,
            effective_from: h.effective_from,
            recorded_at: h.recorded_at,
            name: h.name,
            description: h.description,
            color: h.color ?? null,
            active: h.active,
            deleted: h.deleted,
            parent_routine_id: h.parent_routine_id,
            schedule_mode: h.schedule.mode,
            schedule_source_revision: h.schedule.source_routine_revision,
            schedule_json: canonical(h.schedule.rule),
            time_mode: h.scheduled_time.mode,
            time_source_revision: h.scheduled_time.source_routine_revision,
            scheduled_time: h.scheduled_time.value,
            minimum_duration_seconds: h.minimum_duration_seconds,
            target_amount: h.target_amount,
            unit: h.unit,
            source_path: vault.definitionPath(h),
            data_json: canonical(h),
          });
        for (const h of s.habits)
          for (const routine_id of routineIds(h))
            insert('habit_routines', { habit_id: h.id, habit_revision: h.revision, routine_id });
        for (const r of s.routines)
          r.habit_order.forEach((id, position) =>
            insert('routine_order', {
              routine_id: r.id,
              routine_revision: r.revision,
              habit_id: id,
              position,
            }),
          );
        for (const d of s.days) {
          insert('daily_documents', {
            date: d.date,
            revision: d.revision,
            timezone: d.timezone,
            created_at: d.created_at,
            updated_at: d.updated_at,
            source_path: vault.dailyPath(d.date),
          });
          for (const e of d.executions) {
            const { id, actual_start, actual_end, plan_ref, ...rest } = e;
            insert('executions', {
              execution_id: id,
              date: d.date,
              ...rest,
              actual_start: actual_start ?? null,
              actual_end: actual_end ?? null,
              plan_ref_json: canonical(plan_ref ?? null),
              data_json: canonical(e),
            });
          }
          for (const r of d.receipts) insert('command_receipts', { ...r, date: d.date });
        }
        for (const o of p.occurrences) {
          const { id, ...rest } = o;
          insert('scheduled_occurrences', { occurrence_id: id, ...rest, data_json: canonical(o) });
        }
        for (const q of p.periods) {
          const { id, start, end, ...rest } = q;
          insert('quota_periods', {
            period_id: id,
            period_start: start,
            period_end: end,
            ...rest,
            data_json: canonical(q),
          });
        }
        for (const d of p.quotaDays) {
          const { id, ...rest } = d;
          insert('quota_eligible_days', { ...rest, data_json: canonical(d) });
        }
        for (const [key, value] of Object.entries({
          schema_version: '3',
          projector_version: '3',
          fingerprint: s.fingerprint,
          cutoff: asOf,
          today: p.today,
          series: canonical(p.series),
        }))
          insert('index_metadata', { key, value });
      })();
      const integrity = db.pragma('integrity_check', { simple: true });
      if (integrity !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length)
        throw new AppError('INDEX_UNAVAILABLE', 'Index integrity validation failed', 503);
      if (vault.fingerprint() !== s.fingerprint)
        throw new AppError('REVISION_CONFLICT', 'Vault changed during rebuild', 409);
      db.close();
      fs.renameSync(tmp, this.file);
      return p;
    } finally {
      if (db.open) db.close();
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  }
}
