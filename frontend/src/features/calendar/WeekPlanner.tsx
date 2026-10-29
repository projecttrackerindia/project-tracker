import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { timeApi } from '../../api/endpoints';
import type { CalendarEvent, TimelineEvent } from '../../api/types';
import { Icon } from '../../components/Icon';
import { ErrorState, Segmented } from '../../components/ui';
import { todayISO } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { ToolbarSlot } from '../talk/ToolbarSlot';
import { undoToast } from '../talk/flyTask';
import { CalendarView } from './CalendarView';
import { EventDetail, type DetailActions } from './EventDetail';
import { DayPanel } from './DayPanel';
import { canMoveDue, editError, moveDue, overlapText, refreshAfterEdit } from './calendarEdit';
import { useClearOnRefresh, useDayEdit } from './useDayEdit';
import type { WorkChoice } from './TimeEntryEditor';
import { AttendanceRow } from '../attendance/AttendanceCalendar';
import {
  DOW3, HR, MONTHS, SNAP, addDays, clockH, dateOf, dayLabel, fmtMins, hourOf, isDeadline, isDone, isWorkItem, iso, mondayOf, planKey, RANK,
  type Detail, type Focus, type Meet, type PlanOverrides,
} from './plannerModel';
import { useTodaySignals } from '../home/Signals';
import { Term } from '../../components/Term';
import { buildWeek, daySignature, focusLabel, hoursOf, loggedMinutesOf, readPlan, stickFocus, useTimeline, weekRange, writePlan, type DayView } from './timeline';
import { dayMarks, type DayMark } from './deadline';
import { packColumns, packStyle, type Packed } from './pack';
import { clock24 } from '../work/dueTime';
import './planner.css';
import { ZoneBadge } from '../../components/ZoneBadge';

/** ISO week number. */
const weekNo = (s: string) => { const d = dateOf(s); d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7)); const w1 = new Date(d.getFullYear(), 0, 4); return 1 + Math.round(((d.getTime() - w1.getTime()) / 864e5 - 3 + ((w1.getDay() + 6) % 7)) / 7); };

/** Project colours in the order the filter lists them (the design: indigo, orange, teal …); meetings without a project are green. */
const TINTS = ['i', 'o', 't', 'p', 'b', 'r'] as const;
const DOT: Record<string, string> = { i: '#5856d6', o: '#ff9500', t: '#30b0c7', p: '#af52de', b: '#0071e3', r: '#ff2d55', g: '#28cd41' };

