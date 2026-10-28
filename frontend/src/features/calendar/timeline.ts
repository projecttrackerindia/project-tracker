import { insightApi } from '../../api/endpoints';
import type { CalendarEvent, Timeline, TimelineEvent, TimelineType } from '../../api/types';
import { useWsQuery } from '../../lib/hooks';
import { END, RANK, START, addDays, focusBlocks, focusForItems, hourOf, isDone, isWorkItem, mondayOf, type Focus, type Meet, type PlanOverrides } from './plannerModel';

/**
 * The one timeline. Today ("Your day", the phone's day list, My Work's focus card) and the Calendar (day, week, month) all read
 * GET /timeline through {@link useTimeline} and lay a day out with {@link buildWeek}, so the same day can never show two different stories.
 * Week views and Today ask for the same range (Monday to Sunday of the week), so they share one cached request.
 */

export type Scope = 'me' | 'user' | 'team';
export interface Range { from: string; to: string; scope?: Scope; userId?: string | null }

/** Monday to Sunday of the week a day is in: the range every week view and Today ask for. */
export const weekRange = (day: string): Range => { const m = mondayOf(day); return { from: m, to: addDays(m, 6) }; };
/** Monday to Friday: the days a plan is made for. */
export const workWeek = (day: string) => { const m = mondayOf(day); return Array.from({ length: 5 }, (_, i) => addDays(m, i)); };

/** The query key family every mutation that changes a day invalidates ('timeline'). */
export const timelineKey = (r: Range) => ['timeline', r.from, r.to, r.scope ?? 'me', r.userId ?? ''] as const;

/** An older server (or a test double) may answer without events: read that as an empty day, never a crash. */
const normalise = (d: Timeline): Timeline => (d && Array.isArray(d.events) ? d : { ...(d ?? {}), events: [] } as Timeline);

export function useTimeline(r: Range, opts: { enabled?: boolean } = {}) {
  return useWsQuery<Timeline>([...timelineKey(r)], () => insightApi.timeline(r.from, r.to, r.scope ?? 'me', r.userId ?? undefined),
    { staleTime: 60_000, retry: false, placeholderData: (p) => p, enabled: opts.enabled ?? true, select: normalise });
}

// ------------------------------------------------------------------------------------------------------------------------ helpers
export const hoursOf = (t: TimelineEvent) => {
  const s = hourOf(new Date(t.start));
  const e = t.end ? s + (Date.parse(t.end) - Date.parse(t.start)) / 3.6e6 : s;
  return { start: s, end: Math.max(s, e) };
};

/** A meeting or open item as the planner's older shape (the detail card and the deadline flags read it). */
export function toCalendarEvent(t: TimelineEvent): CalendarEvent {
  if (t.type === 'meeting') {
    return { type: 'meeting', id: t.sourceId, key: null, title: t.title, date: t.date, status: t.status, category: null, overdue: false, projectId: t.projectId,
      projectName: t.projectName, priority: null, startsAt: t.start, durationMinutes: t.end ? Math.round((Date.parse(t.end) - Date.parse(t.start)) / 60_000) : null,
      notes: t.notes, joinUrl: t.joinUrl, people: t.people };
  }
  return { type: t.sourceType as CalendarEvent['type'], id: t.sourceId, key: t.key, title: t.title, date: t.date, status: t.status, category: null, overdue: t.overdue,
    projectId: t.projectId, projectName: t.projectName, priority: t.priority };
}

/** What a focus block is called everywhere: "Focus · INFRA-4 Patch the gateway". Never a generic "Deep work". */
export const focusLabel = (e: CalendarEvent) => `${e.key ? `${e.key} ` : ''}${e.title}`;

// ------------------------------------------------------------------------------------------------------------------------ one week, laid out
export interface DayView {
  day: string;
  meets: Meet[];
  calls: TimelineEvent[];
  time: TimelineEvent[];
  done: TimelineEvent[];
  due: CalendarEvent[];
  reminders: TimelineEvent[];
  attendance: TimelineEvent[];
  off: TimelineEvent[];
  focus: Focus[];
  /** Minutes logged on the day (every entry, timer or typed in). */
  loggedMin: number;
  /** Free minutes left in the working day (9 to 6) from now on: not in a meeting, a call or a focus block. 0 for a past day. */
  freeMin: number;
}
export interface WeekView { days: DayView[]; byDay: Map<string, DayView>; focus: Focus[]; events: TimelineEvent[] }

const FOCUS_PER_DAY = 2, FOCUS_MAX_H = 1.5;
const byStart = (a: TimelineEvent, b: TimelineEvent) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id);

/**
 * The day plan, from the timeline's own open items. Each open item due this week (or already overdue) gets ONE focus block: going day by day from
 * today, the most urgent items first (priority, then due date), the first free gap of an hour or more between meetings and calls, on or before
 * its due day (an overdue item only today), at most two a day and 90 minutes each, never before now and never on a day off. Blocks you moved or
 * removed (kept on this device) follow your choice. Built on the shared focusForItems rule.
 */
