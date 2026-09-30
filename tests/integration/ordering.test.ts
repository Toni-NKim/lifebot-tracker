import { afterEach, expect, it } from 'vitest';
import { harness, routineFields } from '../helpers.js';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

it('Today lists Routine groups by scheduled time, untimed last, regardless of creation order', async () => {
  const t = await harness();
  cleanups.push(t.cleanup);
  for (const [name, time] of [
    ['Noon', '12:00'],
    ['Untimed', null],
    ['Morning', '07:00'],
    ['Late', '23:30'],
    ['Night', '23:00'],
    ['Evening', '21:00'],
  ] as const)
    await t.routine(routineFields({ name, scheduled_time: time }));
  const names = (await t.service.today()).data.routines.map((r) => r.name);
  expect(names).toEqual(['Morning', 'Noon', 'Evening', 'Night', 'Late', 'Untimed']);
});

it('management lists keep creation order', async () => {
  const t = await harness();
  cleanups.push(t.cleanup);
  const names = ['First', 'Second', 'Third', 'Fourth', 'Fifth'];
  for (const [i, name] of names.entries()) {
    t.setNow(`2026-09-21T0${i}:00:00Z`);
    await t.routine(routineFields({ name }));
  }
  const listed = (await t.service.list('routine')).data.map((row) => row.current!.name);
  expect(listed).toEqual(names);
});
