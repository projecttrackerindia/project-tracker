import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { CalendarEvent } from '../../api/types';
import { Icon } from '../../components/Icon';
import { invalidateWorkspace } from '../../lib/hooks';
import { EventDetail, type DetailActions } from './EventDetail';
import { END, START, clockH, fmtMins, hourOf, isDone, type Detail, type Focus, type PlanOverrides } from './plannerModel';
import { dayCounts, daySignature, deadlineHourOf, focusLabel, focusWord, hoursOf, weekRange, workWeek, type DayView } from './timeline';
import { packColumns } from './pack';
import { overlapText } from './calendarEdit';
import { useClearOnRefresh, useDayEdit } from './useDayEdit';
import { toast } from '../../stores/ui';
import { dayMarks, type DayMark } from './deadline';
import { clock24 } from '../work/dueTime';
import { useToday } from './useToday';
import './planner.css';
import './eventDetail.css';
import { ZoneBadge } from '../../components/ZoneBadge';

const MEET_TINTS = ['m-teal', 'm-indigo', 'm-green'];
/** The ruler as the design: the first hour with AM/PM, noon as 12 PM, the rest bare. */
const label = (h: number, first: boolean) => (h === 12 ? '12 PM' : first ? `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}` : String(h % 12 || 12));
const dur = (mins: number) => fmtMins(Math.max(0, Math.round(mins)));

/**
 * Today's edits: the Calendar's own (useDayEdit), so a drag or a card on "Your day" changes the same records the same way — focus blocks in
 * your plan, meetings you organise through their reschedule endpoint, logged time on the timesheet (locked weeks and a change made elsewhere
 * refuse) — and the detail cards get the same editors (the entry form, Move after / Trim on an overlap).
 */
function useTodayEdit(today: string, nowH: number, plan: PlanOverrides, savePlan: (p: PlanOverrides) => void, focus: readonly Focus[], anchor: () => Element | null,
  onAdjust: (id: string) => void) {
  const wk = weekRange(today);
  const ed = useDayEdit({ from: wk.from, to: wk.to, today, nowH, plan, savePlan, anchor, focus: () => focus, onAdjust });
  const wid = ed.wid;
  const actions = (d: DayView | null): DetailActions => ({
    moveFocus: (f, day, start) => ed.moveFocusTo(f, day, start, f.end - f.start),
    removeFocus: ed.removeFocus,
    done: () => { void invalidateWorkspace(wid, 'timeline'); },
    moveMeeting: (m, day, start) => void ed.reschedule(m, day, start, m.end - m.start),
    canMoveMeeting: ed.canMove,
    entryOf: (id) => ed.entries.get(id),
    overlapsOf: (t) => d?.overlaps.get(t.id) ?? [],
    fixOverlap: ed.fixOverlap,
    choices: (d?.due ?? []).filter((e) => e.type === 'task' || e.type === 'work').map((e) => ({ kind: e.type as 'task' | 'work', id: e.id, key: e.key ?? null, title: e.title, projectName: e.projectName })),
  });
  return { ed, actions };
}

/** What can be dragged on Your day, and how: move (the body), or resize its start / end (its edges). */
type YDrag = { kind: 'meeting' | 'time' | 'focus'; key: string; start: number; end: number; mode: 'move' | 'start' | 'end' };
const SNAP_H = .25;
const snapQ = (h: number) => Math.round(h / SNAP_H) * SNAP_H;

/** One marker on the pins row (finished work, a reminder, a deadline, the check-in), placed so no two labels ever overlap. */
interface Pin { key: string; at: number; type: 'done' | 'reminder' | 'deadline' | 'checkin'; cls: string; title: string; body: ReactNode; det: Detail | null }
/** Pins closer than this (hours) go on a second row instead of covering each other. */
const PIN_ROOM = 0.6;

/**
 * Lay the pins out: in time order, each on the first row where the previous pin is at least {@link PIN_ROOM} away (two rows at most), and
 * each label no wider than the room up to the next pin on its row (ellipsized), so labels never print over each other.
 */
