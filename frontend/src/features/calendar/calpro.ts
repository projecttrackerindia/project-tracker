import { addDays, dateOf, iso } from './plannerModel';

/**
 * Calendar Pro helpers: the quick-create sentence ("Review with Ravi tomorrow 3pm 45m"), the visible range as an .ics file, and the
 * week's time breakdown. Pure functions, unit-tested in calpro.test.ts.
 */

export interface Quick { title: string; day: string; start: number; minutes: number; people: string[]; dayGiven: boolean; timeGiven: boolean }

const DOWS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Read a one-line event: a day (today, tomorrow, mon…sun, "next fri", "12 nov", "2026-11-12"), a time ("3pm", "15:30", "at 9"), a length ("45m", "1h", "1.5h", "for 30 min") and "with X[, Y and Z]". */
export function parseQuick(text: string, today: string, fallbackStart = 10): Quick {
  let s = ` ${text.trim()} `;
  let day = today, dayGiven = false, start = fallbackStart, timeGiven = false, minutes = 30;
  const take = (re: RegExp, fn: (m: RegExpMatchArray) => void) => { const m = s.match(re); if (m) { fn(m); s = s.replace(m[0], ' '); } };

  take(/\s(?:for\s+)?(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?)\b/i, (m) => { const n = Number(m[1]); minutes = Math.max(5, Math.round(/^h/i.test(m[2]) ? n * 60 : n)); });
  take(/\s(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i, (m) => { let h = Number(m[1]) % 12; if (/pm/i.test(m[3])) h += 12; start = h + Number(m[2] ?? 0) / 60; timeGiven = true; });
  if (!timeGiven) take(/\s(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/, (m) => { start = Number(m[1]) + Number(m[2]) / 60; timeGiven = true; });
  if (!timeGiven) take(/\sat\s+(\d{1,2})\b/i, (m) => { const h = Number(m[1]); start = h < 8 ? h + 12 : h; timeGiven = true; });
  take(/\s(today|tonight)\b/i, () => { day = today; dayGiven = true; });
  take(/\s(tomorrow|tmrw|tmr)\b/i, () => { day = addDays(today, 1); dayGiven = true; });
  take(/\s(\d{4}-\d{2}-\d{2})\b/, (m) => { day = m[1]; dayGiven = true; });
  take(/\s(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i, (m) => {
    const t = dateOf(today); let d = new Date(t.getFullYear(), MON.indexOf(m[2].toLowerCase().slice(0, 3)), Number(m[1]));
    if (iso(d) < today) d = new Date(t.getFullYear() + 1, d.getMonth(), d.getDate());
    day = iso(d); dayGiven = true;
  });
  take(/\s(next\s+)?(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*\b/i, (m) => {
    const want = DOWS.findIndex((d) => d.startsWith(m[2].toLowerCase().slice(0, 3)));
    const now = dateOf(today).getDay();
    let n = (want - now + 7) % 7; if (n === 0) n = 7;
    day = addDays(today, n); dayGiven = true;
  });
  const people: string[] = [];
  take(/\swith\s+([A-Za-z][\w.'-]*(?:\s*(?:,|and|&)\s*[A-Za-z][\w.'-]*)*)/i, (m) => { for (const p of m[1].split(/\s*(?:,|\band\b|&)\s*/i)) if (p) people.push(p); });
  const title = s.replace(/\s+/g, ' ').trim().replace(/\s+(on|at|for)$/i, '');
  return { title: title ? title[0].toUpperCase() + title.slice(1) + (people.length ? ` with ${people.join(', ')}` : '') : people.length ? `Meeting with ${people.join(', ')}` : '', day, start, minutes, people, dayGiven, timeGiven };
}

export interface IcsEvent { uid: string; title: string; start: Date; end: Date; allDay?: boolean; description?: string | null; url?: string | null }
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const esc = (t: string) => t.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
/** RFC 5545 text for the events (UTC times; all-day items as dates). */
export function toIcs(events: readonly IcsEvent[], now = new Date()): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ProjectTracker//Calendar//EN', 'CALSCALE:GREGORIAN'];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid}@projecttracker`, `DTSTAMP:${stamp(now)}`);
    if (e.allDay) { const d = iso(e.start).replace(/-/g, ''); lines.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${iso(new Date(e.start.getTime() + 86_400_000)).replace(/-/g, '')}`); }
    else lines.push(`DTSTART:${stamp(e.start)}`, `DTEND:${stamp(e.end)}`);
    lines.push(`SUMMARY:${esc(e.title)}`);
    if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`);
    if (e.url) lines.push(`URL:${e.url}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
export function downloadText(name: string, text: string, type = 'text/calendar') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A meeting that reviews work (review, retro, demo, sign-off, walkthrough): counted under "Reviews", not "Meetings". */
export const isReview = (title: string) => /\b(review|retro|retrospective|demo|sign[- ]?off|walkthrough|uat)\b/i.test(title);

export interface Breakdown { key: 'meetings' | 'projects' | 'focus' | 'reviews'; label: string; hours: number; share: number }
/** The week in four bars: meetings, project time logged, focus planned, reviews. Shares are of the largest bar (so the longest is full). */
export function breakdown(meetings: readonly { title: string; hours: number }[], loggedMin: number, focusH: number): Breakdown[] {
  const rev = meetings.filter((m) => isReview(m.title)).reduce((n, m) => n + m.hours, 0);
  const meet = meetings.reduce((n, m) => n + m.hours, 0) - rev;
  const rows = [['meetings', 'Meetings', meet], ['projects', 'Projects', loggedMin / 60], ['focus', 'Focus', focusH], ['reviews', 'Reviews', rev]] as const;
  const max = Math.max(...rows.map((r) => r[2]), 1e-9);
  return rows.map(([key, label, hours]) => ({ key, label, hours, share: hours > 0 ? Math.max(.04, hours / max) : 0 }));
}

/** Hours that overlap between spans (for conflict warnings): the keys of every span that shares time with another. */
export function conflicts(spans: readonly { key: string; start: number; end: number }[]): Set<string> {
  const out = new Set<string>();
  const s = [...spans].sort((a, b) => a.start - b.start);
  for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length && s[j].start < s[i].end - 1e-9; j++) { out.add(s[i].key); out.add(s[j].key); }
  return out;
}
