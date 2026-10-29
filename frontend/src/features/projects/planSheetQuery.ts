import type { SheetRow } from './portfolioApi';
import { addDays, dayNum, dm, isOpen, parseTypedDate } from './planSheet';

/**
 * The Plan sheet's one command field, kept pure: filter tokens (owner:, status:, due:, project:, plain text), what a typed sentence means
 * ("late this week" → status late or at risk + due this week), natural dates for the date editor ("next tue", "fri", "+1w"), loose people
 * matching for pasted names ("J. Weber", "tomas.ortega") and a weekly workload worked out from assigned hours when no capacity plan is there.
 */

export type TokKind = 'owner' | 'status' | 'due' | 'project' | 'text';
export interface Tok { kind: TokKind; value: string; label: string }
export type StatusKey = 'late' | 'risk' | 'prog' | 'todo' | 'done';
export const STATUS_KEYS: StatusKey[] = ['late', 'risk', 'prog', 'todo', 'done'];
export const STATUS_LABEL: Record<StatusKey, string> = { late: 'Late', risk: 'At risk', prog: 'In progress', todo: 'Not started', done: 'Done' };
export type DueKey = 'overdue' | 'this-week' | 'next-week' | 'next-2-weeks' | 'slipped' | 'next-30';
export const DUE_LABEL: Record<DueKey, string> = { overdue: 'Overdue', 'this-week': 'This week', 'next-week': 'Next week', 'next-2-weeks': 'Next 2 weeks', slipped: 'Slipped ≥ 2d', 'next-30': 'Next 30 days' };
const STATUS_VALUES: Record<string, string> = { late: 'Late', risk: 'At risk', lateorrisk: 'Late or at risk', prog: 'In progress', todo: 'Not started', done: 'Done', open: 'Not done' };

export const isWork = (r: SheetRow) => r.kind === 'task' || r.kind === 'subtask';

/** The five states the sheet shows as a dot: done, late, at risk, in progress, not started. */
export function statusKey(r: SheetRow): StatusKey {
  if (!isOpen(r)) return 'done';
  if (r.late) return 'late';
  if (r.atRisk) return 'risk';
  return r.category === 'Todo' ? 'todo' : 'prog';
}
/** The word next to the dot: late and at risk say so; otherwise the project's own column name. */
export const statusText = (r: SheetRow) => { const k = statusKey(r); return k === 'late' || k === 'risk' ? STATUS_LABEL[k] : r.status; };
/** The "+3d" next to a date: how far the due date moved from its first one, else (for a late item) the days past due. */
export const slipDays = (r: SheetRow, today: string) => Math.max(r.slipDays ?? 0, r.due && r.late ? Math.max(1, dayNum(today) - dayNum(r.due)) : 0);

/** Monday of the week of an ISO date. */
export function weekStart(iso: string): string { const n = dayNum(iso); const dow = (new Date(n * 86_400_000).getUTCDay() + 6) % 7; return addDays(iso, -dow); }
export const weekLabel = (mon: string) => { const sun = addDays(mon, 6); return mon.slice(5, 7) === sun.slice(5, 7) ? `${+mon.slice(8, 10)}–${dm(sun)}` : `${dm(mon)} – ${dm(sun)}`; };

export interface QueryCtx { today: string; me: string | null }

/** Whether a row passes one token. */
export function tokenMatch(r: SheetRow, t: Tok, c: QueryCtx): boolean {
  switch (t.kind) {
    case 'owner': return r.ownerId === (t.value === 'me' ? c.me : t.value);
    case 'project': return r.projectId === t.value;
    case 'status': {
      const k = statusKey(r);
      return t.value === 'lateorrisk' ? k === 'late' || k === 'risk' : t.value === 'open' ? k !== 'done' : k === t.value;
    }
    case 'due': {
      if (!r.due) return false;
      const d = dayNum(r.due), today = dayNum(c.today), mon = dayNum(weekStart(c.today));
      switch (t.value as DueKey) {
        case 'overdue': return r.late;
        case 'this-week': return d >= mon && d <= mon + 6;
        case 'next-week': return d >= mon + 7 && d <= mon + 13;
        case 'next-2-weeks': return d >= today && d <= today + 14;
        case 'next-30': return d >= today && d <= today + 30;
        case 'slipped': return slipDays(r, c.today) >= 2;
        default: {
          const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(t.value);
          return !!m && d >= dayNum(m[1]) && d <= dayNum(m[2]);
        }
      }
    }
    case 'text': {
      const q = t.value.toLowerCase();
      return [r.title, r.key, r.notes ?? '', r.owner ?? ''].some((x) => x.toLowerCase().includes(q));
    }
  }
}