function layPins(pins: Pin[], h1: number): (Pin & { row: number; room: number })[] {
  const sorted = [...pins].sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
  const last = [-Infinity, -Infinity];
  const placed = sorted.map((p) => {
    const row = p.at - last[0] >= PIN_ROOM ? 0 : p.at - last[1] >= PIN_ROOM ? 1 : last[0] <= last[1] ? 0 : 1;
    last[row] = p.at;
    return { ...p, row, room: 0 };
  });
  for (const p of placed) {
    const next = placed.find((q) => q.row === p.row && q.at > p.at);
    p.room = (next ? next.at : h1) - p.at;
  }
  return placed;
}

/**
 * "Your day" on Today: meetings, calls and focus blocks on the main row (side by side when they overlap); time logged in a slim green lane
 * under it (as the Calendar week grid's thin lane), never past the now line; finished work, reminders, the check-in and deadlines as pins
 * below - a date-only deadline at the shift's end, "by end of day" (deadlineHourOf). Before the check-in the day is shaded. The header counts
 * are the day's own (dayCounts), the same numbers the Calendar's day shows. Every block opens the Calendar's detail card.
 */
export function YourDay({ team }: { team: boolean }) {
  const { q, day, today, now, plan, savePlan, build } = useToday(team);
  const [open, setOpen] = useState<{ d: Detail; el: HTMLElement | null } | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const nowH = hourOf(now);
  const { ed, actions: actionsOf } = useTodayEdit(today, nowH, plan, savePlan, day?.focus ?? [], () => track.current,
    (id) => track.current?.querySelector<HTMLElement>(`[data-type="time"][data-id="${CSS.escape(id)}"]`)?.click());
  useClearOnRefresh(q.dataUpdatedAt, ed.clearOver);
  // Edits on their way show at once (the same optimistic layer the Calendar uses).
  const { over, apply, withFeed } = ed;
  const d = useMemo(() => (q.data && Object.keys(over).length ? build(apply(q.data.events)) : day), [q.data, over, apply, build, day]);
  const meets = useMemo(() => withFeed(d?.meets ?? []), [withFeed, d]);
  const actions = actionsOf(d);
  const [drag, setDrag] = useState<YDrag | null>(null);
  const dragged = useRef(false);
  const shift = d?.shift ?? { start: START, end: END, checkIn: null };
  // Deadlines with a time and SLA breaches, at their hour (markers only: the lanes stay as they are).
  const marks = d ? dayMarks(d.day, d.due, now.getTime()) : [];
  // the ruler: 9 AM to 8 PM, wider when something happened earlier or later
  const timed = d ? [...meets.map((m) => [m.start, m.end]), ...[...d.calls, ...d.time, ...d.done, ...d.reminders].map((t) => { const h = hoursOf(t); return [h.start, h.end]; }),
    ...(shift.checkIn != null ? [[shift.checkIn, shift.checkIn]] : []), ...marks.map((m) => [m.at, m.at])] : [];
  const h0 = Math.max(0, Math.min(9, ...timed.map((x) => Math.floor(x[0])))), h1 = Math.min(24, Math.max(20, ...timed.map((x) => Math.ceil(x[1]))));
  const cols = h1 - h0;
  const frac = (h: number) => (Math.min(cols, Math.max(0, h - h0)) / cols) * 100;
  const pct = (h: number) => `${frac(h)}%`;
  const width = (a: number, b: number) => `${(Math.max(.25, Math.min(b, h1) - Math.max(a, h0)) / cols) * 100}%`;
  const c = d ? dayCounts(d) : null;
  const show = (det: Detail, el: HTMLElement) => { if (dragged.current) return; setOpen((o) => (o?.d.key === det.key ? null : { d: det, el })); };
  const isToday = d?.day === today;
  const overlapN = d ? d.overlaps.size : 0;

  // ---- dragging: the same edits as the Calendar, along the day (15-minute steps); Alt+←/→ moves, Alt+Shift+←/→ changes the end
  const commit = (g: YDrag, start: number, end: number) => {
    if (!d) return;
    if (g.kind === 'focus') { const f = d.focus.find((x) => x.key === g.key); if (f) ed.moveFocusTo(f, d.day, start, end - start); }
    else if (g.kind === 'meeting') { const m = meets.find((x) => `meeting:${x.key}` === g.key); if (m) void ed.reschedule(m, d.day, start, end - start); }
    else { const t = d.time.find((x) => `time:${x.id}` === g.key); if (t) void ed.moveTime(t, d.day, start, end); }
  };
  const why = (g: Pick<YDrag, 'kind' | 'key'>): string | null => {
    if (!d || team) return 'Open the Calendar to change the team’s day';
    if (g.kind === 'meeting') { const m = meets.find((x) => `meeting:${x.key}` === g.key); return m ? ed.canMove(m) : 'Not found'; }
    if (g.kind === 'time') { const t = d.time.find((x) => `time:${x.id}` === g.key); return t ? ed.timeWhy(t) : 'Not found'; }
    return null;
  };
  const down = (ev: ReactPointerEvent, g: Omit<YDrag, 'mode'>, mode: YDrag['mode']) => {
    if (ev.button !== 0 || why(g)) return;
    ev.stopPropagation();
    const w = track.current?.getBoundingClientRect().width ?? 1;
    const x0 = ev.clientX;
    let cur: YDrag | null = null;
    const len = g.end - g.start;
    const move = (e: PointerEvent) => {
      const dh = ((e.clientX - x0) / w) * cols;
      if (!cur && Math.abs(e.clientX - x0) < 5) return;
      let start = g.start, end = g.end;
      if (mode === 'move') { start = Math.min(24 - len, Math.max(0, snapQ(g.start + dh))); end = start + len; }
      else if (mode === 'start') start = Math.min(g.end - SNAP_H, Math.max(0, snapQ(g.start + dh)));
      else end = Math.max(g.start + SNAP_H, Math.min(24, snapQ(g.end + dh)));
      if (!cur || cur.start !== start || cur.end !== end) { cur = { ...g, mode, start, end }; setDrag(cur); }
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel);
      const r = cur; setDrag(null);
      if (!r) return;
      dragged.current = true; window.setTimeout(() => { dragged.current = false; }, 0);
      if (Math.abs(r.start - g.start) > 1e-6 || Math.abs(r.end - g.end) > 1e-6) commit(g as YDrag, r.start, r.end);
    };
    const cancel = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); setDrag(null); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel);
  };
  const key = (ev: ReactKeyboardEvent, g: Omit<YDrag, 'mode'>) => {
    if (!ev.altKey || (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight')) return;
    ev.preventDefault();
    const w = why(g);
    if (w) { toast(w, 'error'); return; }
    const step = ev.key === 'ArrowLeft' ? -SNAP_H : SNAP_H;
    if (ev.shiftKey) commit(g as YDrag, g.start, Math.max(g.start + SNAP_H, g.end + step));
    else commit(g as YDrag, g.start + step, g.end + step);
  };
  const at = (k: string, start: number, end: number) => (drag && drag.key === k ? { start: drag.start, end: drag.end, lifted: true } : { start, end, lifted: false });
  const edges = (g: Omit<YDrag, 'mode'>) => (why(g) ? null : <>
    <span className="hm-rs l" aria-hidden="true" onPointerDown={(e) => down(e, g, 'start')} onClick={(e) => e.stopPropagation()} />
    <span className="hm-rs r" aria-hidden="true" onPointerDown={(e) => down(e, g, 'end')} onClick={(e) => e.stopPropagation()} />
  </>);

  // ---- the main row: meetings, calls and focus, packed into rows by the Calendar's packing engine when they overlap
  type Block = { key: string; start: number; end: number; node: (style: CSSProperties, half: boolean) => ReactNode };
  const blocks: Block[] = d ? [
    ...meets.map((m, i): Block => {
      const g = { kind: 'meeting' as const, key: `meeting:${m.key}`, start: m.start, end: m.end };
      const pos = at(g.key, m.start, m.end), no = why(g);
      return { key: g.key, start: pos.start, end: pos.end, node: (style, half) => (
        <button type="button" key={m.key} className={`hm-cap ${MEET_TINTS[i % MEET_TINTS.length]}${half ? ' half' : ''}${no ? '' : ' movable'}${pos.lifted ? ' lift' : ''}`} data-type="meeting" data-start={pos.start} data-end={pos.end} style={style}
          title={`${clockH(pos.start)} – ${clockH(pos.end)} · ${m.e.title}${no ? ` · ${no}` : ' · drag to move, drag an edge to change its length (Alt+←/→)'}`}
          onPointerDown={(ev) => down(ev, g, 'move')} onKeyDown={(ev) => key(ev, g)} onClick={(ev) => show({ kind: 'meeting', key: `meeting:${m.key}`, m }, ev.currentTarget)}>
          <span className="hm-cap-t">{m.e.title}</span><small>{clockH(pos.start)} – {clockH(pos.end)}{m.e.joinUrl ? ' · Meet' : ''}</small>{edges(g)}
        </button>
      ) };
    }),
    ...d.calls.map((t): Block => { const s = hoursOf(t); const e = Math.max(s.end, s.start + .25); return { key: `call:${t.id}`, start: s.start, end: e, node: (style, half) => (
      <button type="button" key={t.id} className={`hm-cap call${half ? ' half' : ''}`} data-type="call" data-start={s.start} style={style}
        title={`Call · ${t.title}`} onClick={(ev) => show({ kind: 'call', key: `call:${t.id}`, t }, ev.currentTarget)}>
        <span className="hm-cap-t"><Icon name="phone" size={10} /> {t.title}</span><small>{clockH(s.start)}{t.running ? ' · live' : ` – ${clockH(s.end)}`}</small>
      </button>
    ) }; }),
    ...d.focus.map((f): Block => {
      const g = { kind: 'focus' as const, key: f.key, start: f.start, end: f.end };
      const pos = at(f.key, f.start, f.end);
      return { key: f.key, start: pos.start, end: pos.end, node: (style, half) => {
        const word = focusWord({ ...f, start: pos.start, end: pos.end }, today, nowH);
        return (
          <button type="button" key={f.key} className={`hm-cap focus${word === 'Focus now' ? ' now' : ''}${half ? ' half' : ''}${team ? '' : ' movable'}${pos.lifted ? ' lift' : ''}`} data-type="focus" data-start={pos.start} data-end={pos.end} style={style}
            title={`${word} · ${focusLabel(f.e)} · ${clockH(pos.start)} – ${clockH(pos.end)} · drag to move, drag an edge to resize (Alt+←/→)`}
            onPointerDown={(ev) => down(ev, g, 'move')} onKeyDown={(ev) => key(ev, g)} onClick={(ev) => show({ kind: 'focus', key: f.key, f }, ev.currentTarget)}>
            <span className="hm-cap-t">{word} · {focusLabel(f.e)}</span><small>{clockH(pos.start)} – {clockH(pos.end)}</small>{edges(g)}
          </button>
        );
      } };
    }),
  ] : [];
  const packed = packColumns(blocks.map((b) => ({ key: b.key, start: b.start, end: b.end })));
  const ROW = 38;
  // ---- the logged lane: the day's entries, packed the same way (two entries at once are stacked, never drawn as one bar)
  const LANE = 14, LANE_TOP = 44;
  const logged = (d?.time ?? []).map((t) => {
    const s = hoursOf(t);
    const pos = at(`time:${t.id}`, s.start, Math.max(s.end, s.start + 1 / 12));
    // logged time is time that has happened: never drawn past the now line
    const end = isToday ? Math.min(pos.end, nowH) : pos.end;
    return { t, start: pos.start, end, saved: s, lifted: pos.lifted };
  }).filter((x) => x.end > x.start || x.t.running);
  const lanePack = packColumns(logged.map((x) => ({ key: x.t.id, start: x.start, end: Math.max(x.end, x.start + 1 / 12) })));

  // ---- the pins: finished work, reminders, the check-in and deadlines (date-only at the shift's end: "by end of day")
  const deadlines = new Map<number, CalendarEvent[]>();
  const marked = new Set(marks.map((m) => `${m.e.type}:${m.e.id}`));   // timed deadlines and SLA breaches have their own markers
  for (const e of d?.due ?? []) {
    if (isDone(e) || marked.has(`${e.type}:${e.id}`)) continue;
    const h = deadlineHourOf(e, shift);
    deadlines.set(h, [...(deadlines.get(h) ?? []), e]);
  }
  const pins: Pin[] = d ? [
    ...d.done.map((t): Pin => { const s = hoursOf(t); return { key: `done:${t.id}`, at: s.start, type: 'done', cls: 'done', title: `Done ${clockH(s.start)} · ${t.key ?? ''} ${t.title}`,
      body: <><Icon name="check" size={9} /><span className="hm-pin-t">{t.key ?? t.title}</span></>, det: { kind: 'done', key: `done:${t.id}`, t } }; }),
    ...d.reminders.map((t): Pin => { const s = hoursOf(t); return { key: `reminder:${t.id}`, at: s.start, type: 'reminder', cls: 'rem', title: `Reminder ${clockH(s.start)} · ${t.title}`,
      body: <><i aria-hidden="true" /><span className="hm-pin-t">{t.title}</span></>, det: { kind: 'reminder', key: `reminder:${t.id}`, t } }; }),
    ...[...deadlines].map(([h, list]): Pin => {
      const when = h === shift.end ? 'by end of day' : `by ${clockH(h)}`;
      const what = list.length === 1 ? (list[0].key ?? list[0].title) : `${list.length} due`;
      return { key: `deadline:${h}`, at: h, type: 'deadline', cls: 'dl', title: `${list.map((e) => e.key ?? e.title).join(', ')} due ${when}`,
        body: <><Icon name="flag" size={9} /><span className="hm-pin-t">{what} · {when}</span></>, det: { kind: 'deadline', key: `deadline:${d.day}:${h}`, e: list[0], others: list.slice(1) } };
    }),
    ...(shift.checkIn != null ? [{ key: 'checkin', at: shift.checkIn, type: 'checkin' as const, cls: 'in', title: `Checked in at ${clockH(shift.checkIn)}`,
      body: <span className="hm-pin-t">In {clockH(shift.checkIn)}</span>, det: null }] : []),
  ] : [];
  const laid = layPins(pins, h1);
  const two = laid.some((p) => p.row === 1);
  const PIN_TOP = 62;

  return (
    <section className="hm-card hm-yday" aria-label="Your day" data-testid="your-day" data-day={today} data-sig={d ? daySignature(d) : ''} data-logged={c?.logged ?? ''}>
      <div className="hm-day-hd"><h2 className="hm-h3">Your day</h2><ZoneBadge />
        {c ? (
          <span className="hm-faint" data-testid="your-day-counts">
            {c.meetings} meeting{c.meetings === 1 ? '' : 's'}{c.calls > 0 && <> · {c.calls} call{c.calls === 1 ? '' : 's'}</>} · {c.focus} focus block{c.focus === 1 ? '' : 's'} · <span data-testid="your-day-free">{dur(c.free)} free</span>
            {c.done > 0 && <> · {c.done} done</>}
            {c.logged > 0 && <> · <Link to="/insights?tab=time" className="hm-logged" data-testid="your-day-logged">{dur(c.logged)} logged</Link></>}
            {overlapN > 0 && <> · <button type="button" className="hm-ovl" data-testid="your-day-overlap" title="Some logged time overlaps: open an entry to move or trim it"
              onClick={() => track.current?.querySelector<HTMLElement>('[data-type="time"][data-overlaps]')?.click()}>{overlapN} entries overlap</button></>}
          </span>
        ) : <span className="hm-faint">{q.isError ? 'Your day could not be read.' : 'Reading your day…'}</span>}
        <Link to="/?tab=calendar" className="hm-yday-cal">Calendar<Icon name="chevronR" size={11} /></Link>
      </div>
      <div ref={track} className={`hm-day-track tl lanes${two ? ' two' : ''}${drag ? ' dragging' : ''}`}>
        {/* before the check-in: shaded, with the check-in as a line across the day */}
        {isToday && shift.checkIn != null && shift.checkIn > h0 && <div className="hm-pre" aria-hidden="true" style={{ left: 0, width: pct(shift.checkIn) }} />}
        <div className="hm-lane a" /><div className="hm-lane lg" /><div className="hm-lane m" />
        {shift.checkIn != null && <div className="hm-in" data-testid="your-day-checkin" aria-label={`Checked in at ${clockH(shift.checkIn)}`} style={{ left: pct(shift.checkIn) }} />}
        {[...deadlines.keys()].map((h) => <div key={h} className="hm-dl" aria-hidden="true" data-testid="your-day-deadline" data-hour={h} style={{ left: pct(h) }} />)}
        {blocks.map((b) => {
          const p = packed.get(b.key) ?? { col: 0, cols: 1, span: 1, left: 0, width: 1 };
          const hgt = (ROW - (p.cols - 1) * 2) / p.cols;
          return b.node({ left: pct(b.start), width: width(b.start, b.end), top: p.col * (hgt + 2), height: hgt * p.span + (p.span - 1) * 2 }, p.cols > 1);
        })}
        {logged.map(({ t, start, end, saved, lifted }) => {
          const p = lanePack.get(t.id) ?? { col: 0, cols: 1, span: 1, left: 0, width: 1 };
          const hgt = (LANE - (p.cols - 1)) / p.cols;
          const g = { kind: 'time' as const, key: `time:${t.id}`, start: saved.start, end: Math.max(saved.end, saved.start + .25) };
          const no = why(g);
          const ov = d?.overlaps.get(t.id) ?? [];
          const words = `${t.approximated ? '≈ ' : ''}${clockH(start)}${t.running ? ' · running' : ` – ${clockH(end)}`}`;
          return (
            <button type="button" key={t.id} className={`hm-lg${t.approximated ? ' ap' : ''}${t.running ? ' run' : ''}${ov.length ? ' ovl' : ''}${no ? '' : ' movable'}${lifted ? ' lift' : ''}`} data-type="time" data-id={t.id}
              data-start={start} data-end={end} data-overlaps={ov.length || undefined}
              style={{ left: pct(start), width: `${(Math.max(1 / 12, Math.min(end, h1) - Math.max(start, h0)) / cols) * 100}%`, top: LANE_TOP + p.col * (hgt + 1), height: hgt * p.span + (p.span - 1) }}
              title={`Logged · ${t.title} · ${words}${ov.length ? ` · ${overlapText(ov[0], ed.entries.get(ov[0].sourceId)?.taskKey)}` : ''}${no ? ` · ${no}` : ' · drag to move, drag an edge to resize (Alt+←/→)'}`}
              aria-label={`Logged ${t.title}, ${clockH(start)} to ${clockH(end)}${ov.length ? `, ${overlapText(ov[0], ed.entries.get(ov[0].sourceId)?.taskKey)}` : ''}`}
              onPointerDown={(ev) => down(ev, g, 'move')} onKeyDown={(ev) => key(ev, g)}
              onClick={(ev) => show({ kind: 'time', key: `time:${t.date}:${t.id}`, t }, ev.currentTarget)}>{edges(g)}</button>
          );
        })}
        {laid.map((p) => {
          const style: CSSProperties = { left: pct(p.at), top: PIN_TOP + p.row * 20, maxWidth: `min(200px, calc(${(p.room / cols) * 100}% - 4px))` };
          return p.det ? (
            <button type="button" key={p.key} className={`hm-pin ${p.cls}`} data-type={p.type} data-hour={p.at} style={style} title={p.title}
              onClick={(ev) => show(p.det!, ev.currentTarget)}>{p.body}</button>
          ) : <span key={p.key} className={`hm-pin ${p.cls}`} data-type={p.type} data-hour={p.at} style={style} title={p.title}>{p.body}</span>;
        })}
        {marks.map((m) => <DeadlineMark key={m.key} m={m} left={pct(m.at)} onOpen={(el) => show({ kind: 'deadline', key: `deadline:${m.e.date}:${m.e.type}:${m.e.id}`, e: m.e, others: [] }, el)} />)}
        {drag && <span className="hm-snap" style={{ left: pct(drag.start) }} aria-hidden="true">{clockH(drag.start)} – {clockH(drag.end)}</span>}
        {nowH >= h0 && nowH <= h1 && (
          <div className="hm-now" style={{ left: pct(nowH) }} aria-label={`Now, ${clockH(nowH)}`} data-testid="your-day-now" data-hour={nowH}><span>{clockH(nowH)}</span></div>
        )}
      </div>
      <div className="hm-hours" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>{Array.from({ length: cols }, (_, i) => h0 + i).map((h) => <span key={h}>{label(h, h === h0)}</span>)}</div>
      {open && <EventDetail detail={open.d} anchor={open.el} today={today} nowH={nowH} days={workWeek(today)} actions={actions} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** A deadline at its hour on Your day: a red SLA breach line with its pill, or a flag for work due at a set time. */
function DeadlineMark({ m, left, onOpen }: { m: DayMark; left: string; onOpen: (el: HTMLElement) => void }) {
  const what = `${m.e.key ? `${m.e.key} ` : ''}${m.e.title}`;
  const label = m.kind === 'sla' ? `SLA ${m.late ? 'breached' : 'breach'} ${clock24(m.iso)} · ${what}` : `Due ${clock24(m.iso)} · ${what}`;
  return (
    <>
      {m.kind === 'sla' && <i className="hm-slaline" style={{ left }} aria-hidden="true" />}
      <button type="button" className={`hm-pin dl ${m.kind}${m.late ? ' late' : ''}`} data-type={m.kind === 'sla' ? 'sla' : 'deadline'} data-testid={m.kind === 'sla' ? 'your-day-sla' : 'your-day-due'}
        data-at={clock24(m.iso)} style={{ left }} title={label} aria-label={label} onClick={(ev) => onOpen(ev.currentTarget)}>
        <Icon name="flag" size={9} />{m.kind === 'sla' ? `SLA ${clock24(m.iso)}` : clock24(m.iso)} · {m.e.key ?? m.e.title}
      </button>
    </>
  );
}

/** The phone's "Your day": the same day as a list in time order (Apple's Up Next list), each row opening the same detail card. */
export function YourDayList() {
  const { q, day: d, today, now, plan, savePlan } = useToday(false);
  const [open, setOpen] = useState<{ d: Detail; el: HTMLElement | null } | null>(null);
  const nowH = hourOf(now);
  const { actions: actionsOf } = useTodayEdit(today, nowH, plan, savePlan, d?.focus ?? [], () => document.querySelector('.pt-day'), () => {});
  const actions = actionsOf(d);
  if (!d) return <section className="pt-card pt-day" aria-label="Your day"><p className="pt-quiet">{q.isError ? 'Your day could not be read.' : 'Reading your day…'}</p></section>;
  const c = dayCounts(d);
  const listMarks = dayMarks(d.day, d.due, now.getTime()), listMarked = new Set(listMarks.map((m) => `${m.e.type}:${m.e.id}`));
  type Row = { key: string; at: number; end: number | null; type: string; title: string; sub: string; det: Detail | null };
  const rows: Row[] = [
    ...d.meets.map((m) => ({ key: `meeting:${m.key}`, at: m.start, end: m.end, type: 'meeting', title: m.e.title, sub: m.e.projectName ?? 'Meeting', det: { kind: 'meeting', key: `meeting:${m.key}`, m } as Detail })),
    ...d.calls.map((t) => { const s = hoursOf(t); return { key: t.id, at: s.start, end: s.end, type: 'call', title: t.title, sub: `Call${t.people.length ? ` · ${t.people.length} people` : ''}`, det: { kind: 'call', key: `call:${t.id}`, t } as Detail }; }),
    ...d.time.map((t) => { const s = hoursOf(t); const ov = d.overlaps.get(t.id) ?? []; return { key: t.id, at: s.start, end: s.end, type: 'time', title: t.title, sub: `Logged ${fmtMins(t.minutes ?? 0)}${t.approximated ? ' · typed in' : ''}${ov.length ? ` · ${overlapText(ov[0])}` : ''}`, det: { kind: 'time', key: `time:${t.id}`, t } as Detail }; }),
    ...d.done.map((t) => { const s = hoursOf(t); return { key: t.id, at: s.start, end: null, type: 'done', title: t.title, sub: `Done${t.key ? ` · ${t.key}` : ''}`, det: { kind: 'done', key: `done:${t.id}`, t } as Detail }; }),
    ...d.reminders.map((t) => { const s = hoursOf(t); return { key: t.id, at: s.start, end: null, type: 'reminder', title: t.title, sub: 'Reminder', det: { kind: 'reminder', key: `reminder:${t.id}`, t } as Detail }; }),
    ...d.focus.map((f) => ({ key: f.key, at: f.start, end: f.end, type: 'focus', title: `${focusWord(f, today, nowH)} · ${focusLabel(f.e)}`, sub: 'Suggested focus', det: { kind: 'focus', key: f.key, f } as Detail })),
    // date-only work is due by the end of the shift (deadlineHourOf), and the check-in starts the day
    ...d.due.filter((e) => !isDone(e) && !listMarked.has(`${e.type}:${e.id}`)).map((e) => { const h = deadlineHourOf(e, d.shift); return { key: `deadline:${e.type}:${e.id}`, at: h, end: null, type: 'deadline', title: `${e.key ? `${e.key} ` : ''}${e.title}`,
      sub: h === d.shift.end ? 'Due by end of day' : `Due by ${clockH(h)}`, det: { kind: 'deadline', key: `deadline:${d.day}:${e.type}:${e.id}`, e, others: [] } as Detail }; }),
    ...(d.shift.checkIn != null ? [{ key: 'checkin', at: d.shift.checkIn, end: null, type: 'checkin', title: `Checked in at ${clockH(d.shift.checkIn)}`, sub: 'Attendance', det: null }] : []),
    ...listMarks.map((m) => ({ key: m.key, at: m.at, end: null, type: m.kind === 'sla' ? 'sla' : 'deadline',
      title: `${m.e.key ? `${m.e.key} ` : ''}${m.e.title}`, sub: m.kind === 'sla' ? `SLA ${m.late ? 'breached' : 'breach'} at ${clock24(m.iso)}` : `Due ${clock24(m.iso)}`,
      det: { kind: 'deadline', key: `deadline:${m.e.date}:${m.e.type}:${m.e.id}`, e: m.e, others: [] } as Detail })),
  ].sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
  return (
    <section className="pt-card pt-day" aria-label="Your day" data-testid="your-day" data-day={today} data-sig={daySignature(d)}>
      <div className="pt-eyebrow">YOUR DAY <ZoneBadge /></div>
      <p className="pt-day-counts" data-testid="your-day-counts">{c.meetings} meeting{c.meetings === 1 ? '' : 's'}{c.calls ? ` · ${c.calls} call${c.calls === 1 ? '' : 's'}` : ''} · {c.focus} focus · {dur(c.free)} free{c.logged ? ` · ${dur(c.logged)} logged` : ''}</p>
      {rows.length === 0 ? <p className="pt-quiet">Nothing on your day yet.</p> : (
        <ul className="pt-day-list">
          {rows.map((r) => (
            <li key={r.key}>
              <button type="button" className={`pt-day-row t-${r.type}${r.end != null && r.end < nowH ? ' past' : ''}`} data-type={r.type} disabled={!r.det}
                onClick={(ev) => { const el = ev.currentTarget, det = r.det; if (det) setOpen((o) => (o?.d.key === det.key ? null : { d: det, el })); }}>
                <span className="pt-day-t">{clockH(r.at)}</span><i aria-hidden="true" />
                <span className="pt-day-m"><b>{r.title}</b><small>{r.sub}</small></span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && <EventDetail detail={open.d} anchor={open.el} today={today} nowH={nowH} days={workWeek(today)} actions={actions} onClose={() => setOpen(null)} />}
    </section>
  );
}

