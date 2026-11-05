import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { SiriOrb } from '../../components/aura/SiriOrb';
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
import { canMoveDue, editError, moveDue, needsReason, overlapText, refreshAfterEdit } from './calendarEdit';
import { openSchedule } from '../meet/scheduleStore';
import { instantIn } from '../../lib/zone';
import { useClearOnRefresh, useDayEdit } from './useDayEdit';
import type { WorkChoice } from './TimeEntryEditor';
import { AttendanceRow } from '../attendance/AttendanceCalendar';
import {
  DOW3, HR, MONTHS, SNAP, addDays, clockH, countdown, dateOf, dayLabel, fmtMins, hourOf, isDeadline, isDone, isWorkItem, iso, mondayOf, planKey, RANK,
  type Detail, type Focus, type Meet, type PlanOverrides,
} from './plannerModel';
import { useTodaySignals } from '../home/Signals';
import { Term } from '../../components/Term';
import { buildWeek, daySignature, focusLabel, hoursOf, loggedMinutesOf, readPlan, stickFocus, useTimeline, weekRange, writePlan, type DayView } from './timeline';
import { dayMarks, type DayMark } from './deadline';
import { packColumns, packStyle, type Packed } from './pack';
import { clock24 } from '../work/dueTime';
import './planner.css';
import './calpro.css';
import { ResourceView } from './ResourceView';
import { breakdown, conflicts, downloadText, toIcs, type IcsEvent } from './calpro';
import { canComplete, completeWork, wallAt } from './calendarEdit';
import { reminderApi } from '../reminders/api';
import { appZone } from '../../lib/zone';
import type { OccurrenceScope } from '../meet/meetApi';
import { CalmSheet } from '../../components/calm';
import { Face } from '../../components/Face';


/** Project colours in the order the filter lists them (the design: indigo, orange, teal …); meetings without a project are green. */
const TINTS = ['i', 'o', 't', 'p', 'b', 'r'] as const;
const DOT: Record<string, string> = { i: 'var(--calm-p1)', o: 'var(--calm-p4)', t: 'var(--calm-p2)', p: 'var(--calm-p3)', b: 'var(--calm-p6)', r: 'var(--calm-p5)', g: 'var(--calm-ink3)' };

