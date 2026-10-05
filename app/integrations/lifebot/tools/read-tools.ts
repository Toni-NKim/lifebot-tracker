import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
import { inputSchemas, outputSchema, dataSchemas, type ToolName } from '../contracts/tools.js';
import * as u from '../contracts/upstream.js';
import * as p from '../projections.js';
import type { TrackerReader, ReadPath } from '../http-client.js';
import { LifebotError, shapeError } from '../errors.js';

type Module = 'habit' | 'todo' | 'timebox' | 'agenda';
type Result = z.infer<ReturnType<typeof outputSchema>>;
const fail = (e: unknown) => (e instanceof LifebotError ? e : shapeError());
const matches = (text: string, query?: string) =>
  !query || text.toLocaleLowerCase().includes(query.toLocaleLowerCase());

/** Transport-independent semantic tools. TrackerReader is the entire application boundary. */
export class ReadTools {
  constructor(private http: TrackerReader) {}

  async call(name: ToolName, raw: unknown): Promise<Result> {
    const result: Result = {
      schema_version: '1',
      status: 'ok',
      date: null,
      timezone: null,
      observed_at: new Date().toISOString(),
      versions: {},
      observations: [],
      data: null,
      warnings: [],
      unavailable_modules: [],
    };
    let scope: Module = 'habit';
    const read = async <S extends z.ZodTypeAny>(
      path: ReadPath,
      schema: S,
      module: Module,
      query: Record<string, string> = {},
    ) => {
      scope = module;
      const value = await this.http.get(path, u.envelope(schema), query);
      result.observations.push({ endpoint: path, etag: value.etag, date: null });
      if (module !== 'agenda') result.versions[module] = value.etag;
      if (value.index_warning)
        result.warnings.push(
          `${module}: Tracker reported an index or acceptance warning; data came from its supported read boundary.`,
        );
      return value;
    };
    const calendar = async () => {
      scope = 'habit';
      const c = await this.http.get(
        '/system/status',
        z.union([u.calendar, z.object({ error: z.string() })]),
      );
      if ('error' in c)
        throw new LifebotError(
          'VAULT_UNAVAILABLE',
          'Tracker calendar is unavailable. Inspect Tracker diagnostics.',
        );
      result.date = c.date;
      result.timezone = c.timezone;
      result.observations.push({ endpoint: '/system/status', etag: c.etag, date: c.date });
      return c;
    };
    const setCalendar = (v: { date: string; timezone: string }, requestedDate?: string) => {
      if (requestedDate && v.date !== requestedDate) throw shapeError();
      result.date = v.date;
      result.timezone = v.timezone;
      result.observations.at(-1)!.date = v.date;
    };
    const unavailable = (module: Module, error: unknown) => {
      const e = fail(error);
      result.unavailable_modules.push({ module, code: e.code, message: e.message });
    };
    try {
      // Separate per-tool parsing retains precise unions without accepting extra arguments.
      if (name === 'get_today' || name === 'get_agenda') {
        const args = inputSchemas.get_agenda.parse(raw);
        if (name === 'get_today') inputSchemas.get_today.parse(raw);
        try {
          const a = await read('/agenda', u.agenda, 'agenda', args.date ? { date: args.date } : {});
          if (
            a.data.habits.date !== a.data.date ||
            a.data.todo.date !== a.data.date ||
            a.data.habits.timezone !== a.data.timezone ||
            a.data.todo.timezone !== a.data.timezone ||
            (!args.date && a.data.date !== a.data.today)
          )
            throw shapeError();
          setCalendar(a.data, args.date);
          result.versions = a.data.versions;
          result.agenda_etag = a.etag;
          result.data = p.overview(a.data, args);
        } catch (error) {
          const e = fail(error);
          // Contract/auth failures never masquerade as a degraded successful read.
          if (e.code === 'UPSTREAM_CONTRACT_ERROR' || e.httpStatus === 403 || e.httpStatus === 401)
            throw e;
          unavailable('agenda', e);
          const data: z.infer<typeof dataSchemas.get_today> = {
            prepared: null,
            habits: null,
            todos: null,
            inbox: null,
            plans: null,
            actuals: null,
            candidates: null,
            priorities: null,
            pending_actions: null,
            stats: null,
          };
          try {
            const h = await read('/today', u.today, 'habit');
            setCalendar(h.data);
            if (args.date && args.date !== h.data.date) {
              unavailable(
                'habit',
                new LifebotError(
                  'HISTORICAL_VIEW_UNAVAILABLE',
                  'Habit-only fallback provides Today, not the requested historical agenda.',
                ),
              );
            } else
              data.habits = p.paginate(
                h.data.items.map((i) => p.habit(i.habit, args, i)),
                args,
              );
          } catch (e) {
            if (fail(e).code === 'UPSTREAM_CONTRACT_ERROR') throw e;
            unavailable('habit', e);
          }
          try {
            const t = await read('/todo', u.todos, 'todo', args.date ? { date: args.date } : {});
            if (result.timezone && result.timezone !== t.data.timezone) throw shapeError();
            // A midnight boundary is not an atomic composite snapshot.
            if (data.habits && result.date !== t.data.date)
              throw new LifebotError(
                'READ_CHANGED',
                'Tracker date changed during the composed read; read again.',
              );
            setCalendar(t.data, args.date);
            data.todos = p.paginate(
              t.data.items
                .filter(
                  (i) =>
                    !i.todo.data.deleted &&
                    i.workflow_status === 'next' &&
                    (!i.data.do_date || i.data.do_date <= t.data.date),
                )
                .map(p.todo),
              args,
            );
            data.inbox = p.paginate(t.data.inbox.map(p.inbox), args);
          } catch (e) {
            if (['UPSTREAM_CONTRACT_ERROR', 'READ_CHANGED'].includes(fail(e).code)) throw e;
            unavailable('todo', e);
          }
          unavailable(
            'timebox',
            new LifebotError(
              'DEPENDENCY_UNAVAILABLE',
              'Integrated Timebox data cannot be read without a valid agenda. This does not mean it is empty.',
            ),
          );
          result.data = data.habits || data.todos ? data : null;
          if (!result.data) result.date = null;
          result.status = result.data ? 'partial' : 'unavailable';
          result.warnings.push(
            'Fallback sections are separate HTTP observations, not a cross-module snapshot.',
          );
        }
      } else if (name === 'get_habits') {
        const a = inputSchemas.get_habits.parse(raw);
        if (a.view === 'today') {
          const h = await read('/today', u.today, 'habit');
          setCalendar(h.data);
          const items = h.data.items.filter(
            (i) => !a.routine_id || i.routine_contexts.some((c) => c.routine_id === a.routine_id),
          );
          result.data = {
            habits: p.paginate(
              items.map((i) => p.habit(i.habit, a, i)),
              a,
            ),
            pending_definitions: p.paginate([], a),
          };
        } else {
          const before = await calendar();
          const h = await read('/habits', u.definitions, 'habit');
          const c = await calendar();
          if (h.etag !== c.etag || h.etag !== before.etag || c.date !== before.date)
            throw new LifebotError(
              'READ_CHANGED',
              'Habit changed during the composed read; read again.',
            );
          const visible = (h: z.infer<typeof u.habit>) =>
            !a.routine_id || (h.routine_ids ?? [h.parent_routine_id]).includes(a.routine_id);
          result.data = {
            habits: p.paginate(
              h.data.flatMap((i) =>
                i.current && visible(i.current) ? [p.habit(i.current, a)] : [],
              ),
              a,
            ),
            pending_definitions: p.paginate(
              a.include_pending
                ? h.data.flatMap((i) => i.pending.filter(visible).map((h) => p.habit(h, a)))
                : [],
              a,
            ),
          };
        }
      } else if (name === 'get_todos' || name === 'get_inbox' || name === 'get_projects') {
        const a = inputSchemas[name].parse(raw);
        const day = name === 'get_todos' ? inputSchemas.get_todos.parse(raw).date : undefined;
        const t = await read('/todo', u.todos, 'todo', day ? { date: day } : {});
        setCalendar(t.data, day);
        if (name === 'get_todos') {
          const args = inputSchemas.get_todos.parse(raw);
          result.data = {
            todos: p.paginate(
              t.data.items
                .filter(
                  (i) =>
                    !i.todo.data.deleted &&
                    (args.status === 'open'
                      ? i.workflow_status !== 'completed'
                      : i.workflow_status === args.status) &&
                    (!args.project_id || i.data.project_id === args.project_id) &&
                    matches(i.data.title, args.query),
                )
                .map(p.todo),
              args,
            ),
          };
        } else if (name === 'get_inbox') {
          const args = inputSchemas.get_inbox.parse(raw);
          result.data = {
            inbox: p.paginate(
              t.data.inbox.filter((i) => matches(i.data.title, args.query)).map(p.inbox),
              args,
            ),
          };
        } else {
          const args = inputSchemas.get_projects.parse(raw);
          result.data = {
            projects: p.paginate(
              t.data.projects
                .filter((i) => args.status === 'all' || i.data.status === args.status)
                .map(p.project),
              args,
            ),
          };
        }
      } else if (name === 'get_history') {
        const a = inputSchemas.get_history.parse(raw);
        if (a.domain === 'todo') {
          const t = await read('/todo', u.todos, 'todo');
          setCalendar(t.data);
          result.data = {
            domain: 'todo',
            from: a.from,
            to: a.to,
            history: p.paginate(
              t.data.history
                .filter((i) => {
                  const day = Temporal.Instant.from(i.execution!.completed_at!)
                    .toZonedDateTimeISO(t.data.timezone)
                    .toPlainDate()
                    .toString();
                  return day >= a.from && day <= a.to;
                })
                .map(p.todo),
              a,
            ),
          };
        } else {
          const h = await read('/history', u.history, 'habit', {
            from: a.from,
            to: a.to,
            offset: String(a.offset),
            limit: String(a.limit),
          });
          if (
            h.data.rows.length > a.limit ||
            h.data.offset !== a.offset ||
            h.data.limit !== a.limit
          )
            throw shapeError();
          const c = await calendar();
          if (h.etag !== c.etag || h.data.today !== c.date)
            throw new LifebotError(
              'READ_CHANGED',
              'Habit changed during the composed read; read again.',
            );
          result.data = {
            domain: 'habit',
            from: a.from,
            to: a.to,
            history: {
              items: h.data.rows.map((i) => ({
                habit_id: i.habit_id,
                date: i.date,
                name: i.name,
                kind: i.kind,
                status: i.status ?? null,
                execution: p.completion(i.execution),
              })),
              total: h.data.total,
              offset: a.offset,
              limit: a.limit,
            },
            quota_periods: p.paginate(h.data.quota_periods.map(p.quota), a),
          };
        }
      } else {
        const a = inputSchemas.get_stats.parse(raw);
        if (a.domain === 'agenda') {
          const r = await read('/agenda', u.agenda, 'agenda', a.date ? { date: a.date } : {});
          setCalendar(r.data, a.date);
          result.versions = r.data.versions;
          result.agenda_etag = r.etag;
          result.data = { domain: 'agenda', units: 'seconds_and_counts', metrics: r.data.stats };
        } else {
          const query: Record<string, string> = {};
          if (a.from) query.from = a.from;
          if (a.to) query.to = a.to;
          if (a.habit_id) query.habit_id = a.habit_id;
          const before = await calendar();
          const r = await read('/statistics', u.statistics, 'habit', query);
          const after = await calendar();
          if (before.date !== after.date || before.etag !== r.etag || after.etag !== r.etag)
            throw new LifebotError(
              'READ_CHANGED',
              'Habit changed during the composed read; read again.',
            );
          result.data = {
            domain: 'habit',
            from: r.data.from,
            to: r.data.to,
            rate_unit: 'percent',
            date_scheduled: r.data.date_scheduled,
            weekly_quota: r.data.weekly_quota,
            monthly_quota: r.data.monthly_quota,
            live_quotas: p.paginate(r.data.live_quotas.map(p.quota), a),
            heatmap: p.paginate(r.data.heatmap, a),
            streaks: p.paginate(
              r.data.habits.map(({ id, ...s }) => ({ habit_id: id, ...s })),
              a,
            ),
          };
        }
      }
      const checked = outputSchema(name).safeParse(result);
      if (!checked.success) throw shapeError();
      return checked.data;
    } catch (error) {
      const e =
        error instanceof z.ZodError
          ? new LifebotError('VALIDATION_ERROR', 'Invalid tool arguments.')
          : fail(error);
      result.status = [
        'VAULT_UNAVAILABLE',
        'STATE_UNAVAILABLE',
        'CONNECTION_UNAVAILABLE',
        'NOT_FOUND',
      ].includes(e.code)
        ? 'unavailable'
        : 'error';
      result.data = null;
      result.error = { code: e.code, message: e.message };
      result.unavailable_modules = [{ module: scope, ...result.error }];
      return outputSchema(name).parse(result);
    }
  }
}