export function planWeekFocus(days: string[], busyOf: (day: string) => (readonly [number, number])[], items: CalendarEvent[], today: string, nowH: number, overrides: PlanOverrides): Focus[] {
  const open = items.filter((e) => isWorkItem(e) && !isDone(e))
    .sort((a, b) => (RANK[a.priority ?? ''] ?? 4) - (RANK[b.priority ?? ''] ?? 4) || a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  const key = (e: CalendarEvent) => `${e.type}:${e.id}`;
  const out: Focus[] = [];
  for (const e of open) {
    const o = overrides[key(e)];
    if (o && o !== 'removed' && days.includes(o.day) && o.day >= today) out.push({ key: `focus:${o.day}:${key(e)}`, day: o.day, start: o.start, end: o.start + o.len, e, pinned: true });
  }
  let left = open.filter((e) => !overrides[key(e)]);
  for (const day of days) {
    if (day < today || !left.length) continue;
    const from = day === today ? Math.max(START, Math.ceil(nowH * 4) / 4) : START;
    if (from >= END) continue;
    const pinned = out.filter((f) => f.day === day).map((f) => [f.start, f.end] as const);
    const fits = left.filter((e) => e.date >= day || (e.date < today && day === today));
    const plan = focusForItems(fits.map((e) => ({ item: e, window: null })), [...busyOf(day), ...pinned], from, END, { max: FOCUS_PER_DAY, maxLen: FOCUS_MAX_H, minGap: 1 });
    for (const b of plan.blocks) out.push({ key: `focus:${day}:${key(b.item)}`, day, start: b.start, end: b.end, e: b.item, pinned: false });
    const placed = new Set(plan.blocks.map((b) => key(b.item)));
    left = left.filter((e) => !placed.has(key(e)));
  }
  return out;
}

/**
 * Lay out the days of a timeline. `days` are the days to show (one for Today or the day view, Monday to Friday for the week); the plan is always
 * made for the whole working week of `today` (or of the first day shown) so a day shows the same focus blocks whichever screen draws it.
 */
export function buildWeek(events: readonly TimelineEvent[], days: string[], today: string, nowH: number, overrides: PlanOverrides): WeekView {
  // The working week of the days shown, and today when it falls in that week (a Saturday you work still gets its plan).
  const ww = workWeek(days[0] ?? today);
  const planDays = mondayOf(today) === ww[0] && !ww.includes(today) ? [...ww, today] : ww;
  const off = new Set(events.filter((t) => t.type === 'leave' || t.type === 'holiday').map((t) => t.date));
  const of = (type: TimelineType, day: string) => events.filter((t) => t.type === type && t.date === day).sort(byStart);
  const meetsOf = (day: string): Meet[] => of('meeting', day).map((t) => {
    const h = hoursOf(t);
    return { key: `${t.sourceId}|${t.start}`, e: toCalendarEvent(t), day, start: h.start, end: Math.max(h.end, h.start + .25), feed: null };
  });
  const busyOf = (day: string) => [...meetsOf(day).map((m) => [m.start, m.end] as const), ...of('call', day).map((t) => { const h = hoursOf(t); return [h.start, h.end] as const; })];
  const items = events.filter((t) => t.type === 'due').map(toCalendarEvent);
  const focus = planWeekFocus(planDays.filter((d) => !off.has(d)), busyOf, items, today, nowH, overrides);
  const list = days.map((day): DayView => {
    const f = focus.filter((x) => x.day === day);
    const from = day === today ? Math.max(START, Math.ceil(nowH * 4) / 4) : START;
    const freeMin = day < today || from >= END || off.has(day) ? 0 : focusBlocks([...busyOf(day), ...f.map((x) => [x.start, x.end] as const)], from, END, { max: 0 }).free;
    const time = of('time', day);
    return {
      day, meets: meetsOf(day), calls: of('call', day), time, done: of('done', day), due: items.filter((e) => e.date === day),
      reminders: of('reminder', day), attendance: of('attendance', day), off: events.filter((t) => (t.type === 'leave' || t.type === 'holiday') && t.date === day),
      focus: f, loggedMin: time.reduce((n, t) => n + (t.minutes ?? 0), 0), freeMin,
    };
  });
  return { days: list, byDay: new Map(list.map((d) => [d.day, d])), focus, events: [...events] };
}

/** The numbers on a day's header (Today's "Your day" and the Calendar's day summary use the same ones). */
export function dayCounts(d: DayView) {
  return { meetings: d.meets.length, calls: d.calls.length, focus: d.focus.length, free: d.freeMin, logged: d.loggedMin, done: d.done.length };
}

/** The identity of everything a day shows, for the "Today and Calendar agree" check (data-sig on both screens). */
export const daySignature = (d: DayView) => [
  ...d.meets.map((m) => `meeting:${m.key}`), ...d.calls.map((t) => t.id), ...d.time.map((t) => t.id), ...d.done.map((t) => t.id),
  ...d.reminders.map((t) => t.id), ...d.focus.map((f) => `${f.key}@${f.start}-${f.end}`),
].sort().join(',');

// ------------------------------------------------------------------------------------------------------------------------ your plan changes
/** Your changes to the suggested plan live on this device (there is no shared day plan on the server); Today and the Calendar read the same. */
const planStore = (wid: string | null) => `pt.calendar.plan.${wid ?? 'none'}`;
export function readPlan(wid: string | null): PlanOverrides { try { return JSON.parse(localStorage.getItem(planStore(wid)) ?? '{}') as PlanOverrides; } catch { return {}; } }
export function writePlan(wid: string | null, p: PlanOverrides) { try { localStorage.setItem(planStore(wid), JSON.stringify(p)); } catch { /* private window: the change lasts for this visit */ } }

/** Where a timeline event opens. */
export const linkOf = (t: TimelineEvent) => t.link ?? (t.type === 'reminder' ? '/?tab=reminders' : t.type === 'time' ? '/insights?tab=time' : '/?tab=calendar');
