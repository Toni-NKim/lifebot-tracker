import { routineIds } from '../../../shared/domain/membership.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import YAML from 'yaml';
import lockfile from 'proper-lockfile';
import {
  AppError,
  parseDocument,
  type Document,
  type Snapshot,
  type Tracker,
  type Habit,
  type Routine,
  type Daily,
  type Commit,
} from '../../../shared/contracts/index.js';
import {
  effective,
  executionId,
  isDue,
  todayAt,
  unitOf,
  bounds,
} from '../../../shared/domain/index.js';

export const sha = (text: string) => createHash('sha256').update(text).digest('hex');
// A file the app is about to write, identified by its tracker-relative path and content hash.
export interface PlannedFile {
  path: string;
  sha256: string;
}
// The source fingerprint of a set of files, independent of their order.
export const fingerprintOf = (files: { path: string; sha256: string }[]) =>
  sha(
    canonical(
      [...files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => [f.path, f.sha256]),
    ),
  );
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function serialize(doc: Document) {
  parseDocument(doc);
  const title = 'name' in doc ? doc.name : doc.kind === 'daily_execution' ? doc.date : doc.kind;
  return `---\n${YAML.stringify(doc, { defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN', lineWidth: 0 })}---\n# ${title.replace(/[\r\n]/g, ' ')}\n`;
}
export function parse(text: string, file = 'document'): Document {
  try {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!match) throw new Error('Missing YAML frontmatter');
    const d = YAML.parseDocument(match[1], { uniqueKeys: true, version: '1.2' });
    if (d.errors.length) throw d.errors[0];
    return parseDocument(d.toJS({ maxAliasCount: 0 }));
  } catch (e) {
    throw new AppError('INVALID_VAULT', `${file}: ${(e as Error).message}`);
  }
}
function syncDirectory(dir: string) {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export function atomicWrite(file: string, contents: string, beforeRename?: () => void) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    beforeRename?.();
    fs.renameSync(tmp, file);
    syncDirectory(path.dirname(file));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
export class Vault {
  constructor(public root: string) {
    this.root = path.resolve(root);
  }
  private safe(relative: string) {
    const resolved = path.resolve(this.root, relative);
    if (!resolved.startsWith(this.root + path.sep))
      throw new AppError('INVALID_VAULT', 'Path escapes tracker directory');
    let part = resolved;
    while (part !== path.dirname(this.root)) {
      if (fs.existsSync(part) && fs.lstatSync(part).isSymbolicLink())
        throw new AppError('INVALID_VAULT', 'Symlinks are not supported in tracker storage');
      part = path.dirname(part);
    }
    return resolved;
  }
  async locked<T>(fn: () => T | Promise<T>): Promise<T> {
    if (!fs.existsSync(this.root))
      throw new AppError(
        'VAULT_UNAVAILABLE',
        'Tracker directory does not exist; initialize an explicit Vault first',
        503,
      );
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(this.root, {
        realpath: true,
        stale: 300000,
        update: 10000,
        retries: { retries: 20, minTimeout: 25, maxTimeout: 250 },
      });
    } catch {
      throw new AppError('VAULT_BUSY', 'Another writer owns this Vault', 409);
    }
    try {
      return await fn();
    } finally {
      await release();
    }
  }
  inventory() {
    const files: { path: string; text: string; hash: string }[] = [];
    const walk = (rel: string) => {
      const dir = this.safe(rel);
      if (!fs.existsSync(dir)) return;
      for (const entry of fs
        .readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const name = path.posix.join(rel, entry.name);
        const full = this.safe(name);
        if (entry.isDirectory()) walk(name);
        else if (entry.isFile() && entry.name.endsWith('.md')) {
          if (fs.statSync(full).size > 16 * 1024 * 1024)
            throw new AppError('INVALID_VAULT', `${name}: document exceeds 16 MB`);
          const text = fs.readFileSync(full, 'utf8');
          files.push({ path: name, text, hash: sha(text) });
        }
      }
    };
    const tracker = this.safe('Tracker.md');
    if (!fs.existsSync(tracker))
      throw new AppError(
        'VAULT_UNAVAILABLE',
        'Tracker.md is missing; use vault:init explicitly',
        503,
      );
    const text = fs.readFileSync(tracker, 'utf8');
    files.push({ path: 'Tracker.md', text, hash: sha(text) });
    for (const dir of ['Habits', 'Routines', 'Daily', 'Commits']) walk(dir);
    files.sort((a, b) => a.path.localeCompare(b.path));
    return files;
  }
  fingerprint() {
    return fingerprintOf(this.inventory().map((f) => ({ path: f.path, sha256: f.hash })));
  }
  assertUnchanged(snapshot: Snapshot, ownNewPaths: string[] = []) {
    const allowed = new Set(ownNewPaths);
    const current = this.inventory()
      .filter((file) => !allowed.has(file.path))
      .map((file) => [file.path, file.hash]);
    const expected = snapshot.sources.map((file) => [file.path, file.sha256]);
    if (canonical(current) !== canonical(expected)) {
      throw new AppError(
        'REVISION_CONFLICT',
        'Canonical files changed while preparing this write',
        409,
      );
    }
  }
  load(): Snapshot {
    const files = this.inventory();
    const map = new Map(files.map((f) => [f.path, f]));
    const tracker = parse(map.get('Tracker.md')!.text, 'Tracker.md');
    if (tracker.kind !== 'tracker')
      throw new AppError('INVALID_VAULT', 'Tracker.md must contain tracker settings');
    const s: Snapshot = {
      tracker,
      habits: [],
      routines: [],
      days: [],
      commits: [],
      sources: [],
      fingerprint: fingerprintOf(files.map((f) => ({ path: f.path, sha256: f.hash }))),
      warnings: [],
    };
    const used = new Set(['Tracker.md']);
    const commands = new Set<string>();
    for (const file of files.filter((f) => f.path.startsWith('Commits/'))) {
      const commit = parse(file.text, file.path);
      if (
        commit.kind !== 'definition_commit' ||
        file.path !== `Commits/${commit.id}.md` ||
        commands.has(commit.id)
      )
        throw new AppError('INVALID_VAULT', `${file.path}: invalid/duplicate commit`);
      commands.add(commit.id);
      s.commits.push(commit);
      used.add(file.path);
      for (const name of commit.files) {
        const f = map.get(name);
        if (!f || used.has(name))
          throw new AppError('INVALID_VAULT', `${name}: missing or multiply committed revision`);
        const doc = parse(f.text, name);
        if (
          (doc.kind !== 'habit' && doc.kind !== 'routine') ||
          doc.command_id !== commit.id ||
          name !== this.definitionPath(doc)
        )
          throw new AppError('INVALID_VAULT', `${name}: invalid definition reference`);
        used.add(name);
        if (doc.kind === 'habit') s.habits.push(doc);
        else s.routines.push(doc);
      }
    }
    for (const file of files.filter((f) => f.path.startsWith('Daily/'))) {
      const d = parse(file.text, file.path);
      if (d.kind !== 'daily_execution' || file.path !== this.dailyPath(d.date))
        throw new AppError('INVALID_VAULT', `${file.path}: invalid daily path`);
      s.days.push(d);
      used.add(file.path);
    }
    for (const f of files) {
      if (!used.has(f.path)) s.warnings.push(`Uncommitted revision ignored: ${f.path}`);
      s.sources.push({
        path: f.path,
        kind: f.path === 'Tracker.md' ? 'tracker' : f.path.split('/')[0],
        sha256: f.hash,
      });
    }
    validateSnapshot(s);
    return s;
  }
  definitionPath(d: Habit | Routine) {
    return `${d.kind === 'habit' ? 'Habits' : 'Routines'}/${d.id}/${String(d.revision).padStart(6, '0')}.md`;
  }
  dailyPath(day: string) {
    return `Daily/${day.slice(0, 4)}/${day.slice(5, 7)}/${day}.md`;
  }
  // `planned` runs before anything is written, so a commit intent can be recorded first.
  writeDaily(d: Daily, beforeCommit?: () => void, planned?: (files: PlannedFile[]) => void) {
    const text = serialize(d);
    planned?.([{ path: this.dailyPath(d.date), sha256: sha(text) }]);
    atomicWrite(this.safe(this.dailyPath(d.date)), text, beforeCommit);
  }
  commit(
    definitions: (Habit | Routine)[],
    commandId: string,
    requestHash: string,
    at: string,
    beforeCommit?: () => void,
    planned?: (files: PlannedFile[]) => void,
  ) {
    const revisions = definitions.map((doc) => ({
      path: this.definitionPath(doc),
      text: serialize(doc),
    }));
    for (const r of revisions)
      if (fs.existsSync(this.safe(r.path)))
        throw new AppError('REVISION_CONFLICT', `Revision path already exists: ${r.path}`, 409);
    const commit: Commit = {
      schema_version: 1,
      kind: 'definition_commit',
      id: commandId,
      recorded_at: at,
      request_sha256: requestHash,
      files: revisions.map((r) => r.path),
    };
    const manifest = { path: `Commits/${commandId}.md`, text: serialize(commit) };
    // Write order: every revision, then the manifest that makes them visible.
    planned?.([...revisions, manifest].map((f) => ({ path: f.path, sha256: sha(f.text) })));
    const written: string[] = [];
    try {
      for (const r of revisions) {
        atomicWrite(this.safe(r.path), r.text);
        written.push(r.path);
      }
      atomicWrite(this.safe(manifest.path), manifest.text, beforeCommit);
    } catch (e) {
      // Without a manifest these revisions are invisible. Remove them so a rejected
      // command leaves the Vault unchanged instead of looking like an external edit.
      if (!fs.existsSync(this.safe(manifest.path))) {
        try {
          this.removeUncommitted(written);
        } catch {
          // Leftovers are still ignored by load() and reported as warnings.
        }
      }
      throw e;
    }
  }
  // Deletes definition revisions that no manifest references. Only the app's own
  // interrupted writes may be passed here; committed history is never removed.
  removeUncommitted(paths: string[]) {
    for (const rel of paths)
      if (!/^(Habits|Routines)\/[0-9a-f-]{36}\/[0-9]{6,}\.md$/.test(rel))
        throw new AppError('INVALID_VAULT', `Refusing to remove ${rel}`);
    const files = paths.map((rel) => this.safe(rel));
    for (const file of files) fs.rmSync(file, { force: true });
    for (const dir of new Set(files.map((f) => path.dirname(f)))) {
      if (fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
      syncDirectory(fs.existsSync(dir) ? dir : path.dirname(dir));
    }
  }
  nextRevision(kind: 'habit' | 'routine', id: string) {
    const dir = this.safe(`${kind === 'habit' ? 'Habits' : 'Routines'}/${id}`);
    return fs.existsSync(dir)
      ? Math.max(
          0,
          ...fs
            .readdirSync(dir)
            .filter((f) => /^\d+\.md$/.test(f))
            .map((f) => Number(f.slice(0, -3))),
        ) + 1
      : 1;
  }
  initialize(tracker: Tracker) {
    fs.mkdirSync(this.root, { recursive: true });
    if (fs.readdirSync(this.root).length > 0)
      throw new AppError('INVALID_VAULT', 'Initialize only an empty tracker directory');
    atomicWrite(this.safe('Tracker.md'), serialize(tracker));
  }
}
export function validateSnapshot(s: Snapshot) {
  const fail = (message: string): never => {
    throw new AppError('INVALID_VAULT', message);
  };
  const keys = new Set<string>();
  const ids = new Set<string>();
  for (const v of [...s.habits, ...s.routines]) {
    parseDocument(v);
    const k = `${v.kind}/${v.id}/${v.revision}`;
    if (keys.has(k)) fail(`Duplicate revision ${k}`);
    keys.add(k);
    if (v.effective_from < s.tracker.tracking_started_on) fail(`${k}: definition predates tracker`);
    const opposite = v.kind === 'habit' ? s.routines : s.habits;
    if (opposite.some((o) => o.id === v.id)) fail(`${k}: ID reused across kinds`);
    const same = (v.kind === 'habit' ? s.habits : s.routines).filter((o) => o.id === v.id);
    if (same.some((o) => o.created_at !== v.created_at)) fail(`${k}: created_at changed`);
  }
  for (const h of s.habits) {
    for (const id of routineIds(h))
      if (!s.routines.some((r) => r.id === id)) fail(`${h.id}: missing member Routine ${id}`);
    for (const field of ['schedule', 'scheduled_time'] as const) {
      const binding = h[field];
      if (binding.mode !== 'routine') continue;
      const r = s.routines.find(
        (r) => r.id === h.parent_routine_id && r.revision === binding.source_routine_revision,
      );
      if (!r || r.deleted || r.effective_from > h.effective_from)
        fail(`${h.id}: invalid inherited Routine revision`);
      const resolved = field === 'schedule' ? h.schedule.rule : h.scheduled_time.value;
      if (canonical(resolved) !== canonical(r![field]))
        fail(`${h.id}: inherited value does not match provenance`);
    }
  }
  for (const r of s.routines)
    for (const id of r.habit_order)
      if (!s.habits.some((h) => h.id === id)) fail(`${r.id}: order references unknown Habit`);
  const boundaries = [...new Set([...s.habits, ...s.routines].map((v) => v.effective_from))].sort();
  for (const id of new Set(s.habits.map((h) => h.id))) {
    const versions = s.habits.filter((h) => h.id === id);
    let previous: Habit | undefined;
    for (const day of boundaries) {
      const h = effective(versions, day);
      if (!h) continue;
      for (const routineId of routineIds(h)) {
        const r = effective(
          s.routines.filter((r) => r.id === routineId),
          day,
        );
        if (!r || r.deleted) fail(`${id}: membership references absent/deleted Routine on ${day}`);
      }
      if (previous && previous.active && !previous.deleted && h.revision !== previous.revision) {
        const unit = unitOf(previous.schedule.rule);
        const changesQuota =
          !h.active ||
          h.deleted ||
          canonical(previous.schedule.rule) !== canonical(h.schedule.rule);
        if (unit !== 'occurrences' && changesQuota && bounds(day, unit).start !== day)
          fail(`${id}: quota cadence/deactivation must change at period boundary`);
      }
      previous = h;
    }
  }
  for (const d of s.days) {
    parseDocument(d);
    if (
      d.tracker_id !== s.tracker.id ||
      d.timezone !== s.tracker.timezone ||
      d.date < s.tracker.tracking_started_on ||
      ids.has(d.date)
    )
      fail(`Invalid/duplicate daily document ${d.date}`);
    ids.add(d.date);
    const daily = new Set<string>();
    for (const e of d.executions) {
      const h = effective(
        s.habits.filter((h) => h.id === e.habit_id),
        d.date,
      );
      if (
        !h ||
        !h.active ||
        h.deleted ||
        !isDue(h.schedule.rule, d.date) ||
        h.revision !== e.habit_revision
      )
        fail(`${d.date}: execution not eligible under its referenced Habit`);
      if (daily.has(e.habit_id) || e.id !== executionId(s.tracker.id, e.habit_id, d.date))
        fail(`${d.date}: duplicate/invalid execution ID`);
      daily.add(e.habit_id);
      const r = effective(
        s.routines.filter((r) => r.id === h!.parent_routine_id),
        d.date,
      );
      if (
        e.routine_id !== h!.parent_routine_id ||
        e.routine_revision !== (r?.revision ?? null) ||
        e.target_amount !== h!.target_amount ||
        e.unit !== h!.unit
      )
        fail(`${d.date}: inconsistent execution snapshot`);
      for (const at of [e.recorded_at, e.updated_at, e.completed_at].filter(
        (v): v is string => v !== null,
      ))
        if (todayAt(at, s.tracker.timezone) !== d.date)
          fail(`${d.date}: execution timestamp outside its date`);
    }
    for (const receipt of d.receipts) {
      if (
        receipt.applied_revision > d.revision ||
        s.commits.some((c) => c.id === receipt.command_id) ||
        keys.has(receipt.command_id)
      )
        fail(`${d.date}: invalid/duplicate command receipt`);
      keys.add(receipt.command_id);
    }
  }
}
