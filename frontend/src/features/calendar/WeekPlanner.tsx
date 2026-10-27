import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { insightApi, meetingApi } from '../../api/endpoints';
import type { CalendarEvent } from '../../api/types';
import { Icon } from '../../components/Icon';
import { ErrorState, Segmented } from '../../components/ui';
import { todayISO } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { meetApi, type MeetItem } from '../meet/meetApi';
import { reminderApi } from '../reminders/api';
import { ToolbarSlot } from '../talk/ToolbarSlot';
import { undoToast } from '../talk/flyTask';
import { CalendarView } from './CalendarView';
import './planner.css';

// ------------------------------------------------------------------------------------------------------------------------ helpers
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dateOf = (s: string) => new Date(`${s}T00:00:00`);
const addDays = (s: string, n: number) => { const d = dateOf(s); d.setDate(d.getDate() + n); return iso(d); };
const mondayOf = (s: string) => addDays(s, -((dateOf(s).getDay() + 6) % 7));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hourOf = (d: Date) => d.getHours() + d.getMinutes() / 60;
/** "9:30", "12:00": the design's 12-hour clock without AM/PM. */
const clockH = (h: number) => { const hh = Math.floor(h + 1e-6), mm = Math.round((h - hh) * 60); return `${hh % 12 || 12}:${String(mm).padStart(2, '0')}`; };
/** ISO week number. */
const weekNo = (s: string) => { const d = dateOf(s); d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7)); const w1 = new Date(d.getFullYear(), 0, 4); return 1 + Math.round(((d.getTime() - w1.getTime()) / 864e5 - 3 + ((w1.getDay() + 6) % 7)) / 7); };

/** The grid runs 9 AM to 6 PM; an hour is 73px tall, as the design. A meeting without a known length reads as 30 min. */
const START = 9, END = 18, HR = 73, MEETING_MIN = 30, SNAP = 0.25;
/** Project colours in the order the filter lists them (the design: indigo, orange, teal …); meetings without a project are green. */
const TINTS = ['i', 'o', 't', 'p', 'b', 'r'] as const;
const DOT: Record<string, string> = { i: '#5856d6', o: '#ff9500', t: '#30b0c7', p: '#af52de', b: '#0071e3', r: '#ff2d55', g: '#28cd41' };

type View = 'day' | 'week' | 'month';
type Layer = 'meetings' | 'focus' | 'deadlines' | 'reminders';
interface Meet { key: string; e: CalendarEvent; day: string; start: number; end: number; feed: MeetItem | null }
interface Focus { day: string; start: number; end: number; label: string }

const isDeadline = (e: CalendarEvent) => e.type === 'project' || e.type === 'milestone' || e.type === 'stage' || ((e.type === 'task' || e.type === 'action' || e.type === 'work') && (e.priority === 'High' || e.priority === 'Critical'));
const hrefOf = (e: CalendarEvent) => (e.type === 'meeting'
  ? `/talk?f=meetings&meeting=${e.projectId ? 'p' : 'w'}:${e.id}${e.startsAt ? `&at=${encodeURIComponent(e.startsAt)}` : ''}`
  : e.type === 'task' || e.type === 'action' || e.type === 'work' ? `/work?item=${e.id}` : e.projectId ? `/work/projects/${e.projectId}` : '/work/projects');

/** Suggested focus blocks: free gaps of an hour or more between meetings (today: from now), up to two a day, at most two hours each. */
function focusFor(days: string[], meets: Meet[], topics: string[], today: string, nowH: number): Focus[] {
  const out: Focus[] = [];
  let t = 0;
  for (const day of days) {
    const busy = meets.filter((m) => m.day === day).map((m) => [m.start, m.end] as const).sort((a, b) => a[0] - b[0]);
    let cur = day === today ? Math.max(START, Math.ceil(nowH * 4) / 4) : START;
    const gaps: [number, number][] = [];
    for (const [a, b] of busy) { if (a > cur) gaps.push([cur, Math.min(a, END)]); cur = Math.max(cur, b); }
    if (cur < END) gaps.push([cur, END]);
    let n = 0;
    for (const [a, b] of gaps) {
      if (b - a >= 1 && n < 2) { out.push({ day, start: a, end: a + Math.min(2, b - a), label: topics[t % Math.max(1, topics.length)] ?? 'Deep work' }); n++; t++; }
    }
  }
  return out;
}

