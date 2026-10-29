import type { SheetRow } from './portfolioApi';

/** Pure logic of the Plan sheet (grouping, filters, totals, paste parsing, typed dates), kept apart from the grid so it can be checked on its own. */

export type GroupBy = 'project' | 'owner' | 'status' | 'cadence' | 'none';
export type ColId = 'key' | 'title' | 'owner' | 'start' | 'due' | 'dur' | 'status' | 'progress' | 'deps' | 'meeting' | 'updated' | 'notes';
export interface SheetFilters { notDone: boolean; due30: boolean; lateOnly: boolean; ownerMe: boolean; meetingsOnly: boolean; values: Partial<Record<ColId, string[]>> }
export interface SheetSort { col: ColId; dir: 1 | -1 }
export interface SheetConfig { group: GroupBy; sort: SheetSort | null; filters: SheetFilters }
export const DEFAULT_FILTERS: SheetFilters = { notDone: false, due30: false, lateOnly: false, ownerMe: false, meetingsOnly: false, values: {} };
export const DEFAULT_CONFIG: SheetConfig = { group: 'project', sort: null, filters: DEFAULT_FILTERS };

export type Display =
  | { type: 'row'; row: SheetRow; level: number; childCount?: number }
  | { type: 'group'; id: string; label: string; count: number };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const dayNum = (iso: string) => Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000);
export const isoOf = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => isoOf(dayNum(iso) + n);
/** "2 Sep" */
export const dm = (iso: string | null | undefined) => (iso ? `${+iso.slice(8, 10)} ${MONTHS[+iso.slice(5, 7) - 1]}` : '');

export const isOpen = (r: SheetRow) => !(r.category === 'Done' || r.category === 'Cancelled');
export const isItem = (r: SheetRow) => r.kind !== 'project';

/** The text a cell shows (also what sorting, filter menus and fill-down compare). */
export function cellText(r: SheetRow, c: ColId): string {
  switch (c) {
    case 'key': return r.key;
    case 'title': return r.title;
    case 'owner': return r.owner ?? '';
    case 'start': return r.kind === 'meeting' ? '' : dm(r.start);
    case 'due': return r.kind === 'meeting' ? '' : `${dm(r.due)}${r.dueTime ? ` · ${r.dueTime}` : ''}`;
    case 'dur': return r.durationDays != null ? `${r.durationDays}d` : '';
    case 'status': return r.status;
    case 'progress': return r.progress != null ? `${r.progress}%` : '';
    case 'deps': return r.dependsOn.join(', ');
    case 'meeting': return r.cadence ?? '';
    case 'updated': return r.updatedBy ?? '';
    case 'notes': return r.notes ?? '';
  }
}

function sortValue(r: SheetRow, c: ColId): string | number {
  switch (c) {
    case 'start': return r.start ? dayNum(r.start) : Number.MAX_SAFE_INTEGER;
    case 'due': return r.due ? dayNum(r.due) * 1440 + (r.dueTime ? +r.dueTime.slice(0, 2) * 60 + +r.dueTime.slice(3, 5) : 1439) : Number.MAX_SAFE_INTEGER;
    case 'dur': return r.durationDays ?? -1;
    case 'progress': return r.progress ?? -1;
    case 'updated': return r.updatedAt ? -Date.parse(r.updatedAt) : 0;
    case 'meeting': return r.nextAt ? Date.parse(r.nextAt) : Number.MAX_SAFE_INTEGER;
    default: return cellText(r, c).toLowerCase();
  }
}
const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);

/** Whether an item passes the filters (project rows are judged by their items). */
export function passes(r: SheetRow, f: SheetFilters, me: string | null | undefined, today: string): boolean {
  if (f.meetingsOnly && r.kind !== 'meeting') return false;
  if (f.notDone && !isOpen(r)) return false;
  if (f.lateOnly && !r.late) return false;
  if (f.ownerMe && r.ownerId !== me) return false;
  if (f.due30 && r.kind !== 'meeting' && !(r.due && dayNum(r.due) <= dayNum(today) + 30)) return false;
  for (const [c, vals] of Object.entries(f.values) as [ColId, string[]][]) if (vals?.length && !vals.includes(cellText(r, c))) return false;
  return true;
}
export const anyFilter = (f: SheetFilters) => f.notDone || f.due30 || f.lateOnly || f.ownerMe || f.meetingsOnly || Object.values(f.values).some((v) => v?.length);

/**
 * The rows in display order. Grouped by project: each project's summary row, then its tasks in order (sorted when a sort is set) with sub-items
 * right after their parent; a collapsed project hides its rows; with filters on, a project shows only when one of its items passes. Grouped by owner,
 * status or cadence: a heading per value with its items; none: a flat list of items.
 */
