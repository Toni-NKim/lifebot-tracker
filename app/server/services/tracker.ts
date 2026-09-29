import { routineIds, membershipPatch } from '../../shared/domain/membership.js';
import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import {
  AppError,
  type Snapshot,
  type Habit,
  type Routine,
  type HabitFields,
  type RoutineFields,
  type Daily,
  type ExecutionInput,
} from '../../shared/contracts/index.js';
import {
  todayAt,
  effective,
  changeDate,
  addDays,
  executionId,
  isDue,
  project,
  statistics,
  todayView,
  type Projection,
} from '../../shared/domain/index.js';
import {
  Vault,
  canonical,
  sha,
  fingerprintOf,
  validateSnapshot,
  type PlannedFile,
} from '../storage/markdown/vault.js';
import { Index } from '../index/sqlite/index.js';
import { AcceptedSource } from '../storage/accepted-source.js';
import { CommitIntent } from '../storage/commit-intent.js';

type Definition = Habit | Routine;
export class TrackerService {
  baseline = '';
  indexError: string | null = null;
  // A saved state whose acceptance could not be recorded; its intent is still the proof.
  private unaccepted: string | null = null;
  constructor(
    public vault: Vault,
    public index: Index,
    public clock = () => Temporal.Now.instant().toString(),
    public accepted = AcceptedSource.beside(index.file),
    public intent = CommitIntent.beside(index.file),
  ) {}
  async initialize() {
    // Older installs have no accepted-source file; their index metadata is the fallback.
    const known = this.accepted.read() ?? this.index.metadata().fingerprint ?? '';
    try {
      await this.vault.locked(() => {
        this.baseline = known || this.vault.load().fingerprint;
        // Recovers an interrupted app commit; any other change still requires a rebuild.
        this.refresh(this.load());
      });
    } catch {
      // Keep serving /system/status so an unavailable, invalid or externally changed
      // Vault can be diagnosed.
      if (!this.baseline) this.baseline = known;
    }
  }
  private accept(fingerprint: string): string | null {
    this.baseline = fingerprint;
    try {
      this.accepted.write(fingerprint);
    } catch (e) {
      // Keep the intent so a restart can still prove this commit was the app's own.
      this.unaccepted = fingerprint;
      return `Could not record accepted source state: ${(e as Error).message}`;
    }
    this.unaccepted = null;
    try {
      this.intent.clear();
    } catch {
      // A leftover intent no longer matches the accepted state and is ignored.
    }
    return null;
  }
  // A new write would replace the intent that proves the last unrecorded acceptance,
  // so that acceptance must be recorded first. Fails closed before any Markdown write.
  private settleAcceptance() {
    if (!this.unaccepted) return;
    try {
      this.accepted.write(this.unaccepted);
    } catch (e) {
      throw new AppError(
        'STATE_UNAVAILABLE',
        `The previous change is saved, but its acceptance cannot be recorded in the state directory, so nothing new was saved: ${(e as Error).message}`,
        503,
      );
    }
    this.unaccepted = null;
    try {
      this.intent.clear();
    } catch {
      // A leftover intent no longer matches the accepted state and is ignored.
    }
  }
  // Records what the next canonical write will produce. Vault calls this before writing anything.
  private intend(s: Snapshot) {
    return (files: PlannedFile[]) => {
      const next = new Map(s.sources.map((f) => [f.path, f.sha256]));
      for (const f of files) next.set(f.path, f.sha256);
      const to = fingerprintOf([...next].map(([path, sha256]) => ({ path, sha256 })));
      try {
        this.intent.write({ from: s.fingerprint, to, files });
      } catch (e) {
        // Fail closed: without a durable intent a crash could not be recovered safely,
        // so no canonical write is started.
        throw new AppError(
          'STATE_UNAVAILABLE',
          `Cannot record the commit intent in the state directory, so nothing was saved: ${(e as Error).message}`,
          503,
        );
      }
    };
  }
  // Accepts a source change only if it is exactly the app's own interrupted commit.
  private recover(s: Snapshot): boolean {
    const intent = this.intent.read();
    if (!intent || intent.from !== this.baseline) return false;
    if (s.fingerprint === intent.to) {
      this.accept(s.fingerprint);
      return true;
    }
    // Crash before the manifest: a prefix of the planned revisions exists, nothing is visible.
    const current = new Map(s.sources.map((f) => [f.path, f.sha256]));
    const done = intent.files.findIndex((f) => current.get(f.path) !== f.sha256);
    const written = intent.files.slice(0, done);
    if (
      done <= 0 ||
      intent.files.slice(done).some((f) => current.has(f.path)) ||
      fingerprintOf(s.sources.filter((f) => !written.some((w) => w.path === f.path))) !==
        intent.from
    )
      return false;
    this.vault.removeUncommitted(written.map((f) => f.path));
    this.intent.clear();
    return true;
  }
  private refresh(s: Snapshot): Projection {
    const now = this.clock();
    try {
      const meta = this.index.metadata();
      if (
        meta.fingerprint === s.fingerprint &&
        meta.today === todayAt(now, s.tracker.timezone) &&
        meta.projector_version === '2'
      ) {
        this.indexError = null;
        return this.index.read();
      }
      const p = this.index.rebuild(this.vault, s, now);
      this.indexError = null;
      return p;
    } catch (e) {
      this.indexError = (e as Error).message;
      return project(s, now);
    }
  }
  private load() {
    let s = this.vault.load();
    if (this.baseline && s.fingerprint !== this.baseline && this.recover(s)) s = this.vault.load();
    // Another process (for example the CLI rebuild) may have accepted the current source.
    if (this.baseline && s.fingerprint !== this.baseline && this.accepted.read() === s.fingerprint)
      this.baseline = s.fingerprint;
    if (this.baseline && s.fingerprint !== this.baseline)
      throw new AppError(
        'EXTERNAL_CHANGE',
        'Canonical files changed outside the app. Validate and explicitly rebuild before continuing.',
        409,
      );
    return s;
  }
  async read<T>(fn: (s: Snapshot, p: Projection) => T) {
    return this.vault.locked(() => {
      const s = this.load();
      const p = this.refresh(s);
      return { data: fn(s, p), etag: s.fingerprint, index_warning: this.indexError };
    });
  }
  today() {
    return this.read(todayView);
  }
  list(kind: 'habit' | 'routine') {
    return this.read((s, p) => {
      const versions: Definition[] = kind === 'habit' ? s.habits : s.routines;
      const ids = [...new Set(versions.map((v) => v.id))];
      const created = new Map(versions.map((v) => [v.id, v.created_at]));
      ids.sort((a, b) => created.get(a)!.localeCompare(created.get(b)!) || a.localeCompare(b));
      return ids.map((id) => {
        const all = versions
          .filter((v) => v.id === id)
          .sort(
            (a, b) => a.effective_from.localeCompare(b.effective_from) || a.revision - b.revision,
          );
        const dates = [
          ...new Set(all.filter((v) => v.effective_from > p.today).map((v) => v.effective_from)),
        ];
        return {
          id,
          current: effective(all, p.today) ?? null,
          pending: dates.map((d) => effective(all, d)!),
        };
      });
    });
  }
  stats(from?: string, to?: string, habitId?: string) {
    return this.read((s, p) =>
      statistics(s, p, from ?? s.tracker.tracking_started_on, to ?? p.today, habitId),
    );
  }
  history(from: string, to: string, offset = 0, limit = 50) {
    return this.read((s, p) => {
      const dated = p.occurrences
        .filter((o) => o.date >= from && o.date <= to)
        .map((o) => ({
          ...o,
          kind: 'scheduled' as const,
          name: s.habits.find((h) => h.id === o.habit_id && h.revision === o.habit_revision)!.name,
          execution:
            s.days
              .find((d) => d.date === o.date)
              ?.executions.find((e) => e.id === o.execution_id) ?? null,
        }));
      const activity = p.quotaDays
        .filter((o) => o.date >= from && o.date <= to && o.execution_id)
        .map((o) => ({
          ...o,
          kind: 'quota_activity' as const,
          name: s.habits.find((h) => h.id === o.habit_id && h.revision === o.habit_revision)!.name,
          execution:
            s.days
              .find((d) => d.date === o.date)
              ?.executions.find((e) => e.id === o.execution_id) ?? null,
        }));
      const rows = [...dated, ...activity].sort(
        (a, b) => b.date.localeCompare(a.date) || a.habit_id.localeCompare(b.habit_id),
      );
      return {
        rows: rows.slice(offset, offset + limit),
        total: rows.length,
        offset,
        limit,
        quota_periods: p.periods.filter((q) => q.end >= from && q.end <= to && q.is_final),
        today: p.today,
      };
    });
  }
  async status() {
    try {
      const s = this.vault.load();
      return {
        vault_path: this.vault.root,
        timezone: s.tracker.timezone,
        date: todayAt(this.clock(), s.tracker.timezone),
        source_changed: s.fingerprint !== this.baseline && this.accepted.read() !== s.fingerprint,
        index_warning: this.indexError,
        warnings: s.warnings,
        etag: s.fingerprint,
      };
    } catch (e) {
      return {
        vault_path: this.vault.root,
        error: (e as Error).message,
        index_warning: this.indexError,
      };
    }
  }
  async rebuild(asOf = this.clock()) {
    return this.vault.locked(() => {
      const s = this.vault.load();
      const p = this.index.rebuild(this.vault, s, asOf);
      // An explicit rebuild accepts the source and supersedes any interrupted commit.
      this.indexError = this.accept(s.fingerprint);
      return {
        data: { rebuilt: true, warnings: s.warnings, cutoff: p.cutoff },
        etag: s.fingerprint,
      };
    });
  }
  async validateVault() {
    return this.vault.locked(() => {
      const s = this.vault.load();
      return { valid: true, warnings: s.warnings, fingerprint: s.fingerprint };
    });
  }
  private async mutate(
    command: string,
    etag: string,
    request: unknown,
    apply: (s: Snapshot, now: string, today: string, requestHash: string) => void,
  ) {
    return this.vault.locked(() => {
      const s = this.load();
      const hash = sha(canonical(request));
      const prior =
        s.commits.find((c) => c.id === command)?.request_sha256 ??
        s.days.flatMap((d) => d.receipts).find((r) => r.command_id === command)?.request_sha256;
      if (prior && prior !== hash)
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          'Command ID was already used for another request',
          409,
        );
      if (!prior) {
        this.settleAcceptance();
        if (etag !== s.fingerprint)
          throw new AppError('REVISION_CONFLICT', 'Data changed. Refresh before saving.', 409);
        const now = this.clock();
        apply(s, now, todayAt(now, s.tracker.timezone), hash);
      }
      const saved = this.vault.load();
      // Record acceptance before indexing so an index failure or crash cannot lock the app.
      const acceptError = prior ? null : this.accept(saved.fingerprint);
      const p = this.refresh(saved);
      if (acceptError) this.indexError = acceptError;
      return {
        data: {
          saved: true,
          replayed: !!prior,
          today: todayView(saved, p),
          changes: [...saved.habits, ...saved.routines]
            .filter((v) => v.command_id === command)
            .map((v) => ({
              kind: v.kind,
              id: v.id,
              revision: v.revision,
              effective_from: v.effective_from,
            })),
        },
        etag: saved.fingerprint,
        index_warning: this.indexError,
      };
    });
  }
  // A proposed state that breaks a Vault rule is invalid input: nothing has been written,
  // so it must not be reported as a corrupt Vault.
  private validateProposal(proposed: Snapshot) {
    try {
      validateSnapshot(proposed);
    } catch (e) {
      if (e instanceof AppError && e.code === 'INVALID_VAULT')
        throw new AppError('VALIDATION_ERROR', e.message);
      throw e;
    }
  }
  private guardDay(day: string, zone: string) {
    if (todayAt(this.clock(), zone) !== day)
      throw new AppError(
        'DAY_LOCKED',
        'The day changed before the write committed. Refresh Today.',
        409,
      );
  }
  private bind(h: Habit, s: Snapshot) {
    const r = effective(
      s.routines.filter((r) => r.id === h.parent_routine_id),
      h.effective_from,
    );
    if (h.parent_routine_id && (!r || r.deleted))
      throw new AppError('VALIDATION_ERROR', 'Parent Routine is unavailable at the effective date');
    if (h.schedule.mode === 'routine') {
      if (!r) throw new AppError('VALIDATION_ERROR', 'Schedule inheritance requires a Routine');
      h.schedule = { mode: 'routine', source_routine_revision: r.revision, rule: r.schedule };
    } else h.schedule.source_routine_revision = null;
    if (h.scheduled_time.mode === 'routine') {
      if (!r) throw new AppError('VALIDATION_ERROR', 'Time inheritance requires a Routine');
      h.scheduled_time = {
        mode: 'routine',
        source_routine_revision: r.revision,
        value: r.scheduled_time,
      };
    } else h.scheduled_time.source_routine_revision = null;
    return h;
  }
  private patchTimeline(
    s: Snapshot,
    kind: 'habit' | 'routine',
    id: string,
    patch: Record<string, unknown>,
    from: string,
    command: string,
    now: string,
    selectPatch?: (base: Definition) => Record<string, unknown> | null,
  ): Definition[] {
    const versions: Definition[] = kind === 'habit' ? s.habits : s.routines;
    const all = versions.filter((v) => v.id === id);
    const first = all.sort((a, b) => a.effective_from.localeCompare(b.effective_from))[0];
    if (!first) throw new AppError('NOT_FOUND', 'Definition not found', 404);
    if (from < first.effective_from) from = first.effective_from;
    const dates = [
      ...new Set([
        from,
        ...all.filter((v) => v.effective_from > from).map((v) => v.effective_from),
      ]),
    ].sort();
    let revision = Math.max(this.vault.nextRevision(kind, id), ...all.map((v) => v.revision + 1));
    return dates.flatMap((day) => {
      const base = effective(all, day)!;
      const chosen = selectPatch ? selectPatch(base) : patch;
      if (chosen === null) return [];
      const applied = chosen;
      let next = {
        ...structuredClone(base),
        ...structuredClone(applied),
        revision: revision++,
        command_id: command,
        recorded_at: now,
        effective_from: day,
      } as Definition;
      // Only rebinding changed inheritance fields avoids adopting pending Routine schedules early.
      if (
        next.kind === 'habit' &&
        ('parent_routine_id' in applied || 'schedule' in applied || 'scheduled_time' in applied)
      ) {
        const rebound = this.bind(structuredClone(next), s);
        if ('parent_routine_id' in applied || 'schedule' in applied)
          next.schedule = rebound.schedule;
        if ('parent_routine_id' in applied || 'scheduled_time' in applied)
          next.scheduled_time = rebound.scheduled_time;
      }
      return next;
    });
  }
  private commit(
    s: Snapshot,
    docs: Definition[],
    command: string,
    hash: string,
    now: string,
    today: string,
  ) {
    const proposed = {
      ...s,
      habits: [...s.habits, ...docs.filter((d): d is Habit => d.kind === 'habit')],
      routines: [...s.routines, ...docs.filter((d): d is Routine => d.kind === 'routine')],
    };
    this.validateProposal(proposed);
    this.vault.commit(
      docs,
      command,
      hash,
      now,
      () => {
        this.vault.assertUnchanged(
          s,
          docs.map((doc) => this.vault.definitionPath(doc)),
        );
        this.guardDay(today, s.tracker.timezone);
      },
      this.intend(s),
    );
  }
  createHabit(fields: HabitFields, startsOn: string | undefined, command: string, etag: string) {
    return this.mutate(
      command,
      etag,
      { type: 'create_habit', fields, startsOn: startsOn ?? null },
      (s, now, today, hash) => {
        const from = startsOn ?? today;
        if (from < today) throw new AppError('DAY_LOCKED', 'New Habits cannot start in the past');
        const h = this.bind(
          {
            ...structuredClone(fields),
            schema_version: 1,
            kind: 'habit',
            id: randomUUID(),
            revision: 1,
            command_id: command,
            created_at: now,
            recorded_at: now,
            effective_from: from,
          },
          s,
        );
        this.commit(s, [h], command, hash, now, today);
      },
    );
  }
  editHabit(id: string, patch: Partial<HabitFields>, command: string, etag: string) {
    return this.mutate(command, etag, { type: 'edit_habit', id, patch }, (s, now, today, hash) => {
      const all = s.habits.filter((h) => h.id === id);
      const h =
        effective(all, today) ??
        all.sort((a, b) => a.effective_from.localeCompare(b.effective_from))[0];
      if (!h) throw new AppError('NOT_FOUND', 'Habit not found', 404);
      if (h.deleted) throw new AppError('VALIDATION_ERROR', 'Deleted Habits cannot be restored');
      let candidate = {
        ...structuredClone(h),
        ...structuredClone(patch),
        effective_from: addDays(today, 1),
      };
      if ('schedule' in patch || 'parent_routine_id' in patch) candidate = this.bind(candidate, s);
      const structural =
        ('active' in patch && patch.active !== h.active) ||
        patch.deleted === true ||
        canonical(candidate.schedule.rule) !== canonical(h.schedule.rule);
      const from = changeDate(h, today, structural);
      const docs = this.patchTimeline(s, 'habit', id, patch, from, command, now);
      this.commit(s, docs, command, hash, now, today);
    });
  }
  createRoutine(
    fields: RoutineFields,
    startsOn: string | undefined,
    command: string,
    etag: string,
  ) {
    return this.mutate(
      command,
      etag,
      { type: 'create_routine', fields, startsOn: startsOn ?? null },
      (s, now, today, hash) => {
        const from = startsOn ?? today;
        if (from < today) throw new AppError('DAY_LOCKED', 'New Routines cannot start in the past');
        const r: Routine = {
          ...structuredClone(fields),
          schema_version: 1,
          kind: 'routine',
          id: randomUUID(),
          revision: 1,
          command_id: command,
          created_at: now,
          recorded_at: now,
          effective_from: from,
        };
        this.commit(s, [r], command, hash, now, today);
      },
    );
  }
  editRoutine(id: string, patch: Partial<RoutineFields>, command: string, etag: string) {
    return this.mutate(
      command,
      etag,
      { type: 'edit_routine', id, patch },
      (s, now, today, hash) => {
        const from = addDays(today, 1);
        const current =
          effective(
            s.routines.filter((r) => r.id === id),
            today,
          ) ?? s.routines.find((r) => r.id === id);
        if (!current || current.deleted) throw new AppError('NOT_FOUND', 'Routine not found', 404);
        const docs = this.patchTimeline(s, 'routine', id, patch, from, command, now);
        let proposed = {
          ...s,
          routines: [...s.routines, ...(docs as Routine[])],
          habits: [...s.habits],
        };
        for (const habitId of new Set(s.habits.map((h) => h.id))) {
          const versions = s.habits.filter((h) => h.id === habitId);
          const h =
            effective(versions, today) ??
            versions.sort((a, b) => a.effective_from.localeCompare(b.effective_from))[0];
          // Also account for members scheduled to join in future.
          const member = [h, ...versions.filter((v) => v.effective_from > today)].some((v) =>
            routineIds(v).includes(id),
          );
          if (!member) continue;
          const changes: { field: 'delete' | 'schedule' | 'scheduled_time'; from: string }[] = [];
          if (patch.deleted) changes.push({ field: 'delete', from });
          else {
            if (patch.schedule)
              changes.push({
                field: 'schedule',
                from: changeDate(
                  h,
                  today,
                  canonical(h.schedule.rule) !== canonical(patch.schedule),
                ),
              });
            if ('scheduled_time' in patch) changes.push({ field: 'scheduled_time', from });
          }
          for (const change of changes) {
            const childDocs = this.patchTimeline(
              proposed,
              'habit',
              habitId,
              {},
              change.from,
              command,
              now,
              (base) => {
                if (base.kind !== 'habit' || !routineIds(base).includes(id)) return null;
                if (change.field === 'delete')
                  return membershipPatch(
                    base,
                    routineIds(base).filter((r) => r !== id),
                  );
                if (base.parent_routine_id !== id) return null;
                if (base[change.field].mode !== 'routine') return null;
                return { [change.field]: base[change.field] };
              },
            ) as Habit[];
            docs.push(...childDocs);
            proposed = { ...proposed, habits: [...proposed.habits, ...childDocs] };
          }
        }
        this.commit(s, docs, command, hash, now, today);
      },
    );
  }
  execute(day: string, habitId: string, input: ExecutionInput, command: string, etag: string) {
    return this.mutate(
      command,
      etag,
      { type: 'execute', day, habitId, input },
      (s, now, today, hash) => {
        // Details describe a completion. Enforced for new writes only, so existing files stay readable.
        if (
          input.status === 'incomplete' &&
          (input.duration_seconds !== null ||
            input.actual_amount !== null ||
            input.difficulty_or_quality !== null ||
            input.energy_note !== null)
        )
          throw new AppError(
            'VALIDATION_ERROR',
            'Incomplete executions cannot carry completion details; send them with status completed',
          );
        if (day !== today)
          throw new AppError('DAY_LOCKED', 'Only the current day can be edited', 409);
        const h = effective(
          s.habits.filter((h) => h.id === habitId),
          day,
        );
        if (!h || !h.active || h.deleted || !isDue(h.schedule.rule, day))
          throw new AppError('NOT_SCHEDULED', 'Habit is not eligible today');
        const r = effective(
          s.routines.filter((r) => r.id === h.parent_routine_id),
          day,
        );
        const existing = s.days.find((d) => d.date === day);
        const d: Daily = existing
          ? structuredClone(existing)
          : {
              schema_version: 1,
              kind: 'daily_execution',
              tracker_id: s.tracker.id,
              date: day,
              timezone: s.tracker.timezone,
              revision: 0,
              created_at: now,
              updated_at: now,
              executions: [],
              receipts: [],
            };
        const old = d.executions.find((e) => e.habit_id === habitId);
        const e = {
          ...input,
          id: executionId(s.tracker.id, habitId, day),
          habit_id: habitId,
          habit_revision: h.revision,
          routine_id: h.parent_routine_id,
          routine_revision: r?.revision ?? null,
          slot: 1 as const,
          completed_at: input.status === 'completed' ? (old?.completed_at ?? now) : null,
          recorded_at: old?.recorded_at ?? now,
          updated_at: now,
          target_amount: h.target_amount,
          unit: h.unit,
        };
        d.executions = [...d.executions.filter((e) => e.habit_id !== habitId), e].sort((a, b) =>
          a.habit_id.localeCompare(b.habit_id),
        );
        d.revision++;
        d.updated_at = now;
        d.receipts.push({
          command_id: command,
          request_sha256: hash,
          applied_revision: d.revision,
        });
        this.validateProposal({ ...s, days: [...s.days.filter((x) => x.date !== day), d] });
        this.vault.writeDaily(
          d,
          () => {
            this.vault.assertUnchanged(s);
            this.guardDay(day, s.tracker.timezone);
          },
          this.intend(s),
        );
      },
    );
  }
}
