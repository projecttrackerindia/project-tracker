import type { TimelineProject } from './portfolioApi';

/** Pure layout of the Portfolio timeline (range, ticks, statuses, label placement), so the rules can be checked without a browser. */

export const DAY = 86_400_000;
export const dn = (iso: string) => Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY);
export const iso = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const dmy = (s: string | null | undefined) => (s ? `${+s.slice(8, 10)} ${MON[+s.slice(5, 7) - 1]}` : '—');

export type Zoom = 'week' | 'month' | 'quarter';
export type TStatus = 'On track' | 'At risk' | 'Late' | 'Done' | 'Not started';
export const TONE: Record<TStatus, string> = { 'On track': 'ok', 'At risk': 'risk', Late: 'late', Done: 'done', 'Not started': 'ns' };

export function statusOf(p: TimelineProject, today: string): TStatus {
  if (p.progress >= 100 || p.status === 'Completed') return 'Done';
  if (p.health === 'Delayed') return 'Late';
  if (p.health === 'AtRisk') return 'At risk';
  if (p.start && dn(p.start) > dn(today) && p.progress === 0) return 'Not started';
  return 'On track';
}
/** Days the forecast lands after the due date (the server's slipDays when given). */
export const slipOf = (p: TimelineProject) => p.slipDays != null ? Math.max(0, p.slipDays) : p.forecast && p.due ? Math.max(0, dn(p.forecast) - dn(p.due)) : 0;
/** Where the bar starts: the planned start, else the due date (a dot). */
export const startOf = (p: TimelineProject) => p.start ?? p.due;

/**
 * The range: from the first of the month of the earliest start (or today) to the end of the month of the latest due / forecast / milestone (or
 * today). "Fit" is this range in the width available; it is the default, so there is never an empty year.
 */
export function fitRange(projects: TimelineProject[], today: string): { from: number; to: number } {
  const ds = projects.flatMap((p) => [p.start, p.due, p.forecast, ...p.milestones.map((m) => m.due)]).filter((x): x is string => !!x).map(dn);
  const t = dn(today);
  const a = new Date(Math.min(t, ...ds) * DAY), b = new Date(Math.max(t, ...ds) * DAY);
  const from = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), 1) / DAY;
  const to = Date.UTC(b.getUTCFullYear(), b.getUTCMonth() + 1, 1) / DAY;   // exclusive
  return { from, to };
}
export const PX_PER_DAY: Record<Zoom, number> = { week: 24, month: 7.5, quarter: 2.6 };

export interface Tier { x: number; w: number; label: string; sub?: string }
/** The header: months with the year and week starts (Week / Month), or quarters with month ticks (Quarter). */
export function ticks(from: number, to: number, zoom: Zoom, px: number): { top: Tier[]; bottom: Tier[]; weeks: number[]; months: number[] } {
  const top: Tier[] = [], bottom: Tier[] = [], weeks: number[] = [], months: number[] = [];
  let d = new Date(from * DAY);
  while (d.getTime() / DAY < to) {
    const s = d.getTime() / DAY; const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)); const e = Math.min(to, n.getTime() / DAY);
    months.push(s);
    if (zoom === 'quarter') bottom.push({ x: (s - from) * px, w: (e - s) * px, label: MON[d.getUTCMonth()] });
    else top.push({ x: (s - from) * px, w: (e - s) * px, label: MONTH[d.getUTCMonth()], sub: String(d.getUTCFullYear()) });
    d = n;
  }
  if (zoom === 'quarter') {
    let q = new Date(from * DAY); q = new Date(Date.UTC(q.getUTCFullYear(), Math.floor(q.getUTCMonth() / 3) * 3, 1));
    while (q.getTime() / DAY < to) {
      const n = new Date(Date.UTC(q.getUTCFullYear(), q.getUTCMonth() + 3, 1));
      const s = Math.max(from, q.getTime() / DAY), e = Math.min(to, n.getTime() / DAY);
      top.push({ x: (s - from) * px, w: (e - s) * px, label: `Q${Math.floor(q.getUTCMonth() / 3) + 1}`, sub: String(q.getUTCFullYear()) });
      q = n;
    }
  } else {
    // Week starts (Mondays).
    let w = from + ((8 - new Date(from * DAY).getUTCDay()) % 7);
    for (; w < to; w += 7) { weeks.push(w); bottom.push({ x: (w - from) * px, w: 7 * px, label: String(new Date(w * DAY).getUTCDate()) }); }
  }
  return { top, bottom, weeks, months };
}

/** Rough width of a label in px (11.5px Inter). */
export const textW = (s: string) => Math.ceil(s.length * 6.3) + 4;

/**
 * Where a bar's label goes: after the bar end, or flipped to the left of the bar start when it would run past the right edge; in either place it
 * never covers the today line (it moves to the far side of it, or past it). Returns the label's left x.
 */
export function placeLabel(barStart: number, barEnd: number, width: number, labelW: number, todayX: number, gap = 8): number {
  const crosses = (x: number) => todayX > x - 3 && todayX < x + labelW + 3;
  const right = barEnd + gap, left = barStart - gap - labelW;
  const candidates = [right, left];
  for (const x of candidates) if (x >= 0 && x + labelW <= width && !crosses(x)) return x;
  // Both sides collide with the edge or the today line: put it just past the today line on the side with room.
  const afterToday = todayX + gap, beforeToday = todayX - gap - labelW;
  if (crosses(right) && afterToday + labelW <= width && afterToday >= barEnd) return afterToday;
  if (crosses(left) && beforeToday >= 0 && beforeToday + labelW <= barStart) return beforeToday;
  if (right + labelW <= width && !crosses(right)) return right;
  return Math.max(0, Math.min(width - labelW, crosses(left) ? beforeToday : left));
}

/** Milestones on the same day become one diamond with a count. */
export function mergeMilestones(ms: { id: string; name: string; due: string | null; status: string }[]) {
  const by = new Map<string, { due: string; names: string[]; ids: string[] }>();
  for (const m of ms) if (m.due) { const g = by.get(m.due) ?? { due: m.due, names: [], ids: [] }; g.names.push(m.name); g.ids.push(m.id); by.set(m.due, g); }
  return [...by.values()].sort((a, b) => a.due.localeCompare(b.due));
}
