import { useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { CalendarEvent } from '../../api/types';
import { Icon } from '../../components/Icon';
import { invalidateWorkspace } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { EventDetail, type DetailActions } from './EventDetail';
import { END, START, clockH, fmtMins, hourOf, isDone, lanes, planKey, type Detail, type PlanOverrides } from './plannerModel';
import { dayCounts, daySignature, deadlineHourOf, focusLabel, focusWord, hoursOf, workWeek } from './timeline';
import { useToday } from './useToday';
import './planner.css';
import './eventDetail.css';

const MEET_TINTS = ['m-teal', 'm-indigo', 'm-green'];
/** The ruler as the design: the first hour with AM/PM, noon as 12 PM, the rest bare. */
const label = (h: number, first: boolean) => (h === 12 ? '12 PM' : first ? `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}` : String(h % 12 || 12));
const dur = (mins: number) => fmtMins(Math.max(0, Math.round(mins)));

/** The detail card's actions from Today: focus changes are saved to the same plan the Calendar reads; meetings move from the Calendar. */
function useActions(plan: PlanOverrides, savePlan: (p: PlanOverrides) => void): DetailActions {
  const wid = useWorkspaceId();
  return {
    moveFocus: (f, day, start) => savePlan({ ...plan, [planKey(f.e)]: { day, start, len: f.end - f.start } }),
    removeFocus: (f) => savePlan({ ...plan, [planKey(f.e)]: 'removed' }),
    done: () => { void invalidateWorkspace(wid, 'timeline'); },
    moveMeeting: () => {},
    canMoveMeeting: () => 'Move it from the Calendar',
  };
}

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
  const { q, day, today, now, plan, savePlan } = useToday(team);
  const actions = useActions(plan, savePlan);
  const [open, setOpen] = useState<{ d: Detail; el: HTMLElement | null } | null>(null);
  const nowH = hourOf(now);
  const d = day;
  const shift = d?.shift ?? { start: START, end: END, checkIn: null };
  // the ruler: 9 AM to 8 PM, wider when something happened earlier or later
  const timed = d ? [...d.meets.map((m) => [m.start, m.end]), ...[...d.calls, ...d.time, ...d.done, ...d.reminders].map((t) => { const h = hoursOf(t); return [h.start, h.end]; }),
    ...(shift.checkIn != null ? [[shift.checkIn, shift.checkIn]] : [])] : [];
  const h0 = Math.max(0, Math.min(9, ...timed.map((x) => Math.floor(x[0])))), h1 = Math.min(24, Math.max(20, ...timed.map((x) => Math.ceil(x[1]))));
  const cols = h1 - h0;
  const frac = (h: number) => (Math.min(cols, Math.max(0, h - h0)) / cols) * 100;
  const pct = (h: number) => `${frac(h)}%`;
  const width = (a: number, b: number) => `${(Math.max(.25, Math.min(b, h1) - Math.max(a, h0)) / cols) * 100}%`;
  const c = d ? dayCounts(d) : null;
  const show = (det: Detail, el: HTMLElement) => setOpen((o) => (o?.d.key === det.key ? null : { d: det, el }));
  const isToday = d?.day === today;

  // ---- the main row: meetings, calls and focus, in side-by-side lanes when they overlap
  type Block = { key: string; start: number; end: number; node: (style: CSSProperties, half: boolean) => ReactNode };
  const blocks: Block[] = d ? [
    ...d.meets.map((m, i): Block => ({ key: `meeting:${m.key}`, start: m.start, end: m.end, node: (style, half) => (
      <button type="button" key={m.key} className={`hm-cap ${MEET_TINTS[i % MEET_TINTS.length]}${half ? ' half' : ''}`} data-type="meeting" data-start={m.start} style={style}
        title={`${clockH(m.start)} – ${clockH(m.end)} · ${m.e.title}`} onClick={(ev) => show({ kind: 'meeting', key: `meeting:${m.key}`, m }, ev.currentTarget)}>
        <span className="hm-cap-t">{m.e.title}</span><small>{clockH(m.start)} – {clockH(m.end)}{m.e.joinUrl ? ' · Meet' : ''}</small>
      </button>
    ) })),
    ...d.calls.map((t): Block => { const s = hoursOf(t); const e = Math.max(s.end, s.start + .25); return { key: `call:${t.id}`, start: s.start, end: e, node: (style, half) => (
      <button type="button" key={t.id} className={`hm-cap call${half ? ' half' : ''}`} data-type="call" data-start={s.start} style={style}
        title={`Call · ${t.title}`} onClick={(ev) => show({ kind: 'call', key: `call:${t.id}`, t }, ev.currentTarget)}>
        <span className="hm-cap-t"><Icon name="phone" size={10} /> {t.title}</span><small>{clockH(s.start)}{t.running ? ' · live' : ` – ${clockH(s.end)}`}</small>
      </button>
    ) }; }),
    ...d.focus.map((f): Block => ({ key: f.key, start: f.start, end: f.end, node: (style, half) => {
      const word = focusWord(f, today, nowH);
      return (
        <button type="button" key={f.key} className={`hm-cap focus${word === 'Focus now' ? ' now' : ''}${half ? ' half' : ''}`} data-type="focus" data-start={f.start} data-end={f.end} style={style}
          title={`${word} · ${focusLabel(f.e)} · ${clockH(f.start)} – ${clockH(f.end)}`} onClick={(ev) => show({ kind: 'focus', key: f.key, f }, ev.currentTarget)}>
          <span className="hm-cap-t">{word} · {focusLabel(f.e)}</span><small>{clockH(f.start)} – {clockH(f.end)}</small>
        </button>
      );
    } })),
  ] : [];
  const lane = lanes(blocks.map((b) => ({ key: b.key, start: b.start, end: b.end })));
  const ROW = 38;

  // ---- the pins: finished work, reminders, the check-in and deadlines (date-only at the shift's end: "by end of day")
  const deadlines = new Map<number, CalendarEvent[]>();
  for (const e of d?.due ?? []) {
    if (isDone(e)) continue;
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
    <section className="hm-card hm-yday" aria-label="Your day" data-testid="your-day" data-day={today} data-sig={d ? daySignature(d) : ''}>
      <div className="hm-day-hd"><h2 className="hm-h3">Your day</h2>
        {c ? (
          <span className="hm-faint" data-testid="your-day-counts">
            {c.meetings} meeting{c.meetings === 1 ? '' : 's'}{c.calls > 0 && <> · {c.calls} call{c.calls === 1 ? '' : 's'}</>} · {c.focus} focus block{c.focus === 1 ? '' : 's'} · <span data-testid="your-day-free">{dur(c.free)} free</span>
            {c.done > 0 && <> · {c.done} done</>}
            {c.logged > 0 && <> · <Link to="/insights?tab=time" className="hm-logged">{dur(c.logged)} logged</Link></>}
          </span>
        ) : <span className="hm-faint">{q.isError ? 'Your day could not be read.' : 'Reading your day…'}</span>}
        <Link to="/?tab=calendar" className="hm-yday-cal">Calendar<Icon name="chevronR" size={11} /></Link>
      </div>
      <div className={`hm-day-track tl lanes${two ? ' two' : ''}`}>
        {/* before the check-in: shaded, with the check-in as a line across the day */}
        {isToday && shift.checkIn != null && shift.checkIn > h0 && <div className="hm-pre" aria-hidden="true" style={{ left: 0, width: pct(shift.checkIn) }} />}
        <div className="hm-lane a" /><div className="hm-lane lg" /><div className="hm-lane m" />
        {shift.checkIn != null && <div className="hm-in" data-testid="your-day-checkin" aria-label={`Checked in at ${clockH(shift.checkIn)}`} style={{ left: pct(shift.checkIn) }} />}
        {[...deadlines.keys()].map((h) => <div key={h} className="hm-dl" aria-hidden="true" data-testid="your-day-deadline" data-hour={h} style={{ left: pct(h) }} />)}
        {blocks.map((b) => {
          const l = lane.get(b.key) ?? { lane: 0, of: 1 };
          const hgt = l.of > 1 ? (ROW - (l.of - 1) * 2) / l.of : ROW;
          return b.node({ left: pct(b.start), width: width(b.start, b.end), top: l.lane * (hgt + 2), height: hgt }, l.of > 1);
        })}
        {d?.time.map((t) => {
          // logged time is time that has happened: never drawn past the now line
          const s = hoursOf(t);
          const end = isToday ? Math.min(s.end, nowH) : s.end;
          if (end <= s.start && !t.running) return null;
          return (
            <button type="button" key={t.id} className={`hm-lg${t.approximated ? ' ap' : ''}${t.running ? ' run' : ''}`} data-type="time" data-start={s.start} data-end={end}
              style={{ left: pct(s.start), width: `${(Math.max(1 / 12, Math.min(end, h1) - Math.max(s.start, h0)) / cols) * 100}%` }}
              title={`Logged · ${t.title} · ${t.approximated ? '≈ ' : ''}${clockH(s.start)}${t.running ? ' · running' : ` – ${clockH(end)}`}`}
              aria-label={`Logged ${t.title}, ${clockH(s.start)} to ${clockH(end)}`} onClick={(ev) => show({ kind: 'time', key: `time:${t.id}`, t }, ev.currentTarget)} />
          );
        })}
        {laid.map((p) => {
          const style: CSSProperties = { left: pct(p.at), top: PIN_TOP + p.row * 20, maxWidth: `min(200px, calc(${(p.room / cols) * 100}% - 4px))` };
          return p.det ? (
            <button type="button" key={p.key} className={`hm-pin ${p.cls}`} data-type={p.type} data-hour={p.at} style={style} title={p.title}
              onClick={(ev) => show(p.det!, ev.currentTarget)}>{p.body}</button>
          ) : <span key={p.key} className={`hm-pin ${p.cls}`} data-type={p.type} data-hour={p.at} style={style} title={p.title}>{p.body}</span>;
        })}
        {nowH >= h0 && nowH <= h1 && (
          <div className="hm-now" style={{ left: pct(nowH) }} aria-label={`Now, ${clockH(nowH)}`} data-testid="your-day-now" data-hour={nowH}><span>{clockH(nowH)}</span></div>
        )}
      </div>
      <div className="hm-hours" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>{Array.from({ length: cols }, (_, i) => h0 + i).map((h) => <span key={h}>{label(h, h === h0)}</span>)}</div>
      {open && <EventDetail detail={open.d} anchor={open.el} today={today} nowH={nowH} days={workWeek(today)} actions={actions} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** The phone's "Your day": the same day as a list in time order (Apple's Up Next list), each row opening the same detail card. */
export function YourDayList() {
  const { q, day: d, today, now, plan, savePlan } = useToday(false);
  const actions = useActions(plan, savePlan);
  const [open, setOpen] = useState<{ d: Detail; el: HTMLElement | null } | null>(null);
  const nowH = hourOf(now);
  if (!d) return <section className="pt-card pt-day" aria-label="Your day"><p className="pt-quiet">{q.isError ? 'Your day could not be read.' : 'Reading your day…'}</p></section>;
  const c = dayCounts(d);
  type Row = { key: string; at: number; end: number | null; type: string; title: string; sub: string; det: Detail | null };
  const rows: Row[] = [
    ...d.meets.map((m) => ({ key: `meeting:${m.key}`, at: m.start, end: m.end, type: 'meeting', title: m.e.title, sub: m.e.projectName ?? 'Meeting', det: { kind: 'meeting', key: `meeting:${m.key}`, m } as Detail })),
    ...d.calls.map((t) => { const s = hoursOf(t); return { key: t.id, at: s.start, end: s.end, type: 'call', title: t.title, sub: `Call${t.people.length ? ` · ${t.people.length} people` : ''}`, det: { kind: 'call', key: `call:${t.id}`, t } as Detail }; }),
    ...d.time.map((t) => { const s = hoursOf(t); return { key: t.id, at: s.start, end: s.end, type: 'time', title: t.title, sub: `Logged ${fmtMins(t.minutes ?? 0)}${t.approximated ? ' · typed in' : ''}`, det: { kind: 'time', key: `time:${t.id}`, t } as Detail }; }),
    ...d.done.map((t) => { const s = hoursOf(t); return { key: t.id, at: s.start, end: null, type: 'done', title: t.title, sub: `Done${t.key ? ` · ${t.key}` : ''}`, det: { kind: 'done', key: `done:${t.id}`, t } as Detail }; }),
    ...d.reminders.map((t) => { const s = hoursOf(t); return { key: t.id, at: s.start, end: null, type: 'reminder', title: t.title, sub: 'Reminder', det: { kind: 'reminder', key: `reminder:${t.id}`, t } as Detail }; }),
    ...d.focus.map((f) => ({ key: f.key, at: f.start, end: f.end, type: 'focus', title: `${focusWord(f, today, nowH)} · ${focusLabel(f.e)}`, sub: 'Suggested focus', det: { kind: 'focus', key: f.key, f } as Detail })),
    // date-only work is due by the end of the shift (deadlineHourOf), and the check-in starts the day
    ...d.due.filter((e) => !isDone(e)).map((e) => { const h = deadlineHourOf(e, d.shift); return { key: `deadline:${e.type}:${e.id}`, at: h, end: null, type: 'deadline', title: `${e.key ? `${e.key} ` : ''}${e.title}`,
      sub: h === d.shift.end ? 'Due by end of day' : `Due by ${clockH(h)}`, det: { kind: 'deadline', key: `deadline:${d.day}:${e.type}:${e.id}`, e, others: [] } as Detail }; }),
    ...(d.shift.checkIn != null ? [{ key: 'checkin', at: d.shift.checkIn, end: null, type: 'checkin', title: `Checked in at ${clockH(d.shift.checkIn)}`, sub: 'Attendance', det: null }] : []),
  ].sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
  return (
    <section className="pt-card pt-day" aria-label="Your day" data-testid="your-day" data-day={today} data-sig={daySignature(d)}>
      <div className="pt-eyebrow">YOUR DAY</div>
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

