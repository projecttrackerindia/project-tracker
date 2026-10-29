/**
 * The one layout engine for timed things on a day (Google Calendar / Outlook style): every timed item of a day column — meetings, calls,
 * logged time, focus blocks, reminders and finished work with a time — is packed into side-by-side columns so no two ever cover each other.
 *
 * 1. Items are grouped into clusters: a cluster is a run of items that overlap one another, directly or through a chain.
 * 2. Inside a cluster each item takes the first column that is free at its start (interval-graph colouring, longest first on ties), and
 *    the cluster is divided into as many equal columns as it needed.
 * 3. Expand to fill: an item then widens to the right across every following column that is free for its whole span.
 *
 * Items that only touch (one ends at 10:00, the next starts at 10:00) do not overlap. `minLen` gives point-like items (a reminder, a done
 * check) the height they are drawn with, so a pill at 10:05 and a meeting at 10:10 are packed side by side, not on top of each other.
 * The same function lays out the Calendar's day columns, the Day view, the phone day and Today's "Your day" lanes.
 */
export interface Span { key: string; start: number; end: number }
export interface Packed {
  /** The column the item starts in (0-based). */
  col: number;
  /** How many columns its cluster is divided into. */
  cols: number;
  /** How many columns it covers (1 or more: it expands right into free columns). */
  span: number;
  /** Left edge and width as fractions of the day column (0..1). */
  left: number; width: number;
}

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;

export function packColumns(items: readonly Span[], minLen = 0): Map<string, Packed> {
  const list = items.map((i) => ({ key: i.key, start: i.start, end: Math.max(i.end, i.start + minLen) }))
    .sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || a.key.localeCompare(b.key));
  const out = new Map<string, Packed>();
  let cluster: { key: string; start: number; end: number; col: number }[] = [];
  let colEnds: number[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    const cols = Math.max(1, colEnds.length);
    for (const it of cluster) {
      let span = 1;
      for (let c = it.col + 1; c < cols; c++) {
        if (cluster.some((o) => o.col === c && overlaps(o, it))) break;
        span++;
      }
      out.set(it.key, { col: it.col, cols, span, left: it.col / cols, width: span / cols });
    }
    cluster = []; colEnds = []; clusterEnd = -Infinity;
  };
  for (const it of list) {
    if (cluster.length && it.start >= clusterEnd) flush();
    let col = colEnds.findIndex((e) => e <= it.start);
    if (col < 0) { col = colEnds.length; colEnds.push(it.end); } else colEnds[col] = it.end;
    cluster.push({ ...it, col });
    clusterEnd = Math.max(clusterEnd, it.end);
  }
  if (cluster.length) flush();
  return out;
}

/** CSS for a packed item inside a column, with a small gutter between neighbours. */
export const packStyle = (p: Packed | undefined, gutter = 3) => {
  const l = p ?? { left: 0, width: 1 };
  return { left: `calc(${l.left * 100}% + ${gutter}px)`, width: `calc(${l.width * 100}% - ${gutter * 2}px)` };
};

/** Whether any two packed items of a day cover each other (the invariant the engine keeps; used by the unit tests). */
export function collisions(items: readonly Span[], packed: Map<string, Packed>, minLen = 0): [string, string][] {
  const out: [string, string][] = [];
  const all = items.map((i) => ({ ...i, end: Math.max(i.end, i.start + minLen), p: packed.get(i.key)! }));
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i], b = all[j];
    if (!overlaps(a, b)) continue;
    const ax = [a.p.left, a.p.left + a.p.width], bx = [b.p.left, b.p.left + b.p.width];
    if (Math.min(ax[1], bx[1]) - Math.max(ax[0], bx[0]) > 1e-9) out.push([a.key, b.key]);
  }
  return out;
}
