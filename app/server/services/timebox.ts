import { randomUUID } from 'node:crypto';
import { v5 as uuidv5 } from 'uuid';
import { Temporal } from '@js-temporal/polyfill';
import { AppError, type Snapshot } from '../../shared/contracts/index.js';
import type { PlanData, ManualData, DayPlanData } from '../../shared/contracts/timebox.js';
import type { ActionData, TodoData, PlanningActionData } from '../../shared/contracts/todo.js';
import type { RecordInput } from '../../shared/contracts/module.js';
import { candidates, instantAt, timeboxView } from '../../shared/domain/timebox.js';
import { latest, occurrence, occurrenceId } from '../../shared/domain/todo.js';
import { todayAt } from '../../shared/domain/index.js';
import { agendaEtag, moduleEtag, assertModuleEtag } from '../modules.js';
import type { ModuleSnapshot } from '../storage/markdown/module-vault.js';
import { TrackerService } from './tracker.js';
import { ModuleService } from './module.js';
import { TodoService } from './todo.js';
export interface Versions {
  habit: string;
  todo: string;
  timebox: string;
}
export interface Placement {
  date: string;
  candidate: string | null;
  title: string;
  start: string;
  end: string;
  color: string | null;
}
const token = (s: ModuleSnapshot) => moduleEtag(s.settings.module, s.settings.id, s.fingerprint);
export class TimeboxService {
  constructor(
    public habit: TrackerService,
    public todo: ModuleService,
    public box: ModuleService,
  ) {}
  private locked<T>(fn: (h: Snapshot, t: ModuleSnapshot, b: ModuleSnapshot) => T | Promise<T>) {
    return this.habit.vault.locked(() =>
      this.todo.vault.locked(() =>
        this.box.vault.locked(() => {
          const h = this.habit.snapshotLocked(),
            t = this.todo.loadLocked(),
            b = this.box.loadLocked();
          for (const s of [t, b])
            if (
              s.settings.habit_tracker_id !== h.tracker.id ||
              s.settings.timezone !== h.tracker.timezone
            )
              throw new AppError(
                'INVALID_VAULT',
                'Modules must share the accepted Habit identity and calendar',
              );
          return fn(h, t, b);
        }),
      ),
    );
  }
  private guard(h: Snapshot, t: ModuleSnapshot) {
    return () => {
      if (
        this.habit.vault.fingerprint() !== h.fingerprint ||
        this.todo.vault.fingerprint() !== t.fingerprint
      )
        throw new AppError('EXTERNAL_CHANGE', 'Plan source changed while saving', 409);
    };
  }
  private dependencies(h: Snapshot, t: ModuleSnapshot, versions: Versions) {
    if (h.fingerprint !== versions.habit || token(t) !== versions.todo)
      throw new AppError(
        'REVISION_CONFLICT',
        'Agenda sources changed. Refresh before planning.',
        409,
      );
  }
  read(day?: string) {
    return this.locked((h, t, b) => {
      const now = this.box.clock(),
        date = day ?? todayAt(now, h.tracker.timezone);
      const versions = { habit: h.fingerprint, todo: token(t), timebox: token(b) };
      const warnings = [
        this.todo.readLocked().index_warning,
        this.box.readLocked().index_warning,
      ].filter(Boolean);
      return {
        index_warning: warnings.length ? warnings.join('; ') : null,
        data: {
          ...timeboxView(h, t, b, date, now),
          versions,
          module_ids: { todo: t.settings.id, timebox: b.settings.id },
          actions: [
            ...latest<ActionData>(t, 'staged_action').map((a) => ({
              id: a.id,
              state: a.data.state,
              title: a.data.plan.title,
              error: this.sourceError(t, h, a.data),
            })),
            ...latest<PlanningActionData>(t, 'planning_action').map((a) => ({
              id: a.id,
              state: a.data.state,
              error: this.sourceError(t, h, a.data),
              title: a.data.records
                .filter((r) => r.kind === 'plan')
                .map((r) => r.data.title)
                .join(', '),
            })),
          ].filter((a) => a.state === 'pending'),
        },
        etag: agendaEtag(date, versions, 1),
      };
    });
  }
  private sourceError(t: ModuleSnapshot, h: Snapshot, action: ActionData | PlanningActionData) {
    const plans =
      'plan' in action
        ? [action.plan]
        : action.records.filter((r) => r.kind === 'plan').map((r) => r.data);
    const dependencies =
      action.dependencies ??
      plans
        .filter((p) => p.source.type === 'todo')
        .map((p) => ({ kind: 'todo', id: p.source.id!, revision: p.source.revision! }));
    if (
      (action.habit_fingerprint && action.habit_fingerprint !== h.fingerprint) ||
      dependencies.some((d) => {
        const current = latest<TodoData>(t, d.kind).find((r) => r.id === d.id);
        return (
          !current ||
          current.revision !== d.revision ||
          (d.kind === 'todo' && (current.data.deleted || !current.data.active))
        );
      })
    )
      return 'Source changed. Cancel this pending placement and create a new Plan from the current source.';
    return null;
  }
  private requireSource(t: ModuleSnapshot, action: ActionData | PlanningActionData) {
    const h = this.habit.snapshotLocked();
    const error = this.sourceError(t, h, action);
    if (error) throw new AppError('SOURCE_CHANGED', error, 409);
    return this.guard(h, t);
  }
  // Materialize only the occurrences actually being planned. The source stage and
  // its immutable target proposal survive independently of either derived index.
  private planMutation(
    h: Snapshot,
    t: ModuleSnapshot,
    b: ModuleSnapshot,
    versions: Versions,
    command: string,
    request: unknown,
    build: (b: ModuleSnapshot, now: string) => RecordInput[],
  ) {
    const actionId = uuidv5('materialize', command);
    const existing = latest<PlanningActionData>(t, 'planning_action').find(
      (a) => a.id === actionId,
    );
    const sourceCommand = {
      id: actionId,
      etag: versions.todo,
      request: { type: 'materialize_plans', request },
    };
    if (existing) {
      this.todo.mutateLocked(sourceCommand, () => []); // canonical request-hash check
      return this.resumePlanning(actionId);
    }
    const targetCommand = { id: command, etag: versions.timebox, request };
    if (b.commits.some((c) => c.id === command)) return this.box.mutateLocked(targetCommand, build);
    this.dependencies(h, t, versions);
    assertModuleEtag(versions.timebox, token(b));
    const inputs = build(b, this.box.clock());
    const materialized = new Map<string, RecordInput>();
    for (const input of inputs) {
      if (input.kind !== 'plan') continue;
      const source = (input.data as PlanData).source;
      if (source.type !== 'todo') continue;
      const o = occurrence(t, source.id!, source.anchor_date);
      if (!o.saved) materialized.set(o.id, { kind: 'todo_occurrence', id: o.id, data: o.data });
    }
    if (!materialized.size)
      return this.box.mutateLocked(targetCommand, () => inputs, this.guard(h, t));
    const now = this.box.clock();
    this.box.vault.validateRecords(
      [
        ...b.records,
        ...inputs.map((r) => ({
          ...r,
          schema_version: 1,
          module_id: b.settings.id,
          command_id: command,
          revision: this.box.vault.nextRevision(r.kind, r.id),
          created_at: b.records.find((old) => old.id === r.id)?.created_at ?? now,
          recorded_at: now,
        })),
      ],
      b.settings,
    );
    const action: PlanningActionData = {
      target_module_id: b.settings.id,
      target_etag: token(b),
      target_command: command,
      records: inputs as PlanningActionData['records'],
      dependencies: [
        ...new Map(
          inputs
            .filter((r) => r.kind === 'plan' && (r.data as PlanData).source.type === 'todo')
            .flatMap((r) => {
              const source = (r.data as PlanData).source;
              const todo = latest<TodoData>(t, 'todo').find((v) => v.id === source.id)!;
              const occurrence = latest(t, 'todo_occurrence').find(
                (v) => v.id === source.occurrence_id,
              );
              return [
                { kind: 'todo' as const, id: todo.id, revision: todo.revision },
                {
                  kind: 'todo_occurrence' as const,
                  id: source.occurrence_id!,
                  revision:
                    occurrence?.revision ??
                    this.todo.vault.nextRevision('todo_occurrence', source.occurrence_id!),
                },
              ];
            })
            .map((d) => [d.id, d]),
        ).values(),
      ],
      ...(inputs.some(
        (r) => r.kind === 'plan' && ['habit', 'routine'].includes((r.data as PlanData).source.type),
      )
        ? { habit_fingerprint: h.fingerprint }
        : {}),
      state: 'pending',
    };
    this.todo.mutateLocked(
      sourceCommand,
      () => [...materialized.values(), { kind: 'planning_action', id: actionId, data: action }],
      () => {
        if (
          this.habit.vault.fingerprint() !== h.fingerprint ||
          this.box.vault.fingerprint() !== b.fingerprint
        )
          throw new AppError('EXTERNAL_CHANGE', 'Planning dependencies changed', 409);
      },
    );
    return this.resumePlanning(actionId);
  }
  private resumePlanning(id: string) {
    const s = this.todo.loadLocked();
    const action = latest<PlanningActionData>(s, 'planning_action').find((a) => a.id === id);
    if (!action) throw new AppError('NOT_FOUND', 'Planning action not found', 404);
    const a = action.data;
    if (a.state === 'cancelled')
      throw new AppError('ACTION_CANCELLED', 'Pending placement was cancelled', 409);
    try {
      const b = this.box.loadLocked();
      if (b.settings.id !== a.target_module_id)
        throw new AppError('INVALID_VAULT', 'Timebox identity changed');
      const result = this.box.mutateLocked(
        {
          id: a.target_command,
          etag: a.target_etag,
          request: { type: 'materialized_plans', id, records: a.records },
        },
        () => {
          this.requireSource(s, a);
          return a.records;
        },
        this.guard(this.habit.snapshotLocked(), s),
      );
      if (a.state !== 'done')
        this.todo.mutateLocked(
          { id: uuidv5('finish', id), etag: token(s), request: { type: 'finish_planning', id } },
          () => [{ kind: 'planning_action', id, data: { ...a, state: 'done' } }],
        );
      return { ...result, state: 'done', action_id: id };
    } catch (e) {
      return {
        state: 'pending',
        action_id: id,
        error: {
          code: e instanceof AppError ? e.code : 'RECOVERY_PENDING',
          message: (e as Error).message,
        },
      };
    }
  }
  prepare(day: string, versions: Versions, command: string) {
    return this.locked((h, t, snapshot) =>
      this.planMutation(h, t, snapshot, versions, command, { type: 'prepare', day }, (b, now) => {
        this.dependencies(h, t, versions);
        if (day !== todayAt(now, h.tracker.timezone))
          throw new AppError('DAY_LOCKED', 'Only Today can prepare automatic Plans', 409);
        const old = latest<DayPlanData>(b, 'day_plan').find((r) => r.data.date === day);
        const inputs: RecordInput[] = [
          {
            kind: 'day_plan',
            id: uuidv5(`day/${day}`, b.settings.id),
            data: old?.data ?? { date: day, prepared_at: now, priorities: [] },
          },
        ];
        if (!old)
          for (const c of candidates(h, t, day).candidates.filter((c) => c.time)) {
            const start = instantAt(day, c.time!, h.tracker.timezone);
            const end = Temporal.Instant.from(start).add({
              seconds: Math.ceil(c.duration / 900) * 900,
            });
            const boundary = Temporal.PlainDate.from(day)
              .add({ days: 1 })
              .toZonedDateTime(h.tracker.timezone)
              .toInstant();
            const id = uuidv5(`automatic/${day}/${c.key}`, b.settings.id);
            if (
              latest<PlanData>(b, 'plan').some(
                (p) =>
                  p.data.date === day &&
                  !p.data.cancelled &&
                  p.data.source.type === c.source.type &&
                  p.data.source.id === c.source.id &&
                  p.data.source.occurrence_id === c.source.occurrence_id,
              )
            )
              continue;
            inputs.push({
              kind: 'plan',
              id,
              data: {
                date: day,
                source: c.source,
                title: c.title,
                planned_start: start,
                planned_end: (Temporal.Instant.compare(end, boundary) > 0
                  ? boundary
                  : end
                ).toString(),
                color_override: null,
                inherited_color: c.color,
                origin: 'automatic',
                cancelled: false,
              } satisfies PlanData,
            });
          }
        return inputs;
      }),
    );
  }
  place(input: Placement, id: string | null, versions: Versions, command: string) {
    return this.locked((h, t, snapshot) =>
      this.planMutation(
        h,
        t,
        snapshot,
        versions,
        command,
        { type: 'place', input, id },
        (b, now) => {
          this.dependencies(h, t, versions);
          if (input.date < todayAt(now, h.tracker.timezone))
            throw new AppError('DAY_LOCKED', 'Historical Plans are preserved', 409);
          const old = id ? latest<PlanData>(b, 'plan').find((r) => r.id === id) : undefined;
          if (id && (!old || old.data.date !== input.date))
            throw new AppError('NOT_FOUND', 'Plan not found', 404);
          const c = candidates(h, t, input.date).candidates.find((c) => c.key === input.candidate);
          if (!old && input.candidate && !c)
            throw new AppError('NOT_FOUND', 'Planning candidate is no longer available', 404);
          const source = old?.data.source ??
            c?.source ?? {
              type: 'manual' as const,
              module_id: null,
              id: null,
              revision: null,
              occurrence_id: null,
              anchor_date: null,
              habit_ids: [],
            };
          return [
            {
              kind: 'plan',
              id: id ?? randomUUID(),
              data: {
                date: input.date,
                source,
                title: old?.data.title ?? c?.title ?? input.title,
                planned_start: input.start,
                planned_end: input.end,
                color_override: input.color,
                inherited_color: old?.data.inherited_color ?? c?.color ?? null,
                origin:
                  old?.data.origin === 'automatic' &&
                  input.start === old.data.planned_start &&
                  input.end === old.data.planned_end
                    ? 'automatic'
                    : 'user',
                cancelled: false,
              } satisfies PlanData,
            },
          ];
        },
      ),
    );
  }
  cancel(id: string, etag: string, command: string) {
    return this.box.mutate({ id: command, etag, request: { type: 'cancel', id } }, (b, now) => {
      const p = latest<PlanData>(b, 'plan').find((r) => r.id === id);
      if (!p) throw new AppError('NOT_FOUND', 'Plan not found', 404);
      if (p.data.date < todayAt(now, b.settings.timezone))
        throw new AppError('DAY_LOCKED', 'Historical Plans are preserved', 409);
      return [{ kind: 'plan', id, data: { ...p.data, cancelled: true } }];
    });
  }
  priorities(day: string, ids: string[], versions: Versions, command: string) {
    return this.locked((h, t) =>
      this.box.mutateLocked(
        { id: command, etag: versions.timebox, request: { type: 'priorities', day, ids } },
        (b, now) => {
          this.dependencies(h, t, versions);
          const old = latest<DayPlanData>(b, 'day_plan').find((r) => r.data.date === day);
          if (day !== todayAt(now, b.settings.timezone) || !old)
            throw new AppError('DAY_LOCKED', 'Prepare Today first', 409);
          const valid = candidates(h, t, day).todo.items;
          if (ids.some((id) => !valid.some((i) => i.id === id && !i.todo.data.deleted)))
            throw new AppError('VALIDATION_ERROR', 'Unknown priority occurrence');
          return [{ kind: 'day_plan', id: old.id, data: { ...old.data, priorities: ids } }];
        },
        this.guard(h, t),
      ),
    );
  }
  manual(data: ManualData, id: string | null, etag: string, command: string) {
    return this.box.mutate(
      { id: command, etag, request: { type: 'manual', id, data } },
      (b, now) => {
        if (
          Temporal.Instant.compare(data.actual_start, now) > 0 ||
          (data.actual_end && Temporal.Instant.compare(data.actual_end, now) > 0)
        )
          throw new AppError('VALIDATION_ERROR', 'Actual cannot be in the future');
        if (id && !latest<ManualData>(b, 'manual_actual').some((r) => r.id === id))
          throw new AppError('NOT_FOUND', 'Manual Actual not found', 404);
        if (
          data.plan_id &&
          latest<ManualData>(b, 'manual_actual').some(
            (r) => r.id !== id && r.data.plan_id === data.plan_id && !r.data.deleted,
          )
        )
          throw new AppError('VALIDATION_ERROR', 'Manual Plan already has an Actual');
        return [{ kind: 'manual_actual', id: id ?? randomUUID(), data }];
      },
    );
  }
  manualExecution(
    planId: string,
    action: 'start' | 'complete' | 'undo',
    etag: string,
    command: string,
  ) {
    return this.box.mutate(
      { id: command, etag, request: { type: 'manual_execution', planId, action } },
      (b, now) => {
        const p = latest<PlanData>(b, 'plan').find((r) => r.id === planId);
        if (!p || p.data.source.type !== 'manual')
          throw new AppError('NOT_FOUND', 'Manual Plan not found', 404);
        const id = uuidv5(`manual/${planId}`, b.settings.id);
        const old = latest<ManualData>(b, 'manual_actual').find((r) => r.id === id);
        if (action === 'start' && old && !old.data.deleted)
          throw new AppError('EXECUTION_STARTED', 'Actual already started', 409);
        if (action !== 'start' && (!old || old.data.deleted))
          throw new AppError('NOT_FOUND', 'Start the Manual Actual first', 404);
        const data: ManualData =
          old && action !== 'start'
            ? {
                ...old.data,
                actual_end:
                  action === 'complete' ? (old.data.actual_end ?? now) : old.data.actual_end,
                deleted: action === 'undo',
              }
            : {
                date: todayAt(now, b.settings.timezone),
                title: p.data.title,
                actual_start: now,
                actual_end: null,
                color: p.data.color_override ?? p.data.inherited_color,
                note: '',
                plan_id: planId,
                deleted: false,
              };
        return [{ kind: 'manual_actual', id, data }];
      },
    );
  }
  stageInbox(inboxId: string, input: Placement, versions: Versions, command: string) {
    return this.locked((h, t, b) => {
      this.todo.mutateLocked(
        { id: command, etag: versions.todo, request: { type: 'inbox_plan', inboxId, input } },
        (s, now) => {
          this.dependencies(h, t, versions);
          if (versions.timebox !== token(b))
            throw new AppError('REVISION_CONFLICT', 'Timebox changed', 409);
          if (input.date < todayAt(now, s.settings.timezone))
            throw new AppError('DAY_LOCKED', 'Cannot create a past Plan', 409);
          const inputs = new TodoService(this.todo).processInputs(
            s,
            now,
            inboxId,
            'date',
            input.date,
          );
          const todo = inputs.find((r) => r.kind === 'todo')!;
          const plan: PlanData = {
            date: input.date,
            title: (todo.data as TodoData).title,
            source: {
              type: 'todo',
              module_id: s.settings.id,
              id: todo.id,
              revision: 1,
              occurrence_id: occurrenceId(s.settings.id, todo.id, null),
              anchor_date: null,
              habit_ids: [],
            },
            planned_start: input.start,
            planned_end: input.end,
            color_override: input.color,
            inherited_color: null,
            origin: 'user',
            cancelled: false,
          };
          // Validate the target proposal before making the recoverable source stage visible.
          this.box.vault.validateRecords(
            [
              ...b.records,
              {
                schema_version: 1,
                kind: 'plan',
                module_id: b.settings.id,
                id: command,
                revision: 1,
                command_id: command,
                created_at: now,
                recorded_at: now,
                data: plan,
              },
            ],
            b.settings,
          );
          const action: ActionData = {
            dependencies: [
              { kind: 'todo', id: todo.id, revision: 1 },
              { kind: 'todo_occurrence', id: plan.source.occurrence_id!, revision: 1 },
            ],
            inbox_id: inboxId,
            todo_id: todo.id,
            plan_id: uuidv5('plan', command),
            target_module_id: b.settings.id,
            target_command: uuidv5('target', command),
            target_etag: versions.timebox,
            plan,
            state: 'pending',
          };
          const d = todo.data as TodoData;
          return [
            ...inputs,
            {
              kind: 'todo_occurrence',
              id: plan.source.occurrence_id!,
              data: {
                todo_id: todo.id,
                template_revision: 1,
                anchor_date: null,
                do_date: d.do_date,
                due_at: d.due_at,
                title: d.title,
                project_id: d.project_id,
                workflow_status: d.workflow_status,
              },
            },
            { kind: 'staged_action', id: command, data: action },
          ];
        },
        () => {
          if (
            this.habit.vault.fingerprint() !== h.fingerprint ||
            this.box.vault.fingerprint() !== b.fingerprint
          )
            throw new AppError('EXTERNAL_CHANGE', 'Agenda changed during Inbox processing', 409);
        },
      );
      return this.resumeLocked(command);
    });
  }
  private resumeLocked(id: string) {
    const s = this.todo.loadLocked();
    const action = latest<ActionData>(s, 'staged_action').find((a) => a.id === id);
    if (!action) throw new AppError('NOT_FOUND', 'Staged action not found', 404);
    if (action.data.state === 'done') return { state: 'done', action_id: id };
    const a = action.data;
    if (a.state === 'cancelled')
      throw new AppError('ACTION_CANCELLED', 'Pending placement was cancelled', 409);
    try {
      const b = this.box.loadLocked();
      if (b.settings.id !== a.target_module_id)
        throw new AppError('INVALID_VAULT', 'Timebox identity changed');
      this.box.mutateLocked(
        {
          id: a.target_command,
          etag: a.target_etag,
          request: { type: 'staged_plan', plan: a.plan, id: a.plan_id },
        },
        () => {
          this.requireSource(s, a);
          return [{ kind: 'plan', id: a.plan_id, data: a.plan }];
        },
        this.guard(this.habit.snapshotLocked(), s),
      );
      this.todo.mutateLocked(
        { id: uuidv5('finish', id), etag: token(s), request: { type: 'finish_action', id } },
        () => [{ kind: 'staged_action', id, data: { ...a, state: 'done' } }],
      );
      return { state: 'done', action_id: id };
    } catch (e) {
      return {
        state: 'pending',
        action_id: id,
        error: {
          code: e instanceof AppError ? e.code : 'RECOVERY_PENDING',
          message: (e as Error).message,
        },
      };
    }
  }
  cancelAction(id: string, versions: Versions, command: string) {
    return this.locked((_h, t, b) =>
      this.todo.mutateLocked(
        { id: command, etag: versions.todo, request: { type: 'cancel_action', id } },
        () => {
          const a = [
            ...latest<ActionData>(t, 'staged_action'),
            ...latest<PlanningActionData>(t, 'planning_action'),
          ].find((a) => a.id === id);
          if (!a) throw new AppError('NOT_FOUND', 'Action not found', 404);
          if (b.commits.some((c) => c.id === a.data.target_command))
            throw new AppError(
              'ALREADY_COMMITTED',
              'Plan already saved; resume to finish recovery',
              409,
            );
          return [{ kind: a.kind, id, data: { ...a.data, state: 'cancelled' } }];
        },
      ),
    );
  }
  resume(id: string, versions: Versions, command: string, acceptCurrent: boolean) {
    return this.locked((h, t, b) => {
      const planning = latest<PlanningActionData>(t, 'planning_action').some((a) => a.id === id);
      if (acceptCurrent)
        this.todo.mutateLocked(
          {
            id: command,
            etag: versions.todo,
            request: { type: 'review_action', id, target_etag: versions.timebox },
          },
          () => {
            this.dependencies(h, t, versions);
            if (versions.timebox !== token(b))
              throw new AppError('REVISION_CONFLICT', 'Timebox changed again', 409);
            const a = planning
              ? latest<PlanningActionData>(t, 'planning_action').find((a) => a.id === id)
              : latest<ActionData>(t, 'staged_action').find((a) => a.id === id);
            if (!a) throw new AppError('NOT_FOUND', 'Action not found', 404);
            if (!b.commits.some((c) => c.id === a.data.target_command))
              this.requireSource(t, a.data);
            return [
              {
                kind: planning ? 'planning_action' : 'staged_action',
                id,
                data: { ...a.data, target_etag: token(b) },
              },
            ];
          },
        );
      return planning ? this.resumePlanning(id) : this.resumeLocked(id);
    });
  }
}