export function buildDisplay(rows: SheetRow[], cfg: SheetConfig, collapsed: ReadonlySet<string>, me: string | null | undefined, today: string): Display[] {
  const f = cfg.filters;
  const filtered = anyFilter(f);
  const items = rows.filter((r) => isItem(r) && passes(r, f, me, today));
  const keep = new Set(items.map((r) => r.id));
  const sortRows = (list: SheetRow[]) => cfg.sort ? [...list].sort((a, b) => cmp(sortValue(a, cfg.sort!.col), sortValue(b, cfg.sort!.col)) * cfg.sort!.dir) : list;
  const out: Display[] = [];
  if (cfg.group === 'project') {
    const projects = sortRows(rows.filter((r) => r.kind === 'project'));
    for (const p of projects) {
      const mine = rows.filter((r) => r.projectId === p.id && isItem(r));
      // Keep parents of passing sub-items so the tree stays readable.
      const shown = new Set(mine.filter((r) => keep.has(r.id)).map((r) => r.id));
      for (const r of mine) if (shown.has(r.id) && r.parentId) shown.add(r.parentId);
      if (filtered && shown.size === 0) continue;
      out.push({ type: 'row', row: p, level: 0, childCount: shown.size || mine.length });
      if (collapsed.has(p.id)) continue;
      const visible = mine.filter((r) => !filtered || shown.has(r.id));
      const ids = new Set(visible.map((r) => r.id));
      const roots = sortRows(visible.filter((r) => !r.parentId || !ids.has(r.parentId)));
      const kids = (id: string) => sortRows(visible.filter((r) => r.parentId === id));
      const walk = (r: SheetRow, level: number) => { out.push({ type: 'row', row: r, level: Math.min(level, 2) }); for (const k of kids(r.id)) walk(k, level + 1); };
      // Tasks first, meetings after them (as in the design).
      for (const r of roots.filter((x) => x.kind !== 'meeting')) walk(r, 1);
      for (const r of roots.filter((x) => x.kind === 'meeting')) walk(r, 1);
    }
    return out;
  }
  const list = sortRows(items);
  if (cfg.group === 'none') return list.map((row) => ({ type: 'row', row, level: 0 }));
  const label = (r: SheetRow) => cfg.group === 'owner' ? r.owner ?? 'No owner' : cfg.group === 'status' ? (r.kind === 'meeting' ? 'Meetings' : r.status) : r.cadence ?? 'No meeting';
  const groups = new Map<string, SheetRow[]>();
  for (const r of list) { const k = label(r); groups.set(k, [...(groups.get(k) ?? []), r]); }
  for (const [k, g] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push({ type: 'group', id: `g:${k}`, label: k, count: g.length });
    if (!collapsed.has(`g:${k}`)) for (const row of g) out.push({ type: 'row', row, level: 0 });
  }
  return out;
}

export interface Totals { rows: number; projects: number; owners: number; start: string | null; end: string | null; spanDays: number | null; late: number; risk: number; avg: number | null; meetings: number }
export function totals(display: Display[]): Totals {
  const rows = display.flatMap((d) => (d.type === 'row' ? [d.row] : []));
  const items = rows.filter(isItem);
  const work = items.filter((r) => r.kind !== 'meeting');
  const starts = rows.map((r) => r.start).filter((x): x is string => !!x).sort();
  const ends = rows.map((r) => r.due).filter((x): x is string => !!x).sort();
  const prog = work.map((r) => r.progress).filter((x): x is number => x != null);
  const start = starts[0] ?? null, end = ends[ends.length - 1] ?? null;
  return {
    rows: rows.length, projects: rows.filter((r) => r.kind === 'project').length, owners: new Set(rows.map((r) => r.ownerId).filter(Boolean)).size,
    start, end, spanDays: start && end ? dayNum(end) - dayNum(start) + 1 : null,
    late: work.filter((r) => r.late).length, risk: work.filter((r) => r.atRisk).length,
    avg: prog.length ? Math.round(prog.reduce((a, b) => a + b, 0) / prog.length) : null, meetings: items.filter((r) => r.kind === 'meeting').length,
  };
}

// ---------------------------------------------------------------- typed dates and times