/** Side-by-side lanes for meetings that overlap on one day. */
function lanes(list: Meet[]) {
  const sorted = [...list].sort((a, b) => a.start - b.start || b.end - a.end);
  const out = new Map<string, { lane: number; of: number }>();
  let group: Meet[] = [], groupEnd = -1, laneEnds: number[] = [];
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

// ------------------------------------------------------------------------------------------------------------------------ page
/**
 * Calendar (the sidebar's Calendar): the mini month, layer and project filters and the ✦ week line on the left; the work week from 9 to 6
 * with meetings at their real lengths, suggested focus blocks (hatched), deadline flags on the day headers, reminder capsules and the now
 * line; and the selected meeting on the right (agenda, people, Join, notes, linked work). A meeting you organise can be dragged to a new
 * time (15-minute steps; Alt+↑/↓ with the keyboard), with Undo.
 */
export function WeekPlanner({ onTab, extra }: { onTab?: (t: 'for-you' | 'calendar') => void; /** Under the ✦ line (Subscribe in Google / Outlook). */ extra?: ReactNode }) {
  const navigate = useNavigate();
  const wid = useWorkspaceId();
  const today = todayISO();
  const [view, setView] = useState<View>(() => (typeof window !== 'undefined' && window.innerWidth < 760 ? 'day' : 'week'));
  const [anchor, setAnchor] = useState(today);
  const [mini, setMini] = useState(() => { const d = dateOf(today); return { y: d.getFullYear(), m: d.getMonth() }; });
  const [layers, setLayers] = useState<Record<Layer, boolean>>({ meetings: true, focus: true, deadlines: true, reminders: true });
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [moved, setMoved] = useState<Record<string, { day: string; start: number }>>({});
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = window.setInterval(() => setNow(new Date()), 60_000); return () => window.clearInterval(t); }, []);
  const nowH = hourOf(now);

  const monday = mondayOf(anchor);
  const sunday = addDays(monday, 6);
  const week = useMemo(() => Array.from({ length: 5 }, (_, i) => addDays(monday, i)), [monday]);
  const days = view === 'day' ? [anchor] : week;

  const q = useWsQuery(['calendar', 'week', monday, 'me'], () => insightApi.calendar(monday, sunday, undefined, true), { placeholderData: (p) => p });
  const feed = useWsQuery(['meet', 'feed', monday], () => meetApi.feed({ from: `${monday}T00:00:00`, to: `${addDays(sunday, 1)}T00:00:00` }), { staleTime: 60_000, retry: false });
  const rem = useWsQuery(['reminders', 'list'], reminderApi.list, { staleTime: 60_000, retry: false });

  const events = useMemo(() => (q.data ?? []).filter((e) => e.category !== 'Cancelled' && e.status !== 'Cancelled'), [q.data]);
  const projects = useMemo(() => [...new Set(events.map((e) => e.projectName).filter((n): n is string => !!n))].slice(0, 6), [events]);
  const tintOf = (name: string | null) => (name && projects.includes(name) ? TINTS[projects.indexOf(name) % TINTS.length] : 'g');
  const shown = (e: CalendarEvent) => !e.projectName || !hidden.has(e.projectName);

  const meets: Meet[] = useMemo(() => {
    const byStart = new Map((feed.data?.items ?? []).map((f) => [`${f.id}|${Date.parse(f.start)}`, f]));
    const byId = new Map((feed.data?.items ?? []).map((f) => [f.id, f]));
    return events.filter((e) => e.type === 'meeting' && e.startsAt).map((e) => {
      const s = new Date(e.startsAt!);
      const f = byStart.get(`${e.id}|${s.getTime()}`) ?? byId.get(e.id) ?? null;
      const len = (e.durationMinutes ?? (f ? (Date.parse(f.end) - Date.parse(f.start)) / 60_000 : MEETING_MIN)) / 60;
      const key = `${e.id}|${e.startsAt}`;
      const mv = moved[key];
      const start = mv ? mv.start : hourOf(s);
      return { key, e, day: mv ? mv.day : iso(s), start, end: start + len, feed: f };
    });
  }, [events, feed.data, moved]);

  // ---- drag to reschedule
  const [drag, setDrag] = useState<{ key: string; day: string; start: number; moved: boolean } | null>(null);
  const justDragged = useRef(false);
  const dragRef = useRef<{ key: string; x: number; y: number; day: string; start: number; colW: number; dayIdx: number } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const live = (m: Meet) => (drag && drag.key === m.key && drag.moved ? { ...m, day: drag.day, start: drag.start, end: drag.start + (m.end - m.start) } : m);
  const placed = meets.map(live);
  const visibleMeets = placed.filter((m) => layers.meetings && shown(m.e) && days.includes(m.day));
  const topics = [...new Set(events.filter((e) => e.type !== 'meeting' && e.type !== 'project').map((e) => e.title.replace(/^[A-Z]{2,}[‑-]\d+\s*[·:\-–—]\s*/, '').trim()).filter(Boolean))];
  const focus = layers.focus ? focusFor(days, placed.filter((m) => shown(m.e)), topics.length ? topics : ['Deep work', 'Reviews'], today, nowH) : [];

  const canMove = (m: Meet): string | null => {
    if (!m.feed) return 'Open the meeting in Talk to move it';
    if (!m.feed.canManage) return 'Only the organiser can move this meeting';
    if (m.feed.recurring) return 'A recurring meeting moves from its series in Talk';
    if (Date.parse(m.feed.end) < Date.now()) return 'This meeting has ended';
    return null;
  };
  const reschedule = async (m: Meet, day: string, start: number, undo = false) => {
    const from = { day: m.day, start: m.start };
    const len = m.end - m.start;
    const at = (d: string, h: number) => { const x = dateOf(d); x.setMinutes(Math.round(h * 60)); return x; };
    setMoved((s) => ({ ...s, [m.key]: { day, start } }));
    try {
      const body = { startTime: at(day, start).toISOString(), endTime: at(day, start + len).toISOString() };
      if (m.e.projectId) await meetingApi.reschedule(m.e.id, body); else await meetingApi.workspaceReschedule(m.e.id, body);
      void invalidateWorkspace(wid, 'meet');
      if (undo) { toast('Moved back.', 'info'); return; }
      const before = focus.filter((f) => f.day === day && f.end > from.start && f.start < start + len);
      const label = `${m.e.title} moved to ${DOW3[dateOf(day).getDay()]} ${clockH(start)}${before.length ? ' · focus shortened' : ''}`;
      undoToast(label, () => void reschedule({ ...m, day, start, end: start + len }, from.day, from.start, true), gridRef.current, 46);
    } catch (err) {
      setMoved((s) => ({ ...s, [m.key]: from }));
      toast(err instanceof ApiError ? err.message : 'Could not move the meeting.', 'error');
    }
  };
  const onPointerDown = (ev: ReactPointerEvent, m: Meet) => {
    if (ev.button !== 0 || canMove(m)) return;
    const grid = gridRef.current;
    const col = grid?.querySelector<HTMLElement>('.wp-col');
    dragRef.current = { key: m.key, x: ev.clientX, y: ev.clientY, day: m.day, start: m.start, colW: col?.getBoundingClientRect().width ?? 140, dayIdx: days.indexOf(m.day) };
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  };
  const onPointerMove = (ev: ReactPointerEvent, m: Meet) => {
    const d = dragRef.current;
    if (!d || d.key !== m.key) return;
    const dy = ev.clientY - d.y, dx = ev.clientX - d.x;
    if (!drag && Math.hypot(dx, dy) < 5) return;
    const len = m.end - m.start;
    const start = Math.min(END - len, Math.max(START, Math.round((d.start + dy / HR) / SNAP) * SNAP));
    const idx = Math.min(days.length - 1, Math.max(0, d.dayIdx + Math.round(dx / d.colW)));
    setDrag({ key: m.key, day: days[idx], start, moved: true });
  };
  const onPointerUp = (m: Meet) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || !drag || drag.key !== m.key) { setDrag(null); return; }
    const { day, start } = drag;
    setDrag(null);
    justDragged.current = true;
    window.setTimeout(() => { justDragged.current = false; }, 0);
    if (day !== m.day || Math.abs(start - m.start) > 1e-6) void reschedule(m, day, start);
  };

  // ---- the inspector: the chosen meeting, else the next one
  const upcoming = [...meets].filter((m) => days.includes(m.day)).sort((a, b) => (a.day + a.start.toFixed(2)).localeCompare(b.day + b.start.toFixed(2)));
  const nextUp = upcoming.find((m) => m.day > today || (m.day === today && m.end > nowH)) ?? upcoming[0] ?? null;
  const sel = meets.find((m) => m.key === selected) ?? nextUp;

  // ---- ✦ the week in one line
  const weekMeets = meets.filter((m) => week.includes(m.day));
  const meetH = weekMeets.reduce((n, m) => n + (m.end - m.start), 0);
  const focusH = focusFor(week, meets, ['x'], today, nowH).reduce((n, f) => n + (f.end - f.start), 0);
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
        <div className="wp-filters">
          <div className="wp-ft">Show</div>
          {([['meetings', 'Meetings'], ['focus', 'Focus blocks'], ['deadlines', 'Deadlines'], ['reminders', 'Reminders']] as const).map(([k, label]) => (
            <label key={k} className={`wp-fr${layers[k] ? '' : ' off'}`}><input type="checkbox" className="sr-only" checked={layers[k]} onChange={(e) => setLayers((s) => ({ ...s, [k]: e.target.checked }))} /><i className={`k-${k}`} aria-hidden="true" />{label}</label>
          ))}
          {projects.length > 0 && <div className="wp-ft">Projects</div>}
          {projects.map((p) => (
            <label key={p} className={`wp-fr${hidden.has(p) ? ' off' : ''}`}><input type="checkbox" className="sr-only" checked={!hidden.has(p)} onChange={() => setHidden((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; })} /><i style={{ background: DOT[tintOf(p)] }} aria-hidden="true" />{p}</label>
          ))}
        </div>
        <section className="wp-ai" aria-label="This week">
          <span className="wp-orb" aria-hidden="true" />
          <p>{q.isLoading ? 'Reading the week…' : <>This week: <b>{fmtH(meetH)} meetings</b>, {fmtH(focusH)} focus.{' '}
            {busiest && busiest.h >= 4 && longest ? <>{dateOf(busiest.d).toLocaleDateString('en-GB', { weekday: 'long' })} is overbooked — move {longest.e.title.toLowerCase().startsWith('sprint') ? longest.e.title.toLowerCase() : longest.e.title}?</>
              : <>{dateOf(perDay.reduce((a, b) => (b.h < a.h ? b : a), perDay[0]).d).toLocaleDateString('en-GB', { weekday: 'long' })} is clearest for focused work.</>}</>}</p>
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
          {q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : (
            <div className="wp-cal" ref={gridRef} style={{ ['--cols' as string]: days.length }}>
              <div className="wp-days">
                <span />
                {days.map((d) => {
                  const flag = layers.deadlines ? events.filter((e) => e.date === d && isDeadline(e) && shown(e))
                    .sort((a, b) => ['project', 'milestone', 'stage'].indexOf(b.type) - ['project', 'milestone', 'stage'].indexOf(a.type))[0] : undefined;
                  return (
                    <div key={d} className={`wp-dh${d === today ? ' tdy' : ''}`}>
                      {DOW3[dateOf(d).getDay()]}<b>{dateOf(d).getDate()}</b>
                      {flag && <button type="button" className="wp-flag" title={`${flag.title}${flag.projectName ? ` · ${flag.projectName}` : ''} — due`} onClick={() => navigate(hrefOf(flag))}>⚑ {flag.title}</button>}
                    </div>
                  );
                })}
              </div>
              <div className="wp-body" style={{ height: (END - START) * HR }}>
                <div className="wp-lines" aria-hidden="true" />
                <div className="wp-hrs" aria-hidden="true">
                  {Array.from({ length: END - START }, (_, i) => START + i).map((h) => (
                    <span key={h} style={{ top: (h - START) * HR, opacity: h === START ? 0 : 1 }}>{h === 12 ? '12 PM' : h === 10 ? '10 AM' : h > 12 ? h - 12 : h}</span>
                  ))}
                  {days.includes(today) && nowH >= START && nowH <= END && <span className="wp-nowl" style={{ top: (nowH - START) * HR - 7 }}>{clockH(nowH)}</span>}
                </div>
                {days.map((d) => {
                  const list = visibleMeets.filter((m) => m.day === d);
                  const lane = lanes(list);
                  return (
                    <div key={d} className="wp-col" data-day={d}>
                      {d === today && nowH >= START && nowH <= END && <div className="wp-now" style={{ top: (nowH - START) * HR }} aria-label={`Now, ${clockH(nowH)}`} />}
                      {focus.filter((f) => f.day === d).map((f) => (
                        <div key={`f${f.start}`} className={`wp-e f${drag ? ' dim' : ''}`} style={{ top: (f.start - START) * HR, height: (f.end - f.start) * HR - 2 }} title="A suggested focus block">
                          Focus · {f.label}<small>{f.end - f.start >= 1.5 ? `${clockH(f.start)} – ${clockH(f.end)}` : clockH(f.start)}</small>
                        </div>
                      ))}
                      {layers.reminders && (rem.data?.open ?? []).filter((r) => r.nextFireAt && iso(new Date(r.nextFireAt)) === d).slice(0, 3).map((r) => {
                        const h = hourOf(new Date(r.nextFireAt!));
                        return (
                          <button key={r.id} type="button" className="wp-rem" style={{ top: Math.max(.2, Math.min(END - START - .2, h - START)) * HR - 9 }} onClick={() => navigate('/?tab=reminders')} title={`Reminder · ${clockH(h)}`}>
                            <i aria-hidden="true" />{r.title}
                          </button>
                        );
                      })}
                      {list.map((m) => {
                        const orig = meets.find((x) => x.key === m.key)!;
                        const why = canMove(orig);
                        const len = m.end - m.start;
                        const xs = len <= .3;
                        const l = lane.get(m.key) ?? { lane: 0, of: 1 };
                        const dragging = drag?.key === m.key && drag.moved;
                        const people = (m.e.people ?? []).slice(1, 3).map((p) => p.split(' ')[0]).join(', ');
                        const sub = len >= 1.25 ? `${clockH(m.start)} – ${clockH(m.end)}` : `${clockH(m.start)}${people ? ` · ${people}` : m.e.projectName ? ` · ${m.e.projectName}` : ''}`;
                        const top = (Math.max(m.start, START) - START) * HR;
                        return (
                          <div key={m.key} className="wp-slot">
                            {dragging && <div className="wp-ghost" style={{ top: (orig.start - START) * HR, height: len * HR - 2 }} aria-hidden="true" />}
                            {dragging && <span className="wp-snap" style={{ top: top - 22 }}>{clockH(m.start)}</span>}
                            <button type="button" className={`wp-e ${tintOf(m.e.projectName)}${xs ? ' xs' : ''}${sel?.key === m.key ? ' sel' : ''}${dragging ? ' lift' : ''}${why ? '' : ' movable'}`}
                              style={{ top, height: Math.max(.25, len) * HR - 2, left: `calc(${(l.lane / l.of) * 100}% + 3px)`, width: `calc(${100 / l.of}% - 6px)` }}
                              title={why ? `${m.e.title} · ${why}` : `${m.e.title} · drag to move (Alt+↑/↓)`} aria-pressed={sel?.key === m.key}
                              onClick={() => { if (!dragging && !justDragged.current) setSelected(m.key); }}
                              onPointerDown={(ev) => onPointerDown(ev, orig)} onPointerMove={(ev) => onPointerMove(ev, orig)} onPointerUp={() => onPointerUp(orig)} onPointerCancel={() => { dragRef.current = null; setDrag(null); }}
                              onKeyDown={(ev) => { if (!why && ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) { ev.preventDefault(); void reschedule(orig, orig.day, Math.min(END - len, Math.max(START, orig.start + (ev.key === 'ArrowUp' ? -SNAP : SNAP)))); } }}>
                              {m.e.title}{!xs && <small>{sub}</small>}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      )}

      {view !== 'month' && <Inspector m={sel} events={events} nowH={nowH} today={today} onOpen={(e) => navigate(hrefOf(e))} />}
    </div>
  );
}

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
            <div key={p} className="wp-att"><span className={`wp-av c${i % 5}`} aria-hidden="true">{p.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()}</span>{p}<em>{i === 0 ? 'organiser' : 'invited'}</em></div>
          ))}
        </div>
      )}
      <div className="wp-notes">
        <span className="wp-orb" aria-hidden="true" />
        <div><b>Notes by Project Tracker</b><small>Summary &amp; action items after the call</small></div>
        <button type="button" role="switch" aria-checked={notes} aria-label="Notes by Project Tracker" className={`wp-sw${notes ? ' on' : ''}`} aria-disabled="true"
          title="The notetaker is set on the meeting — open it in Talk to change" onClick={() => onOpen(e)} />
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