/** Tokens of one kind are alternatives (owner A or B); different kinds all apply. */
export function matchesAll(r: SheetRow, toks: Tok[], c: QueryCtx): boolean {
  const by = new Map<TokKind, Tok[]>();
  for (const t of toks) by.set(t.kind, [...(by.get(t.kind) ?? []), t]);
  for (const [kind, list] of by) {
    if (kind === 'text') { if (!list.every((t) => tokenMatch(r, t, c))) return false; }
    else if (!list.some((t) => tokenMatch(r, t, c))) return false;
  }
  return true;
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[._\-,]+/g, ' ').replace(/\s+/g, ' ').trim();

/** A person by a loosely typed name: exact, else one person whose name words start with every typed word ("J. Weber", "Aisha K", "tomas.ortega"). */
export function fuzzyPerson<P extends { id: string; name: string }>(typed: string | null | undefined, people: P[]): P | null {
  if (!typed?.trim()) return null;
  const n = norm(typed.replace(/<[^>]*>/g, '').replace(/@.*$/, ''));
  if (!n) return null;
  const exact = people.filter((p) => norm(p.name) === n);
  if (exact.length === 1) return exact[0];
  const words = n.split(' ');
  const hits = people.filter((p) => { const pw = norm(p.name).split(' '); return words.length <= pw.length && words.every((w, i) => pw[i]?.startsWith(w)); });
  if (hits.length === 1) return hits[0];
  // One word: a unique first name or surname.
  if (words.length === 1) { const one = people.filter((p) => norm(p.name).split(' ').some((w) => w === words[0])); if (one.length === 1) return one[0]; }
  return null;
}

/**
 * What a typed sentence means. Explicit tokens ("owner:ravi", "status:late", "due:this-week", "project:aa") first; then phrases: late / at risk /
 * overdue / done / not started / in progress, dates (this week, next week, next 2 weeks, slipped), mine, a person's name, a project's name or key.
 * Whatever is left is a text search.
 */
