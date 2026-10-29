// One typed line, read the same way everywhere (the meeting page's capture line, My Work's add line, Aura's chips) and the same way the
// server reads it (QuickLine.cs): "Confirm bank sandbox date @Ravi fri" → title, owner token and due date. Only words it is sure of are
// taken out of the title.

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export interface QuickLine { title: string; ownerToken: string | null; due: string | null; dateToken: string | null }

/** yyyy-mm-dd of a local calendar date (no time zone shift). */
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fromIso = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s: string, n: number) => { const d = fromIso(s); d.setDate(d.getDate() + n); return iso(d); };

/** The next such weekday after today (today itself only when allowToday): "fri" said on a Friday means next Friday. */
export function nextDay(today: string, day: number, allowToday = false): string {
  const t = fromIso(today).getDay();
  let diff = (day - t + 7) % 7;
  if (diff === 0 && !allowToday) diff = 7;
  return addDays(today, diff);
}

function dayIndex(w: string): number {
  if (w.length < 3) return -1;
  const i = DAYS.indexOf(w.slice(0, 3));
  if (i < 0) return -1;
  return DAY_NAMES[i].startsWith(w) || ['tues', 'thur', 'thurs'].includes(w) ? i : -1;
}
function monthIndex(w: string): number {
  if (w.length < 3) return 0;
  const i = MONTHS.indexOf(w.slice(0, 3));
  if (i < 0) return 0;
  return MONTH_NAMES[i].startsWith(w) || w === 'sept' ? i + 1 : 0;
}
const daysIn = (y: number, m: number) => new Date(y, m, 0).getDate();
function inYear(today: string, month: number, day: number): string | null {
  const y = fromIso(today).getFullYear();
  if (day > daysIn(y, month) && day > daysIn(y + 1, month)) return null;
  const d = iso(new Date(y, month - 1, Math.min(day, daysIn(y, month))));
  return d < addDays(today, -30) ? iso(new Date(y + 1, month - 1, Math.min(day, daysIn(y + 1, month)))) : d;
}
const num = (w: string) => { const n = Number(w.replace(/(st|nd|rd|th)$/, '')); return Number.isInteger(n) ? n : NaN; };

function dateAt(w: string, next: string | null, next2: string | null, today: string): [string | null, number] {
  switch (w) {
    case 'today': case 'tod': case 'eod': return [today, 1];
    case 'tomorrow': case 'tmr': case 'tmrw': case 'tom': return [addDays(today, 1), 1];
    case 'eow': return [nextDay(today, 5, true), 1];
    case 'next': if (next === 'week') return [nextDay(today, 1, false), 2]; break;
    case 'in': {
      const n = next ? Number(next) : NaN;
      if (Number.isInteger(n) && n > 0 && n < 366 && (next2 === 'day' || next2 === 'days')) return [addDays(today, n), 3];
      if (Number.isInteger(n) && n > 0 && n < 53 && (next2 === 'week' || next2 === 'weeks')) return [addDays(today, 7 * n), 3];
      break;
    }
  }
  const plus = /^\+(\d{1,3})d$/.exec(w);
  if (plus) return [addDays(today, Number(plus[1])), 1];
  if (/^\d{4}-\d{2}-\d{2}$/.test(w) && !Number.isNaN(fromIso(w).getTime())) return [w, 1];
  const di = dayIndex(w);
  if (di >= 0) return [nextDay(today, di, false), 1];
  const dom = num(w);
  if (dom >= 1 && dom <= 31 && next && monthIndex(next) > 0) return [inYear(today, monthIndex(next), dom), 2];
  const mi = monthIndex(w);
  if (mi > 0 && next) { const d2 = num(next); if (d2 >= 1 && d2 <= 31) return [inYear(today, mi, d2), 2]; }
  return [null, 0];
}

const trim = (w: string) => w.replace(/^[,.;]+|[,.;]+$/g, '');