/** The grid shows the whole day (midnight to midnight) and scrolls to the first thing on it, or 8 AM. */
const G0 = 0, G1 = 24, FIRST_HOUR = 8;
const hourLabel = (h: number) => `${h}:00`;
/** "09:30": the design's 24-hour clock. */
const hm = (h: number) => { const m = Math.round(h * 60); return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
/** Free time worth a hint: a quarter hour or more between 9:00 and 18:00, from now on. */
const FREE0 = 9, FREE1 = 18, FREE_MIN = .25, FREE_MAX = 2;

type View = 'day' | '3day' | 'week' | 'month' | 'agenda' | 'people';
const VIEWS: [View, string, string][] = [['day', 'Day', 'D'], ['3day', '3 days', '3'], ['week', 'Week', 'W'], ['month', 'Month', 'M'], ['agenda', 'Agenda', 'A'], ['people', 'People', 'P']];
/** "GMT+5:30": the app zone's offset now, as the references label the time axis. */
const tzLabel = () => { try { const p = new Intl.DateTimeFormat('en-GB', { timeZone: appZone(), timeZoneName: 'shortOffset' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName'); return p?.value ?? appZone(); } catch { return appZone(); } };
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
  const [railOpen, setRailOpen] = useState(false);
  const [showLayers, setShowLayers] = useState(false);
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
  const week = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(monday, i)), [monday]);
  const days = useMemo(() => (view === 'day' ? [anchor] : view === '3day' ? [anchor, addDays(anchor, 1), addDays(anchor, 2)] : week), [view, anchor, week]);
  const rangeTo = view === '3day' && addDays(anchor, 2) > sunday ? addDays(anchor, 2) : sunday;
  const [q, setQ] = useState('');
  const [recurAsk, setRecurAsk] = useState<{ m: Meet; day: string; start: number; len: number } | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; el: HTMLElement } | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  // The Day panel's day: today when it is on screen, else the first day shown; a click on a day header or empty time chooses another.
  const [selDay, setSelDay] = useState(today);
  useEffect(() => { setSelDay(view === 'day' ? anchor : week.includes(today) ? today : week[0]); }, [monday, view, anchor, week, today]);

  // One request for the visible week (the same one Today makes for this week), the meeting feed for what only Meet knows (who may move it),
  // my own entries as the timesheet has them (locks, stamps) and the week grid (the day's capacity, the work I log time on).
  const tl = useTimeline(rangeTo === sunday ? weekRange(anchor) : { from: monday, to: rangeTo }, { enabled: view !== 'month' && view !== 'people' });
  const grid = useWsQuery(['time', 'grid', monday], () => timeApi.grid(monday), { staleTime: 60_000, retry: false, enabled: view !== 'month', placeholderData: (p) => p });
  const savePlan = (p: PlanOverrides) => { setPlan(p); writePlan(wid, p); };
  const focusRef = useRef<readonly Focus[]>([]);
  const gridRef = useRef<HTMLDivElement>(null);
  // The edits a day takes, shared with Today's "Your day" (the same rules, the same writes, the same refresh).
  const ed = useDayEdit({ from: monday, to: rangeTo, enabled: view !== 'month' && view !== 'people', today, nowH, plan, savePlan, anchor: () => gridRef.current, focus: () => focusRef.current,
    onAdjust: (id) => { const el = gridRef.current?.querySelector<HTMLElement>(`[data-type="time"][data-id="${CSS.escape(id)}"]`); el?.click(); } });
  const { entries, canMove, timeWhy, apply: applyEdits, withFeed } = ed;
  useClearOnRefresh(tl.dataUpdatedAt, ed.clearOver);
  const raw = useMemo(() => applyEdits((tl.data?.events ?? []).filter((t) => !(t.type === 'due' && doneIds.has(t.sourceId)))), [tl.data, doneIds, applyEdits]);
  const projects = useMemo(() => [...new Set(raw.map((e) => e.projectName).filter((n): n is string => !!n))].slice(0, 6), [raw]);
  const tintOf = useCallback((name: string | null) => (name && projects.includes(name) ? TINTS[projects.indexOf(name) % TINTS.length] : 'g'), [projects]);
  const timeline = useMemo(() => { const k = q.trim().toLowerCase(); return raw.filter((t) => (t.projectName ? !hidden.has(t.projectName) : !(hidden.has(PERSONAL) && (t.type === 'meeting' || t.type === 'call'))) && (!k || `${t.title} ${t.key ?? ''} ${t.projectName ?? ''}`.toLowerCase().includes(k))); }, [raw, hidden, q]);
  const calCount = useCallback((p: string | null) => raw.filter((t) => (p ? t.projectName === p : !t.projectName && (t.type === 'meeting' || t.type === 'call'))).length, [raw]);
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
      if (needsReason(err) && !reason) { setDueAsk({ e, date }); return; }
      toast(editError(err, 'The due date could not be moved.'), 'error');
    }
  };
  const dropDue = (e: CalendarEvent, date: string) => {
    if (date === e.date) return;
    if (!canMoveDue(e)) { toast(`${KIND_WORD[e.type] ?? 'This'} dates move from the ${e.type === 'action' ? 'project’s follow-ups' : 'project'}.`, 'error'); return; }
    if (date > e.date && (e.type === 'task' || e.type === 'work')) setDueAsk({ e, date }); else void shiftDue(e, date, '');
  };

  // ---- dragging: a block (move), its top or bottom edge (resize), a deadline flag (to another day header), or empty time (create)
  const [drag, setDrag] = useState<DragState | null>(null);
  const justDragged = useRef(false);
  const afterDrag = () => { justDragged.current = true; window.setTimeout(() => { justDragged.current = false; }, 0); };
  const commit = (it: DragItem, day: string, start: number, end: number) => {
    if (it.kind === 'meeting') { const m = meets.find((x) => x.key === it.key); if (m) { if (m.feed?.recurring) setRecurAsk({ m, day, start, len: end - start }); else void reschedule(m, day, start, end - start); } }
    else if (it.kind === 'time') { const t = raw.find((x) => `time:${x.date}:${x.id}` === it.key); if (t) void moveTime(t, day, start, end); }
    else if (it.kind === 'focus') { const f = wv.focus.find((x) => x.key === it.key); if (f) moveFocusTo(f, day, start, end - start); }
    else if (it.kind === 'reminder') { const t = raw.find((x) => `reminder:${x.date}:${x.id}` === it.key); if (t) void moveRem(t, day, start); }
  };
  const live = useRef({ down: (_e: ReactPointerEvent, _it: DragItem, _mode: DragMode) => {}, open: (_d: Detail, _el: HTMLElement) => {}, alt: (_it: DragItem, _up: boolean) => {},
    create: (_e: ReactPointerEvent, _day: string) => {}, flag: (_e: ReactPointerEvent, _f: CalendarEvent) => {}, free: (_d: string, _a: number, _b: number) => {} });
  live.current.free = (day, a, b) => {
    if (justDragged.current) return;
    const end = Math.min(b, a + 1);
    setSelDay(day); setPick({ day, a, b: end });
    setOpen({ d: { kind: 'create', key: `create:${day}:${a}-${end}`, day, start: a, end }, el: null });
  };
  live.current.down = (ev, it, mode) => {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    // A finger drags only after a long press (350 ms without moving), so a swipe still scrolls the day.
    if (ev.pointerType === 'touch' && !(ev as ReactPointerEvent & { held?: boolean }).held) {
      const x0 = ev.clientX, y0 = ev.clientY, native = ev.nativeEvent;
      let gone = false;
      const early = (e: PointerEvent) => { if (Math.hypot(e.clientX - x0, e.clientY - y0) > 8) quit(); };
      const quit = () => { gone = true; window.clearTimeout(timer); window.removeEventListener('pointermove', early); window.removeEventListener('pointerup', quit); window.removeEventListener('pointercancel', quit); };
      const timer = window.setTimeout(() => {
        if (gone) return; quit();
        const stop = (t: TouchEvent) => t.preventDefault();
        window.addEventListener('touchmove', stop, { passive: false });
        const off = () => { window.removeEventListener('touchmove', stop); window.removeEventListener('pointerup', off); window.removeEventListener('pointercancel', off); };
        window.addEventListener('pointerup', off); window.addEventListener('pointercancel', off);
        navigator.vibrate?.(10);
        live.current.down(Object.assign({}, ev, { clientX: native.clientX, clientY: native.clientY, button: 0, pointerType: 'touch', held: true, stopPropagation: () => {} }) as ReactPointerEvent, it, mode);
      }, 350);
      window.addEventListener('pointermove', early); window.addEventListener('pointerup', quit); window.addEventListener('pointercancel', quit);
      return;
    }
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
      // A click on empty time opens quick create there (an hour from the half hour clicked), like the references; a drag picks the span.
      if (!dragged) { const s0 = Math.min(G1 - 1, Math.floor(a * 2) / 2); setSelDay(day); setPick({ day, a: s0, b: s0 + 1 }); setOpen({ d: { kind: 'create', key: `create:${day}:${s0}-${s0 + 1}`, day, start: s0, end: s0 + 1 }, el: null }); return; }
      if (Math.abs(b - a) < SNAP) { setPick(null); setSelDay(day); return; }
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
    free: (day, start, end) => live.current.free(day, start, end),
  }), []);
  const closeDetail = useCallback(() => { setOpen(null); setPick(null); }, []);
  const openKey = open?.d.key ?? null;

  const projectRefs = useMemo(() => { const m = new Map<string, { id: string; name: string; colour: string }>(); for (const t of raw) if (t.projectId && t.projectName && !m.has(t.projectId)) m.set(t.projectId, { id: t.projectId, name: t.projectName, colour: DOT[tintOf(t.projectName)] }); return [...m.values()].slice(0, 6); }, [raw, tintOf]);
  const actions: DetailActions = {
    previewSpan: (day, a, b) => setPick((p) => (p && p.day === day && p.a === a && p.b === b ? p : { day, a, b })),
    projects: projectRefs,
    moveFocus: (f, day, start) => moveFocusTo(f, day, start, f.end - f.start),
    removeFocus: ed.removeFocus,
    done: (e) => setDoneIds((s) => new Set(s).add(e.id)),
    moveMeeting: (m, day, start) => { const x = meets.find((y) => y.key === m.key) ?? m; if (x.feed?.recurring) setRecurAsk({ m: x, day, start, len: x.end - x.start }); else void reschedule(x, day, start, x.end - x.start); },
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
    // Work due at a time is drawn in the grid as a task chip at that hour, packed with everything else.
    for (const m of marks) spans.push({ key: `task:${d}:${m.key}`, start: m.at, end: m.at + TASK_H });
    // Free time: the gaps of a quarter hour or more between 9:00 and 18:00 (from now on today), as dashed hints that open "new" there.
    const free: { start: number; end: number }[] = [];
    if (d >= today && dateOf(d).getDay() % 6 !== 0 && !(dv?.off.length)) {
      const busy = spans.filter((x) => !x.key.startsWith('reminder:') && !x.key.startsWith('done:')).map((x) => [x.start, x.end] as const).sort((a, b) => a[0] - b[0]);
      let cur = d === today ? Math.max(FREE0, Math.ceil(nowH * 4) / 4) : FREE0;
      for (const [a, b] of [...busy, [FREE1, FREE1] as const]) {
        const gapEnd = Math.min(a, FREE1);
        if (gapEnd - cur >= FREE_MIN - 1e-9 && gapEnd - cur <= FREE_MAX + 1e-9) free.push({ start: cur, end: gapEnd });
        cur = Math.max(cur, b);
        if (cur >= FREE1) break;
      }
    }
    const clash = conflicts([...ms.map((m) => ({ key: m.key, start: m.start, end: m.end })), ...calls.map((c) => { const h = hoursOf(c); return { key: c.id, start: h.start, end: Math.max(h.end, h.start + .25) }; })]);
    return { d, clash, meets: ms, calls, pack: packColumns(spans, PILL_H), focus: fs, logged, done, reminders, marks, free: free.slice(0, 3), overlaps: dv?.overlaps ?? new Map() };
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
  const perDay = week.slice(0, 5).map((d) => ({ d, h: weekMeets.filter((m) => m.day === d).reduce((n, m) => n + (m.end - m.start), 0) }));
  const busiest = perDay.reduce((a, b) => (b.h > a.h ? b : a), perDay[0]);
  const longest = weekMeets.filter((m) => m.day === busiest?.d).sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
  const fmtH = (h: number) => `${Math.round(h * 10) / 10}h`.replace('.0h', 'h');
  const capOf = (d: string) => grid.data?.days?.find((x) => x.date === d)?.targetMinutes ?? (dateOf(d).getDay() % 6 === 0 ? 0 : 480);
  const weekCap = week.reduce((n, d) => n + capOf(d), 0);

  const md = dateOf(anchor);
  const title0: ReactNode = view === 'day'
    ? <>{md.toLocaleDateString('en-GB', { weekday: 'long' })} <em>{md.getDate()} {MONTHS[md.getMonth()].slice(0, 3)} {md.getFullYear()}</em></>
    : view === 'month' ? <>{MONTHS[md.getMonth()]} <em>{md.getFullYear()}</em></>
      : view === 'agenda' ? <>Agenda <em>· {week.includes(today) ? 'this week' : `week of ${dateOf(monday).getDate()} ${MONTHS[dateOf(monday).getMonth()].slice(0, 3)}`}</em></>
        : (() => { const a = dateOf(week[0]), b = dateOf(week[6]); return a.getMonth() === b.getMonth() ? <>{MONTHS[a.getMonth()]} <em>{a.getDate()} – {b.getDate()}, {b.getFullYear()}</em></> : <>{MONTHS[a.getMonth()].slice(0, 3)} {a.getDate()} <em>– {MONTHS[b.getMonth()].slice(0, 3)} {b.getDate()}, {b.getFullYear()}</em></>; })();
  const title: ReactNode = view === 'day' || view === 'month' ? title0 : <>{MONTHS[dateOf(days[0]).getMonth()]} <em className="wp-yr">{dateOf(days[0]).getFullYear()}</em><span className="wp-range">{title0}</span></>;
  const titleText = view === 'day' ? `${DOW3[md.getDay()]} ${md.getDate()} ${MONTHS[md.getMonth()]}` : `Week of ${dateOf(monday).getDate()} ${MONTHS[dateOf(monday).getMonth()]}`;
  const step = view === 'day' ? 1 : view === '3day' ? 3 : 7;
  const shift = (n: number) => {
    if (view === 'month') { const d = new Date(md.getFullYear(), md.getMonth() + n, 1); setAnchor(iso(d)); setMini({ y: d.getFullYear(), m: d.getMonth() }); return; }
    setAnchor(addDays(anchor, n * step));
  };

  const seg = (
    <div className="tb-seg wp-seg" role="tablist" aria-label="Calendar view">
      {VIEWS.map(([v, label, k]) => <button key={v} type="button" role="tab" data-view={v} aria-selected={view === v} title={`${label} (${k})`} onClick={() => setView(v)}>{label}</button>)}
    </div>
  );
  const newEvent = () => {
    const d = days.includes(today) ? today : selDay;
    const s0 = d === today ? Math.min(22, Math.max(9, Math.ceil(nowH * 4) / 4)) : 10;
    if (view === 'month' || view === 'agenda' || view === 'people') { openSchedule({ start: instantIn(d, s0).toISOString(), minutes: 30 }); return; }
    setSelDay(d); setPick({ day: d, a: s0, b: s0 + 1 });
    setOpen({ d: { kind: 'create', key: `create:${d}:${s0}-${s0 + 1}`, day: d, start: s0, end: s0 + 1 }, el: null });
  };
  const inlineDetail = wide && view === 'day';
  const detail = open && <EventDetail key={open.d.key} detail={open.d} anchor={open.el} today={today} nowH={nowH} days={week} actions={actions} onClose={closeDetail} inline={inlineDetail} />;
  const selDv = wv.byDay.get(selDay) ?? buildWeek(timeline, [selDay], today, nowQ, plan, nowH).byDay.get(selDay);
  const overdue = useMemo(() => wv.days.flatMap((d) => d.due).filter((e) => e.overdue && e.date < today), [wv, today]);

  // ---- the left rail: what is next, and the first free time today worth holding
  const upcoming = useMemo(() => meets.filter((m) => m.day > today || (m.day === today && m.end > nowH)).sort((a, b) => a.day.localeCompare(b.day) || a.start - b.start).slice(0, 5), [meets, today, nowH]);
  const firstFree = cols.find((c) => c.d === today)?.free[0] ?? null;
  const joinOf = (m: Meet) => m.e.joinUrl ?? m.feed?.joinUrl ?? null;
  const join = (m: Meet) => { const u = joinOf(m); if (!u) return; if (/^https?:/i.test(u)) window.open(u, '_blank', 'noopener'); else navigate(u); };
  const canJoin = (m: Meet) => !!joinOf(m) && m.day === today && m.start - nowH <= .25 && m.end > nowH;
  // ---- Today in the rail: today's meetings still to come and the work due today, each with a check (work is marked done for real)
  const todayList = useMemo(() => {
    const ms = meets.filter((m) => m.day === today).sort((a, b) => a.start - b.start).map((m) => ({ key: `m:${m.key}`, title: m.e.title, when: `${hm(m.start)} – ${hm(m.end)}`, past: m.end <= nowH, e: null as CalendarEvent | null }));
    const due = (wv.byDay.get(today)?.due ?? []).filter((e) => isWorkItem(e) && !isDone(e)).map((e) => ({ key: `d:${e.type}:${e.id}`, title: `${e.key ? `${e.key} ` : ''}${e.title}`, when: 'Due today', past: false, e }));
    return [...ms, ...due].slice(0, 6);
  }, [meets, wv, today, nowH]);
  const tick = async (row: (typeof todayList)[number]) => {
    setTicked((s) => new Set(s).add(row.key));
    if (!row.e || !canComplete(row.e)) return;
    try { await completeWork(row.e); setDoneIds((s) => new Set(s).add(row.e!.id)); refreshAfterEdit(wid); toast(`✓ ${row.title} done`, 'success'); }
    catch (err) { setTicked((s) => { const n = new Set(s); n.delete(row.key); return n; }); toast(editError(err, 'It could not be marked done.'), 'error'); }
  };
  const bars = useMemo(() => breakdown(weekMeets.map((m) => ({ title: m.e.title, hours: m.end - m.start })), loggedM, focusH), [weekMeets, loggedM, focusH]);
  // ---- Unscheduled: open work this week with no time you chose yet (only a suggested focus block, or none); drag one onto the grid to time-block it (an hour, 15-minute steps)
  const unscheduled = useMemo(() => { const planned = new Set(wv.focus.filter((f) => f.pinned).map((f) => planKey(f.e))); return openItems.filter((e) => !planned.has(planKey(e))).slice(0, 6); }, [wv, openItems]);
  const trayDown = (ev: ReactPointerEvent<HTMLElement>, e: CalendarEvent) => {
    if (ev.button !== 0) return;
    const chip = ev.currentTarget, x0 = ev.clientX, y0 = ev.clientY;
    let dragged = false, drop: { day: string; start: number } | null = null;
    const move = (m: PointerEvent) => {
      if (!dragged && Math.hypot(m.clientX - x0, m.clientY - y0) < 6) return;
      dragged = true; chip.classList.add('lift'); chip.style.transform = `translate(${m.clientX - x0}px, ${m.clientY - y0}px)`;
      const col = (document.elementFromPoint(m.clientX, m.clientY) as HTMLElement | null)?.closest<HTMLElement>('.wp-col[data-day]');
      if (col) { const h = clamp(Math.floor((m.clientY - col.getBoundingClientRect().top) / HR / SNAP) * SNAP, G0, G1 - 1); drop = { day: col.dataset.day!, start: h }; setPick({ day: drop.day, a: h, b: h + 1 }); }
      else { drop = null; setPick(null); }
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      chip.classList.remove('lift'); chip.style.transform = ''; setPick(null);
      if (dragged && drop) actions.planFocus?.(e, drop.day, drop.start, drop.start + 1);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  // ---- export the shown range as .ics (meetings, focus, deadlines as all-day)
  const exportIcs = () => {
    const ev: IcsEvent[] = [];
    for (const c of cols) {
      for (const m of c.meets) ev.push({ uid: `m-${m.key}`, title: m.e.title, start: instantIn(c.d, m.start), end: instantIn(c.d, m.end), url: m.e.joinUrl ?? m.feed?.joinUrl ?? null, description: m.e.projectName });
      for (const f of c.focus) ev.push({ uid: `f-${f.key}`, title: `Focus · ${focusLabel(f.e)}`, start: instantIn(c.d, f.start), end: instantIn(c.d, f.end) });
      for (const e of wv.byDay.get(c.d)?.due ?? []) ev.push({ uid: `d-${e.type}-${e.id}`, title: `Due · ${e.key ? `${e.key} ` : ''}${e.title}`, start: dateOf(c.d), end: dateOf(c.d), allDay: true });
    }
    downloadText(`calendar-${days[0]}.ics`, toIcs(ev));
    toast(`✓ ${ev.length} event${ev.length === 1 ? '' : 's'} exported`, 'success');
  };
  // ---- the ⋯ / right-click menu on a block
  const ctxOf = (el: HTMLElement) => {
    const key = el.dataset.block ?? '';
    const m = el.dataset.type === 'meeting' ? meets.find((x) => `meeting:${x.day}:${x.key}` === key) ?? null : null;
    const f = el.dataset.type === 'focus' ? wv.focus.find((x) => x.key === key) ?? null : null;
    return { m, f };
  };
  const remind = async (m: Meet) => {
    try {
      await reminderApi.create({ title: m.e.title, targetType: 'Meeting', targetId: m.e.id, when: { at: wallAt(m.day, Math.max(0, m.start - .25)), timeZone: appZone() } });
      refreshAfterEdit(wid); toast(`✓ Reminder set 15 min before ${m.e.title}`, 'success');
    } catch (err) { toast(editError(err, 'The reminder could not be set.'), 'error'); }
  };
  const [sp, setSp] = useState<{ x: number; y: number } | null>(null);
  const onSwipeStart = (e: React.TouchEvent) => { if (e.touches.length === 1) setSp({ x: e.touches[0].clientX, y: e.touches[0].clientY }); };
  const onSwipeEnd = (e: React.TouchEvent) => {
    if (!sp || drag) return;
    const t = e.changedTouches[0]; const dx = t.clientX - sp.x, dy = t.clientY - sp.y; setSp(null);
    if (Math.abs(dx) > 70 && Math.abs(dy) < 45) shift(dx < 0 ? 1 : -1);
  };
  const searchRef = useRef<HTMLInputElement>(null);
  // ---- keyboard: N new, T today, D / 3 / W / M / A / P views, ← → previous / next, / search, Esc closes the menu
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (e.metaKey || e.ctrlKey || e.altKey || (t && (t.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')))) return;
    const k = e.key.toLowerCase();
    const v = VIEWS.find((x) => x[2].toLowerCase() === k);
    if (k === 'n') { e.preventDefault(); newEvent(); }
    else if (k === 't') { setAnchor(today); }
    else if (v) setView(v[0]);
    else if (k === '/') { e.preventDefault(); searchRef.current?.focus(); }
    else if ((k === 'arrowleft' || k === 'arrowright') && !t?.closest('[data-block]')) shift(k === 'arrowleft' ? -1 : 1);
    else if (k === 'escape') setCtx(null);
  };
  useEffect(() => { const on = (e: KeyboardEvent) => keys.current(e); window.addEventListener('keydown', on); return () => window.removeEventListener('keydown', on); }, []);
  useEffect(() => { if (!ctx) return; const off = () => setCtx(null); window.addEventListener('pointerdown', off); window.addEventListener('scroll', off, true); return () => { window.removeEventListener('pointerdown', off); window.removeEventListener('scroll', off, true); }; }, [ctx]);
  const toggleCal = (p: string) => setHidden((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  const rail = (
    <>
      <MiniMonth y={mini.y} m={mini.m} today={today} week={view === 'day' ? [anchor] : week} onPick={(d) => { setAnchor(d); if (view === 'month') setView('week'); }}
        onShift={(n) => setMini(({ y, m }) => { const d = new Date(y, m + n, 1); return { y: d.getFullYear(), m: d.getMonth() }; })} />
      <section className="wp-rc wp-filters" aria-label="Calendars" data-testid="wp-layers">
        <div className="wp-ft wp-ft-row">Calendars<button type="button" className="wp-show-dots" aria-expanded={showLayers} aria-label="Show layers" title="Show: meetings, calls, logged time, done, focus, deadlines, reminders" onClick={() => setShowLayers((v) => !v)}>⋯</button></div>
        {projects.map((p) => (
          <label key={p} className={`wp-fr${hidden.has(p) ? ' off' : ''}`}><input type="checkbox" className="sr-only" checked={!hidden.has(p)} onChange={() => toggleCal(p)} />
            <i className="wp-ck" style={{ ['--ck' as string]: DOT[tintOf(p)] }} aria-hidden="true" /><span title={p}>{p}</span><em>{calCount(p) || ''}</em></label>
        ))}
        <label className={`wp-fr${hidden.has(PERSONAL) ? ' off' : ''}`}><input type="checkbox" className="sr-only" checked={!hidden.has(PERSONAL)} onChange={() => toggleCal(PERSONAL)} />
          <i className="wp-ck" style={{ ['--ck' as string]: DOT.g }} aria-hidden="true" /><span>Personal</span><em>{calCount(null) || ''}</em></label>
        {showLayers && LAYERS.map(([k, label]) => (
          <label key={k} className={`wp-fr sub${layers[k] ? '' : ' off'}`} data-layer={k}><input type="checkbox" className="sr-only" checked={layers[k]} onChange={(e) => setLayers((s) => ({ ...s, [k]: e.target.checked }))} /><i className={`k-${k}`} aria-hidden="true" /><span>{label}</span></label>
        ))}
        {showLayers && extra && <div className="wp-extra-in">{extra}</div>}
      </section>
      <section className="wp-rc cp-today" aria-label="Upcoming today" data-testid="cp-today">
        <div className="wp-ft">Upcoming today</div>
        {todayList.length === 0 && <p className="wp-up-none">{tl.isLoading ? 'Reading the day…' : 'Nothing left today.'}</p>}
        {todayList.map((r) => {
          const on = ticked.has(r.key) || r.past;
          return (
            <label key={r.key} className={`cp-chk${on ? ' on' : ''}`}>
              <input type="checkbox" checked={on} disabled={r.past || ticked.has(r.key)} onChange={() => void tick(r)} aria-label={`${r.e ? 'Mark done' : 'Tick off'}: ${r.title}`} />
              <span title={r.title}>{r.title}</span><small>{r.when}</small>
            </label>
          );
        })}
      </section>
      <section className="wp-rc cp-bars" aria-label="Time breakdown" data-testid="cp-breakdown">
        <div className="wp-ft">Time breakdown <em>this week</em></div>
        {bars.map((b) => (
          <div key={b.key} className={`cp-bar ${b.key}`}><span>{b.label}</span><i aria-hidden="true"><em style={{ transform: `scaleX(${b.share})` }} /></i><small>{fmtH(b.hours)}</small></div>
        ))}
      </section>
      {unscheduled.length > 0 && (
        <section className="wp-rc cp-tray" aria-label="Unscheduled" data-testid="cp-tray">
          <div className="wp-ft">Unscheduled <em>drag onto the grid</em></div>
          {unscheduled.map((e) => (
            <button key={`${e.type}:${e.id}`} type="button" className="cp-tray-i" data-testid="cp-tray-item" title={`${e.title} · drag onto the calendar to block time for it`}
              style={{ ['--ck' as string]: DOT[tintOf(e.projectName)] }} onPointerDown={(ev) => trayDown(ev, e)}>
              <i aria-hidden="true" /><span>{e.key ? <b>{e.key}</b> : null}{e.title}</span><small>{dayLabel(e.date, today)}</small>
            </button>
          ))}
        </section>
      )}
      <section className="wp-rc wp-up" aria-label="Upcoming" data-testid="wp-upcoming">
        <div className="wp-ft">Upcoming</div>
        {upcoming.length === 0 && <p className="wp-up-none">{tl.isLoading ? 'Reading the week…' : 'Nothing else this week.'}</p>}
        {upcoming.map((m) => {
          const cd = countdown(m.day, m.start, m.end, today, nowH);
          return (
            <div key={m.key} className="wp-up-r" style={{ ['--ck' as string]: DOT[tintOf(m.e.projectName)] }}>
              <button type="button" className="wp-up-t" onClick={(ev) => { if (!days.includes(m.day)) setAnchor(m.day); live.current.open({ kind: 'meeting', key: `meeting:${m.day}:${m.key}`, m }, ev.currentTarget); }}>
                <b title={m.e.title}>{m.e.title}</b><small>{m.day === today ? '' : `${DOW3[dateOf(m.day).getDay()]} `}{hm(m.start)}{cd && cd !== 'ended' ? ` · ${cd}` : m.feed?.providerName ? ` · ${m.feed.providerName}` : m.e.projectName ? ` · ${m.e.projectName}` : ''}</small>
              </button>
              {canJoin(m) && <button type="button" className="wp-join-pill" onClick={() => join(m)}>Join</button>}
            </div>
          );
        })}
      </section>
      <section className="wp-ai" aria-label="This week" data-testid="wp-week-summary">
        <SiriOrb className="wp-orb" />
        <div>
          {firstFree && <p className="wp-ai-free">{fmtMins(Math.round((firstFree.end - firstFree.start) * 60))} free at {hm(firstFree.start)}.{' '}
            <button type="button" className="wp-ai-act" onClick={() => { setRailOpen(false); live.current.free(today, firstFree.start, firstFree.end); }}>Hold it?</button></p>}
          {!firstFree && <p>{tl.isLoading ? 'Reading the week…' : <>This week: <b>{fmtH(meetH)} meetings</b>{callsN > 0 && <>, {callsN} call{callsN === 1 ? '' : 's'}</>}, {fmtH(focusH)} focus{loggedM > 0 && <>, {fmtMins(loggedM)} logged</>}{doneN > 0 && <>, {doneN} done</>}.{' '}
            {busiest && busiest.h >= 4 && longest ? <>{dateOf(busiest.d).toLocaleDateString('en-GB', { weekday: 'long' })} is overbooked — move {longest.e.title}?</>
              : perDay.length > 0 && <>{dateOf(perDay.reduce((a, b) => (b.h < a.h ? b : a), perDay[0]).d).toLocaleDateString('en-GB', { weekday: 'long' })} is clearest for focused work.</>}</>}</p>}
        </div>
      </section>
    </>
  );

  // ---- the day at a glance (Day view)
  const dayMeets = meets.filter((m) => m.day === selDay && layers.meetings);
  const glanceLogged = layers.logged ? loggedMinutesOf(selDv?.time ?? []) : 0;
  const glance = (
    <section className="wp-glance" aria-label={`${dayLabel(selDay, today)} at a glance`} data-testid="wp-glance">
      <div className="wp-ft">{dateOf(selDay).toLocaleDateString('en-GB', { weekday: 'long' })} at a glance</div>
      <div className="wp-glance-g">
        <span><b>{dayMeets.length + (selDv?.calls.length ?? 0) + (selDv?.focus.length ?? 0)}</b><small>events</small></span>
        <span><b>{fmtMins(Math.round(dayMeets.reduce((n, m) => n + (m.end - m.start), 0) * 60))}</b><small>meetings</small></span>
        <span><b>{fmtMins(Math.round((selDv?.focus ?? []).reduce((n, f) => n + (f.end - f.start), 0) * 60))}</b><small>focus</small></span>
      </div>
      {glanceLogged > 0 && (
        <button type="button" className={`wp-glance-logged${openKey === `loggedDay:${selDay}` ? ' open' : ''}`} data-testid="wp-logged" data-block={`loggedDay:${selDay}`} data-day={selDay}
          aria-label={`${fmtMins(glanceLogged)} logged`} title="The day's logged time — click for the entries"
          onClick={(ev) => handlers.open({ kind: 'loggedDay', key: `loggedDay:${selDay}`, day: selDay, entries: layers.logged ? selDv?.time ?? [] : [] }, ev.currentTarget)}>
          <Icon name="timer" size={12} />{fmtMins(glanceLogged)} logged<Icon name="chevronR" size={12} />
        </button>
      )}
    </section>
  );

  return (
    <div className={`wp wp-${view}`} data-testid="week-planner">
      <ToolbarSlot title={<h1 className="tb-crumb">Calendar</h1>} />
      <aside className="wp-left" aria-label="Month and calendars">{rail}</aside>

      <header className="wp-top">
        <h1 className="wp-h1">Calendar</h1>
        <h2 className="wp-title" aria-label={titleText}>{title}</h2>
        <div className="wp-navs">
          <button type="button" className="wp-nav" aria-label={view === 'day' ? 'Previous day' : view === 'month' ? 'Previous month' : 'Previous week'} onClick={() => shift(-1)}><Icon name="chevronL" size={14} /></button>
          <button type="button" className="wp-today" onClick={() => { setAnchor(today); const d = dateOf(today); setMini({ y: d.getFullYear(), m: d.getMonth() }); }}>Today</button>
          <button type="button" className="wp-nav" aria-label={view === 'day' ? 'Next day' : view === 'month' ? 'Next month' : 'Next week'} onClick={() => shift(1)}><Icon name="chevronR" size={14} /></button>
        </div>
        <span className="wp-tz" title={`Times in ${appZone()}`} data-testid="cp-tz">{tzLabel()}</span>
        <span className="wp-sp" />
        <span className="cp-break" aria-hidden="true" />
        <label className="cp-search"><Icon name="search" size={13} /><span className="sr-only">Search events</span>
          <input ref={searchRef} type="search" placeholder="Search events" aria-label="Search events" value={q} onChange={(e) => setQ(e.target.value)} data-testid="cp-search" /></label>
        {seg}
        <details className="cp-more"><summary aria-label="More calendar actions" title="Export, print, shortcuts">⋯</summary>
          <div className="cp-menu" role="menu">
            <button type="button" role="menuitem" onClick={(e) => { (e.currentTarget.closest('details') as HTMLDetailsElement).open = false; exportIcs(); }} data-testid="cp-export">Export .ics</button>
            <button type="button" role="menuitem" onClick={(e) => { (e.currentTarget.closest('details') as HTMLDetailsElement).open = false; window.print(); }}>Print</button>
            <p className="cp-keys"><kbd>N</kbd> new · <kbd>T</kbd> today · <kbd>D</kbd> <kbd>3</kbd> <kbd>W</kbd> <kbd>M</kbd> <kbd>A</kbd> <kbd>P</kbd> views · <kbd>←</kbd> <kbd>→</kbd> · <kbd>/</kbd> search</p>
          </div>
        </details>
        <button type="button" className="wp-new" data-testid="wp-new" onClick={newEvent}><Icon name="plus" size={13} />New event</button>
        <button type="button" className="wp-rail-btn" onClick={() => setRailOpen(true)} aria-haspopup="dialog">Calendars ›</button>
        {onTab && <span className="wp-hometab"><Segmented label="Home" value="calendar" onChange={onTab} options={[{ id: 'for-you', label: 'For me' }, { id: 'calendar', label: 'Calendar' }]} /></span>}
      </header>

      {view === 'people' ? (
        <ResourceView week={typeof window !== 'undefined' && window.innerWidth <= 760 ? [anchor, addDays(anchor, 1), addDays(anchor, 2)] : week} today={today} q={q} tintOf={tintOf} onOpenLink={(l) => navigate(l)} />
      ) : view === 'month' ? (
        <section className="wp-month" aria-label="Month"><CalendarView mine onOpenTask={(id) => navigate(`/work?item=${id}`)} /></section>
      ) : view === 'agenda' ? (
        <Agenda week={week} today={today} nowH={nowH} cols={cols} tintOf={tintOf} canJoin={canJoin} onJoin={join}
          onOpen={(d, el) => live.current.open(d, el)} loading={tl.isLoading} />
      ) : (
        <section className="wp-main" aria-label={view === 'day' ? 'Day' : titleText}>
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
            <div className={`wp-cal${open ? ' has-open' : ''}${drag ? ' dragging' : ''}`} ref={gridRef} style={{ ['--cols' as string]: days.length }} onKeyDown={onGridKey}
              onContextMenu={(ev) => { const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-block][data-type="meeting"], [data-block][data-type="focus"]'); if (!el) return; ev.preventDefault(); setCtx({ x: ev.clientX, y: ev.clientY, el }); }}
              onTouchStart={onSwipeStart} onTouchEnd={onSwipeEnd}>
              <div className="wp-days">
                <span />
                {days.map((d) => {
                  const dv = wv.byDay.get(d);
                  const lv = dv?.off[0] ?? null;
                  const vk = `leave:${d}`;
                  return (
                    <div key={d} className={`wp-dh${d === today ? ' tdy' : ''}${d === selDay ? ' sel' : ''}${flagOver === d ? ' drop' : ''}`} data-day={d} data-sig={dv ? daySignature(dv) : ''}
                      onClick={(ev) => { if (!(ev.target as HTMLElement).closest('button')) setSelDay(d); }}>
                      <button type="button" className="wp-dh-pick" aria-pressed={d === selDay} aria-label={`Show ${dateOf(d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}`}
                        onClick={() => { setSelDay(d); if (view === 'week' && !wide) { setAnchor(d); setView('day'); } }}>
                        {view === 'day' ? dateOf(d).toLocaleDateString('en-GB', { weekday: 'long' }) : DOW3[dateOf(d).getDay()]}<b>{dateOf(d).getDate()}</b>
                      </button>
                      {lv && <button type="button" className={`wp-leave${openKey === vk ? ' open' : ''}`} data-block={vk} data-day={d} data-start={-3} aria-expanded={openKey === vk}
                        onClick={(ev) => handlers.open({ kind: 'leave', key: vk, day: d, note: lv.type === 'holiday' ? lv.title : lv.note }, ev.currentTarget)}>{lv.type === 'holiday' ? lv.title || 'Holiday' : 'Leave'}</button>}
                    </div>
                  );
                })}
              </div>
              {/* The all-day row (Google Calendar's): each day's deadlines as chips, never on top of the day's blocks. A chip drags to another day to
                  move the date; a timed one shows its time (it is in the grid at that hour too). */}
              {layers.deadlines && strips.some((x) => x.chips.length > 0) && (
                <div className="wp-allday" data-testid="wp-allday">
                  <span className="wp-allday-l">all-day</span>
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
                    {days.includes(today) && <span className="wp-nowl" style={{ top: (nowH - G0) * HR - 8 }}>{hm(nowH)}</span>}
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

      {view === 'day' && (
        <div className="wp-side">
          {glance}
          <DayPanel day={selDay} today={today} nowH={nowH} dv={selDv} meets={dayMeets} focus={(wv.byDay.get(selDay)?.focus ?? []).filter(() => layers.focus)}
            overdue={overdue} peopleOf={(id) => peopleById.get(id) ?? []} entries={entries} capacityMin={capOf(selDay)}
            detail={inlineDetail ? detail : null} detailKey={open?.d.key ?? null}
            week={<WeekStrip week={week.slice(0, 5)} today={today} sel={selDay} onPick={(d) => { setSelDay(d); setAnchor(d); }} wv={wv} meets={weekMeets} capOf={capOf} loggedM={loggedM} weekCap={weekCap} doneN={doneN} callsN={callsN} meetH={meetH} />}
            onOpen={(d, el) => live.current.open(d, el)}
            onCreate={(d) => {
              const s0 = d === today ? Math.max(G0, Math.floor(nowH * 4) / 4 - 1) : 9;
              setSelDay(d); setPick({ day: d, a: s0, b: s0 + 1 });
              setOpen({ d: { kind: 'create', key: `create:${d}:${s0}-${s0 + 1}`, day: d, start: s0, end: s0 + 1 }, el: null });
            }}
            onDone={(e) => setDoneIds((s) => new Set(s).add(e.id))} />
        </div>
      )}
      {!inlineDetail && detail}
      {dueAsk && <DueReason e={dueAsk.e} date={dueAsk.date} today={today} onCancel={() => setDueAsk(null)} onSave={(reason) => { const a = dueAsk; setDueAsk(null); void shiftDue(a.e, a.date, reason); }} />}
      {recurAsk && (
        <div className="ed-scrim wp-ask-scrim" onClick={(ev) => { if (ev.target === ev.currentTarget) setRecurAsk(null); }}>
          <div className="ed ed-pop wp-ask" role="dialog" aria-modal="true" aria-label="Move a repeating meeting" data-testid="recur-ask">
            <div className="ed-kind"><span className="ed-ico" aria-hidden="true"><Icon name="repeat" size={13} /></span>Repeating meeting</div>
            <h2 className="ed-title">{recurAsk.m.e.title}</h2>
            <p className="ed-when">Move to <b>{spanText(recurAsk.day, recurAsk.start, recurAsk.start + recurAsk.len)}</b></p>
            <div className="ed-pick-act cp-recur">
              <button type="button" className="ed-btn ghost" onClick={() => setRecurAsk(null)}>Cancel</button>
              {(['following', 'this'] as OccurrenceScope[]).map((sc) => (
                <button key={sc} type="button" className={`ed-btn${sc === 'this' ? ' primary' : ''}`} onClick={() => { const a = recurAsk; setRecurAsk(null); void reschedule(a.m, a.day, a.start, a.len, false, sc); }}>
                  {sc === 'this' ? 'This event' : 'This and following'}</button>
              ))}
            </div>
          </div>
        </div>
      )}
      {ctx && (() => {
        const { m, f } = ctxOf(ctx.el);
        const close = () => setCtx(null);
        return (
          <div className="cp-ctx" role="menu" data-testid="cp-ctx" style={{ left: Math.min(ctx.x, window.innerWidth - 220), top: Math.min(ctx.y, window.innerHeight - 200) }} onPointerDown={(e) => e.stopPropagation()}>
            <button type="button" role="menuitem" onClick={() => { close(); ctx.el.click(); }}>Open</button>
            {m && <button type="button" role="menuitem" onClick={() => { close(); void remind(m); }}>Set reminder</button>}
            {m && (m.e.joinUrl || m.feed?.joinUrl) && <button type="button" role="menuitem" onClick={() => { close(); join(m); }}>Join call</button>}
            {m && <button type="button" role="menuitem" onClick={() => { close(); downloadText(`${m.e.title.replace(/[^\w-]+/g, '-').slice(0, 40)}.ics`, toIcs([{ uid: `m-${m.key}`, title: m.e.title, start: instantIn(m.day, m.start), end: instantIn(m.day, m.end), url: m.e.joinUrl ?? null }])); }}>Export .ics</button>}
            {f && <button type="button" role="menuitem" className="danger" onClick={() => { close(); ed.removeFocus(f); }}>Remove from plan</button>}
          </div>
        );
      })()}
      <CalmSheet open={railOpen} onClose={() => setRailOpen(false)} title="Calendars" kind="side" width={360}><div className="wp-left in-sheet">{rail}</div></CalmSheet>
    </div>
  );
}

/** Agenda: the week as a list, day by day: time, a colour bar, what, where, who, and Join when it is about to start. */
function Agenda({ week, today, nowH, cols, tintOf, canJoin, onJoin, onOpen, loading }: {
  week: string[]; today: string; nowH: number; cols: { d: string; meets: Meet[]; calls: TimelineEvent[]; focus: Focus[]; marks: DayMark[] }[];
  tintOf: (p: string | null) => string; canJoin: (m: Meet) => boolean; onJoin: (m: Meet) => void; onOpen: (d: Detail, el: HTMLElement) => void; loading: boolean;
}) {
  type Row = { key: string; start: number; end: number; title: string; where: string; people: string[]; tint: string; open: () => Detail; meet?: Meet; past: boolean };
  const days = week.map((d) => {
    const c = cols.find((x) => x.d === d);
    const past = (end: number) => d < today || (d === today && end <= nowH);
    const rows: Row[] = c ? [
      ...c.meets.map((m): Row => ({ key: m.key, start: m.start, end: m.end, title: m.e.title, where: [m.feed?.providerName ?? (m.e.joinUrl ? 'Video' : null)].filter(Boolean).join(' · ') || (m.e.projectName ?? ''),
        people: m.e.people ?? [], tint: DOT[tintOf(m.e.projectName)], meet: m, past: past(m.end), open: () => ({ kind: 'meeting', key: `meeting:${d}:${m.key}`, m }) })),
      ...c.calls.map((t): Row => { const h = hoursOf(t); return { key: t.id, start: h.start, end: Math.max(h.end, h.start + .25), title: t.title, where: 'Call', people: t.people, tint: DOT.g, past: past(h.end), open: () => ({ kind: 'call', key: `call:${d}:${t.id}`, t }) }; }),
      ...c.focus.map((f): Row => ({ key: f.key, start: f.start, end: f.end, title: `Focus · ${focusLabel(f.e)}`, where: 'Desk', people: [], tint: DOT[tintOf(f.e.projectName)], past: past(f.end), open: () => ({ kind: 'focus', key: f.key, f }) })),
      ...c.marks.map((m): Row => ({ key: m.key, start: m.at, end: m.at + TASK_H, title: `${m.e.key ? `${m.e.key} ` : ''}${m.e.title}`, where: m.kind === 'sla' ? 'SLA' : 'Task', people: [], tint: DOT[tintOf(m.e.projectName)], past: past(m.at),
        open: () => ({ kind: 'deadline', key: `deadline:${d}:${m.e.type}:${m.e.id}`, e: m.e, others: [] }) })),
    ].sort((a, b) => a.start - b.start) : [];
    return { d, rows };
  }).filter((x) => x.rows.length > 0 && x.d >= (week.includes(today) ? today : week[0]));
  return (
    <section className="wp-agenda" aria-label="Agenda" data-testid="wp-agenda">
      {loading && <p className="wp-up-none">Reading the week…</p>}
      {!loading && days.length === 0 && <p className="wp-up-none">Nothing else on the calendar this week.</p>}
      {days.map(({ d, rows }) => (
        <div key={d} className="wp-ag-day">
          <div className={`wp-ag-date${d === today ? ' tdy' : ''}`}><small>{dateOf(d).toLocaleDateString('en-GB', { weekday: 'long' })}</small><b>{dateOf(d).getDate()} {MONTHS[dateOf(d).getMonth()].slice(0, 3)}</b></div>
          <ul>
            {rows.map((r) => (
              <li key={r.key} className={r.past ? 'past' : ''} style={{ ['--ck' as string]: r.tint }}>
                <button type="button" className="wp-ag-main" data-block={r.open().key} onClick={(ev) => onOpen(r.open(), ev.currentTarget)}>
                  <span className="wp-ag-t">{hm(r.start)} – {hm(r.end)}</span><i aria-hidden="true" /><b>{r.title}</b><span className="wp-ag-w">{r.where}</span>
                </button>
                <span className="wp-ag-p">{r.people.slice(0, 4).map((p) => <Face key={p} byName name={p} className="wp-ag-av" title={p} text={p.split(/\s+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase()} />)}</span>
                <span className="wp-ag-j">{r.meet && canJoin(r.meet) && <button type="button" className="wp-join-pill" onClick={() => onJoin(r.meet!)}>Join</button>}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

const KIND_WORD: Record<string, string> = { project: 'Project', milestone: 'Milestone', stage: 'Stage', action: 'Follow-up' };

/** Moving a task's date later needs the reason (the task form's rule): asked right where the flag was dropped. */
function DueReason({ e, date, today, onCancel, onSave }: { e: CalendarEvent; date: string; today: string; onCancel: () => void; onSave: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  useEffect(() => { const k = (ev: KeyboardEvent) => { if (ev.key === 'Escape') onCancel(); }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k); }, [onCancel]);
  return (
    <div className="ed-scrim wp-ask-scrim" onClick={(ev) => { if (ev.target === ev.currentTarget) onCancel(); }}>
      <form className="ed ed-pop wp-ask" role="dialog" aria-modal="true" aria-label="Reason for extending" data-testid="due-reason" style={{ ['--ed-tint' as string]: 'var(--ed-red)' }}
        onSubmit={(ev) => { ev.preventDefault(); if (reason.trim()) onSave(reason.trim()); }}>
        <div className="ed-kind"><span className="ed-ico" aria-hidden="true"><Icon name="flag" size={13} /></span>Move the due date</div>
        <h2 className="ed-title">{e.key ? `${e.key} · ` : ''}{e.title}</h2>
        <p className="ed-when">{dayLabel(e.date, today)} → <b>{dayLabel(date, today)}</b></p>
        <label className="wp-ask-l"><span>Reason for extending (required)</span>
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
  /** A free-time hint: start something new there. */
  free: (day: string, start: number, end: number) => void;
}
interface ColData {
  /** Meetings and calls that share time with another (a conflict ring and a warning in the title). */
  clash: Set<string>;
  d: string; meets: Meet[]; calls: TimelineEvent[]; pack: Map<string, Packed>; focus: Focus[];
  logged: TimelineEvent[]; done: TimelineEvent[]; reminders: TimelineEvent[]; marks: DayMark[]; free: { start: number; end: number }[]; overlaps: Map<string, TimelineEvent[]>;
}
const top = (h: number) => (h - G0) * HR;
/** Point-like items (a reminder, a done check) take a quarter hour of the column: the height their pill is drawn with. */
const PILL_H = .25;
/** A task due at a time: a chip half an hour tall. */
const TASK_H = .5;
/** Meetings and calls without a project: the "Personal" calendar. */
const PERSONAL = '__personal';
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
  // The live tooltip while a block is dragged: its new span, or (resizing from the bottom edge) where it now ends and how long it is.
  const snap = drag && drag.day === d ? (drag.mode === 'bottom'
    ? <span className="wp-snap end" data-testid="wp-snap" style={{ top: top(drag.end) + 4 }}>Ends {hm(drag.end)}<em>{fmtMins(Math.round((drag.end - drag.start) * 60))}</em></span>
    : drag.mode === 'top'
      ? <span className="wp-snap" data-testid="wp-snap" style={{ top: top(drag.start) - 26 }}>Starts {hm(drag.start)}<em>{fmtMins(Math.round((drag.end - drag.start) * 60))}</em></span>
      : <span className="wp-snap" data-testid="wp-snap" style={{ top: top(drag.start) - 26 }}>{DOW3[dateOf(d).getDay()]} {hm(drag.start)} – {hm(drag.end)}</span>) : null;
  // A block dragged in from another day is drawn here.
  const visitor = drag && drag.day === d && drag.item.day !== d;
  return (
    <div className={`wp-col${sel ? ' sel' : ''}`} data-day={d} onPointerDown={(e) => h.create(e, d)}>
      {nowTop != null && <div className="wp-now" style={{ top: nowTop }} aria-label={`Now, ${nowLabel}`} data-testid="wp-now" />}
      {ghost}{snap}
      {pick && <div className="wp-pick" data-block={pick.key ?? undefined} data-day={d} data-start={pick.start} style={{ top: top(pick.start), height: (pick.end - pick.start) * HR - 2 }}><span>{hm(pick.start)} – {hm(pick.end)}</span></div>}
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
            title={`${t.approximated ? '≈ Typed in as minutes, placed on the day' : 'Logged'} · ${t.title} · ${hm(sp.start)}–${hm(sp.end)}${ov.length ? ` · ${overlapText(ov[0])}` : ''}${why ? ` · ${why}` : ' · drag to move, drag an edge to resize'}`}
            onPointerDown={why ? undefined : (e) => h.down(e, it, 'move')}
            onKeyDown={(ev) => { if (!why && ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) { ev.preventDefault(); h.alt(it, ev.key === 'ArrowUp'); } }}
            onClick={(ev) => h.open({ kind: 'time', key, t }, ev.currentTarget)}>
            <span className="wp-lbl">{ov.length > 0 && <b className="wp-ovl" aria-hidden="true">!</b>}{t.running ? 'Running · ' : ''}{t.title}</span><small>{t.approximated ? '≈ ' : ''}{hm(pos.start)}{t.running ? '' : ` – ${hm(pos.end)}`}</small>
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
            <span className="wp-f-k">{nowAt != null && f.start <= nowAt && nowAt < f.end ? 'Focus now' : 'Focus'}</span><span className="wp-lbl">{focusLabel(f.e)}</span><small>{hm(pos.start)} – {hm(pos.end)}</small>
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
            title={`Call · ${t.title} · ${hm(sp.start)}–${hm(end)}`} onClick={(ev) => h.open({ kind: 'call', key, t }, ev.currentTarget)}>
            <Icon name="phone" size={10} /><span className="wp-lbl">{t.title}</span>{!xs && <small>{hm(sp.start)}{t.running ? ' · live' : ` – ${hm(sp.end)}`}{t.people.length ? ` · ${t.people.length} people` : ''}</small>}
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
        const sub = len >= 1.25 ? `${hm(pos.start)} – ${hm(pos.end)}` : `${hm(pos.start)}${people ? ` · ${people}` : m.e.projectName ? ` · ${m.e.projectName}` : ''}`;
        const it: DragItem = { kind: 'meeting', key: m.key, day: d, start: m.start, end: m.end, resizable: true, label: m.e.title, cls: tintOf(m.e.projectName) };
        const clash = col.clash.has(m.key);
        const link = !!(m.e.joinUrl || m.feed?.joinUrl);
        const faces = len >= 1.4 && !narrowOf(pk) ? (m.e.people ?? []).slice(0, 3) : [];
        return (
          <button key={m.key} type="button" className={`wp-e ${tintOf(m.e.projectName)}${clash ? ' clash' : ''}${xs ? ' xs' : ''}${narrowOf(pk) && !pos.lifted ? ' narrow' : ''}${pos.lifted ? ' lift' : ''}${why ? '' : ' movable'}${openKey === key ? ' open' : ''}`}
            data-block={key} data-day={d} data-start={m.start} data-type="meeting" aria-expanded={openKey === key}
            style={{ top: top(pos.start), height: Math.max(.25, len) * HR - 2, ...(pos.lifted ? {} : packStyle(pk)) }}
            title={`${clash ? 'Conflict · overlaps another meeting · ' : ''}${why ? `${m.e.title} · ${why}` : `${m.e.title} · drag to move, drag an edge to change its length (Alt+↑/↓) · right-click for more`}`}
            onClick={(ev) => h.open({ kind: 'meeting', key, m }, ev.currentTarget)}
            onPointerDown={why ? undefined : (ev) => h.down(ev, it, 'move')}
            onKeyDown={(ev) => { if (!why && ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) { ev.preventDefault(); h.alt(it, ev.key === 'ArrowUp'); } }}>
            <span className="wp-lbl">{link && <Icon name="video" size={10} />}{m.e.title}</span>{!xs && <small>{sub}</small>}
            {faces.length > 0 && <span className="cp-faces" aria-hidden="true">{faces.map((p) => <Face key={p} byName name={p} className="cp-face" text={p.split(/\s+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase()} />)}{(m.e.people?.length ?? 0) > 3 && <em>+{(m.e.people?.length ?? 0) - 3}</em>}</span>}
            {clash && !xs && <span className="cp-clash" aria-label="Conflict">!</span>}
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
            style={{ top: top(at0), ...packStyle(col.pack.get(key)) }} title={`Done ${hm(at0)} · ${t.key ? `${t.key} ` : ''}${t.title}`}
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
            style={{ top: top(pos.start), ...(pos.lifted ? {} : packStyle(col.pack.get(key))) }} title={`Reminder · ${hm(hr)} · ${t.title}${movable ? ' · drag to move' : ''}`}
            onPointerDown={movable ? (e) => h.down(e, it, 'move') : undefined}
            onClick={(ev) => h.open({ kind: 'reminder', key, t }, ev.currentTarget)}>
            <i aria-hidden="true" />{t.title}
          </button>
        );
      })}
      {/* a deadline with a time: a thin line at its hour (its chip is in the day's due strip, its time in the margin), never over a block's text */}
      {!dragging && col.free.map((f) => {
        const mins = Math.round((f.end - f.start) * 60);
        return (
          <button key={`free:${f.start}`} type="button" className={`wp-free${mins < 45 ? ' xs' : ''}`} data-testid="wp-free" data-day={d} style={{ top: top(f.start) + 1, height: Math.max(14, (f.end - f.start) * HR - 3) }}
            title={`${fmtMins(mins)} free from ${hm(f.start)} · click to plan something here`} onClick={() => h.free(d, f.start, f.end)}>
            <span>{fmtMins(mins)} free</span>{mins >= 60 && <small>Good for focus</small>}
          </button>
        );
      })}
      {col.marks.map((m) => {
        const key = `task:${d}:${m.key}`;
        const fk = `deadline:${d}:${m.e.type}:${m.e.id}`;
        return (
          <button key={key} type="button" className={`wp-task${m.late ? ' late' : ''}${m.kind === 'sla' ? ' sla' : ''}${openKey === fk ? ' open' : ''}`} data-testid="wp-task" data-block={fk} data-day={d} data-start={m.at}
            aria-expanded={openKey === fk} style={{ top: top(m.at), height: TASK_H * HR - 2, ...packStyle(col.pack.get(key)) }}
            title={`${m.kind === 'sla' ? 'SLA' : 'Due'} ${clock24(m.iso)} · ${m.e.key ? `${m.e.key} ` : ''}${m.e.title}`}
            onClick={(ev) => h.open({ kind: 'deadline', key: fk, e: m.e, others: [] }, ev.currentTarget)}>
            <i aria-hidden="true" /><span className="wp-lbl">{m.e.key ? `${m.e.key} ` : ''}{m.e.title}</span>
          </button>
        );
      })}
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
        <button type="button" className="wp-empty-btn" onClick={() => navigate('/meetings?new=schedule')}>Schedule meeting</button>
        {risky?.href
          ? <button type="button" className="wp-empty-btn" title={`${risky.title} · ${risky.reason}`} onClick={() => navigate(risky.href!)}>Open riskiest project</button>
          : <button type="button" className="wp-empty-btn" onClick={() => navigate('/work/projects?status=AtRisk')}>Projects at risk</button>}
      </div>
    </div>
  );
}
