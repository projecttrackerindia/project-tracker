import type { GridKind, GridRow, TimesheetGrid } from '../../api/types';
import { DOW } from '../../lib/format';

/**
 * What a timesheet cell accepts: "1.5" or "1,5" (hours), "1:30", "90m", "1h 30m", "2h". A bare number is hours, as on paper timesheets;
 * an empty cell or "0" is nothing. Returns null when it cannot be understood.
 */
export function parseCell(text: string): number | null {
  const t = text.trim().toLowerCase().replace(',', '.');
  if (!t || t === '-' || t === '–') return 0;
  let m = /^(\d{1,2}):([0-5]\d)$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(\d+(?:\.\d+)?)$/.exec(t);
  if (m) return Math.round(Number(m[1]) * 60);
  m = /^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?$/.exec(t);
  if (m && (m[1] || m[2])) return Math.round(Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0));
  return null;
}

/** 90 → "1:30", 0 → "". The compact form a grid cell shows. */
export const hm = (min: number) => (min > 0 ? `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}` : '');

/** 90 → "1.5" for exports. */
export const hoursDecimal = (min: number) => (Math.round((min / 60) * 100) / 100).toString();

export const cellKey = (kind: GridKind, targetId: string, date: string) => `${kind}:${targetId}:${date}`;
export const rowKey = (r: { kind: GridKind; targetId: string }) => `${r.kind}:${r.targetId}`;

export const dayName = (iso: string) => DOW[new Date(`${iso}T00:00:00`).getDay()];
export const dayNum = (iso: string) => new Date(`${iso}T00:00:00`).getDate();

/** How a day's logged time compares with the person's normal day. */
export function dayState(minutes: number, target: number): 'none' | 'under' | 'met' | 'over' {
  if (target === 0) return minutes > 0 ? 'over' : 'none';
  if (minutes === 0) return 'none';
  if (minutes < target * 0.95) return 'under';
  return minutes > target + 15 ? 'over' : 'met';
}

/** The week as CSV: one row per task or piece of work, hours per day, then the totals. */
export function gridCsv(grid: TimesheetGrid, rows: GridRow[]): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const head = ['Key', 'Title', 'Project', 'Billable', ...grid.days.map((d) => `${dayName(d.date)} ${d.date}`), 'Total (h)'];
  const lines = [head.map(esc).join(',')];
  for (const r of rows) lines.push([r.key, r.title, r.projectName ?? (r.kind === 'work' ? 'Operational work' : ''), r.billable ? 'yes' : 'no',
    ...r.cells.map((c) => (c.minutes ? hoursDecimal(c.minutes) : '')), hoursDecimal(r.totalMinutes)].map(esc).join(','));
  lines.push(['', 'Total', '', '', ...grid.days.map((d) => hoursDecimal(d.minutes)), hoursDecimal(grid.totalMinutes)].map(esc).join(','));
  return lines.join('\n');
}

export function downloadText(name: string, text: string, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob(['\uFEFF' + text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Quick add: "2h ATL-12 yesterday", "45m WT-3 mon standup", "1:30 on ATL-7 2026-10-14". Finds a duration, a work item key, and a day
 * (today, yesterday, a weekday of this week, or a date); whatever is left is the note.
 */
export function parseQuickAdd(text: string, week: string[], today: string): { minutes: number; key: string; date: string; note: string } | { error: string } {
  let rest = ` ${text.trim()} `;
  const take = (re: RegExp) => { const m = re.exec(rest); if (m) rest = rest.replace(m[0], ' '); return m; };
  const key = take(/\s([A-Za-z][A-Za-z0-9]*-\d+)\s/);
  if (!key) return { error: 'Add the work item key, like ATL-12 or WT-3.' };
  const dur = take(/\s(\d{1,2}:[0-5]\d|\d+(?:[.,]\d+)?\s*h(?:ours?|rs?)?(?:\s*\d+\s*m(?:in(?:ute)?s?)?)?|\d+\s*m(?:in(?:ute)?s?)?|\d+(?:[.,]\d+)?)\s/i);
  const minutes = dur ? parseCell(dur[1].replace(/\s+/g, ' ')) : null;
  if (!minutes) return { error: 'Add how long, like 2h, 45m or 1:30.' };
  let date = today;
  const word = take(/\s(today|yesterday|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|\d{4}-\d{2}-\d{2})\s/i);
  if (word) {
    const w = word[1].toLowerCase();
    if (w === 'yesterday') { const d = new Date(`${today}T00:00:00`); d.setDate(d.getDate() - 1); date = localIso(d); }
    else if (/^\d{4}-/.test(w)) date = w;
    else if (w !== 'today') { const i = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].findIndex((p) => w.startsWith(p)); if (i >= 0) date = week[i]; }
  }
  if (!week.includes(date)) return { error: 'That day is not in the week on screen.' };
  if (date > today) return { error: 'Time cannot be logged for a day that has not happened yet.' };
  const note = rest.replace(/^\s*on\s+/i, ' ').replace(/\s+on\s*$/i, ' ').replace(/\s+/g, ' ').trim();
  return { minutes, key: key[1].toUpperCase(), date, note };
}

const localIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

