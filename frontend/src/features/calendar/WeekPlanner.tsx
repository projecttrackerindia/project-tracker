import { Face } from '../../components/Face';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { meetingApi } from '../../api/endpoints';
import type { CalendarEvent, TimelineEvent } from '../../api/types';
import { Icon } from '../../components/Icon';
import { ErrorState, Segmented } from '../../components/ui';
import { todayISO } from '../../lib/format';
import { instantIn } from '../../lib/zone';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { meetApi } from '../meet/meetApi';
import { ToolbarSlot } from '../talk/ToolbarSlot';
import { undoToast } from '../talk/flyTask';
import { CalendarView } from './CalendarView';
import { EventDetail, type DetailActions } from './EventDetail';
import { AttendanceRow } from '../attendance/AttendanceCalendar';
import {
  DOW3, HR, MONTHS, SNAP, addDays, clockH, dateOf, fmtMins, hourOf, hrefOf, isDeadline, iso, lanes, mondayOf, planKey, RANK,
  type Detail, type Focus, type Meet, type PlanOverrides,
} from './plannerModel';
import { buildWeek, daySignature, focusLabel, hoursOf, readPlan, useTimeline, weekRange, writePlan, type DayView } from './timeline';
import './planner.css';

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
export function WeekPlanner({ onTab, extra }: { onTab?: (t: 'for-you' | 'calendar') => void; /** Under the ✦ line (Subscribe in Google / Outlook). */ extra?: ReactNode }) {
  const navigate = useNavigate();
  const wid = useWorkspaceId();
  const today = todayISO();
  const [view, setView] = useState<View>(() => (typeof window !== 'undefined' && window.innerWidth < 760 ? 'day' : 'week'));
  const [anchor, setAnchor] = useState(today);
  const [mini, setMini] = useState(() => { const d = dateOf(today); return { y: d.getFullYear(), m: d.getMonth() }; });
  const [layers, setLayers] = useState<Record<Layer, boolean>>({ meetings: true, calls: true, logged: true, done: true, focus: true, deadlines: true, reminders: true });
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [moved, setMoved] = useState<Record<string, { day: string; start: number }>>({});
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

  // One request for the visible week (the same one Today makes for this week), and the meeting feed for what only Meet knows (who may move it).
  const tl = useTimeline(weekRange(anchor), { enabled: view !== 'month' });
  const feed = useWsQuery(['meet', 'feed', monday], () => meetApi.feed({ from: `${monday}T00:00:00`, to: `${addDays(sunday, 1)}T00:00:00` }), { staleTime: 60_000, retry: false, enabled: view !== 'month' });
  const raw = useMemo(() => (tl.data?.events ?? []).filter((t) => !(t.type === 'due' && doneIds.has(t.sourceId))), [tl.data, doneIds]);
  const projects = useMemo(() => [...new Set(raw.map((e) => e.projectName).filter((n): n is string => !!n))].slice(0, 6), [raw]);
  const tintOf = useCallback((name: string | null) => (name && projects.includes(name) ? TINTS[projects.indexOf(name) % TINTS.length] : 'g'), [projects]);
  const timeline = useMemo(() => raw.filter((t) => !t.projectName || !hidden.has(t.projectName)), [raw, hidden]);
  const wv = useMemo(() => buildWeek(timeline, week, today, nowQ, plan), [timeline, week, today, nowQ, plan]);
  const events = useMemo(() => wv.days.flatMap((d) => [...d.meets.map((m) => m.e), ...d.due]), [wv]);

  const meets: Meet[] = useMemo(() => {
    const byStart = new Map((feed.data?.items ?? []).map((f) => [`${f.id}|${Date.parse(f.start)}`, f]));
    const byId = new Map((feed.data?.items ?? []).map((f) => [f.id, f]));
    return wv.days.flatMap((d) => d.meets).map((m) => {
      const f = byStart.get(`${m.e.id}|${Date.parse(m.e.startsAt!)}`) ?? byId.get(m.e.id) ?? null;
      const mv = moved[m.key];
      const len = m.end - m.start;
      return mv ? { ...m, day: mv.day, start: mv.start, end: mv.start + len, feed: f } : { ...m, feed: f };
    });
  }, [wv, feed.data, moved]);

  // ---- drag to reschedule
  const [drag, setDrag] = useState<{ key: string; day: string; start: number; moved: boolean } | null>(null);
  const justDragged = useRef(false);
  const dragRef = useRef<{ key: string; x: number; y: number; day: string; start: number; colW: number; dayIdx: number } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const placed = useMemo(() => meets.map((m) => (drag && drag.key === m.key && drag.moved ? { ...m, day: drag.day, start: drag.start, end: drag.start + (m.end - m.start) } : m)), [meets, drag]);
  const focus = useMemo(() => (layers.focus ? wv.focus.filter((f) => days.includes(f.day)) : []), [layers.focus, wv, days]);

  const canMove = useCallback((m: Meet): string | null => {
    if (!m.feed) return 'Open the meeting in Messages to move it';
    if (!m.feed.canManage) return 'Only the organiser can move this meeting';
    if (m.feed.recurring) return 'A recurring meeting moves from its series in Messages';
    if (Date.parse(m.feed.end) < Date.now()) return 'This meeting has ended';
    return null;
  }, []);
  const reschedule = async (m: Meet, day: string, start: number, undo = false) => {
    const from = { day: m.day, start: m.start };
    const len = m.end - m.start;
    const at = (d: string, h: number) => instantIn(d, h);   // the wall-clock time in the app's zone, not the device's
    setMoved((s) => ({ ...s, [m.key]: { day, start } }));
    try {
      const body = { startTime: at(day, start).toISOString(), endTime: at(day, start + len).toISOString() };
      if (m.e.projectId) await meetingApi.reschedule(m.e.id, body); else await meetingApi.workspaceReschedule(m.e.id, body);
      void invalidateWorkspace(wid, 'meet');
      void invalidateWorkspace(wid, 'timeline');
      if (undo) { toast('Moved back.', 'info'); return; }
      const before = focus.filter((f) => f.day === day && f.end > start && f.start < start + len);
      const label = `${m.e.title} moved to ${DOW3[dateOf(day).getDay()]} ${clockH(start)}${before.length ? ' · focus replanned' : ''}`;
      undoToast(label, () => void reschedule({ ...m, day, start, end: start + len }, from.day, from.start, true), gridRef.current, 46);
    } catch (err) {
      setMoved((s) => ({ ...s, [m.key]: from }));
      toast(err instanceof ApiError ? err.message : 'Could not move the meeting.', 'error');
    }
  };

  // Pointer and key handlers change every render; the day columns get stable ones that read the latest through a ref, so a column only
  // re-renders when its own blocks change (not on hover, not when another day's block is dragged).
  const live = useRef({ onPointerDown: (_e: ReactPointerEvent, _m: Meet) => {}, onPointerMove: (_e: ReactPointerEvent, _m: Meet) => {}, onPointerUp: (_m: Meet) => {},
    onCancel: () => {}, onAltMove: (_m: Meet, _up: boolean) => {}, onOpen: (_d: Detail, _el: HTMLElement) => {} });
  live.current.onPointerDown = (ev, m) => {
    if (ev.button !== 0 || canMove(m)) return;
    const col = gridRef.current?.querySelector<HTMLElement>('.wp-col');
    dragRef.current = { key: m.key, x: ev.clientX, y: ev.clientY, day: m.day, start: m.start, colW: col?.getBoundingClientRect().width ?? 140, dayIdx: days.indexOf(m.day) };
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  };
  live.current.onPointerMove = (ev, m) => {
    const d = dragRef.current;
    if (!d || d.key !== m.key) return;
    const dy = ev.clientY - d.y, dx = ev.clientX - d.x;
    if (!drag && Math.hypot(dx, dy) < 5) return;
    const len = m.end - m.start;
    const start = Math.min(G1 - len, Math.max(G0, Math.round((d.start + dy / HR) / SNAP) * SNAP));
    const idx = Math.min(days.length - 1, Math.max(0, d.dayIdx + Math.round(dx / d.colW)));
    if (!drag || drag.day !== days[idx] || drag.start !== start) setDrag({ key: m.key, day: days[idx], start, moved: true });
  };
  live.current.onPointerUp = (m) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || !drag || drag.key !== m.key) { setDrag(null); return; }
    const { day, start } = drag;
    setDrag(null);
    justDragged.current = true;
    window.setTimeout(() => { justDragged.current = false; }, 0);
    if (day !== m.day || Math.abs(start - m.start) > 1e-6) void reschedule(m, day, start);
  };
  live.current.onCancel = () => { dragRef.current = null; setDrag(null); };
  live.current.onAltMove = (m, up) => { if (!canMove(m)) void reschedule(m, m.day, Math.min(G1 - (m.end - m.start), Math.max(G0, m.start + (up ? -SNAP : SNAP)))); };
  live.current.onOpen = (d, el) => {
    if (justDragged.current || drag?.moved) return;
    if (d.kind === 'meeting') setSelected(d.m.key);
    setOpen((o) => (o?.d.key === d.key ? null : { d, el }));
  };
  const handlers = useMemo<ColHandlers>(() => ({
    down: (e, m) => live.current.onPointerDown(e, m), move: (e, m) => live.current.onPointerMove(e, m), up: (m) => live.current.onPointerUp(m),
    cancel: () => live.current.onCancel(), alt: (m, up) => live.current.onAltMove(m, up), open: (d, el) => live.current.onOpen(d, el),
  }), []);
  const closeDetail = useCallback(() => setOpen(null), []);
  const openKey = open?.d.key ?? null;

  const savePlan = (p: PlanOverrides) => { setPlan(p); writePlan(wid, p); };
  const actions: DetailActions = {
    moveFocus: (f, day, start) => {
      const before = plan;
      savePlan({ ...plan, [planKey(f.e)]: { day, start, len: f.end - f.start } });
      undoToast(`Focus on ${focusLabel(f.e)} moved to ${DOW3[dateOf(day).getDay()]} ${clockH(start)}`, () => savePlan(before), gridRef.current, 46);
    },
    removeFocus: (f) => {
      const before = plan;
      savePlan({ ...plan, [planKey(f.e)]: 'removed' });
      undoToast(`${focusLabel(f.e)} taken out of your plan`, () => savePlan(before), gridRef.current, 46);
    },
    done: (e) => setDoneIds((s) => new Set(s).add(e.id)),
    moveMeeting: (m, day, start) => void reschedule(meets.find((x) => x.key === m.key) ?? m, day, start),
    canMoveMeeting: canMove,
  };
  // ---- the blocks of each day, laid out once per data change (not per render)
  const cols = useMemo(() => days.map((d) => {
    const dv: DayView | undefined = wv.byDay.get(d) ?? buildWeek(timeline, [d], today, nowQ, plan).byDay.get(d);
    const ms = placed.filter((m) => layers.meetings && m.day === d);
    const calls = layers.calls ? dv?.calls ?? [] : [];
    const spans = [...ms.map((m) => ({ key: m.key, start: m.start, end: m.end })), ...calls.map((c) => { const h = hoursOf(c); return { key: c.id, start: h.start, end: Math.max(h.end, h.start + .25) }; })];
    return {
      d, meets: ms, calls, lanes: lanes(spans),
      focus: focus.filter((f) => f.day === d),
      logged: layers.logged ? dv?.time ?? [] : [],
      done: layers.done ? dv?.done ?? [] : [],
      reminders: layers.reminders ? dv?.reminders ?? [] : [],
    };
  }), [days, wv, timeline, today, nowQ, plan, placed, layers, focus]);
  const origByKey = useMemo(() => new Map(meets.map((m) => [m.key, m])), [meets]);
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

  // ---- the inspector: the chosen meeting, else the next one
  const upcoming = [...meets].filter((m) => days.includes(m.day)).sort((a, b) => (a.day + a.start.toFixed(2)).localeCompare(b.day + b.start.toFixed(2)));
  const nextUp = upcoming.find((m) => m.day > today || (m.day === today && m.end > nowH)) ?? upcoming[0] ?? null;
  const sel = meets.find((m) => m.key === selected) ?? nextUp;

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

  const title = view === 'day'
    ? `${DOW3[dateOf(anchor).getDay()]} ${dateOf(anchor).getDate()} ${MONTHS[dateOf(anchor).getMonth()]}`
    : (() => { const a = dateOf(week[0]), b = dateOf(week[4]); return a.getMonth() === b.getMonth() ? `${a.getDate()} – ${b.getDate()} ${MONTHS[b.getMonth()]}` : `${a.getDate()} ${MONTHS[a.getMonth()].slice(0, 3)} – ${b.getDate()} ${MONTHS[b.getMonth()].slice(0, 3)}`; })();

  const seg = (
    <div className="tb-seg" role="tablist" aria-label="Calendar view">
      {(['day', 'week', 'month'] as const).map((v) => <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)}>{v[0].toUpperCase() + v.slice(1)}</button>)}
    </div>
  );

  return (
    <div className={`wp wp-${view}`} data-testid="week-planner">
      <ToolbarSlot title={<h1>Calendar</h1>}>{seg}</ToolbarSlot>
      <div className="wp-phone-head tb-wide-hide">
        <h1>Calendar</h1>
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
            <h2>{title}</h2>{view === 'week' && <span className="wp-wk">Week {weekNo(monday)}</span>}
            <span className="wp-sp" />
            <button type="button" className="wp-nav" aria-label={view === 'day' ? 'Previous day' : 'Previous week'} onClick={() => setAnchor(addDays(anchor, view === 'day' ? -1 : -7))}><Icon name="chevronL" size={14} /></button>
            <button type="button" className="wp-today" onClick={() => { setAnchor(today); const d = dateOf(today); setMini({ y: d.getFullYear(), m: d.getMonth() }); }}>Today</button>
            <button type="button" className="wp-nav" aria-label={view === 'day' ? 'Next day' : 'Next week'} onClick={() => setAnchor(addDays(anchor, view === 'day' ? 1 : 7))}><Icon name="chevronR" size={14} /></button>
          </div>
          {tl.isError ? <ErrorState error={tl.error} retry={() => void tl.refetch()} /> : (
            <div className={`wp-cal${open ? ' has-open' : ''}`} ref={gridRef} style={{ ['--cols' as string]: days.length }} onKeyDown={onGridKey}>
              <div className="wp-days">
                <span />
                {days.map((d) => {
                  const dv = wv.byDay.get(d);
                  const due = layers.deadlines ? (dv?.due ?? []).filter((e) => isDeadline(e) || e.overdue)
                    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || ['project', 'milestone', 'stage'].indexOf(b.type) - ['project', 'milestone', 'stage'].indexOf(a.type) || (RANK[a.priority ?? ''] ?? 4) - (RANK[b.priority ?? ''] ?? 4)) : [];
                  const flag = due[0];
                  const ents = layers.logged ? dv?.time ?? [] : [];
                  const mins = ents.reduce((n, t) => n + (t.minutes ?? 0), 0);
                  const lv = dv?.off[0] ?? null;
                  const fk = flag ? `deadline:${d}:${flag.type}:${flag.id}` : '', lk = `loggedDay:${d}`, vk = `leave:${d}`;
                  return (
                    <div key={d} className={`wp-dh${d === today ? ' tdy' : ''}`} data-day={d} data-sig={dv ? daySignature(dv) : ''}>
                      {DOW3[dateOf(d).getDay()]}<b>{dateOf(d).getDate()}</b>
                      {mins > 0 && (
                        <button type="button" className={`wp-logged${openKey === lk ? ' open' : ''}`} data-testid="wp-logged" data-block={lk} data-day={d} data-start={-2}
                          aria-label={`${fmtMins(mins)} logged`} aria-expanded={openKey === lk} title={`Logged ${fmtMins(mins)} — click for the entries`}
                          onClick={(ev) => handlers.open({ kind: 'loggedDay', key: lk, day: d, entries: ents }, ev.currentTarget)}>
                          <Icon name="timer" size={10} />{fmtMins(mins)}
                        </button>
                      )}
                      {lv && <button type="button" className={`wp-leave${openKey === vk ? ' open' : ''}`} data-block={vk} data-day={d} data-start={-3} aria-expanded={openKey === vk}
                        onClick={(ev) => handlers.open({ kind: 'leave', key: vk, day: d, note: lv.type === 'holiday' ? lv.title : lv.note }, ev.currentTarget)}>{lv.type === 'holiday' ? 'Holiday' : 'Leave'}</button>}
                      {flag && (
                        <button type="button" className={`wp-flag${flag.overdue ? ' late' : ''}${openKey === fk ? ' open' : ''}`} data-block={fk} data-day={d} data-start={-1} aria-expanded={openKey === fk} data-testid="wp-flag"
                          title={`${flag.key ? `${flag.key} ` : ''}${flag.title}${flag.projectName ? ` · ${flag.projectName}` : ''} — ${flag.overdue ? 'overdue' : 'due'}${due.length > 1 ? ` (+${due.length - 1} more)` : ''}`}
                          onClick={(ev) => handlers.open({ kind: 'deadline', key: fk, e: flag, others: due.slice(1) }, ev.currentTarget)}>
                          <Icon name="flag" size={9} />{flag.key ?? flag.title}{due.length > 1 && <em>+{due.length - 1}</em>}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              <AttendanceRow days={days} today={today} />
              <div className="wp-scroll" ref={scrollRef} data-testid="wp-scroll">
                <div className="wp-body" style={{ height: (G1 - G0) * HR }}>
                  <div className="wp-lines" aria-hidden="true" />
                  <div className="wp-hrs" aria-hidden="true">
                    {Array.from({ length: G1 - G0 }, (_, i) => G0 + i).map((h) => (
                      <span key={h} data-hour={h} style={{ top: (h - G0) * HR, opacity: h === G0 ? 0 : 1 }}>{hourLabel(h)}</span>
                    ))}
                    {days.includes(today) && <span className="wp-nowl" style={{ top: (nowH - G0) * HR - 7 }}>{clockH(nowH)}</span>}
                  </div>
                  {cols.map((c) => (
                    <DayCol key={c.d} col={c} nowTop={c.d === today ? (nowH - G0) * HR : null} nowLabel={clockH(nowH)}
                      openKey={openKey?.includes(`:${c.d}:`) ? openKey : null}
                      selKey={sel && sel.day === c.d ? sel.key : null} drag={drag && drag.moved && c.meets.some((m) => m.key === drag.key) ? drag.key : null} dragging={!!drag?.moved}
                      tintOf={tintOf} origByKey={origByKey} canMove={canMove} h={handlers} />
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {view !== 'month' && <Inspector m={sel} events={events} nowH={nowH} today={today} onOpen={(e) => navigate(hrefOf(e))} />}
      {open && <EventDetail detail={open.d} anchor={open.el} today={today} nowH={nowH} days={week} actions={actions} onClose={closeDetail} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ one day
interface ColHandlers {
  down: (e: ReactPointerEvent, m: Meet) => void; move: (e: ReactPointerEvent, m: Meet) => void; up: (m: Meet) => void; cancel: () => void;
  alt: (m: Meet, up: boolean) => void; open: (d: Detail, el: HTMLElement) => void;
}
interface ColData {
  d: string; meets: Meet[]; calls: TimelineEvent[]; lanes: Map<string, { lane: number; of: number }>; focus: Focus[];
  logged: TimelineEvent[]; done: TimelineEvent[]; reminders: TimelineEvent[];
}
const top = (h: number) => (h - G0) * HR;

/** One day of the week. Memoised: hover is pure CSS, and a column re-renders only when its own blocks, the now line or the open card on it change. */
const DayCol = memo(function DayCol({ col, nowTop, nowLabel, openKey, selKey, drag, dragging, tintOf, origByKey, canMove, h }: {
  col: ColData; nowTop: number | null; nowLabel: string; openKey: string | null; selKey: string | null; drag: string | null; dragging: boolean;
  tintOf: (p: string | null) => string; origByKey: Map<string, Meet>; canMove: (m: Meet) => string | null; h: ColHandlers;
}) {
  const { d } = col;
  return (
    <div className="wp-col" data-day={d}>
      {nowTop != null && <div className="wp-now" style={{ top: nowTop }} aria-label={`Now, ${nowLabel}`} data-testid="wp-now" />}
      {col.logged.map((t) => {
        const sp = hoursOf(t);
        const key = `time:${d}:${t.id}`;
        // Under a meeting, call or focus block the entry is a slim green bar at the column's edge (still a button), so nothing is drawn twice.
        const end = Math.max(sp.end, sp.start + .25);
        const under = [...col.meets, ...col.focus].some((m) => m.start < end && m.end > sp.start) || col.calls.some((c) => { const x = hoursOf(c); return x.start < end && Math.max(x.end, x.start + .25) > sp.start; });
        return (
          <button key={t.id} type="button" className={`wp-e lg${under ? ' thin' : ''}${t.running ? ' run' : ''}${t.approximated ? ' ap' : ''}${openKey === key ? ' open' : ''}`} aria-label={`Logged ${fmtMins(t.minutes ?? 0)} · ${t.title}`} data-block={key} data-day={d} data-start={sp.start} data-type="time"
            aria-expanded={openKey === key} style={{ top: top(sp.start), height: Math.max(16, (Math.max(sp.end, sp.start + .25) - sp.start) * HR - 2) }}
            title={`${t.approximated ? 'Logged (typed in, placed on the day)' : 'Logged'} · ${t.title}`}
            onClick={(ev) => h.open({ kind: 'time', key, t }, ev.currentTarget)}>
            {t.running ? 'Running · ' : ''}{t.title}<small>{t.approximated ? '≈ ' : ''}{clockH(sp.start)}{t.running ? '' : ` – ${clockH(sp.end)}`}</small>
          </button>
        );
      })}
      {col.focus.map((f) => (
        <button key={f.key} type="button" className={`wp-e f${dragging ? ' dim' : ''}${openKey === f.key ? ' open' : ''}`} data-block={f.key} data-day={d} data-start={f.start} data-type="focus" aria-expanded={openKey === f.key}
          style={{ top: top(f.start), height: (f.end - f.start) * HR - 2 }} title={`Focus · ${focusLabel(f.e)}`}
          onClick={(ev) => h.open({ kind: 'focus', key: f.key, f }, ev.currentTarget)}>
          <span className="wp-f-k">Focus</span>{focusLabel(f.e)}<small>{clockH(f.start)} – {clockH(f.end)}</small>
        </button>
      ))}
      {col.calls.map((t) => {
        const sp = hoursOf(t);
        const end = Math.max(sp.end, sp.start + .25);
        const l = col.lanes.get(t.id) ?? { lane: 0, of: 1 };
        const key = `call:${d}:${t.id}`;
        const xs = end - sp.start <= .3;
        return (
          <button key={t.id} type="button" className={`wp-e c${xs ? ' xs' : ''}${t.running ? ' run' : ''}${openKey === key ? ' open' : ''}`} data-block={key} data-day={d} data-start={sp.start} data-type="call"
            aria-expanded={openKey === key} style={{ top: top(sp.start), height: (end - sp.start) * HR - 2, left: `calc(${(l.lane / l.of) * 100}% + 3px)`, width: `calc(${100 / l.of}% - 6px)` }}
            title={`Call · ${t.title}`} onClick={(ev) => h.open({ kind: 'call', key, t }, ev.currentTarget)}>
            <Icon name="phone" size={10} />{t.title}{!xs && <small>{clockH(sp.start)}{t.running ? ' · live' : ` – ${clockH(sp.end)}`}{t.people.length ? ` · ${t.people.length} people` : ''}</small>}
          </button>
        );
      })}
      {col.meets.map((m) => {
        const orig = origByKey.get(m.key) ?? m;
        const why = canMove(orig);
        const len = m.end - m.start;
        const xs = len <= .3;
        const l = col.lanes.get(m.key) ?? { lane: 0, of: 1 };
        const isDrag = drag === m.key;
        const people = (m.e.people ?? []).slice(1, 3).map((p) => p.split(' ')[0]).join(', ');
        const sub = len >= 1.25 ? `${clockH(m.start)} – ${clockH(m.end)}` : `${clockH(m.start)}${people ? ` · ${people}` : m.e.projectName ? ` · ${m.e.projectName}` : ''}`;
        const key = `meeting:${d}:${m.key}`;
        return (
          <div key={m.key} className="wp-slot">
            {isDrag && <div className="wp-ghost" style={{ top: top(orig.start), height: len * HR - 2 }} aria-hidden="true" />}
            {isDrag && <span className="wp-snap" style={{ top: top(m.start) - 22 }}>{clockH(m.start)}</span>}
            <button type="button" className={`wp-e ${tintOf(m.e.projectName)}${xs ? ' xs' : ''}${selKey === m.key ? ' sel' : ''}${isDrag ? ' lift' : ''}${why ? '' : ' movable'}${openKey === key ? ' open' : ''}`}
              data-block={key} data-day={d} data-start={m.start} data-type="meeting" aria-expanded={openKey === key}
              style={{ top: top(m.start), height: Math.max(.25, len) * HR - 2, left: `calc(${(l.lane / l.of) * 100}% + 3px)`, width: `calc(${100 / l.of}% - 6px)` }}
              title={why ? `${m.e.title} · ${why}` : `${m.e.title} · drag to move (Alt+↑/↓)`} aria-pressed={selKey === m.key}
              onClick={(ev) => h.open({ kind: 'meeting', key, m: orig }, ev.currentTarget)}
              onPointerDown={(ev) => h.down(ev, orig)} onPointerMove={(ev) => h.move(ev, orig)} onPointerUp={() => h.up(orig)} onPointerCancel={h.cancel}
              onKeyDown={(ev) => { if (!why && ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) { ev.preventDefault(); h.alt(orig, ev.key === 'ArrowUp'); } }}>
              {m.e.title}{!xs && <small>{sub}</small>}
            </button>
          </div>
        );
      })}
      {col.done.map((t) => {
        const at = hoursOf(t).start;
        const key = `done:${d}:${t.id}`;
        return (
          <button key={t.id} type="button" className={`wp-done${openKey === key ? ' open' : ''}`} data-block={key} data-day={d} data-start={at} data-type="done" aria-expanded={openKey === key}
            style={{ top: Math.max(2, top(at) - 9) }} title={`Done ${clockH(at)} · ${t.key ? `${t.key} ` : ''}${t.title}`}
            onClick={(ev) => h.open({ kind: 'done', key, t }, ev.currentTarget)}>
            <Icon name="check" size={9} />{t.key ?? t.title}
          </button>
        );
      })}
      {col.reminders.map((t) => {
        const hr = hoursOf(t).start;
        const key = `reminder:${d}:${t.id}`;
        return (
          <button key={t.id} type="button" className={`wp-rem${t.status !== 'scheduled' ? ' fired' : ''}${openKey === key ? ' open' : ''}`} data-block={key} data-day={d} data-start={hr} data-type="reminder" aria-expanded={openKey === key}
            style={{ top: Math.max(2, top(hr) - 9) }} title={`Reminder · ${clockH(hr)}`}
            onClick={(ev) => h.open({ kind: 'reminder', key, t }, ev.currentTarget)}>
            <i aria-hidden="true" />{t.title}
          </button>
        );
      })}
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

function Inspector({ m, events, nowH, today, onOpen }: { m: Meet | null; events: CalendarEvent[]; nowH: number; today: string; onOpen: (e: CalendarEvent) => void }) {
  if (!m) return (
    <aside className="wp-insp empty" aria-label="Meeting"><p>No meetings this week. Pick one on the grid to see its agenda, people and linked work here.</p></aside>
  );
  const e = m.e, f = m.feed;
  const d = dateOf(m.day);
  const mins = Math.round(((m.day === today ? m.start - nowH : 99) * 60));
  const rel = m.day === today && mins > 0 && mins < 600 ? (mins < 60 ? `in ${mins} min` : `in ${Math.floor(mins / 60)}h ${mins % 60 ? `${mins % 60}m` : ''}`.trim()) : m.day === today && m.end > nowH && m.start <= nowH ? 'now' : null;
  const join = e.joinUrl ?? f?.joinUrl ?? null;
  const where = join ? `${f?.providerName ?? (join.includes('meet.google') ? 'Google Meet' : join.includes('teams') ? 'Microsoft Teams' : 'Project Tracker call')} · ${join.replace(/^https?:\/\//, '').replace(/^\/calls\/.*/, 'in Project Tracker')}` : null;
  const agenda = (f?.description ?? '').split(/\n+|(?:^|\s)\d+[.)]\s+/).map((s) => s.trim().replace(/^[-•*]\s*/, '')).filter(Boolean).slice(0, 6);
  const people = e.people ?? [];
  const notes = !!e.notes || (f ? f.notetaker === 'transcript' || f.notetaker === 'voice' : false);
  const linked = events.filter((x) => x.projectId && x.projectId === e.projectId && x.type !== 'meeting').slice(0, 3);
  const pr = (p: string | null) => (p === 'Critical' || p === 'High' ? 'High' : p === 'Medium' ? 'Med' : p === 'Low' ? 'Low' : null);
  return (
    <aside className="wp-insp" aria-label="Meeting">
      <div>
        <div className="wp-insp-top">{e.projectName && <span className={`wp-pill`}>{e.projectName}</span>}{rel && <span className="wp-faint">{rel}</span>}</div>
        <h2>{e.title}</h2>
        <p className="wp-when">{DOW3[d.getDay()]} {d.getDate()} {MONTHS[d.getMonth()].slice(0, 3)} · {clockH(m.start)} – {clockH(m.end)}{where && <><br />{where}</>}</p>
      </div>
      {join && (/^https?:/.test(join)
        ? <a className="wp-join" href={join} target="_blank" rel="noreferrer">Join meeting</a>
        : <a className="wp-join" href={join}>Join meeting</a>)}
      <section className="wp-agenda" aria-label="Agenda">
        <div className="wp-agenda-hd"><span className="wp-orb sm" aria-hidden="true" />{agenda.length ? 'Agenda' : 'Agenda · drafted for you'}</div>
        {agenda.length ? <ol>{agenda.map((a) => <li key={a}>{a}</li>)}</ol>
          : <p>No agenda yet. <button type="button" className="link-btn" onClick={() => onOpen(e)}>Read the brief</button> — Project Tracker drafts one from the linked work.</p>}
      </section>
      {people.length > 0 && (
        <div>
          <div className="wp-lab">Attendees · {f?.invited ?? people.length}</div>
          {people.map((p, i) => (
            <div key={p} className="wp-att"><Face byName name={p} className={`wp-av c${i % 5}`} text={p.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()} />{p}<em>{i === 0 ? 'organiser' : 'invited'}</em></div>
          ))}
        </div>
      )}
      <div className="wp-notes">
        <span className="wp-orb" aria-hidden="true" />
        <div><b>Notes by Project Tracker</b><small>Summary &amp; action items after the call</small></div>
        <button type="button" role="switch" aria-checked={notes} aria-label="Notes by Project Tracker" className={`wp-sw${notes ? ' on' : ''}`} aria-disabled="true"
          title="The notetaker is set on the meeting — open it in Messages to change" onClick={() => onOpen(e)} />
      </div>
      {linked.length > 0 && (
        <div>
          <div className="wp-lab">Linked</div>
          {linked.map((x) => {
            const p = pr(x.priority);
            return (
              <button key={`${x.type}${x.id}`} type="button" className="wp-att link" onClick={() => onOpen(x)}>
                <span className={`wp-kind ${p === 'High' ? 'r' : p === 'Med' ? 'o' : 'b'}`} aria-hidden="true">{p === 'High' ? '●' : p === 'Med' ? '!' : '▤'}</span>{x.title}<em>{p ?? (x.type === 'stage' ? 'Stage' : x.type === 'project' ? 'Deadline' : '')}</em>
              </button>
            );
          })}
        </div>
      )}
    </aside>
  );
}
