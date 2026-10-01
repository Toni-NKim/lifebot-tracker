import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { AppError } from '../../../shared/contracts/index.js';
import type { ModuleRecord } from '../../../shared/contracts/module.js';
import type { ModulePaths } from '../../modules.js';
import { canonical } from '../../storage/markdown/vault.js';
import type { ModuleSnapshot, ModuleVault } from '../../storage/markdown/module-vault.js';

// A module-local source index. Domain projections can add versioned tables here,
// but no table in this file may depend on another module's database being present.
export class ModuleIndex {
  readonly file: string;
  constructor(public paths: ModulePaths) {
    this.file = paths.database;
  }
  metadata(): Record<string, string> {
    if (!fs.existsSync(this.file)) return {};
    let db: Database.Database | undefined;
    try {
      db = new Database(this.file, { readonly: true });
      return Object.fromEntries(
        (
          db.prepare('SELECT key, value FROM index_metadata').all() as {
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
  matches(snapshot: ModuleSnapshot) {
    const meta = this.metadata();
    return (
      meta.module === snapshot.settings.module &&
      meta.module_id === snapshot.settings.id &&
      meta.fingerprint === snapshot.fingerprint &&
      meta.projector_version === '1'
    );
  }
  read(): ModuleRecord[] {
    // Short-lived connections are required because rebuild atomically replaces the file.
    const db = new Database(this.file, { readonly: true });
    try {
      return (
        db.prepare('SELECT data_json FROM record_revisions ORDER BY rowid').all() as {
          data_json: string;
        }[]
      ).map((r) => JSON.parse(r.data_json) as ModuleRecord);
    } finally {
      db.close();
    }
  }
  rebuild(vault: ModuleVault, snapshot: ModuleSnapshot) {
    if (this.paths.name !== snapshot.settings.module || this.paths.root !== vault.root)
      throw new AppError('CONFIGURATION_ERROR', 'Index belongs to a different module');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    const db = new Database(temp);
    try {
      db.exec(`
        PRAGMA foreign_keys=ON;
        CREATE TABLE source_files(path TEXT PRIMARY KEY, sha256 TEXT NOT NULL);
        CREATE TABLE commits(id TEXT PRIMARY KEY, request_sha256 TEXT NOT NULL, data_json TEXT NOT NULL);
        CREATE TABLE record_revisions(kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
          command_id TEXT NOT NULL REFERENCES commits(id), source_path TEXT NOT NULL REFERENCES source_files(path),
          data_json TEXT NOT NULL, PRIMARY KEY(kind,id,revision));
        CREATE INDEX records_by_id ON record_revisions(id,revision);
        CREATE VIEW current_records AS SELECT r.* FROM record_revisions r WHERE revision=(
          SELECT MAX(revision) FROM record_revisions s WHERE s.kind=r.kind AND s.id=r.id);
        CREATE TABLE index_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `);
      db.transaction(() => {
        const source = db.prepare('INSERT INTO source_files VALUES (?,?)');
        const commit = db.prepare('INSERT INTO commits VALUES (?,?,?)');
        const record = db.prepare('INSERT INTO record_revisions VALUES (?,?,?,?,?,?)');
        const meta = db.prepare('INSERT INTO index_metadata VALUES (?,?)');
        for (const f of snapshot.sources) source.run(f.path, f.sha256);
        for (const c of snapshot.commits) commit.run(c.id, c.request_sha256, canonical(c));
        for (const r of snapshot.records)
          record.run(r.kind, r.id, r.revision, r.command_id, vault.recordPath(r), canonical(r));
        for (const [key, value] of Object.entries({
          module: snapshot.settings.module,
          module_id: snapshot.settings.id,
          schema_version: '1',
          projector_version: '1',
          fingerprint: snapshot.fingerprint,
        }))
          meta.run(key, value);
      })();
      if (
        db.pragma('integrity_check', { simple: true }) !== 'ok' ||
        (db.pragma('foreign_key_check') as unknown[]).length
      )
        throw new AppError('INDEX_UNAVAILABLE', 'Module index integrity check failed', 503);
      if (vault.fingerprint() !== snapshot.fingerprint)
        throw new AppError('REVISION_CONFLICT', 'Source changed during rebuild', 409);
      db.close();
      fs.renameSync(temp, this.file);
      return [...snapshot.records];
    } finally {
      if (db.open) db.close();
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }
}