export function interpret(text: string, people: { id: string; name: string }[], projects: { id: string; title: string; key: string }[]): Tok[] {
  let t = ` ${text.toLowerCase().replace(/\s+/g, ' ')} `;
  const out: Tok[] = [];
  const take = (re: RegExp) => { const m = re.exec(t); if (!m) return null; t = t.replace(m[0], ' '); return m; };
  // explicit key:value
  for (;;) {
    const m = take(/\s(owner|who|status|due|project|p):("[^"]+"|\S+)/);
    if (!m) break;
    const v = m[2].replace(/"/g, '').replace(/-/g, ' ');
    if (m[1] === 'owner' || m[1] === 'who') {
      if (v === 'me' || v === 'mine') out.push({ kind: 'owner', value: 'me', label: 'Me' });
      else { const p = fuzzyPerson(v, people); if (p) out.push({ kind: 'owner', value: p.id, label: p.name }); }
    } else if (m[1] === 'status') {
      const s = statusWord(v); if (s) out.push({ kind: 'status', value: s, label: STATUS_VALUES[s] });
    } else if (m[1] === 'due') {
      const d = dueWord(v); if (d) out.push({ kind: 'due', value: d, label: DUE_LABEL[d] });
    } else {
      const p = projects.find((x) => x.key.toLowerCase() === v || norm(x.title).startsWith(norm(v))); if (p) out.push({ kind: 'project', value: p.id, label: p.title });
    }
  }
  const dueRe: [RegExp, DueKey][] = [[/\s(this week|this wk)\s/, 'this-week'], [/\snext 2 weeks|\snext two weeks|\snext fortnight/, 'next-2-weeks'], [/\snext week\s/, 'next-week'],
    [/\s(next 30 days|this month)\s/, 'next-30'], [/\s(slipped|slipping)\s/, 'slipped'], [/\soverdue\s/, 'overdue']];
  for (const [re, k] of dueRe) if (take(re)) out.push({ kind: 'due', value: k, label: DUE_LABEL[k] });
  const hasDue = out.some((x) => x.kind === 'due');
  const statusRe: [RegExp, string][] = [[/\slate or at risk\s|\sat risk or late\s|\sslipping or late\s/, 'lateorrisk'], [/\sat risk\s|\srisky\s/, 'risk'], [/\slate\s|\sbehind\s/, hasDue ? 'lateorrisk' : 'late'],
    [/\snot started\s|\sto do\s|\stodo\s/, 'todo'], [/\sin progress\s|\sactive\s|\sdoing\s/, 'prog'], [/\snot done\s|\sopen\s/, 'open'], [/\sdone\s|\scompleted?\s|\sfinished\s/, 'done']];
  for (const [re, k] of statusRe) if (take(re)) out.push({ kind: 'status', value: k, label: STATUS_VALUES[k] });
  if (take(/\s(mine|my tasks|my work|for me|assigned to me)\s/) || take(/\smy\s/)) out.push({ kind: 'owner', value: 'me', label: 'Me' });
  // People: full names first, then a unique first name.
  for (const p of [...people].sort((a, b) => b.name.length - a.name.length)) {
    const full = norm(p.name);
    if (t.includes(` ${full} `)) { t = t.replace(` ${full} `, ' '); out.push({ kind: 'owner', value: p.id, label: p.name }); continue; }
    const first = full.split(' ')[0];
    if (first.length > 2 && t.includes(` ${first} `) && people.filter((x) => norm(x.name).split(' ')[0] === first).length === 1) { t = t.replace(` ${first} `, ' '); out.push({ kind: 'owner', value: p.id, label: p.name }); }
  }
  for (const p of projects) {
    const name = norm(p.title), key = p.key.toLowerCase();
    if (t.includes(` ${name} `)) { t = t.replace(` ${name} `, ' '); out.push({ kind: 'project', value: p.id, label: p.title }); }
    else if (t.includes(` ${key} `)) { t = t.replace(` ${key} `, ' '); out.push({ kind: 'project', value: p.id, label: p.title }); }
  }
  const rest = t.replace(/\s(owned by|owner|by|for|due|in|on|the|and|or|of|with|tasks?|items?|show|me|all|is|are)\s/g, ' ').replace(/\s+/g, ' ').trim();
  if (rest && rest.length > 1) out.push({ kind: 'text', value: rest, label: `“${rest}”` });
  // One token per kind+value.
  const order: TokKind[] = ['owner', 'status', 'due', 'project', 'text'];
  return out.filter((x, i) => out.findIndex((y) => y.kind === x.kind && y.value === x.value) === i).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}
function statusWord(v: string): string | null {
  const w = v.trim();
  if (/^(late or at risk|late or risk|lateorrisk)$/.test(w)) return 'lateorrisk';
  if (/^(late|overdue|behind)$/.test(w)) return 'late';
  if (/^(at risk|risk|risky)$/.test(w)) return 'risk';
  if (/^(done|complete|completed|closed)$/.test(w)) return 'done';
  if (/^(todo|to do|not started|new)$/.test(w)) return 'todo';
  if (/^(in progress|active|doing|wip|prog)$/.test(w)) return 'prog';
  if (/^(open|not done)$/.test(w)) return 'open';
  return null;
}
function dueWord(v: string): DueKey | null {
  const w = v.trim();
  if (/^(this week|week|thisweek)$/.test(w)) return 'this-week';
  if (/^(next week|nextweek)$/.test(w)) return 'next-week';
  if (/^(next 2 weeks|2 weeks|fortnight)$/.test(w)) return 'next-2-weeks';
  if (/^(overdue|late|past)$/.test(w)) return 'overdue';
  if (/^(slipped|slip)$/.test(w)) return 'slipped';
  if (/^(30|next 30|month|this month)$/.test(w)) return 'next-30';
  return null;
}

// ---------------------------------------------------------------- natural dates

const DOW = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
/** "today", "fri", "next tue", "+1w", "+2d", "7 Nov", "7/11" → ISO; null when it is not a date. Plain day names are the next one from today (today counts). */
export function parseNatural(text: string, base: string | null, today: string): string | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return null;
  const w = /^([+-])\s*(\d{1,2})\s*w(?:eeks?)?$/.exec(t);
  if (w) return addDays(base ?? today, (w[1] === '-' ? -7 : 7) * +w[2]);
  const m = /^(next |this )?(mon|tue|wed|thu|fri|sat|sun)[a-z]*$/.exec(t);
  if (m) {
    const want = DOW.indexOf(m[2]);
    const dow = (new Date(dayNum(today) * 86_400_000).getUTCDay() + 6) % 7;
    if (m[1] === 'next ') return addDays(weekStart(today), 7 + want);
    return addDays(today, (want - dow + 7) % 7);
  }
  return parseTypedDate(t, base, today);
}

// ---------------------------------------------------------------- workload

export interface Load { id: string; name: string; pct: number; minutes: number; capacity: number; source: 'plan' | 'estimate' }
const workingDays = (a: number, b: number) => { let n = 0; for (let d = a; d <= b; d++) { const dow = new Date(d * 86_400_000).getUTCDay(); if (dow !== 0 && dow !== 6) n++; } return n; };
/**
 * A person's load in one week from the sheet alone: each open task they own that overlaps the week counts its estimate (8 h when it has none),
 * spread evenly over its working days; against 40 h. Used when the workspace's capacity plan is not available.
 */
export function estimateLoad(rows: SheetRow[], personId: string, mon: string): { minutes: number; capacity: number } {
  const a = dayNum(mon), b = a + 6;
  let minutes = 0;
  for (const r of rows) {
    if (!isWork(r) || r.ownerId !== personId || !isOpen(r) || !r.due) continue;
    const s = dayNum(r.start ?? r.due), e = dayNum(r.due);
    if (e < a || s > b) continue;
    const total = Math.max(1, workingDays(s, e)), inWeek = workingDays(Math.max(a, s), Math.min(b, e));
    minutes += ((r.estimatedHours ?? 8) * 60 * inWeek) / total;
  }
  return { minutes: Math.round(minutes), capacity: 40 * 60 };
}

/** Progress from a task's checklist (the smart fill's suggestion), else null. */
export const checklistPct = (r: SheetRow) => (r.checklistTotal ? Math.round(((r.checklistDone ?? 0) * 100) / r.checklistTotal) : null);

/** Text with @mentions and links marked: [{t:'text'|'mention'|'link', v}] for rendering. */
export function noteParts(text: string): { t: 'text' | 'mention' | 'link'; v: string }[] {
  const out: { t: 'text' | 'mention' | 'link'; v: string }[] = [];
  const re = /(https?:\/\/[^\s)]+)|(@[A-Za-zÀ-ÿ][\w.À-ÿ-]*)/g;
  let i = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(text))) { if (m.index > i) out.push({ t: 'text', v: text.slice(i, m.index) }); out.push({ t: m[1] ? 'link' : 'mention', v: m[0] }); i = m.index + m[0].length; }
  if (i < text.length) out.push({ t: 'text', v: text.slice(i) });
  return out;
}

/** A pasted date as ISO, day first (DD/MM) or month first (MM/DD); other forms (7 Nov, 2026-11-07) either way. Null when not a date. */
export function pastedDate(text: string | undefined, order: 'dmy' | 'mdy', today: string): string | null {
  if (!text?.trim()) return null;
  const m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/.exec(text.trim());
  if (m && order === 'mdy') return parseTypedDate(`${m[2]}/${m[1]}${m[3] ? `/${m[3]}` : ''}`, null, today);
  return parseTypedDate(text, null, today);
}
