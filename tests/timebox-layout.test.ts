import { expect, it } from 'vitest';
import { intervalLanes } from '../app/web/lib/timebox-layout.js';
it('separates overlapping intervals and recovers full width after a cluster', () => {
  const layout = intervalLanes([
    { key: 'a', start: 60, end: 120 },
    { key: 'b', start: 90, end: 100 },
    { key: 'c', start: 120, end: 150 },
  ]);
  expect(layout.get('a')?.lane).not.toBe(layout.get('b')?.lane);
  expect(layout.get('a')?.count).toBe(2);
  expect(layout.get('c')).toEqual({ lane: 0, count: 1 });
});