/** The grid shows the whole day (midnight to midnight) and scrolls to the first thing on it, or 8 AM. */
const G0 = 0, G1 = 24, FIRST_HOUR = 8;
const hourLabel = (h: number) => (h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`);

type View = 'day' | 'week' | 'month';
type Layer = 'meetings' | 'calls' | 'logged' | 'done' | 'focus' | 'deadlines' | 'reminders';
const LAYERS: [Layer, string][] = [['meetings', 'Meetings'], ['calls', 'Calls'], ['logged', 'Logged time'], ['done', 'Done'], ['focus', 'Focus'], ['deadlines', 'Deadlines'], ['reminders', 'Reminders']];

// ------------------------------------------------------------------------------------------------------------------------ page
/**
 * Calendar (the sidebar's Calendar): the mini month, layer and project filters and the ✦ week line on the left; the whole day with meetings
 * and calls at their real lengths, time logged as quiet green bars, finished work as check pills at the minute it was finished, focus blocks
 * from your day plan, deadline flags and logged totals on the day headers, reminder rings and the now line; the selected meeting on the right.
 * Everything comes from the one timeline (GET /timeline) that Today reads too. Any block opens a card that says what it is and what can be
 * done with it. Enter opens, Esc closes, the arrow keys walk the blocks. A meeting you organise can be dragged to a new time, with Undo.
 */
type DragKind = 'meeting' | 'time' | 'focus' | 'reminder';
type DragMode = 'move' | 'top' | 'bottom';
/** Anything on the grid that can be dragged: its kind, its block key, where it is now, and whether its edges resize it. */
interface DragItem { kind: DragKind; key: string; day: string; start: number; end: number; resizable: boolean; /** Drawn on another day while dragged there. */ label: string; cls: string }
interface DragState { item: DragItem; mode: DragMode; day: string; start: number; end: number }
const snapH = (h: number) => Math.round(h / SNAP) * SNAP;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const spanText = (day: string, a: number, b: number) => `${DOW3[dateOf(day).getDay()]} ${clockH(a)}–${clockH(b)}`;

/** Whether the Day panel sits beside the grid (then a block's card opens inside it instead of as a popover). */
function useWide() {
  const q = '(min-width: 1440px)';
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(q).matches);
  useEffect(() => {
    if (!window.matchMedia) return;
    const m = window.matchMedia(q); const on = () => setWide(m.matches);
    m.addEventListener?.('change', on); return () => m.removeEventListener?.('change', on);
  }, []);
  return wide;
}

/** The day a detail belongs to (selecting a block selects its day in the Day panel). */
const dayOfDetail = (d: Detail): string | null => {
  switch (d.kind) {
    case 'meeting': return d.m.day;
    case 'focus': return d.f.day;
    case 'deadline': return d.e.date;
    case 'time': case 'done': case 'call': case 'reminder': return d.t.date;
    case 'loggedDay': case 'leave': case 'create': return d.day;
  }
};

/**
 * Calendar (the sidebar's Calendar): the mini month, layer and project filters and the ✦ week line on the left; the whole day with meetings
 * and calls at their real lengths, time logged as quiet green bars, finished work as check pills at the minute it was finished, focus blocks
 * from your day plan, deadline flags and logged totals on the day headers, reminder rings and the now line; the Day panel on the right.
 * Everything comes from the one timeline (GET /timeline) that Today reads too, and every edit writes the real record:
 * drag a time entry, a focus block, a reminder or a meeting you organise to move it (its edges resize it, 15-minute steps), drag a deadline flag
 * to another day to move the due date (a later date asks why), drag over empty time to log time, plan focus or schedule a meeting.
 * Enter opens, Esc closes, the arrow keys walk the blocks, Alt+↑/↓ moves the focused block a quarter hour.
 */
export function WeekPlanner({ onTab, extra }: { onTab?: (t: 'for-you' | 'calendar') => void; /** Under the ✦ line (Subscribe in Google / Outlook). */ extra?: ReactNode }) {
  const navigate = useNavigate();
  const wid = useWorkspaceId();
  const today = todayISO();
  const wide = useWide();
  const [view, setView] = useState<View>(() => (typeof window !== 'undefined' && window.innerWidth < 760 ? 'day' : 'week'));
  const [anchor, setAnchor] = useState(today);
  const [mini, setMini] = useState(() => { const d = dateOf(today); return { y: d.getFullYear(), m: d.getMonth() }; });
  const [layers, setLayers] = useState<Record<Layer, boolean>>({ meetings: true, calls: true, logged: true, done: true, focus: true, deadlines: true, reminders: true });
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<PlanOverrides>(() => readPlan(wid));
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<{ d: Detail; el: HTMLElement | null } | null>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = window.setInterval(() => setNow(new Date()), 60_000); return () => window.clearInterval(t); }, []);
  useEffect(() => { setPlan(readPlan(wid)); }, [wid]);
  const nowH = hourOf(now);
  /** The plan only needs to move when the quarter hour does. */
  const nowQ = Math.ceil(nowH * 4) / 4;

  const monday = mondayOf(anchor);
  const sunday = addDays(monday, 6);
  const week = useMemo(() => Array.from({ length: 5 }, (_, i) => addDays(monday, i)), [monday]);
  const days = useMemo(() => (view === 'day' ? [anchor] : week), [view, anchor, week]);
  // The Day panel's day: today when it is on screen, else the first day shown; a click on a day header or empty time chooses another.
  const [selDay, setSelDay] = useState(today);
  useEffect(() => { setSelDay(view === 'day' ? anchor : week.includes(today) ? today : week[0]); }, [monday, view, anchor, week, today]);

  // One request for the visible week (the same one Today makes for this week), the meeting feed for what only Meet knows (who may move it),
  // my own entries as the timesheet has them (locks, stamps) and the week grid (the day's capacity, the work I log time on).
  const tl = useTimeline(weekRange(anchor), { enabled: view !== 'month' });
  const grid = useWsQuery(['time', 'grid', monday], () => timeApi.grid(monday), { staleTime: 60_000, retry: false, enabled: view !== 'month', placeholderData: (p) => p });
  const savePlan = (p: PlanOverrides) => { setPlan(p); writePlan(wid, p); };
  const focusRef = useRef<readonly Focus[]>([]);
  const gridRef = useRef<HTMLDivElement>(null);
  // The edits a day takes, shared with Today's "Your day" (the same rules, the same writes, the same refresh).
  const ed = useDayEdit({ from: monday, to: sunday, enabled: view !== 'month', today, nowH, plan, savePlan, anchor: () => gridRef.current, focus: () => focusRef.current,
    onAdjust: (id) => { const el = gridRef.current?.querySelector<HTMLElement>(`[data-type="time"][data-id="${CSS.escape(id)}"]`); el?.click(); } });
  const { entries, canMove, timeWhy, apply: applyEdits, withFeed } = ed;
  useClearOnRefresh(tl.dataUpdatedAt, ed.clearOver);
  const raw = useMemo(() => applyEdits((tl.data?.events ?? []).filter((t) => !(t.type === 'due' && doneIds.has(t.sourceId)))), [tl.data, doneIds, applyEdits]);
  const projects = useMemo(() => [...new Set(raw.map((e) => e.projectName).filter((n): n is string => !!n))].slice(0, 6), [raw]);
  const tintOf = useCallback((name: string | null) => (name && projects.includes(name) ? TINTS[projects.indexOf(name) % TINTS.length] : 'g'), [projects]);
  const timeline = useMemo(() => raw.filter((t) => !t.projectName || !hidden.has(t.projectName)), [raw, hidden]);
  const wv = useMemo(() => buildWeek(timeline, week, today, nowQ, plan, nowH), [timeline, week, today, nowQ, plan, nowH]);
  const openItems = useMemo(() => wv.days.flatMap((d) => d.due).filter((e) => isWorkItem(e) && !isDone(e)), [wv]);
  const choices = useMemo<WorkChoice[]>(() => {
    const out = new Map<string, WorkChoice>();
    for (const r of [...(Array.isArray(grid.data?.rows) ? grid.data!.rows : []), ...(Array.isArray(grid.data?.suggestions) ? grid.data!.suggestions : [])]) out.set(`${r.kind}:${r.targetId}`, { kind: r.kind as 'task' | 'work', id: r.targetId, key: r.key, title: r.title, projectName: r.projectName });
    for (const e of openItems) if (e.type === 'task' || e.type === 'work') out.set(`${e.type}:${e.id}`, out.get(`${e.type}:${e.id}`) ?? { kind: e.type, id: e.id, key: e.key ?? null, title: e.title, projectName: e.projectName });
    return [...out.values()];
  }, [grid.data, openItems]);
  const peopleById = useMemo(() => new Map(raw.map((t) => [t.sourceId, t.people])), [raw]);

  const meets: Meet[] = useMemo(() => withFeed(wv.days.flatMap((d) => d.meets)), [wv, withFeed]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const focus = useMemo(() => (layers.focus ? wv.focus.filter((f) => days.includes(f.day)) : []), [layers.focus, wv, days]);
  focusRef.current = focus;

  // The same rule as Today: a suggested block that has started stays where it is for the rest of the day.
  useEffect(() => {
    const next = stickFocus(wv.focus, plan, today, nowH);
    if (next) { setPlan(next); writePlan(wid, next); }
  }, [wv, plan, today, nowH, wid]);
  const { reschedule, moveTime, moveRem, moveFocusTo } = ed;
  // A deadline flag dropped on another day: the due date moves (a task moved later asks why first, the same rule as its form).
  const [dueAsk, setDueAsk] = useState<{ e: CalendarEvent; date: string } | null>(null);
  const shiftDue = async (e: CalendarEvent, date: string, reason: string, undo = false) => {
    const from = e.date;
    const ids = raw.filter((t) => t.type === 'due' && t.sourceId === e.id).map((t) => t.id);
    ed.patch(Object.fromEntries(ids.map((id) => [id, { date, overdue: date < today }])));
    try {
      await moveDue(e, date, reason);
      refreshAfterEdit(wid);
      if (undo) { toast('Moved back.', 'info'); return; }
      const back = () => (from > date ? setDueAsk({ e: { ...e, date }, date: from }) : void shiftDue({ ...e, date }, from, '', true));
      undoToast(`${e.key ?? e.title} now due ${dayLabel(date, today).toLowerCase()}`, back, gridRef.current, 46);
    } catch (err) {
      ed.unpatch(ids);
      toast(editError(err, 'The due date could not be moved.'), 'error');
    }
  };
  const dropDue = (e: CalendarEvent, date: string) => {
    if (date === e.date) return;
    if (!canMoveDue(e)) { toast(`${KIND_WORD[e.type] ?? 'This'} dates move from the ${e.type === 'action' ? 'project’s follow-ups' : 'project'}.`, 'error'); return; }
    if (date > e.date && e.type === 'task') setDueAsk({ e, date }); else void shiftDue(e, date, '');
  };

  // ---- dragging: a block (move), its top or bottom edge (resize), a deadline flag (to another day header), or empty time (create)
  const [drag, setDrag] = useState<DragState | null>(null);
  const justDragged = useRef(false);
  const afterDrag = () => { justDragged.current = true; window.setTimeout(() => { justDragged.current = false; }, 0); };
  const commit = (it: DragItem, day: string, start: number, end: number) => {
    if (it.kind === 'meeting') { const m = meets.find((x) => x.key === it.key); if (m) void reschedule(m, day, start, end - start); }
    else if (it.kind === 'time') { const t = raw.find((x) => `time:${x.date}:${x.id}` === it.key); if (t) void moveTime(t, day, start, end); }
    else if (it.kind === 'focus') { const f = wv.focus.find((x) => x.key === it.key); if (f) moveFocusTo(f, day, start, end - start); }
    else if (it.kind === 'reminder') { const t = raw.find((x) => `reminder:${x.date}:${x.id}` === it.key); if (t) void moveRem(t, day, start); }
  };
  const live = useRef({ down: (_e: ReactPointerEvent, _it: DragItem, _mode: DragMode) => {}, open: (_d: Detail, _el: HTMLElement) => {}, alt: (_it: DragItem, _up: boolean) => {},
    create: (_e: ReactPointerEvent, _day: string) => {}, flag: (_e: ReactPointerEvent, _f: CalendarEvent) => {} });
  live.current.down = (ev, it, mode) => {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    const col = gridRef.current?.querySelector<HTMLElement>('.wp-col');
    const g = { x: ev.clientX, y: ev.clientY, colW: col?.getBoundingClientRect().width ?? 140, dayIdx: days.indexOf(it.day) };
    let cur: DragState | null = null;
    const move = (e: PointerEvent) => {
      const dx = e.clientX - g.x, dy = e.clientY - g.y;
      if (!cur && Math.hypot(dx, dy) < 5) return;
      const len = it.end - it.start;
      let day = it.day, start = it.start, end = it.end;
      if (mode === 'move') {
        start = clamp(snapH(it.start + dy / HR), G0, G1 - len); end = start + len;
        day = days[clamp(g.dayIdx + Math.round(dx / g.colW), 0, days.length - 1)];
      } else if (mode === 'top') start = clamp(snapH(it.start + dy / HR), G0, it.end - SNAP);
      else end = clamp(snapH(it.end + dy / HR), it.start + SNAP, G1);
      if (!cur || cur.day !== day || cur.start !== start || cur.end !== end) { cur = { item: it, mode, day, start, end }; setDrag(cur); }
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel);
      const d = cur; setDrag(null);
      if (!d) return;
      afterDrag();
      if (d.day !== it.day || Math.abs(d.start - it.start) > 1e-6 || Math.abs(d.end - it.end) > 1e-6) commit(it, d.day, d.start, d.end);
    };
    const cancel = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); setDrag(null); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel);
  };
  live.current.alt = (it, upKey) => {
    const d = upKey ? -SNAP : SNAP;
    const len = it.end - it.start;
    const start = clamp(it.start + d, G0, G1 - len);
    commit(it, it.day, start, start + len);
  };
  live.current.open = (d, el) => {
    if (justDragged.current) return;
    const day = dayOfDetail(d);
    if (day && days.includes(day)) setSelDay(day);
    setOpen((o) => (o?.d.key === d.key ? null : { d, el }));
  };
  // Empty time: a click chooses the day for the Day panel; a drag picks a span to log time, plan focus or schedule a meeting in.
  const [pick, setPick] = useState<{ day: string; a: number; b: number } | null>(null);
  live.current.create = (ev, day) => {
    if (ev.button !== 0 || ev.target !== ev.currentTarget) return;
    const colTop = (ev.currentTarget as HTMLElement).getBoundingClientRect().top;
    const hAt = (y: number) => clamp(G0 + (y - colTop) / HR, G0, G1);
    const a = Math.floor(hAt(ev.clientY) / SNAP) * SNAP;
    let b = a, dragged = false;
    const move = (e: PointerEvent) => {
      const h = hAt(e.clientY);
      const nb = h >= a ? Math.ceil(h / SNAP) * SNAP : Math.floor(h / SNAP) * SNAP;
      if (!dragged && Math.abs(e.clientY - ev.clientY) < 6) return;
      dragged = true;
      if (nb !== b) { b = nb; setPick({ day, a, b }); }
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (!dragged || Math.abs(b - a) < SNAP) { setPick(null); setSelDay(day); return; }
      const s0 = Math.min(a, b), e0 = Math.max(a, b);
      setPick({ day, a: s0, b: e0 });
      setSelDay(day);
      setOpen({ d: { kind: 'create', key: `create:${day}:${s0}-${e0}`, day, start: s0, end: e0 }, el: null });
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const [flagOver, setFlagOver] = useState<string | null>(null);
  live.current.flag = (ev, f) => {
    if (ev.button !== 0) return;
    const x0 = ev.clientX, y0 = ev.clientY;
    let target: string | null = null, dragged = false;
    const move = (e: PointerEvent) => {
      if (!dragged && Math.hypot(e.clientX - x0, e.clientY - y0) < 6) return;
      dragged = true;
      const hd = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('.wp-dh[data-day], .wp-col[data-day], .wp-allday-d[data-day]');
      target = hd?.dataset.day ?? null; setFlagOver(target);
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      setFlagOver(null);
      if (!dragged) return;
      afterDrag();
      if (target) dropDue(f, target);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const handlers = useMemo<ColHandlers>(() => ({
    down: (e, it, mode) => live.current.down(e, it, mode), open: (d, el) => live.current.open(d, el), alt: (it, up) => live.current.alt(it, up),
    create: (e, day) => live.current.create(e, day),
  }), []);
  const closeDetail = useCallback(() => { setOpen(null); setPick(null); }, []);
  const openKey = open?.d.key ?? null;

  const actions: DetailActions = {
    moveFocus: (f, day, start) => moveFocusTo(f, day, start, f.end - f.start),
    removeFocus: ed.removeFocus,
    done: (e) => setDoneIds((s) => new Set(s).add(e.id)),
    moveMeeting: (m, day, start) => { const x = meets.find((y) => y.key === m.key) ?? m; void reschedule(x, day, start, x.end - x.start); },
    canMoveMeeting: canMove,
    entryOf: (id) => entries.get(id),
    overlapsOf: (t) => wv.byDay.get(t.date)?.overlaps.get(t.id) ?? [],
    fixOverlap: ed.fixOverlap,
    choices,
    openItems,
    planFocus: (e, day, start, end) => {
      savePlan({ ...plan, [planKey(e)]: { day, start, len: end - start } });
      toast(`Focus on ${focusLabel(e)} planned · ${spanText(day, start, end)}`, 'success');
    },
  };
  // ---- the blocks of each day, laid out once per data change (not per render)
  const cols = useMemo(() => days.map((d) => {
    const dv: DayView | undefined = wv.byDay.get(d) ?? buildWeek(timeline, [d], today, nowQ, plan, nowH).byDay.get(d);
    const ms = meets.filter((m) => layers.meetings && m.day === d);
    const calls = layers.calls ? dv?.calls ?? [] : [];
    const fs = focus.filter((f) => f.day === d);
    const done = layers.done ? dv?.done ?? [] : [];
    const reminders = layers.reminders ? dv?.reminders ?? [] : [];
    const logged = layers.logged ? dv?.time ?? [] : [];
    // Every timed thing of the day shares the column through the one packing engine (pack.ts): overlapping items split the width into
    // columns and widen into free ones, so no block, logged entry, reminder or check ever covers another's text.
    const spans = [
      ...ms.map((m) => ({ key: m.key, start: m.start, end: m.end })),
      ...calls.map((c) => { const h = hoursOf(c); return { key: c.id, start: h.start, end: Math.max(h.end, h.start + .25) }; }),
      ...fs.map((f) => ({ key: f.key, start: f.start, end: f.end })),
      ...logged.map((t) => { const h = hoursOf(t); return { key: `time:${d}:${t.id}`, start: h.start, end: Math.max(h.end, h.start + .25) }; }),
      ...reminders.map((t) => { const h = hoursOf(t).start; return { key: `reminder:${d}:${t.id}`, start: h, end: h + PILL_H }; }),
      ...done.map((t) => { const h = hoursOf(t).start; return { key: `done:${d}:${t.id}`, start: h, end: h + PILL_H }; }),
    ];
    // Deadlines with a time (a due time, or an open ticket's SLA breach): a chip in the day's due strip, a thin line at its hour.
    const marks = layers.deadlines ? dayMarks(d, dv?.due ?? [], now.getTime()) : [];
    return { d, meets: ms, calls, pack: packColumns(spans, PILL_H), focus: fs, logged, done, reminders, marks, overlaps: dv?.overlaps ?? new Map() };
  }), [days, wv, timeline, today, nowQ, nowH, plan, meets, layers, focus, now]);
  // ---- each day's due strip: the flagged deadlines (overdue first) and every deadline with a time, at most three chips and "+N"
  const strips = useMemo(() => cols.map((c) => {
    const dv = wv.byDay.get(c.d);
    const flagged = (dv?.due ?? []).filter((e) => !isDone(e) && (isDeadline(e) || e.overdue))
      .sort((a, b) => Number(b.overdue) - Number(a.overdue) || ['project', 'milestone', 'stage'].indexOf(b.type) - ['project', 'milestone', 'stage'].indexOf(a.type) || (RANK[a.priority ?? ''] ?? 4) - (RANK[b.priority ?? ''] ?? 4));
    const timed = new Map(c.marks.map((m) => [`${m.e.type}:${m.e.id}`, m]));
    const all = [...c.marks.map((m) => ({ e: m.e, mark: m as DayMark | null })), ...flagged.filter((e) => !timed.has(`${e.type}:${e.id}`)).map((e) => ({ e, mark: null as DayMark | null }))];
    const chips = all.slice(0, 3).map((x) => ({ ...x, others: all.filter((y) => y.e !== x.e && !y.mark).map((y) => y.e) }));
    return { d: c.d, chips, more: Math.max(0, all.length - 3) };
  }), [cols, wv]);
  // The card follows its block when the data refreshes (or closes when the block is gone, e.g. after Mark done).
  useEffect(() => {
    if (!openKey) return;
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-block="${CSS.escape(openKey)}"]`) ?? null;
    if (!el) { if (open?.el && !open.el.isConnected) setOpen(null); return; }
    if (el !== open?.el) setOpen((o) => (o ? { ...o, el } : o));
  }, [openKey, open?.el, cols]);

  // ---- the whole day is on the grid; it opens at the first thing on the shown days, or 8 AM (once per range, not on every refresh)
  const earliest = useMemo(() => {
    let h = FIRST_HOUR;
    for (const c of cols) {
      for (const m of c.meets) h = Math.min(h, m.start);
      for (const t of [...c.calls, ...c.logged, ...c.done, ...c.reminders]) h = Math.min(h, hoursOf(t).start);
      for (const f of c.focus) h = Math.min(h, f.start);
    }
    return Math.max(G0, Math.floor(h));
  }, [cols]);
  // A deadline's time in the time-axis margin (one tag per minute across the shown days), beside the thin line on its day.
  const marginTags = useMemo(() => {
    const by = new Map<string, { at: string; h: number; sla: boolean; late: boolean; tip: string }>();
    for (const c of cols) for (const m of c.marks) {
      const at = clock24(m.iso), x = by.get(at), what = `${m.kind === 'sla' ? 'SLA' : 'Due'} ${at} · ${m.e.key ?? m.e.title}`;
      by.set(at, x ? { ...x, sla: x.sla || m.kind === 'sla', late: x.late || m.late, tip: `${x.tip} · ${what}` } : { at, h: m.at, sla: m.kind === 'sla', late: m.late, tip: what });
    }
    return [...by.values()].filter((t) => Math.abs(t.h - nowH) > .2 || !days.includes(today));
  }, [cols, nowH, days, today]);
  const scrolledFor = useRef<string | null>(null);
  const rangeKey = `${view}:${days[0]}:${days.length}:${tl.data ? 'y' : 'n'}`;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || scrolledFor.current === rangeKey) return;
    scrolledFor.current = rangeKey;
    el.scrollTop = Math.max(0, (earliest - G0) * HR - 12);
  }, [rangeKey, earliest]);

  // ---- arrows walk the blocks: ↑/↓ within a day, ←/→ to the nearest block of the next day; Enter opens (a button); Esc closes
  const onGridKey = (ev: ReactKeyboardEvent) => {
    if (ev.altKey || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(ev.key)) return;
    const cur = (ev.target as HTMLElement).closest<HTMLElement>('[data-block]');
    if (!cur || !gridRef.current) return;
    const all = [...gridRef.current.querySelectorAll<HTMLElement>('[data-block]')];
    const di = (el: HTMLElement) => days.indexOf(el.dataset.day ?? '');
    const st = (el: HTMLElement) => Number(el.dataset.start ?? 0);
    const here = di(cur), at = st(cur);
    let next: HTMLElement | undefined;
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      const same = all.filter((el) => di(el) === here).sort((a, b) => st(a) - st(b));
      next = same[same.indexOf(cur) + (ev.key === 'ArrowUp' ? -1 : 1)];
    } else {
      const step = ev.key === 'ArrowLeft' ? -1 : 1;
      for (let i = here + step; i >= 0 && i < days.length && !next; i += step) {
        next = all.filter((el) => di(el) === i).sort((a, b) => Math.abs(st(a) - at) - Math.abs(st(b) - at))[0];
      }
    }
    if (next) { ev.preventDefault(); next.focus(); if (open) next.click(); }
  };

  // ---- ✦ the week in one line, from the same days the grid draws
  const weekMeets = meets.filter((m) => week.includes(m.day));
  const meetH = weekMeets.reduce((n, m) => n + (m.end - m.start), 0);
  const focusH = wv.focus.filter((f) => week.includes(f.day)).reduce((n, f) => n + (f.end - f.start), 0);
  const callsN = wv.days.reduce((n, d) => n + d.calls.length, 0);
  const loggedM = wv.days.reduce((n, d) => n + d.loggedMin, 0);
  const doneN = wv.days.reduce((n, d) => n + d.done.length, 0);
  const perDay = week.map((d) => ({ d, h: weekMeets.filter((m) => m.day === d).reduce((n, m) => n + (m.end - m.start), 0) }));
  const busiest = perDay.reduce((a, b) => (b.h > a.h ? b : a), perDay[0]);
  const longest = weekMeets.filter((m) => m.day === busiest?.d).sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
  const fmtH = (h: number) => `${Math.round(h * 10) / 10}h`.replace('.0h', 'h');
  const capOf = (d: string) => grid.data?.days?.find((x) => x.date === d)?.targetMinutes ?? (dateOf(d).getDay() % 6 === 0 ? 0 : 480);
  const weekCap = week.reduce((n, d) => n + capOf(d), 0);

  const title = view === 'day'
    ? `${DOW3[dateOf(anchor).getDay()]} ${dateOf(anchor).getDate()} ${MONTHS[dateOf(anchor).getMonth()]}`
    : (() => { const a = dateOf(week[0]), b = dateOf(week[4]); return a.getMonth() === b.getMonth() ? `${a.getDate()} – ${b.getDate()} ${MONTHS[b.getMonth()]}` : `${a.getDate()} ${MONTHS[a.getMonth()].slice(0, 3)} – ${b.getDate()} ${MONTHS[b.getMonth()].slice(0, 3)}`; })();

  const seg = (
    <div className="tb-seg" role="tablist" aria-label="Calendar view">
      {(['day', 'week', 'month'] as const).map((v) => <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)}>{v[0].toUpperCase() + v.slice(1)}</button>)}
    </div>
  );
  const detail = open && <EventDetail key={open.d.key} detail={open.d} anchor={open.el} today={today} nowH={nowH} days={week} actions={actions} onClose={closeDetail} inline={wide && view !== 'month'} />;
  const selDv = wv.byDay.get(selDay) ?? buildWeek(timeline, [selDay], today, nowQ, plan, nowH).byDay.get(selDay);
  const overdue = useMemo(() => wv.days.flatMap((d) => d.due).filter((e) => e.overdue && e.date < today), [wv, today]);

  return (
    <div className={`wp wp-${view}`} data-testid="week-planner">
      <ToolbarSlot title={<h1>Calendar</h1>}>{seg}</ToolbarSlot>
      <div className="wp-phone-head tb-wide-hide">
        <h1>Calendar <ZoneBadge /></h1>
        {onTab && <Segmented label="Home" value="calendar" onChange={onTab} options={[{ id: 'for-you', label: 'For me' }, { id: 'calendar', label: 'Calendar' }]} />}
        {seg}
      </div>

      <aside className="wp-left" aria-label="Month and filters">
        <MiniMonth y={mini.y} m={mini.m} today={today} week={view === 'day' ? [anchor] : week} onPick={(d) => setAnchor(d)}
          onShift={(n) => setMini(({ y, m }) => { const d = new Date(y, m + n, 1); return { y: d.getFullYear(), m: d.getMonth() }; })} />
        <div className="wp-filters" data-testid="wp-layers">
          <div className="wp-ft">Show</div>
          {LAYERS.map(([k, label]) => (
            <label key={k} className={`wp-fr${layers[k] ? '' : ' off'}`} data-layer={k}><input type="checkbox" className="sr-only" checked={layers[k]} onChange={(e) => setLayers((s) => ({ ...s, [k]: e.target.checked }))} /><i className={`k-${k}`} aria-hidden="true" />{label}</label>
          ))}
          {projects.length > 0 && <div className="wp-ft">Projects</div>}
          {projects.map((p) => (
            <label key={p} className={`wp-fr${hidden.has(p) ? ' off' : ''}`}><input type="checkbox" className="sr-only" checked={!hidden.has(p)} onChange={() => setHidden((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; })} /><i style={{ background: DOT[tintOf(p)] }} aria-hidden="true" />{p}</label>
          ))}
        </div>
        <section className="wp-ai" aria-label="This week" data-testid="wp-week-summary">
          <span className="wp-orb" aria-hidden="true" />
          <p>{tl.isLoading ? 'Reading the week…' : <>This week: <b>{fmtH(meetH)} meetings</b>{callsN > 0 && <>, {callsN} call{callsN === 1 ? '' : 's'}</>}, {fmtH(focusH)} focus{loggedM > 0 && <>, {fmtMins(loggedM)} logged</>}{doneN > 0 && <>, {doneN} done</>}.{' '}
            {busiest && busiest.h >= 4 && longest ? <>{dateOf(busiest.d).toLocaleDateString('en-GB', { weekday: 'long' })} is overbooked — move {longest.e.title}?</>
              : perDay.length > 0 && <>{dateOf(perDay.reduce((a, b) => (b.h < a.h ? b : a), perDay[0]).d).toLocaleDateString('en-GB', { weekday: 'long' })} is clearest for focused work.</>}</>}</p>
        </section>
        {extra && <div className="wp-extra">{extra}</div>}
      </aside>

      {view === 'month' ? (
        <section className="wp-month" aria-label="Month"><CalendarView mine onOpenTask={(id) => navigate(`/work?item=${id}`)} /></section>
      ) : (
        <section className="wp-main" aria-label={view === 'day' ? 'Day' : `Week of ${title}`}>
          <div className="wp-whd">
            <h2>{title}</h2><ZoneBadge />{view === 'week' && <span className="wp-wk">Week {weekNo(monday)}</span>}
            <span className="wp-sp" />
            <button type="button" className="wp-nav" aria-label={view === 'day' ? 'Previous day' : 'Previous week'} onClick={() => setAnchor(addDays(anchor, view === 'day' ? -1 : -7))}><Icon name="chevronL" size={14} /></button>
            <button type="button" className="wp-today" onClick={() => { setAnchor(today); const d = dateOf(today); setMini({ y: d.getFullYear(), m: d.getMonth() }); }}>Today</button>
            <button type="button" className="wp-nav" aria-label={view === 'day' ? 'Next day' : 'Next week'} onClick={() => setAnchor(addDays(anchor, view === 'day' ? 1 : 7))}><Icon name="chevronR" size={14} /></button>
          </div>
          {!tl.isLoading && !tl.isError && !meets.some((m) => days.includes(m.day)) && (
            <NoMeetings scope={view === 'day' ? 'day' : 'week'} focusCount={wv.focus.filter((f) => days.includes(f.day)).length}
              onPlanFocus={() => {
                setLayers((l) => ({ ...l, focus: true }));
                const n = wv.focus.filter((f) => days.includes(f.day) && (f.day > today || (f.day === today && f.end > nowH))).length;
                toast(n ? `${n} focus block${n === 1 ? '' : 's'} planned from your open work. Drag one to move it.` : 'No open work with a date to plan focus for.', n ? 'success' : 'info');
                window.setTimeout(() => scrollRef.current?.querySelector<HTMLElement>('[data-type="focus"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80);
              }} />
          )}
          {tl.isError ? <ErrorState error={tl.error} retry={() => void tl.refetch()} /> : (
            <div className={`wp-cal${open ? ' has-open' : ''}${drag ? ' dragging' : ''}`} ref={gridRef} style={{ ['--cols' as string]: days.length }} onKeyDown={onGridKey}>
              <div className="wp-days">
                <span />
                {days.map((d) => {
                  const dv = wv.byDay.get(d);
                  const ents = layers.logged ? dv?.time ?? [] : [];
                  const mins = loggedMinutesOf(ents);
                  const lv = dv?.off[0] ?? null;
                  const lk = `loggedDay:${d}`, vk = `leave:${d}`;
                  return (
                    <div key={d} className={`wp-dh${d === today ? ' tdy' : ''}${d === selDay ? ' sel' : ''}${flagOver === d ? ' drop' : ''}`} data-day={d} data-sig={dv ? daySignature(dv) : ''}
                      onClick={(ev) => { if (!(ev.target as HTMLElement).closest('button')) setSelDay(d); }}>
                      <button type="button" className="wp-dh-pick" aria-pressed={d === selDay} aria-label={`Show ${dateOf(d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })} in the Day panel`} onClick={() => setSelDay(d)}>
                        {DOW3[dateOf(d).getDay()]}<b>{dateOf(d).getDate()}</b>
                      </button>
                      {mins > 0 && (
                        <button type="button" className={`wp-logged${openKey === lk ? ' open' : ''}`} data-testid="wp-logged" data-block={lk} data-day={d} data-start={-2}
                          aria-label={`${fmtMins(mins)} logged`} aria-expanded={openKey === lk} title={`Logged ${fmtMins(mins)} — click for the entries`}
                          onClick={(ev) => handlers.open({ kind: 'loggedDay', key: lk, day: d, entries: ents }, ev.currentTarget)}>
                          <Icon name="timer" size={10} />{fmtMins(mins)}
                        </button>
                      )}
                      {lv && <button type="button" className={`wp-leave${openKey === vk ? ' open' : ''}`} data-block={vk} data-day={d} data-start={-3} aria-expanded={openKey === vk}
                        onClick={(ev) => handlers.open({ kind: 'leave', key: vk, day: d, note: lv.type === 'holiday' ? lv.title : lv.note }, ev.currentTarget)}>{lv.type === 'holiday' ? 'Holiday' : 'Leave'}</button>}
                    </div>
                  );
                })}
              </div>
              {/* The all-day / due strip (Google Calendar's all-day row): each day's deadlines as chips, never on top of the day's blocks. A chip
                  drags to another day to move the date; a timed one shows its time (its line is on the grid at that hour). */}
              {layers.deadlines && strips.some((x) => x.chips.length > 0) && (
                <div className="wp-allday" data-testid="wp-allday">
                  <span className="wp-allday-l">Due</span>
                  {strips.map(({ d, chips, more }) => (
                    <div key={d} className={`wp-allday-d${flagOver === d ? ' drop' : ''}`} data-day={d}>
                      {chips.map((c) => {
                        const fk = `deadline:${d}:${c.e.type}:${c.e.id}`;
                        const tag = c.mark ? (c.mark.kind === 'sla' ? `SLA ${clock24(c.mark.iso)}` : clock24(c.mark.iso)) : null;
                        const label = `${c.e.key ? `${c.e.key} ` : ''}${c.e.title}${c.e.projectName ? ` · ${c.e.projectName}` : ''} — ${c.mark ? (c.mark.kind === 'sla' ? `SLA ${c.mark.late ? 'breached' : 'breach'} ${clock24(c.mark.iso)}` : `due ${clock24(c.mark.iso)}`) : c.e.overdue ? 'overdue' : 'due'}${canMoveDue(c.e) ? ' · drag to another day to move the date' : ''}`;
                        return (
                          <button key={fk} type="button" className={`wp-flag${c.e.overdue || c.mark?.late ? ' late' : ''}${c.mark ? ` timed ${c.mark.kind}` : ''}${openKey === fk ? ' open' : ''}${canMoveDue(c.e) ? ' movable' : ''}`}
                            data-block={fk} data-day={d} data-start={-1} aria-expanded={openKey === fk} data-testid={c.mark ? (c.mark.kind === 'sla' ? 'wp-sla' : 'wp-due') : 'wp-flag'}
                            data-at={c.mark ? clock24(c.mark.iso) : undefined} title={label} aria-label={label}
                            onPointerDown={(ev) => live.current.flag(ev, c.e)}
                            onClick={(ev) => { if (!justDragged.current) handlers.open({ kind: 'deadline', key: fk, e: c.e, others: c.mark ? [] : c.others }, ev.currentTarget); }}>
                            <Icon name="flag" size={9} />{tag && <span className="wp-flag-at">{tag}</span>}{c.e.key ?? c.e.title}
                          </button>
                        );
                      })}
                      {more > 0 && <span className="wp-flag-more" title={`${more} more due`}>+{more}</span>}
                    </div>
                  ))}
                </div>
              )}
              <AttendanceRow days={days} today={today} />
              <div className="wp-scroll" ref={scrollRef} data-testid="wp-scroll">
                <div className="wp-body" style={{ height: (G1 - G0) * HR }}>
                  <div className="wp-lines" aria-hidden="true" />
                  <div className="wp-hrs" aria-hidden="true">
                    {Array.from({ length: G1 - G0 }, (_, i) => G0 + i).map((h) => (
                      <span key={h} data-hour={h} style={{ top: (h - G0) * HR, opacity: h === G0 ? 0 : 1 }}>{hourLabel(h)}</span>
                    ))}
                    {days.includes(today) && <span className="wp-nowl" style={{ top: (nowH - G0) * HR - 7 }}>{clockH(nowH)}</span>}
                    {marginTags.map((t) => <span key={t.at} className={`wp-dl-tag${t.sla ? ' sla' : ''}${t.late ? ' late' : ''}`} data-testid="wp-dl-tag" style={{ top: (t.h - G0) * HR - 7 }} title={t.tip}>{t.at}</span>)}
                  </div>
                  {cols.map((c) => (
                    <DayCol key={c.d} col={c} nowTop={c.d === today ? (nowH - G0) * HR : null} nowLabel={clockH(nowH)}
                      openKey={openKey?.includes(`:${c.d}:`) ? openKey : null} sel={c.d === selDay && view === 'week'}
                      drag={drag && (drag.day === c.d || drag.item.day === c.d) ? drag : null} dragging={!!drag}
                      pick={pick && pick.day === c.d ? { start: Math.min(pick.a, pick.b), end: Math.max(pick.a, pick.b), key: openKey?.startsWith('create:') ? openKey : null } : null}
                      tintOf={tintOf} canMove={canMove} timeWhy={timeWhy} h={handlers} />
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {view !== 'month' && (
        <DayPanel day={selDay} today={today} nowH={nowH} dv={selDv} meets={meets.filter((m) => m.day === selDay && layers.meetings)} focus={(wv.byDay.get(selDay)?.focus ?? []).filter(() => layers.focus)}
          overdue={overdue} peopleOf={(id) => peopleById.get(id) ?? []} entries={entries} capacityMin={capOf(selDay)}
          detail={wide ? detail : null} detailKey={open?.d.key ?? null}
          week={<WeekStrip week={week} today={today} sel={selDay} onPick={setSelDay} wv={wv} meets={weekMeets} capOf={capOf} loggedM={loggedM} weekCap={weekCap} doneN={doneN} callsN={callsN} meetH={meetH} />}
          onOpen={(d, el) => live.current.open(d, el)}
          onCreate={(d) => {
            const s0 = d === today ? Math.max(G0, Math.floor(nowH * 4) / 4 - 1) : 9;
            setSelDay(d); setPick({ day: d, a: s0, b: s0 + 1 });
            setOpen({ d: { kind: 'create', key: `create:${d}:${s0}-${s0 + 1}`, day: d, start: s0, end: s0 + 1 }, el: null });
          }}
          onDone={(e) => setDoneIds((s) => new Set(s).add(e.id))} />
      )}
      {!(wide && view !== 'month') && detail}
      {dueAsk && <DueReason e={dueAsk.e} date={dueAsk.date} today={today} onCancel={() => setDueAsk(null)} onSave={(reason) => { const a = dueAsk; setDueAsk(null); void shiftDue(a.e, a.date, reason); }} />}
    </div>
  );
}

const KIND_WORD: Record<string, string> = { project: 'Project', milestone: 'Milestone', stage: 'Stage', action: 'Follow-up' };

/** Moving a task's date later needs the reason (the task form's rule): asked right where the flag was dropped. */
function DueReason({ e, date, today, onCancel, onSave }: { e: CalendarEvent; date: string; today: string; onCancel: () => void; onSave: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  useEffect(() => { const k = (ev: KeyboardEvent) => { if (ev.key === 'Escape') onCancel(); }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k); }, [onCancel]);
  return (
    <div className="ed-scrim wp-ask-scrim" onClick={(ev) => { if (ev.target === ev.currentTarget) onCancel(); }}>
      <form className="ed ed-pop wp-ask" role="dialog" aria-modal="true" aria-label="Why it needs more time" data-testid="due-reason" style={{ ['--ed-tint' as string]: 'var(--ed-red)' }}
        onSubmit={(ev) => { ev.preventDefault(); if (reason.trim()) onSave(reason.trim()); }}>
        <div className="ed-kind"><span className="ed-ico" aria-hidden="true"><Icon name="flag" size={13} /></span>Move the due date</div>
        <h2 className="ed-title">{e.key ? `${e.key} · ` : ''}{e.title}</h2>
        <p className="ed-when">{dayLabel(e.date, today)} → <b>{dayLabel(date, today)}</b></p>
        <label className="wp-ask-l"><span>Why it needs more time</span>
          <input className="ed-sel" autoFocus aria-label="Reason" maxLength={500} value={reason} placeholder="Waiting on the vendor's fix" onChange={(ev) => setReason(ev.target.value)} /></label>
        <div className="ed-pick-act"><button type="button" className="ed-btn ghost" onClick={onCancel}>Cancel</button><button type="submit" className="ed-btn primary" disabled={!reason.trim()}>Move date</button></div>
      </form>
    </div>
  );
}

/** The week under the Day panel: each day's logged time against its capacity and its meeting hours; a day opens in the panel. */
function WeekStrip({ week, today, sel, onPick, wv, meets, capOf, loggedM, weekCap, doneN, callsN, meetH }: {
  week: string[]; today: string; sel: string; onPick: (d: string) => void; wv: { byDay: Map<string, DayView> }; meets: Meet[]; capOf: (d: string) => number;
  loggedM: number; weekCap: number; doneN: number; callsN: number; meetH: number;
}) {
  return (
    <>
      <h3>This week<em>{fmtMins(loggedM)} of {fmtMins(weekCap)} logged</em></h3>
      <div className="dp-wk" role="group" aria-label="Days of the week">
        {week.map((d) => {
          const dv = wv.byDay.get(d);
          const lg = dv?.loggedMin ?? 0, cap = capOf(d), mh = meets.filter((m) => m.day === d).reduce((n, m) => n + (m.end - m.start), 0);
          return (
            <button key={d} type="button" className={`dp-wd${d === sel ? ' on' : ''}${d === today ? ' tdy' : ''}`} aria-pressed={d === sel} onClick={() => onPick(d)}
              title={`${dateOf(d).toLocaleDateString('en-GB', { weekday: 'long' })}: ${fmtMins(lg)} logged${cap ? ` of ${fmtMins(cap)}` : ''}, ${Math.round(mh * 10) / 10}h meetings`}>
              <span>{DOW3[dateOf(d).getDay()][0]}</span>
              <i className="dp-wd-bar" aria-hidden="true"><i style={{ height: `${Math.min(100, cap ? (lg / cap) * 100 : 0)}%` }} className={cap && lg > cap ? 'over' : ''} /></i>
              <small>{lg ? fmtMins(lg) : '–'}</small>
            </button>
          );
        })}
      </div>
      <p className="dp-wk-sum">{Math.round(meetH * 10) / 10}h meetings{callsN ? ` · ${callsN} call${callsN === 1 ? '' : 's'}` : ''}{doneN ? ` · ${doneN} done` : ''}</p>
    </>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ one day
interface ColHandlers {
  down: (e: ReactPointerEvent, it: DragItem, mode: DragMode) => void; open: (d: Detail, el: HTMLElement) => void; alt: (it: DragItem, up: boolean) => void;
  create: (e: ReactPointerEvent, day: string) => void;
}
interface ColData {
  d: string; meets: Meet[]; calls: TimelineEvent[]; pack: Map<string, Packed>; focus: Focus[];
  logged: TimelineEvent[]; done: TimelineEvent[]; reminders: TimelineEvent[]; marks: DayMark[]; overlaps: Map<string, TimelineEvent[]>;
}
const top = (h: number) => (h - G0) * HR;
/** Point-like items (a reminder, a done check) take a quarter hour of the column: the height their pill is drawn with. */
const PILL_H = .25;
const narrowOf = (p: Packed | undefined) => !!p && p.width < 1 - 1e-9;

/** The drag handles on a block's top and bottom edges (resize, 15-minute steps). */
function Edges({ it, h }: { it: DragItem; h: ColHandlers }) {
  return (
    <>
      <span className="wp-rs t" aria-hidden="true" onPointerDown={(e) => h.down(e, it, 'top')} onClick={(e) => e.stopPropagation()} />
      <span className="wp-rs b" aria-hidden="true" onPointerDown={(e) => h.down(e, it, 'bottom')} onClick={(e) => e.stopPropagation()} />
    </>
  );
}

/** One day of the week. Memoised: hover is pure CSS, and a column re-renders only when its own blocks, the now line, a drag over it or the open card on it change. */
const DayCol = memo(function DayCol({ col, nowTop, nowLabel, openKey, sel, drag, dragging, pick, tintOf, canMove, timeWhy, h }: {
  col: ColData; nowTop: number | null; nowLabel: string; openKey: string | null; sel: boolean; drag: DragState | null; dragging: boolean;
  pick: { start: number; end: number; key: string | null } | null;
  tintOf: (p: string | null) => string; canMove: (m: Meet) => string | null; timeWhy: (t: TimelineEvent) => string | null; h: ColHandlers;
}) {
  const { d } = col;
  const nowAt = nowTop == null ? null : nowTop / HR + G0;
  // Where a block is drawn: where it is, or where it is being dragged to.
  const at = (key: string, start: number, end: number) => (drag && drag.item.key === key ? (drag.day === d ? { start: drag.start, end: drag.end, lifted: true } : null) : { start, end, lifted: false });
  const ghost = drag && drag.item.day === d ? <div className="wp-ghost" style={{ top: top(drag.item.start), height: (drag.item.end - drag.item.start) * HR - 2 }} aria-hidden="true" /> : null;
  const snap = drag && drag.day === d ? <span className="wp-snap" style={{ top: top(drag.start) - 22 }}>{clockH(drag.start)} – {clockH(drag.end)}</span> : null;
  // A block dragged in from another day is drawn here.
  const visitor = drag && drag.day === d && drag.item.day !== d;
  return (
    <div className={`wp-col${sel ? ' sel' : ''}`} data-day={d} onPointerDown={(e) => h.create(e, d)}>
      {nowTop != null && <div className="wp-now" style={{ top: nowTop }} aria-label={`Now, ${nowLabel}`} data-testid="wp-now" />}
      {ghost}{snap}
      {pick && <div className="wp-pick" data-block={pick.key ?? undefined} data-day={d} data-start={pick.start} style={{ top: top(pick.start), height: (pick.end - pick.start) * HR - 2 }}><span>{clockH(pick.start)} – {clockH(pick.end)}</span></div>}
      {col.logged.map((t) => {
        const sp = hoursOf(t);
        const key = `time:${d}:${t.id}`;
        const pos = at(key, sp.start, Math.max(sp.end, sp.start + .25));
        if (!pos) return null;
        const pk = col.pack.get(key);
        const ov = col.overlaps.get(t.id) ?? [];
        const why = timeWhy(t);
        const it: DragItem = { kind: 'time', key, day: d, start: sp.start, end: Math.max(sp.end, sp.start + .25), resizable: true, label: t.title, cls: 'lg' };
        return (
          <button key={t.id} type="button" className={`wp-e lg${narrowOf(pk) && !pos.lifted ? ' narrow' : ''}${ov.length ? ' ovl' : ''}${t.running ? ' run' : ''}${t.approximated ? ' ap' : ''}${openKey === key ? ' open' : ''}${why ? '' : ' movable'}${pos.lifted ? ' lift' : ''}`}
            aria-label={`Logged ${fmtMins(t.minutes ?? 0)} · ${t.title}${t.approximated ? ' (approximate time)' : ''}${ov.length ? ` · ${overlapText(ov[0])}` : ''}`} data-block={key} data-day={d} data-start={sp.start} data-type="time" data-id={t.id}
            data-overlaps={ov.length || undefined} aria-expanded={openKey === key} style={{ top: top(pos.start), height: Math.max(16, (pos.end - pos.start) * HR - 2), ...(pos.lifted ? {} : packStyle(pk)) }}
            title={`${t.approximated ? '≈ Typed in as minutes, placed on the day' : 'Logged'} · ${t.title} · ${clockH(sp.start)}–${clockH(sp.end)}${ov.length ? ` · ${overlapText(ov[0])}` : ''}${why ? ` · ${why}` : ' · drag to move, drag an edge to resize'}`}
            onPointerDown={why ? undefined : (e) => h.down(e, it, 'move')}
            onKeyDown={(ev) => { if (!why && ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) { ev.preventDefault(); h.alt(it, ev.key === 'ArrowUp'); } }}
            onClick={(ev) => h.open({ kind: 'time', key, t }, ev.currentTarget)}>
            <span className="wp-lbl">{ov.length > 0 && <b className="wp-ovl" aria-hidden="true">!</b>}{t.running ? 'Running · ' : ''}{t.title}</span><small>{t.approximated ? '≈ ' : ''}{clockH(pos.start)}{t.running ? '' : ` – ${clockH(pos.end)}`}</small>
            {!why && <Edges it={it} h={h} />}
          </button>
        );
      })}
      {col.focus.map((f) => {
        const pos = at(f.key, f.start, f.end);
        if (!pos) return null;
        const pk = col.pack.get(f.key);
        const it: DragItem = { kind: 'focus', key: f.key, day: d, start: f.start, end: f.end, resizable: true, label: focusLabel(f.e), cls: 'f' };
        return (
          <button key={f.key} type="button" className={`wp-e f movable${narrowOf(pk) && !pos.lifted ? ' narrow' : ''}${dragging && !pos.lifted ? ' dim' : ''}${openKey === f.key ? ' open' : ''}${pos.lifted ? ' lift' : ''}`} data-block={f.key} data-day={d} data-start={f.start} data-type="focus" aria-expanded={openKey === f.key}
            style={{ top: top(pos.start), height: (pos.end - pos.start) * HR - 2, ...(pos.lifted ? {} : packStyle(pk)) }} title={`Focus · ${focusLabel(f.e)} · drag to move, drag an edge to resize`}
            onPointerDown={(e) => h.down(e, it, 'move')}
            onKeyDown={(ev) => { if (ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) { ev.preventDefault(); h.alt(it, ev.key === 'ArrowUp'); } }}
            onClick={(ev) => h.open({ kind: 'focus', key: f.key, f }, ev.currentTarget)}>
            <span className="wp-f-k">{nowAt != null && f.start <= nowAt && nowAt < f.end ? 'Focus now' : 'Focus'}</span><span className="wp-lbl">{focusLabel(f.e)}</span><small>{clockH(pos.start)} – {clockH(pos.end)}</small>
            <Edges it={it} h={h} />
          </button>
        );
      })}
      {col.calls.map((t) => {
        const sp = hoursOf(t);
        const end = Math.max(sp.end, sp.start + .25);
        const pk = col.pack.get(t.id);
        const key = `call:${d}:${t.id}`;
        const xs = end - sp.start <= .3;
        return (
          <button key={t.id} type="button" className={`wp-e c${xs ? ' xs' : ''}${narrowOf(pk) ? ' narrow' : ''}${t.running ? ' run' : ''}${openKey === key ? ' open' : ''}`} data-block={key} data-day={d} data-start={sp.start} data-type="call"
            aria-expanded={openKey === key} style={{ top: top(sp.start), height: (end - sp.start) * HR - 2, ...packStyle(pk) }}
            title={`Call · ${t.title} · ${clockH(sp.start)}–${clockH(end)}`} onClick={(ev) => h.open({ kind: 'call', key, t }, ev.currentTarget)}>
            <Icon name="phone" size={10} /><span className="wp-lbl">{t.title}</span>{!xs && <small>{clockH(sp.start)}{t.running ? ' · live' : ` – ${clockH(sp.end)}`}{t.people.length ? ` · ${t.people.length} people` : ''}</small>}
          </button>
        );
      })}
      {col.meets.map((m) => {
        const key = `meeting:${d}:${m.key}`;
        const pos = at(m.key, m.start, m.end);
        if (!pos) return null;
        const why = canMove(m);
        const len = pos.end - pos.start;
        const xs = len <= .3;
        const pk = col.pack.get(m.key);
        const people = (m.e.people ?? []).slice(1, 3).map((p) => p.split(' ')[0]).join(', ');
        const sub = len >= 1.25 ? `${clockH(pos.start)} – ${clockH(pos.end)}` : `${clockH(pos.start)}${people ? ` · ${people}` : m.e.projectName ? ` · ${m.e.projectName}` : ''}`;
        const it: DragItem = { kind: 'meeting', key: m.key, day: d, start: m.start, end: m.end, resizable: true, label: m.e.title, cls: tintOf(m.e.projectName) };
        return (
          <button key={m.key} type="button" className={`wp-e ${tintOf(m.e.projectName)}${xs ? ' xs' : ''}${narrowOf(pk) && !pos.lifted ? ' narrow' : ''}${pos.lifted ? ' lift' : ''}${why ? '' : ' movable'}${openKey === key ? ' open' : ''}`}
            data-block={key} data-day={d} data-start={m.start} data-type="meeting" aria-expanded={openKey === key}
            style={{ top: top(pos.start), height: Math.max(.25, len) * HR - 2, ...(pos.lifted ? {} : packStyle(pk)) }}
            title={why ? `${m.e.title} · ${why}` : `${m.e.title} · drag to move, drag an edge to change its length (Alt+↑/↓)`}
            onClick={(ev) => h.open({ kind: 'meeting', key, m }, ev.currentTarget)}
            onPointerDown={why ? undefined : (ev) => h.down(ev, it, 'move')}
            onKeyDown={(ev) => { if (!why && ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) { ev.preventDefault(); h.alt(it, ev.key === 'ArrowUp'); } }}>
            <span className="wp-lbl">{m.e.title}</span>{!xs && <small>{sub}</small>}
            {!why && !xs && <Edges it={it} h={h} />}
          </button>
        );
      })}
      {visitor && drag && <div className={`wp-e ${drag.item.cls === 'rem' ? 'g' : drag.item.cls} lift wp-visit`} aria-hidden="true" style={{ top: top(drag.start), height: Math.max(16, (drag.end - drag.start) * HR - 2) }}><span className="wp-lbl">{drag.item.label}</span><small>{clockH(drag.start)} – {clockH(drag.end)}</small></div>}
      {col.done.map((t) => {
        const at0 = hoursOf(t).start;
        const key = `done:${d}:${t.id}`;
        return (
          <button key={t.id} type="button" className={`wp-done${openKey === key ? ' open' : ''}`} data-block={key} data-day={d} data-start={at0} data-type="done" aria-expanded={openKey === key}
            style={{ top: top(at0), ...packStyle(col.pack.get(key)) }} title={`Done ${clockH(at0)} · ${t.key ? `${t.key} ` : ''}${t.title}`}
            onClick={(ev) => h.open({ kind: 'done', key, t }, ev.currentTarget)}>
            <Icon name="check" size={9} />{t.key ?? t.title}
          </button>
        );
      })}
      {col.reminders.map((t) => {
        const hr = hoursOf(t).start;
        const key = `reminder:${d}:${t.id}`;
        const pos = at(key, hr, hr + .25);
        if (!pos) return null;
        const movable = t.status === 'scheduled';
        const it: DragItem = { kind: 'reminder', key, day: d, start: hr, end: hr + .25, resizable: false, label: t.title, cls: 'rem' };
        return (
          <button key={t.id} type="button" className={`wp-rem${t.status !== 'scheduled' ? ' fired' : ''}${openKey === key ? ' open' : ''}${movable ? ' movable' : ''}${pos.lifted ? ' lift' : ''}`} data-block={key} data-day={d} data-start={hr} data-type="reminder" aria-expanded={openKey === key}
            style={{ top: top(pos.start), ...(pos.lifted ? {} : packStyle(col.pack.get(key))) }} title={`Reminder · ${clockH(hr)} · ${t.title}${movable ? ' · drag to move' : ''}`}
            onPointerDown={movable ? (e) => h.down(e, it, 'move') : undefined}
            onClick={(ev) => h.open({ kind: 'reminder', key, t }, ev.currentTarget)}>
            <i aria-hidden="true" />{t.title}
          </button>
        );
      })}
      {/* a deadline with a time: a thin line at its hour (its chip is in the day's due strip, its time in the margin), never over a block's text */}
      {col.marks.map((m) => <i key={m.key} className={`wp-dl-line ${m.kind}${m.late ? ' late' : ''}`} data-testid="wp-dl-line" data-kind={m.kind} data-day={d} data-at={clock24(m.iso)} style={{ top: top(m.at) }} aria-hidden="true" />)}
    </div>
  );
});

function MiniMonth({ y, m, today, week, onPick, onShift }: { y: number; m: number; today: string; week: string[]; onPick: (d: string) => void; onShift: (n: number) => void }) {
  const first = new Date(y, m, 1);
  const lead = (first.getDay() + 6) % 7;
  const count = new Date(y, m + 1, 0).getDate();
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: count }, (_, i) => iso(new Date(y, m, i + 1)))];
  // fill the last row with next month's first days (faint), as the design
  while (cells.length % 7) cells.push(iso(new Date(y, m + 1, cells.length - lead - count + 1)));
  return (
    <section className="wp-mm" aria-label={`${MONTHS[m]} ${y}`}>
      <div className="wp-mm-hd"><span>{MONTHS[m]} {y}</span>
        <span className="wp-mm-nav"><button type="button" aria-label="Previous month" onClick={() => onShift(-1)}>‹</button><button type="button" aria-label="Next month" onClick={() => onShift(1)}>›</button></span></div>
      <div className="wp-mm-g">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <b key={i}>{d}</b>)}
        {cells.map((c, i) => {
          if (!c) return <span key={i} />;
          const d = dateOf(c);
          const other = d.getMonth() !== m, weekend = d.getDay() % 6 === 0;
          return (
            <button key={c} type="button" className={`${c === today ? 'td' : week.includes(c) ? 'wk' : ''}${other || weekend ? ' faint' : ''}`} onClick={() => onPick(c)} aria-label={d.toDateString()} aria-current={c === today ? 'date' : undefined}>{d.getDate()}</button>
          );
        })}
      </div>
    </section>
  );
}

function NoMeetings({ scope, focusCount, onPlanFocus }: { scope: 'day' | 'week'; focusCount: number; onPlanFocus: () => void }) {
  const navigate = useNavigate();
  const signals = useTodaySignals();
  const risky = signals.data?.groups?.find((g) => g.kind === 'risk')?.items?.[0] ?? null;
  return (
    <div className="wp-empty" role="status" data-testid="calendar-empty">
      <div className="wp-empty-t"><b>No meetings this {scope}.</b> <span><Term k="free time">Free time</Term> to protect{focusCount ? ` · ${focusCount} focus block${focusCount === 1 ? '' : 's'} suggested` : ''}.</span></div>
      <div className="wp-empty-acts">
        <button type="button" className="wp-empty-btn pri" onClick={onPlanFocus} data-testid="plan-focus">Plan focus</button>
        <button type="button" className="wp-empty-btn" onClick={() => navigate('/messages?f=meetings&new=1')}>Schedule meeting</button>
        {risky?.href
          ? <button type="button" className="wp-empty-btn" title={`${risky.title} · ${risky.reason}`} onClick={() => navigate(risky.href!)}>Open riskiest project</button>
          : <button type="button" className="wp-empty-btn" onClick={() => navigate('/work/projects?status=AtRisk')}>Projects at risk</button>}
      </div>
    </div>
  );
}