/** Reads "text @owner date" (see QuickLine.cs). <today> is yyyy-mm-dd in the workspace's day. */
export function parseQuickLine(text: string, today: string): QuickLine {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const keep = words.map(() => true);
  let ownerToken: string | null = null; let due: string | null = null; let dateToken: string | null = null;
  for (let i = 0; i < words.length; i++) {
    if (!keep[i]) continue;
    const m = /^@([\p{L}\p{N}._'-]{1,60})$/u.exec(trim(words[i]));
    if (!ownerToken && m) { ownerToken = m[1]; keep[i] = false; continue; }
    if (due) continue;
    const lower = trim(words[i]).toLowerCase();
    const [d, used] = dateAt(lower, words[i + 1] ? trim(words[i + 1]).toLowerCase() : null, words[i + 2] ? trim(words[i + 2]).toLowerCase() : null, today);
    if (!d) continue;
    due = d; dateToken = words.slice(i, i + used).join(' ');
    for (let k = i; k < i + used; k++) keep[k] = false;
    if (i > 0 && keep[i - 1] && ['due', 'by', 'on'].includes(words[i - 1].toLowerCase())) keep[i - 1] = false;
  }
  const title = words.filter((_, i) => keep[i]).join(' ').trim().replace(/[,;\-·]+$/, '').trim();
  return { title, ownerToken, due, dateToken };
}

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** The person "@ravi" means: full name without spaces, first name, first name + last initial, or the only name starting with it. */
export function resolveOwner<P extends { id: string; name: string }>(token: string, people: P[]): { person: P | null; ambiguous: boolean } {
  const t = token.trim().replace(/^@/, '').toLowerCase().replace(/[._-]/g, '');
  if (!t) return { person: null, ambiguous: false };
  const list = people.filter((p) => p.name.trim());
  const rules: ((p: P) => boolean)[] = [
    (p) => squash(p.name) === t,
    (p) => squash(p.name.split(/\s+/)[0]) === t,
    (p) => { const n = p.name.trim().split(/\s+/); return n.length > 1 && !!squash(n[n.length - 1]) && squash(n[0]) + squash(n[n.length - 1])[0] === t; },
    (p) => squash(p.name).startsWith(t),
  ];
  for (const rule of rules) {
    const hits = list.filter(rule);
    if (hits.length === 1) return { person: hits[0], ambiguous: false };
    if (hits.length > 1) return { person: null, ambiguous: true };
  }
  return { person: null, ambiguous: false };
}

/** What a sentence typed into Aura says about a meeting: "weekly sandbox sync with Mira and AutoPay team tomorrow 11:30 for 45m". */
export interface MeetingSentence {
  title: string; people: string[]; date: string | null; time: string | null; minutes: number | null;
  repeat: 'Once' | 'Daily' | 'Weekly' | 'Monthly' | null;
}

export function parseMeetingSentence(text: string, today: string): MeetingSentence {
  let rest = ` ${text.trim()} `;
  let repeat: MeetingSentence['repeat'] = null;
  const rep = /\s(every\s+day|daily|every\s+week|weekly|every\s+month|monthly)\s/i.exec(rest);
  if (rep) { const w = rep[1].toLowerCase(); repeat = /day|daily/.test(w) ? 'Daily' : /month/.test(w) ? 'Monthly' : 'Weekly'; rest = rest.replace(rep[0], ' '); }
  let minutes: number | null = null;
  const dur = /\s(?:for\s+)?(\d{1,3})\s*(m|min|mins|minutes|h|hr|hrs|hour|hours)\b/i.exec(rest);
  if (dur) { const n = Number(dur[1]); minutes = /^h/i.test(dur[2]) ? n * 60 : n; rest = rest.replace(dur[0], ' '); }
  let time: string | null = null;
  const tm = /\s(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?=\s)/i.exec(rest);
  if (tm && (tm[2] || tm[3])) {
    let h = Number(tm[1]); const mi = Number(tm[2] ?? 0);
    if (tm[3]?.toLowerCase() === 'pm' && h < 12) h += 12;
    if (tm[3]?.toLowerCase() === 'am' && h === 12) h = 0;
    if (h < 24 && mi < 60) { time = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`; rest = rest.replace(tm[0], ' '); }
  }
  let people: string[] = [];
  const withM = /\swith\s+(.+?)(?=\s(?:on|at|tomorrow|today|next|for|every|weekly|daily|monthly)\s|\s*$)/i.exec(rest);
  if (withM) {
    people = withM[1].split(/\s*(?:,|\band\b|&)\s*/i).map((s) => s.trim()).filter(Boolean);
    rest = rest.replace(withM[0], ' ');
  }
  const line = parseQuickLine(rest, today);
  const title = line.title.replace(/^(schedule|set up|book)\s+(a\s+)?/i, '').replace(/\s+(meeting)$/i, ' $1').trim();
  return { title: title ? title[0].toUpperCase() + title.slice(1) : '', people, date: line.due, time, minutes, repeat };
}
