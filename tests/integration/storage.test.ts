import { afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { harness, habitFields, execution, routineFields, undone } from '../helpers.js';
import { parse, serialize, atomicWrite } from '../../app/server/storage/markdown/vault.js';
import { project, executionId } from '../../app/shared/domain/index.js';
const cleanups: (() => void)[] = [];
async function setup(start?: string) {
  const t = await harness(start);
  cleanups.push(t.cleanup);
  return t;
}
afterEach(() => {
  cleanups.splice(0).forEach((f) => f());
  vi.restoreAllMocks();
});
describe('canonical persistence', () => {
  it('round-trips Korean and multiline YAML, rejects malformed frontmatter', async () => {
    const t = await setup();
    const h = await t.create();
    expect(parse(serialize(h))).toEqual(h);
    expect(() => parse('---\nkind: habit\nkind: routine\n---\n')).toThrow();
    expect(() => parse('---\nkind: tracker\nschema_version: 99\n---\n')).toThrow();
  });
  it('stores completion and its idempotency receipt before indexing', async () => {
    const t = await setup();
    const h = await t.create();
    const cmd = randomUUID();
    const old = t.etag();
    await t.service.execute('2026-09-21', h.id, execution(), cmd, old);
    const d = t.vault.load().days[0];
    expect(d.executions[0].energy_note).toContain('\n');
    await t.service.execute('2026-09-21', h.id, execution(), cmd, old);
    expect(t.vault.load().days[0].revision).toBe(1);
    await expect(
      t.service.execute('2026-09-21', h.id, execution({ status: 'incomplete' }), cmd, t.etag()),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('rejects stale clients, past days, and non-due dates', async () => {
    const t = await setup();
    const h = await t.create();
    const stale = t.etag();
    await t.service.execute('2026-09-21', h.id, execution(), randomUUID(), stale);
    await expect(
      t.service.execute('2026-09-21', h.id, execution(), randomUUID(), stale),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    t.setNow('2026-09-22T00:00:00Z');
    await expect(
      t.service.execute('2026-09-21', h.id, execution(), randomUUID(), t.etag()),
    ).rejects.toMatchObject({ code: 'DAY_LOCKED' });
  });
  it('undo/recomplete resets timestamp; editing context preserves it', async () => {
    const t = await setup();
    const h = await t.create();
    await t.service.execute('2026-09-21', h.id, execution(), randomUUID(), t.etag());
    t.setNow('2026-09-21T01:00:00Z');
    await t.service.execute(
      '2026-09-21',
      h.id,
      execution({ energy_note: 'changed' }),
      randomUUID(),
      t.etag(),
    );
    expect(t.vault.load().days[0].executions[0].completed_at).toBe('2026-09-21T00:00:00Z');
    await t.service.execute('2026-09-21', h.id, undone(), randomUUID(), t.etag());
    await t.service.execute('2026-09-21', h.id, execution(), randomUUID(), t.etag());
    expect(t.vault.load().days[0].executions[0].completed_at).toBe('2026-09-21T01:00:00Z');
  });
  it('rechecks midnight immediately before daily commit', async () => {
    const t = await setup();
    const h = await t.create();
    const original = t.vault.writeDaily.bind(t.vault);
    vi.spyOn(t.vault, 'writeDaily').mockImplementation((d, guard) => {
      t.setNow('2026-09-21T15:00:00Z');
      return original(d, guard);
    });
    await expect(
      t.service.execute('2026-09-21', h.id, execution(), randomUUID(), t.etag()),
    ).rejects.toMatchObject({ code: 'DAY_LOCKED' });
    expect(t.vault.load().days).toHaveLength(0);
  });
  it('a definition commit rejected at midnight leaves no orphans and does not lock the app', async () => {
    const t = await setup();
    const r = await t.routine();
    const h = await t.create(
      habitFields({
        parent_routine_id: r.id,
        schedule: { mode: 'routine', source_routine_revision: 1, rule: r.schedule },
      }),
    );
    const before = t.etag();
    const original = t.vault.commit.bind(t.vault);
    vi.spyOn(t.vault, 'commit').mockImplementation((docs, command, hash, at, guard) => {
      t.setNow('2026-09-21T15:00:00Z');
      return original(docs, command, hash, at, guard);
    });
    // A Routine edit writes several revisions (Routine + inheriting child) before its manifest.
    await expect(
      t.service.editRoutine(r.id, { schedule: { type: 'weekdays' } }, randomUUID(), before),
    ).rejects.toMatchObject({ code: 'DAY_LOCKED' });
    vi.restoreAllMocks();
    expect(t.etag()).toBe(before);
    expect(t.vault.load().warnings).toEqual([]);
    await expect(t.service.today()).resolves.toBeDefined();
    await t.service.execute('2026-09-22', h.id, execution(), randomUUID(), t.etag());
  });
  it('an interrupted atomic replacement preserves the old file', async () => {
    const t = await setup();
    const file = path.join(t.root, 'atomic.txt');
    fs.writeFileSync(file, 'old');
    expect(() =>
      atomicWrite(file, 'new', () => {
        throw new Error('crash');
      }),
    ).toThrow('crash');
    expect(fs.readFileSync(file, 'utf8')).toBe('old');
  });
  it('rechecks external source changes immediately before committing', async () => {
    const t = await setup();
    const h = await t.create();
    const write = t.vault.writeDaily.bind(t.vault);
    vi.spyOn(t.vault, 'writeDaily').mockImplementation((d, guard) => {
      atomicWrite(
        path.join(t.vault.root, t.vault.definitionPath(h)),
        serialize({ ...h, name: 'External edit during write' }),
      );
      return write(d, guard);
    });
    await expect(
      t.service.execute('2026-09-21', h.id, execution(), randomUUID(), t.etag()),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(t.vault.load().days).toHaveLength(0);
    expect(t.vault.load().habits[0].name).toBe('External edit during write');
  });
  it('uncommitted definitions remain invisible; retry uses a new revision path', async () => {
    const t = await setup();
    const h = await t.create();
    const orphan = {
      ...h,
      revision: 2,
      name: 'Orphan',
      command_id: randomUUID(),
      effective_from: '2026-09-22',
    };
    const file = path.join(t.vault.root, t.vault.definitionPath(orphan));
    atomicWrite(file, serialize(orphan));
    expect(t.vault.load().habits).toHaveLength(1);
    expect(t.vault.load().warnings).toHaveLength(1);
    await t.service.rebuild();
    await t.service.editHabit(h.id, { name: 'Valid' }, randomUUID(), t.etag());
    expect(t.vault.load().habits.find((v) => v.name === 'Valid')!.revision).toBe(3);
  });
});
describe('rebuild consistency', () => {
  it('database deletion rebuilds identical logical rows and statistics without source changes', async () => {
    const t = await setup();
    const h = await t.create();
    await t.service.execute('2026-09-21', h.id, execution(), randomUUID(), t.etag());
    t.setNow('2026-09-25T00:00:00Z');
    const before = await t.service.stats();
    const source = t.etag();
    const rows = t.index.read();
    fs.unlinkSync(t.index.file);
    await t.service.rebuild();
    expect(t.etag()).toBe(source);
    expect(t.index.read()).toEqual(rows);
    expect((await t.service.stats()).data).toEqual(before.data);
    expect(t.index.read()).toEqual(project(t.vault.load(), '2026-09-25T00:00:00Z'));
    expect(
      t.index.read().occurrences.filter((o) => o.is_final && o.status === 'incomplete'),
    ).toHaveLength(3);
  });
  it('a post-save index failure retains canonical success and recovers', async () => {
    const t = await setup();
    const h = await t.create();
    const mock = vi.spyOn(t.index, 'rebuild').mockImplementation(() => {
      throw new Error('disk error');
    });
    const result = await t.service.execute('2026-09-21', h.id, execution(), randomUUID(), t.etag());
    expect(result.data.saved).toBe(true);
    expect(result.index_warning).toBe('disk error');
    expect(t.vault.load().days[0].executions[0].status).toBe('completed');
    mock.mockRestore();
    await t.service.rebuild();
    expect(t.index.read().occurrences[0].status).toBe('completed');
  });
  it('invalid external source blocks reads/writes and leaves the prior database intact', async () => {
    const t = await setup();
    const h = await t.create();
    const db = fs.readFileSync(t.index.file);
    const file = path.join(t.vault.root, t.vault.definitionPath(h));
    fs.writeFileSync(file, 'broken');
    await expect(t.service.rebuild()).rejects.toMatchObject({ code: 'INVALID_VAULT' });
    expect(fs.readFileSync(t.index.file)).toEqual(db);
  });
  it('valid external edits require explicit rebuild', async () => {
    const t = await setup();
    const h = await t.create();
    atomicWrite(
      path.join(t.vault.root, t.vault.definitionPath(h)),
      serialize({ ...h, name: 'Externally edited' }),
    );
    await expect(t.service.today()).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
    await t.service.rebuild();
    expect((await t.service.today()).data.items[0].habit.name).toBe('Externally edited');
  });
});
describe('effective definition timelines', () => {
  it('changes tomorrow and preserves unrelated pending fields', async () => {
    const t = await setup();
    const h = await t.create();
    await t.service.editHabit(h.id, { name: 'New name' }, randomUUID(), t.etag());
    await t.service.editHabit(h.id, { description: 'New description' }, randomUUID(), t.etag());
    expect((await t.service.today()).data.items[0].habit.name).toBe('Reading');
    t.setNow('2026-09-22T00:00:00Z');
    expect((await t.service.today()).data.items[0].habit).toMatchObject({
      name: 'New name',
      description: 'New description',
    });
  });
  it('quota schedule/deletion waits until next week, cosmetic changes apply tomorrow', async () => {
    const t = await setup();
    const h = await t.create(
      habitFields({
        schedule: {
          mode: 'explicit',
          source_routine_revision: null,
          rule: { type: 'weekly_quota', count: 3 },
        },
      }),
    );
    await t.service.editHabit(
      h.id,
      {
        schedule: {
          mode: 'explicit',
          source_routine_revision: null,
          rule: { type: 'weekly_quota', count: 5 },
        },
      },
      randomUUID(),
      t.etag(),
    );
    await t.service.editHabit(h.id, { name: 'Exercise' }, randomUUID(), t.etag());
    const list = (await t.service.list('habit')).data[0];
    expect(list.pending.map((v) => v.effective_from)).toEqual(['2026-09-22', '2026-09-28']);
    t.setNow('2026-09-22T00:00:00Z');
    const today = (await t.service.today()).data;
    expect(today.items[0].quota?.target_count).toBe(3);
    expect(today.items[0].habit.name).toBe('Exercise');
    t.setNow('2026-09-28T00:00:00Z');
    expect((await t.service.today()).data.items[0].quota?.target_count).toBe(5);
  });
  it('Routine defaults propagate, overrides stay explicit, deletion detaches without erasing history', async () => {
    const t = await setup();
    const r = await t.routine();
    const h = await t.create(
      habitFields({
        parent_routine_id: r.id,
        schedule: { mode: 'routine', source_routine_revision: r.revision, rule: r.schedule },
        scheduled_time: {
          mode: 'routine',
          source_routine_revision: r.revision,
          value: r.scheduled_time,
        },
      }),
    );
    const explicit = await t.create(habitFields({ name: 'Override', parent_routine_id: r.id }));
    await t.service.editRoutine(r.id, { scheduled_time: '08:00' }, randomUUID(), t.etag());
    t.setNow('2026-09-22T00:00:00Z');
    const items = (await t.service.today()).data.items;
    expect(items.find((i) => i.habit_id === h.id)?.scheduled_time).toBe('08:00');
    expect(items.find((i) => i.habit_id === explicit.id)?.scheduled_time).toBe('22:00');
    await t.service.editRoutine(r.id, { deleted: true }, randomUUID(), t.etag());
    t.setNow('2026-09-23T00:00:00Z');
    expect((await t.service.today()).data.items.every((i) => i.routine_id === null)).toBe(true);
    expect(t.vault.load().routines).toHaveLength(3);
  });
});
describe('execution timestamps belong to their local day', () => {
  it.each([
    ['2026-09-20T15:00:00Z', true], // 00:00 in Seoul on the 21st
    ['2026-09-21T14:59:59.999999Z', true], // 23:59:59.999999 on the 21st
    ['2026-09-20T14:59:59.999Z', false], // still the 20th
    ['2026-09-21T15:00:00Z', false], // already the 22nd
  ])('%s valid on 2026-09-21 = %s', async (at, valid) => {
    const t = await setup();
    const h = await t.create();
    const tracker = t.vault.load().tracker;
    const write = () =>
      t.vault.writeDaily({
        schema_version: 1,
        kind: 'daily_execution',
        tracker_id: tracker.id,
        date: '2026-09-21',
        timezone: tracker.timezone,
        revision: 1,
        created_at: at,
        updated_at: at,
        receipts: [],
        executions: [
          {
            ...execution(),
            id: executionId(tracker.id, h.id, '2026-09-21'),
            habit_id: h.id,
            habit_revision: 1,
            routine_id: null,
            routine_revision: null,
            slot: 1,
            completed_at: at,
            recorded_at: at,
            updated_at: at,
            target_amount: '20',
            unit: 'pages',
          },
        ],
      });
    write();
    if (valid) expect(t.vault.load().days).toHaveLength(1);
    else expect(() => t.vault.load()).toThrow('execution timestamp outside its date');
  });
});
