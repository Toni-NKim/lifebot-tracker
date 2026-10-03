import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { Temporal } from '@js-temporal/polyfill';
import { AppError, validate } from '../../../shared/contracts/index.js';
import {
  ModuleSchema,
  ModuleCommitSchema,
  parseModuleRecord,
  type ModuleContract,
  type ModuleSettings,
  type ModuleCommit,
  type ModuleRecord,
} from '../../../shared/contracts/module.js';
import { atomicWrite, fingerprintOf, sha, type PlannedFile } from './vault.js';
import { withVaultLock } from '../lock.js';

export interface ModuleSnapshot {
  settings: ModuleSettings;
  records: readonly ModuleRecord[];
  commits: readonly ModuleCommit[];
  sources: readonly PlannedFile[];
  fingerprint: string;
  warnings: readonly string[];
}
export function moduleMarkdown(doc: unknown) {
  return `---\n${YAML.stringify(doc, { defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN', lineWidth: 0 })}---\n`;
}
function frontmatter(text: string, file: string): unknown {
  try {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!match) throw new Error('Missing YAML frontmatter');
    const doc = YAML.parseDocument(match[1], { uniqueKeys: true, version: '1.2' });
    if (doc.errors.length) throw doc.errors[0];
    return doc.toJS({ maxAliasCount: 0 });
  } catch (e) {
    throw new AppError('INVALID_VAULT', `${file}: ${(e as Error).message}`);
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const v of Object.values(value))
      if (v && typeof v === 'object' && !Object.isFrozen(v)) freeze(v);
  }
  return value;
}
export class ModuleVault {
  private cache = new Map<string, { hash: string; value: unknown }>();
  private snapshot?: ModuleSnapshot;
  constructor(
    public root: string,
    public contract: ModuleContract,
  ) {
    this.root = path.resolve(root);
    const dirs = Object.values(contract.records).map((r) => r.directory);
    if (
      new Set(dirs).size !== dirs.length ||
      dirs.some((d) => !/^[A-Z][A-Za-z]+$/.test(d) || d === 'Commits')
    )
      throw new AppError(
        'CONFIGURATION_ERROR',
        'Record directories must be unique and cannot use Commits',
      );
  }
  locked<T>(fn: () => T | Promise<T>) {
    return withVaultLock(this.root, fn);
  }
  safe(relative: string) {
    const file = path.resolve(this.root, relative);
    if (!file.startsWith(this.root + path.sep))
      throw new AppError('INVALID_VAULT', 'Path escapes module root');
    let part = file;
    while (part !== path.dirname(this.root)) {
      if (fs.existsSync(part) && fs.lstatSync(part).isSymbolicLink())
        throw new AppError('INVALID_VAULT', 'Module storage does not support symlinks');
      part = path.dirname(part);
    }
    return file;
  }
  inventory() {
    const files: (PlannedFile & { text: string })[] = [];
    if (!fs.existsSync(this.root))
      throw new AppError('VAULT_UNAVAILABLE', 'Module is not initialized', 503);
    const walk = (dir: string) => {
      const full = dir ? this.safe(dir) : this.root;
      if (fs.lstatSync(full).isSymbolicLink())
        throw new AppError('INVALID_VAULT', 'Module storage does not support symlinks');
      for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
        const rel = path.posix.join(dir, entry.name);
        const file = this.safe(rel);
        if (entry.isDirectory()) walk(rel);
        else if (entry.isFile() && entry.name.endsWith('.md')) {
          if (fs.statSync(file).size > 16 * 1024 * 1024)
            throw new AppError('INVALID_VAULT', `${rel}: document exceeds 16 MB`);
          const text = fs.readFileSync(file, 'utf8');
          files.push({ path: rel, sha256: sha(text), text });
        }
      }
    };
    walk('');
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }
  fingerprint() {
    return fingerprintOf(this.inventory());
  }
  private document(file: PlannedFile & { text: string }) {
    const cached = this.cache.get(file.path);
    if (cached?.hash === file.sha256) return cached.value;
    const value = freeze(frontmatter(file.text, file.path));
    this.cache.set(file.path, { hash: file.sha256, value });
    return value;
  }
  recordPath(record: Pick<ModuleRecord, 'kind' | 'id' | 'revision'>) {
    const type = this.contract.records[record.kind];
    if (!type) throw new AppError('INVALID_VAULT', 'Unsupported record kind');
    return `${type.directory}/${record.id}/${String(record.revision).padStart(6, '0')}.md`;
  }
  isRecordPath(relative: string) {
    return (
      Object.values(this.contract.records).some((r) => relative.startsWith(r.directory + '/')) &&
      /^[A-Z][A-Za-z]+\/[0-9a-f-]{36}\/[0-9]{6,}\.md$/.test(relative)
    );
  }
  load(): ModuleSnapshot {
    const inventory = this.inventory();
    const fingerprint = fingerprintOf(inventory);
    if (this.snapshot?.fingerprint === fingerprint) return this.snapshot;
    const files = new Map(inventory.map((f) => [f.path, f]));
    for (const key of this.cache.keys()) if (!files.has(key)) this.cache.delete(key);
    const settingsFile = files.get('Module.md');
    if (!settingsFile)
      throw new AppError('VAULT_UNAVAILABLE', 'Module.md is missing; initialize explicitly', 503);
    try {
      const settings = validate<ModuleSettings>(ModuleSchema, this.document(settingsFile));
      Temporal.PlainDate.from(settings.activated_on);
      Temporal.Instant.from(settings.created_at).toZonedDateTimeISO(settings.timezone);
      if (settings.module !== this.contract.name)
        throw new Error('Module identity does not match root');
      const used = new Set(['Module.md']);
      const records: ModuleRecord[] = [];
      const commits: ModuleCommit[] = [];
      for (const file of inventory.filter((f) => f.path.startsWith('Commits/'))) {
        const commit = validate<ModuleCommit>(ModuleCommitSchema, this.document(file));
        if (file.path !== `Commits/${commit.id}.md` || commit.module_id !== settings.id)
          throw new Error('Invalid commit identity');
        Temporal.Instant.from(commit.recorded_at);
        commits.push(commit);
        used.add(file.path);
        for (const rel of commit.files) {
          const source = files.get(rel);
          if (!source || used.has(rel))
            throw new Error(`Missing or multiply committed revision: ${rel}`);
          const record = parseModuleRecord(this.document(source), this.contract);
          if (
            record.module_id !== settings.id ||
            record.command_id !== commit.id ||
            this.recordPath(record) !== rel
          )
            throw new Error(`Invalid revision identity: ${rel}`);
          records.push(record);
          used.add(rel);
        }
      }
      this.validateRecords(records, settings);
      const warnings: string[] = [];
      for (const file of inventory)
        if (!used.has(file.path)) {
          if (!this.isRecordPath(file.path))
            throw new Error(`Unknown canonical path: ${file.path}`);
          warnings.push(`Uncommitted revision ignored: ${file.path}`);
        }
      this.snapshot = freeze({
        settings,
        records,
        commits,
        sources: inventory.map(({ path, sha256 }) => ({ path, sha256 })),
        fingerprint,
        warnings,
      });
      return this.snapshot;
    } catch (e) {
      throw new AppError('INVALID_VAULT', (e as Error).message);
    }
  }
  validateRecords(records: readonly ModuleRecord[], settings: ModuleSettings) {
    const identities = new Map<string, { kind: string; created: string; revisions: Set<number> }>();
    for (const record of records) {
      parseModuleRecord(record, this.contract);
      if (Temporal.Instant.compare(record.created_at, record.recorded_at) > 0)
        throw new AppError('INVALID_VAULT', 'Revision predates creation');
      if (record.module_id !== settings.id)
        throw new AppError('INVALID_VAULT', 'Record belongs to another module');
      const prior = identities.get(record.id);
      if (
        prior &&
        (prior.kind !== record.kind ||
          prior.created !== record.created_at ||
          prior.revisions.has(record.revision))
      )
        throw new AppError('INVALID_VAULT', 'Duplicate revision or changed record identity');
      if (prior) prior.revisions.add(record.revision);
      else
        identities.set(record.id, {
          kind: record.kind,
          created: record.created_at,
          revisions: new Set([record.revision]),
        });
    }
    this.contract.validate?.(records, settings);
  }
  nextRevision(kind: string, id: string) {
    const directory = path.posix.dirname(this.recordPath({ kind, id, revision: 1 }));
    const dir = this.safe(directory);
    return !fs.existsSync(dir)
      ? 1
      : Math.max(
          0,
          ...fs
            .readdirSync(dir)
            .filter((f) => /^\d+\.md$/.test(f))
            .map((f) => Number(f.slice(0, -3))),
        ) + 1;
  }
  assertUnchanged(snapshot: ModuleSnapshot, ownPaths: string[] = []) {
    if (
      fingerprintOf(this.inventory().filter((f) => !ownPaths.includes(f.path))) !==
      snapshot.fingerprint
    )
      throw new AppError(
        'REVISION_CONFLICT',
        'Module source changed while preparing this write',
        409,
      );
  }
  commit(
    snapshot: ModuleSnapshot,
    records: ModuleRecord[],
    manifest: ModuleCommit,
    intend: (files: PlannedFile[]) => void,
    guard: () => void = () => {},
  ) {
    const revisions = records.map((r) => ({ path: this.recordPath(r), text: moduleMarkdown(r) }));
    const marker = { path: `Commits/${manifest.id}.md`, text: moduleMarkdown(manifest) };
    for (const f of [...revisions, marker])
      if (fs.existsSync(this.safe(f.path)))
        throw new AppError('REVISION_CONFLICT', 'Revision or command path already exists', 409);
    intend([...revisions, marker].map((f) => ({ path: f.path, sha256: sha(f.text) })));
    const written: string[] = [];
    try {
      for (const f of revisions) {
        atomicWrite(this.safe(f.path), f.text);
        written.push(f.path);
      }
      atomicWrite(this.safe(marker.path), marker.text, () => {
        this.assertUnchanged(snapshot, written);
        // Do not publish an own revision modified by an external writer before the marker.
        const current = new Map(this.inventory().map((f) => [f.path, f.sha256]));
        if (revisions.some((f) => current.get(f.path) !== sha(f.text)))
          throw new AppError('REVISION_CONFLICT', 'Prepared revision changed before commit', 409);
        guard();
      });
    } catch (e) {
      if (!fs.existsSync(this.safe(marker.path))) {
        try {
          // Only clean up when the entire source still matches the planned addition.
          this.assertUnchanged(snapshot, written);
          const current = new Map(this.inventory().map((f) => [f.path, f.sha256]));
          if (
            written.every((p) => current.get(p) === sha(revisions.find((f) => f.path === p)!.text))
          )
            this.removeUncommitted(written);
        } catch {
          /* Keep the intent for restartable cleanup. */
        }
      }
      throw e;
    }
  }
  removeUncommitted(paths: string[]) {
    const snapshot = this.load();
    const committed = new Set(snapshot.commits.flatMap((c) => c.files));
    for (const rel of paths)
      if (!this.isRecordPath(rel) || committed.has(rel))
        throw new AppError('INVALID_VAULT', `Refusing to remove ${rel}`);
    for (const rel of paths) {
      const file = this.safe(rel);
      fs.rmSync(file, { force: true });
      const fd = fs.openSync(path.dirname(file), 'r');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
  }
}
