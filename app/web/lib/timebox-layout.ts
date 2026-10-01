// Interval clusters share the available width; overlapping Plan/Actual pairs are
// grouped by the caller so an execution remains on top of its own ghost Plan.
export function intervalLanes(items: { key: string; start: number; end: number }[]) {
  const result = new Map<string, { lane: number; count: number }>();
  const sorted = items.toSorted((a, b) => a.start - b.start || a.key.localeCompare(b.key));
  let group: typeof sorted = [],
    end = -Infinity;
  const flush = () => {
    const lanes: number[] = [];
    const assigned = group.map((item) => {
      let lane = lanes.findIndex((last) => last <= item.start);
      if (lane < 0) lane = lanes.length;
      lanes[lane] = Math.max(item.end, item.start + 14);
      return { key: item.key, lane };
    });
    for (const item of assigned) result.set(item.key, { lane: item.lane, count: lanes.length });
    group = [];
  };
  for (const item of sorted) {
    if (item.start >= end && group.length) flush();
    if (!group.length) end = -Infinity;
    group.push(item);
    end = Math.max(end, item.end, item.start + 14);
  }
  flush();
  return result;
}