/** A date typed into a cell, day first: 2026-11-07, 7 Nov, 7 Nov 2026, 7/11, 7/11/2026; "+3" / "-2" move it from what it was. Null when it is not a date. */
export function parseTypedDate(text: string, base: string | null, today: string): string | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const rel = /^([+-])\s*(\d{1,3})\s*d?$/.exec(t);
  if (rel) return addDays(base ?? today, (rel[1] === '-' ? -1 : 1) * +rel[2]);
  if (t === 'today') return today;
  if (t === 'tomorrow') return addDays(today, 1);
  const year = +today.slice(0, 4);
  const ok = (y: number, m: number, d: number) => {
    if (m < 1 || m > 12 || d < 1) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
  };
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return ok(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/.exec(t);
  if (m) return ok(m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : year, +m[2], +m[1]);
  m = /^(\d{1,2})\s*([a-z]{3,9})\.?\s*(\d{4})?$/.exec(t) ?? null;
  if (m) { const mi = MONTHS.findIndex((x) => m![2].startsWith(x.toLowerCase())); return mi < 0 ? null : ok(m[3] ? +m[3] : year, mi + 1, +m[1]); }
  m = /^([a-z]{3,9})\.?\s*(\d{1,2}),?\s*(\d{4})?$/.exec(t);
  if (m) { const mi = MONTHS.findIndex((x) => m![1].startsWith(x.toLowerCase())); return mi < 0 ? null : ok(m[3] ? +m[3] : year, mi + 1, +m[2]); }
  return null;
}
/** "18:00", "6pm", "9:30 am" → "HH:mm"; null when not a time. */
export function parseTypedTime(text: string): string | null {
  const t = text.trim().toLowerCase();
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(t);
  if (!m) return null;
  let h = +m[1]; const min = m[2] ? +m[2] : 0;
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  return h > 23 || min > 59 ? null : `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
/** "7 Nov · 18:00" / "7 Nov 18:00" / "2026-11-07" → date and optional time. */
export function parseDue(text: string, base: string | null, today: string): { date: string; time: string | null } | null {
  const sep = text.split(/\s*[·,]\s*/).filter(Boolean);
  if (sep.length === 2) { const d = parseTypedDate(sep[0], base, today); const t = parseTypedTime(sep[1]); if (d && t) return { date: d, time: t }; }
  const m = /^(.*\S)\s+(\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm))$/i.exec(text.trim());
  if (m) { const d = parseTypedDate(m[1], base, today); const t = parseTypedTime(m[2]); if (d && t) return { date: d, time: t }; }
  const d = parseTypedDate(text, base, today);
  return d ? { date: d, time: null } : null;
}

// ---------------------------------------------------------------- paste from Excel

export type PasteField = 'title' | 'owner' | 'start' | 'due' | 'status' | 'ignore';
export const PASTE_FIELDS: { id: PasteField; label: string }[] = [
  { id: 'title', label: 'Title' }, { id: 'owner', label: 'Owner' }, { id: 'start', label: 'Start' }, { id: 'due', label: 'Due' }, { id: 'status', label: 'Status' }, { id: 'ignore', label: 'Ignore' },
];
const HEADER_WORDS: [PasteField, RegExp][] = [
  ['title', /^(task|title|name|item|activity|work|deliverable|summary)s?$/],
  ['owner', /^(owner|assigned to|assignee|assigned|who|responsible|person|resource)$/],
  ['start', /^(start|start date|from|begin|begins)$/],
  ['due', /^(end|due|due date|end date|finish|deadline|to|target|target date)$/],
  ['status', /^(status|state|stage)$/],
];

/** Excel puts cells in tabs and rows in new lines (quoted cells may hold new lines). */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false;
  const s = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}

/** Column mapping by header words; without a header row, the columns are taken as Title, Owner, Start, Due, Status. */
export function mapColumns(rows: string[][]): { header: boolean; map: PasteField[] } {
  const first = rows[0] ?? [];
  const width = Math.max(0, ...rows.map((r) => r.length));
  const guess = first.map((h) => HEADER_WORDS.find(([, re]) => re.test(h.trim().toLowerCase()))?.[0] ?? null);
  const header = guess.filter(Boolean).length >= Math.min(2, first.length);
  if (header) {
    const used = new Set<PasteField>();
    const map = Array.from({ length: width }, (_, i) => { const g = guess[i]; if (g && !used.has(g)) { used.add(g); return g; } return 'ignore' as PasteField; });
    return { header, map };
  }
  const order: PasteField[] = ['title', 'owner', 'start', 'due', 'status'];
  return { header, map: Array.from({ length: width }, (_, i) => order[i] ?? 'ignore') };
}

export function pasteRows(rows: string[][], header: boolean, map: PasteField[]) {
  return (header ? rows.slice(1) : rows).map((r) => {
    const o: Record<string, string> = {};
    map.forEach((f, i) => { if (f !== 'ignore' && r[i] != null && r[i] !== '') o[f] = r[i]; });
    return { title: o.title ?? '', owner: o.owner, start: o.start, due: o.due, status: o.status };
  });
}

/** "2h ago", "Yesterday", "3d ago", "2w ago" */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const m = Math.max(0, (now - Date.parse(iso)) / 60_000);
  if (m < 2) return 'Just now';
  if (m < 60) return `${Math.round(m)}m ago`;
  if (m < 60 * 20) return `${Math.round(m / 60)}h ago`;
  const d = m / 1440;
  if (d < 1.5) return d < 1 ? 'Today' : 'Yesterday';
  if (d < 14) return `${Math.round(d)}d ago`;
  return `${Math.round(d / 7)}w ago`;
}
