import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { AppError, UUID, validate } from '../../shared/contracts/index.js';
import {
  ModuleSchema,
  type ModuleSettings,
  type ModuleRecord,
  type RecordInput,
  type ModuleCommit,
} from '../../shared/contracts/module.js';
import {
  ModuleVault,
  moduleMarkdown,
  type ModuleSnapshot,
} from '../storage/markdown/module-vault.js';
import {
  atomicWrite,
  canonical,
  sha,
  fingerprintOf,
  type PlannedFile,
} from '../storage/markdown/vault.js';
import { AcceptedSource } from '../storage/accepted-source.js';
import { CommitIntent, type Intent } from '../storage/commit-intent.js';
import { ModuleIndex } from '../index/sqlite/module-index.js';
import { moduleEtag, assertModuleEtag } from '../modules.js';

export interface ModuleCommand {
  id: string;
  etag: string;
  request: unknown;
}
export const currentRecords = (records: readonly ModuleRecord[]) => {
  const latest = new Map<string, ModuleRecord>();
  for (const r of records) if ((latest.get(r.id)?.revision ?? 0) < r.revision) latest.set(r.id, r);
  return [...latest.values()];
};

// Public operations own the lock. Locked operations are for a coordinator that
// already acquired the same module root via withModuleLocks; never nest the two.
export class ModuleService {
  readonly accepted: AcceptedSource;
  readonly intent: CommitIntent;
  private pending: { fingerprint: string; over: string | null } | null = null;
  constructor(
    public vault: ModuleVault,
    public index: ModuleIndex,
    public clock = () => Temporal.Now.instant().toString(),
  ) {
    if (vault.root !== index.paths.root || vault.contract.name !== index.paths.name)
      throw new AppError('CONFIGURATION_ERROR', 'Module service paths do not match');
    this.accepted = new AcceptedSource(index.paths.acceptedSource);
    this.intent = new CommitIntent(index.paths.commitIntent);
  }
  private marker() {
    try {
      const value = fs.readFileSync(this.accepted.file, 'utf8').trim();
      if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('Invalid accepted-source marker');
      return value;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new AppError(
        'STATE_UNAVAILABLE',
        `Cannot read accepted source: ${(e as Error).message}`,
        503,
      );
    }
  }
  private readIntent(): Intent | null {
    if (!fs.existsSync(this.intent.file)) return null;
    const value = this.intent.read();
    if (!value || new Set(value.files.map((f) => f.path)).size !== value.files.length)
      throw new AppError(
        'STATE_UNAVAILABLE',
        'Invalid module commit intent; repair state explicitly',
        503,
      );
    return value;
  }
  private accept(fingerprint: string, explicit = false): string | null {
    let over: string | null;
    try {
      over = this.marker();
    } catch (e) {
      if (!explicit) throw e;
      over = null;
    }
    try {
      this.accepted.write(fingerprint);
    } catch (e) {
      this.pending = { fingerprint, over };
      return `Canonical data is saved; acceptance is pending: ${(e as Error).message}`;
    }
    this.pending = null;
    try {
      this.intent.clear();
    } catch {
      /* An obsolete intent cannot accept a later state. */
    }
    return null;
  }
  private settleAcceptance() {
    if (!this.pending) return;
    const durable = this.marker();
    if (durable !== this.pending.over && durable !== this.pending.fingerprint) {
      this.pending = null;
      throw new AppError('REVISION_CONFLICT', 'Another process accepted a newer state', 409);
    }
    const warning = this.accept(this.pending.fingerprint);
    if (warning) throw new AppError('STATE_UNAVAILABLE', warning, 503);
  }
  private intend(from: string, sources: readonly PlannedFile[], files: PlannedFile[]) {
    const next = new Map(sources.map((f) => [f.path, f.sha256]));
    for (const f of files) next.set(f.path, f.sha256);
    try {
      this.intent.write({
        from,
        to: fingerprintOf([...next].map(([path, sha256]) => ({ path, sha256 }))),
        files,
      });
    } catch (e) {
      throw new AppError(
        'STATE_UNAVAILABLE',
        `Nothing saved; cannot record intent: ${(e as Error).message}`,
        503,
      );
    }
  }
  loadLocked(): ModuleSnapshot {
    let snapshot = this.vault.load();
    let baseline = this.marker();
    if (this.pending && baseline !== this.pending.over && baseline !== this.pending.fingerprint)
      this.pending = null;
    if (baseline === null && this.pending) baseline = this.pending.fingerprint;
    // New modules have no legacy SQLite trust bootstrap. Explicit state loss trusts
    // valid Markdown; deleting SQLite alone never changes the durable baseline.
    if (baseline === null) {
      if (fs.existsSync(this.index.file) || fs.existsSync(this.intent.file))
        throw new AppError(
          'STATE_UNAVAILABLE',
          'Accepted-source is missing from existing module state; explicitly validate/rebuild to establish trust',
          503,
        );
      baseline = snapshot.fingerprint;
      this.accept(baseline);
    }
    if (snapshot.fingerprint === baseline) return snapshot;
    const intent = this.readIntent();
    if (intent?.from === baseline && intent.to === snapshot.fingerprint) {
      this.accept(snapshot.fingerprint);
      return snapshot;
    }
    const current = new Map(snapshot.sources.map((f) => [f.path, f.sha256]));
    const manifest = intent?.files.at(-1);
    if (
      intent?.from === baseline &&
      manifest &&
      /^Commits\/[0-9a-f-]{36}\.md$/.test(manifest.path) &&
      !current.has(manifest.path)
    ) {
      const revisions = intent.files.slice(0, -1);
      const present = revisions.filter((f) => current.has(f.path));
      if (
        revisions.every((f) => this.vault.isRecordPath(f.path)) &&
        present.length &&
        present.every((f) => current.get(f.path) === f.sha256) &&
        fingerprintOf(snapshot.sources.filter((f) => !present.some((p) => p.path === f.path))) ===
          baseline
      ) {
        this.vault.removeUncommitted(present.map((f) => f.path));
        snapshot = this.vault.load();
        if (snapshot.fingerprint === baseline) return snapshot;
      }
    }
    throw new AppError(
      'EXTERNAL_CHANGE',
      `${this.vault.contract.name} Markdown changed outside the app. Validate and explicitly rebuild this module.`,
      409,
    );
  }
  private project(snapshot: ModuleSnapshot) {
    try {
      const records = this.index.matches(snapshot)
        ? this.index.read()
        : this.index.rebuild(this.vault, snapshot);
      return { records, warning: null as string | null };
    } catch (e) {
      return { records: [...snapshot.records], warning: (e as Error).message };
    }
  }
  private envelope(snapshot: ModuleSnapshot, extra: object = {}) {
    const p = this.project(snapshot);
    return {
      data: {
        settings: snapshot.settings,
        records: p.records,
        current: currentRecords(p.records),
        warnings: snapshot.warnings,
        ...extra,
      },
      etag: moduleEtag(snapshot.settings.module, snapshot.settings.id, snapshot.fingerprint),
      index_warning: this.pending ? 'Canonical data is saved; acceptance is pending' : p.warning,
    };
  }
  readLocked() {
    return this.envelope(this.loadLocked());
  }
  read() {
    return this.vault.locked(() => this.readLocked());
  }
  async status() {
    try {
      const view = await this.read();
      return {
        initialized: true,
        etag: view.etag,
        index_warning: view.index_warning,
        warnings: view.data.warnings,
      };
    } catch (e) {
      return {
        initialized: fs.existsSync(this.vault.safe('Module.md')),
        error: (e as Error).message,
        code: e instanceof AppError ? e.code : 'VAULT_UNAVAILABLE',
      };
    }
  }
  // Explicit initialization only. Record an empty trusted baseline and intent
  // before the single atomic Module.md write; startup can recover acceptance loss.
  async initializeModule(habit: { id: string; timezone: string; week_starts_on: 'monday' }) {
    const now = this.clock();
    const settings = validate<ModuleSettings>(ModuleSchema, {
      schema_version: 1,
      kind: 'module',
      module: this.vault.contract.name,
      id: randomUUID(),
      habit_tracker_id: habit.id,
      timezone: habit.timezone,
      week_starts_on: habit.week_starts_on,
      created_at: now,
      activated_on: Temporal.Instant.from(now)
        .toZonedDateTimeISO(habit.timezone)
        .toPlainDate()
        .toString(),
    });
    fs.mkdirSync(this.vault.root, { recursive: true });
    return this.vault.locked(() => {
      if (fs.readdirSync(this.vault.root).length)
        throw new AppError('INVALID_VAULT', 'Initialize only an empty module directory');
      const from = fingerprintOf([]);
      try {
        this.accepted.write(from);
      } catch (e) {
        throw new AppError('STATE_UNAVAILABLE', `Nothing saved: ${(e as Error).message}`, 503);
      }
      const text = moduleMarkdown(settings);
      this.intend(from, [], [{ path: 'Module.md', sha256: sha(text) }]);
      atomicWrite(this.vault.safe('Module.md'), text);
      this.accept(this.vault.fingerprint());
      return this.envelope(this.loadLocked());
    });
  }
  mutate(
    command: ModuleCommand,
    build: (snapshot: ModuleSnapshot, now: string) => RecordInput[],
    guard?: () => void,
  ) {
    return this.vault.locked(() => this.mutateLocked(command, build, guard));
  }
  mutateLocked(
    command: ModuleCommand,
    build: (snapshot: ModuleSnapshot, now: string) => RecordInput[],
    guard?: () => void,
  ) {
    validate(UUID, command.id);
    const snapshot = this.loadLocked();
    const requestHash = sha(
      canonical({ module: snapshot.settings.module, request: command.request }),
    );
    const prior = snapshot.commits.find((c) => c.id === command.id);
    if (prior) {
      if (prior.request_sha256 !== requestHash)
        throw new AppError('IDEMPOTENCY_CONFLICT', 'Command ID was used for different input', 409);
      return this.envelope(snapshot, {
        saved: true,
        replayed: true,
        changes: snapshot.records.filter((r) => r.command_id === command.id),
      });
    }
    this.settleAcceptance();
    // Validate an existing intent even if the source is unchanged, before replacing it.
    this.readIntent();
    assertModuleEtag(
      command.etag,
      moduleEtag(snapshot.settings.module, snapshot.settings.id, snapshot.fingerprint),
    );
    const now = this.clock();
    const inputs = build(snapshot, now);
    if (!inputs.length || new Set(inputs.map((r) => r.id)).size !== inputs.length)
      throw new AppError('VALIDATION_ERROR', 'A command must contain distinct record identities');
    const records: ModuleRecord[] = inputs.map((input) => {
      const type = this.vault.contract.records[input.kind];
      if (!type) throw new AppError('VALIDATION_ERROR', 'Unsupported record kind');
      return {
        schema_version: type.version,
        kind: input.kind,
        module_id: snapshot.settings.id,
        id: input.id,
        revision: this.vault.nextRevision(input.kind, input.id),
        command_id: command.id,
        created_at: snapshot.records.find((r) => r.id === input.id)?.created_at ?? now,
        recorded_at: now,
        data: structuredClone(input.data),
      };
    });
    try {
      this.vault.validateRecords([...snapshot.records, ...records], snapshot.settings);
    } catch (e) {
      throw new AppError('VALIDATION_ERROR', (e as Error).message);
    }
    const manifest: ModuleCommit = {
      schema_version: 1,
      kind: 'module_commit',
      module_id: snapshot.settings.id,
      id: command.id,
      recorded_at: now,
      request_sha256: requestHash,
      files: records.map((r) => this.vault.recordPath(r)),
    };
    this.vault.commit(
      snapshot,
      records,
      manifest,
      (files) => this.intend(snapshot.fingerprint, snapshot.sources, files),
      guard,
    );
    const saved = this.vault.load();
    if (saved.fingerprint !== this.readIntent()?.to)
      throw new AppError(
        'EXTERNAL_CHANGE',
        'Canonical commit finished but unrelated source changes were detected; validate/rebuild before continuing',
        409,
      );
    this.accept(saved.fingerprint);
    return this.envelope(saved, { saved: true, replayed: false, changes: records });
  }
  validateVault() {
    return this.vault.locked(() => {
      const s = this.vault.load();
      return { valid: true, fingerprint: s.fingerprint, warnings: s.warnings };
    });
  }
  rebuild() {
    return this.vault.locked(() => {
      const snapshot = this.vault.load();
      this.index.rebuild(this.vault, snapshot);
      this.accept(snapshot.fingerprint, true);
      return this.envelope(snapshot, { rebuilt: true });
    });
  }
}
