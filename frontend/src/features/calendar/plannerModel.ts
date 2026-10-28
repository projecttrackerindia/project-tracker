import type { CalendarEvent, TimeEntry } from '../../api/types';
import type { IconName } from '../../components/Icon';
import type { MeetItem } from '../meet/meetApi';

// ------------------------------------------------------------------------------------------------------------------------ dates & clock
export const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const dateOf = (s: string) => new Date(`${s}T00:00:00`);
export const addDays = (s: string, n: number) => { const d = dateOf(s); d.setDate(d.getDate() + n); return iso(d); };
export const mondayOf = (s: string) => addDays(s, -((dateOf(s).getDay() + 6) % 7));
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DOW3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const hourOf = (d: Date) => d.getHours() + d.getMinutes() / 60;
/** "9:30", "12:00": the design's 12-hour clock without AM/PM. */
export const clockH = (h: number) => { const hh = Math.floor(h + 1e-6), mm = Math.round((h - hh) * 60); return `${hh % 12 || 12}:${String(mm).padStart(2, '0')}`; };
/** "9:30 AM". */
export const clockAP = (h: number) => `${clockH(h)} ${Math.floor(h + 1e-6) >= 12 ? 'PM' : 'AM'}`;
export const fmtMins = (mins: number) => { const h = Math.floor(mins / 60), m = Math.round(mins % 60); return `${h ? `${h}h` : ''}${m ? `${h ? ' ' : ''}${m}m` : ''}` || '0m'; };
export const dayLabel = (day: string, today: string) => {
  if (day === today) return 'Today';
  if (day === addDays(today, 1)) return 'Tomorrow';
  if (day === addDays(today, -1)) return 'Yesterday';
  const d = dateOf(day); return `${DOW3[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
};

/** The grid runs 9 AM to 6 PM; an hour is 73px tall, as the design. A meeting without a known length reads as 30 min. */
export const START = 9, END = 18, HR = 73, MEETING_MIN = 30, SNAP = 0.25;

// ------------------------------------------------------------------------------------------------------------------------ blocks
export interface Meet { key: string; e: CalendarEvent; day: string; start: number; end: number; feed: MeetItem | null }
/** A focus block: time on the grid given to one open piece of your work, on or before the day it is due. */
export interface Focus { key: string; day: string; start: number; end: number; e: CalendarEvent; /** Moved by you (Move to another time). */ pinned: boolean }
/** Your changes to the suggested plan (kept on this device): a block moved, or an item taken out of the plan. */
export type PlanOverrides = Record<string, { day: string; start: number; len: number } | 'removed'>;

const OPEN_KINDS = new Set(['task', 'action', 'work']);
export const isDone = (e: CalendarEvent) => e.category === 'Done' || e.category === 'Cancelled' || e.status === 'Completed' || e.status === 'Cancelled' || e.status === 'Done';
export const isWorkItem = (e: CalendarEvent) => OPEN_KINDS.has(e.type);
export const RANK: Record<string, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };
/** A deadline worth a flag on the day header: a project, milestone or stage end, or your own high-priority work, while it is still open. */
export const isDeadline = (e: CalendarEvent) => !isDone(e) && (e.type === 'project' || e.type === 'milestone' || e.type === 'stage' || (isWorkItem(e) && (e.priority === 'High' || e.priority === 'Critical')));
export const planKey = (e: CalendarEvent) => `${e.type}:${e.id}`;

/**
 * The day plan. Each open item of yours due this week gets ONE focus block (not one a day): the first free gap of an hour or more between
 * meetings from today up to its due day, most urgent first (priority, then due date), at most two blocks a day and two hours each. Past days
 * get none (nothing was planned there), finished items drop out, and an item you moved or took out of the plan follows your choice.
 * This replaces the old rule that cycled every task title through every free gap, which painted the same "Focus · <title>" on every day of
 * the week whether or not it was still open or already past due.
 */
export function planFocus(days: string[], meets: Pick<Meet, 'day' | 'start' | 'end'>[], events: CalendarEvent[], today: string, nowH: number, overrides: PlanOverrides): Focus[] {
  const out: Focus[] = [];
  const items = events.filter((e) => isWorkItem(e) && !isDone(e) && e.date >= today)
    .sort((a, b) => (RANK[a.priority ?? ''] ?? 4) - (RANK[b.priority ?? ''] ?? 4) || a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  const busyOf = (day: string) => [...meets.filter((m) => m.day === day), ...out.filter((f) => f.day === day)].map((m) => [m.start, m.end] as const).sort((a, b) => a[0] - b[0]);
  // the ones you placed yourself go first, so the suggestions fit around them
  for (const e of items) {
    const o = overrides[planKey(e)];
    if (o && o !== 'removed' && days.includes(o.day) && o.day >= today) out.push({ key: `focus:${o.day}:${planKey(e)}`, day: o.day, start: o.start, end: o.start + o.len, e, pinned: true });
  }
  for (const e of items) {
    if (overrides[planKey(e)]) continue;
    for (const day of days) {
      if (day < today || day > e.date) continue;
      if (out.filter((f) => f.day === day && !f.pinned).length >= 2) continue;
      let cur = day === today ? Math.max(START, Math.ceil(nowH * 4) / 4) : START;
      let slot: [number, number] | null = null;
      for (const [a, b] of [...busyOf(day), [END, END] as const]) {
        if (Math.min(a, END) - cur >= 1) { slot = [cur, cur + Math.min(2, Math.min(a, END) - cur)]; break; }
        cur = Math.max(cur, b);
      }
      if (slot) { out.push({ key: `focus:${day}:${planKey(e)}`, day, start: slot[0], end: slot[1], e, pinned: false }); break; }
    }
  }
  return out;
}

/** Side-by-side lanes for blocks that overlap on one day. */
export function lanes(list: { key: string; start: number; end: number }[]) {
  const sorted = [...list].sort((a, b) => a.start - b.start || b.end - a.end);
  const out = new Map<string, { lane: number; of: number }>();
  let group: typeof list = [], groupEnd = -1, laneEnds: number[] = [];
  const flush = () => { for (const m of group) out.set(m.key, { lane: out.get(m.key)!.lane, of: laneEnds.length }); group = []; laneEnds = []; };
  for (const m of sorted) {
    if (m.start >= groupEnd && group.length) flush();
    let lane = laneEnds.findIndex((e) => e <= m.start);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(m.end); } else laneEnds[lane] = m.end;
    out.set(m.key, { lane, of: 1 }); group.push(m); groupEnd = Math.max(groupEnd, m.end);
  }
  flush();
  return out;
}

export const hrefOf = (e: CalendarEvent) => (e.type === 'meeting'
  ? `/messages?f=meetings&meeting=${e.projectId ? 'p' : 'w'}:${e.id}${e.startsAt ? `&at=${encodeURIComponent(e.startsAt)}` : ''}`
  : isWorkItem(e) ? `/work?item=${e.id}` : e.projectId ? `/work/projects/${e.projectId}` : '/work/projects');

// ------------------------------------------------------------------------------------------------------------------------ what a click opens
export interface Reminder { id: string; title: string; nextFireAt: string | null }
export type Detail =
  | { kind: 'meeting'; key: string; m: Meet }
  | { kind: 'focus'; key: string; f: Focus }
  | { kind: 'deadline'; key: string; e: CalendarEvent; others: CalendarEvent[] }
  | { kind: 'logged'; key: string; entry: TimeEntry }
  | { kind: 'loggedDay'; key: string; day: string; entries: TimeEntry[] }
  | { kind: 'reminder'; key: string; r: Reminder }
  | { kind: 'leave'; key: string; day: string; note: string | null };

/** Colour and icon of each kind of block, shared with the grid. */
export const KIND: Record<Detail['kind'], { icon: IconName; tint: string; label: string }> = {
  meeting: { icon: 'video', tint: 'var(--ed-meet)', label: 'Meeting' },
  focus: { icon: 'target', tint: 'var(--ed-focus)', label: 'Focus' },
  deadline: { icon: 'flag', tint: 'var(--ed-red)', label: 'Deadline' },
  logged: { icon: 'timer', tint: 'var(--ed-green)', label: 'Logged time' },
  loggedDay: { icon: 'timer', tint: 'var(--ed-green)', label: 'Logged time' },
  reminder: { icon: 'alarm', tint: 'var(--ed-orange)', label: 'Reminder' },
  leave: { icon: 'sun', tint: 'var(--ed-gray)', label: 'Leave' },
};

/** "in 18 min", "in 2h 5m", "now", "ended": how far a meeting is. */
export function countdown(day: string, start: number, end: number, today: string, nowH: number) {
  if (day < today || (day === today && end <= nowH)) return 'ended';
  if (day === today && start <= nowH) return 'now';
  if (day !== today) return null;
  const mins = Math.round((start - nowH) * 60);
  return mins < 60 ? `in ${mins} min` : `in ${fmtMins(mins)}`;
}
