import { toISODate } from './format';

/** How days are picked in a date filter: one day, a start-to-end range, or any number of separate days. */
export type SelectMode = 'single' | 'range' | 'multiple';

/** The days shown for a month: whole weeks (Sunday first), padded with the neighbouring months' days, flagged `other`. */
export function monthCells(year: number, month: number): { date: Date; other: boolean }[] {
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const list: { date: Date; other: boolean }[] = [];
  for (let i = first.getDay() - 1; i >= 0; i--) list.push({ date: new Date(year, month, -i), other: true });
  for (let d = 1; d <= daysInMonth; d++) list.push({ date: new Date(year, month, d), other: false });
  while (list.length % 7) list.push({ date: new Date(year, month + 1, list.length - daysInMonth - first.getDay() + 1), other: true });
  return list;
}

/** Every day from `a` to `b` inclusive, whichever comes first (ISO dates, yyyy-mm-dd). */
export function datesBetween(a: string, b: string): string[] {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const out: string[] = [];
  for (let d = new Date(lo + 'T00:00:00'); toISODate(d) <= hi; d.setDate(d.getDate() + 1)) out.push(toISODate(d));
  return out;
}

/** What a click on `iso` does to the selection. In range mode the first click starts a range (the anchor), the second ends it. */
export function nextSelection(mode: SelectMode, selected: string[], anchor: string | null, iso: string): { selected: string[]; anchor: string | null } {
  if (mode === 'single') return { selected: [iso], anchor: null };
  if (mode === 'multiple') return { selected: selected.includes(iso) ? selected.filter((d) => d !== iso) : [...selected, iso], anchor: null };
  if (!anchor) return { selected: [iso], anchor: iso };
  return { selected: [anchor, iso].sort(), anchor: null };
}

/** The days that are picked, whichever mode built the selection (a range fills in every day between its two ends). */
export function activeDates(mode: SelectMode, selected: string[]): Set<string> {
  if (mode !== 'range' || selected.length < 2) return new Set(selected);
  return new Set(datesBetween(selected[0], selected[selected.length - 1]));
}

/** While a range has been started and the pointer is over another day: the days the range would cover if that day were clicked. */
export function previewDates(mode: SelectMode, anchor: string | null, hover: string | null): Set<string> {
  return mode === 'range' && anchor && hover ? new Set(datesBetween(anchor, hover)) : new Set();
}

/**
 * The classes that show a day's state, the same for every date filter:
 *  selected  - picked (click)            hovered  - the pointer (or keyboard focus) is on it
 *  preview   - would be in the range     hot      - the pointer is on the picked date / range, which lights up as a whole
 *  anchor    - the start of a range that is waiting for its end
 */
export function dayClasses(iso: string, s: { active: Set<string>; preview: Set<string>; hover: string | null; anchor: string | null }): string {
  const c: string[] = [];
  const picked = s.active.has(iso);
  if (picked) c.push('selected');
  if (picked && s.hover !== null && s.active.has(s.hover)) c.push('hot');
  if (s.preview.has(iso)) c.push('preview');
  if (s.hover === iso) c.push('hovered');
  if (s.anchor === iso) c.push('anchor');
  return c.join(' ');
}
