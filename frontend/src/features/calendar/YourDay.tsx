import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { TimelineEvent } from '../../api/types';
import { Icon } from '../../components/Icon';
import { invalidateWorkspace } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { EventDetail, type DetailActions } from './EventDetail';
import { clockH, fmtMins, hourOf, planKey, type Detail, type PlanOverrides } from './plannerModel';
import { dayCounts, daySignature, focusLabel, hoursOf, workWeek } from './timeline';
import { dayMarks, type DayMark } from './deadline';
import { clock24 } from '../work/dueTime';
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

/**
 * "Your day" on Today: the working day on two lanes — meetings and calls above; logged time (green) and focus blocks (indigo, as on the
 * Calendar) below — with finished work as check pills and reminders as rings on a third row, and a red line for now. The header counts are
 * the day's own (dayCounts), the same numbers the Calendar's day shows. Every block opens the Calendar's detail card.
 */
export function YourDay({ team }: { team: boolean }) {
  const { q, day, today, now, plan, savePlan } = useToday(team);
  const actions = useActions(plan, savePlan);
  const [open, setOpen] = useState<{ d: Detail; el: HTMLElement | null } | null>(null);
  const nowH = hourOf(now);
  const d = day;
  // Deadlines with a time and SLA breaches, at their hour (markers only: the lanes stay as they are).
  const marks = d ? dayMarks(d.day, d.due, now.getTime()) : [];
  // the ruler: 9 AM to 7 PM, wider when something happened earlier or later
  const timed = d ? [...d.meets.map((m) => [m.start, m.end]), ...[...d.calls, ...d.time, ...d.done, ...d.reminders].map((t) => { const h = hoursOf(t); return [h.start, h.end]; }),
    ...marks.map((m) => [m.at, m.at])] : [];
  const h0 = Math.max(0, Math.min(9, ...timed.map((x) => Math.floor(x[0])))), h1 = Math.min(24, Math.max(20, ...timed.map((x) => Math.ceil(x[1]))));
  const cols = h1 - h0;
  const pct = (h: number) => `${(Math.min(cols, Math.max(0, h - h0)) / cols) * 100}%`;
  const width = (a: number, b: number) => `${(Math.max(.25, Math.min(b, h1) - Math.max(a, h0)) / cols) * 100}%`;
  const c = d ? dayCounts(d) : null;
  const show = (det: Detail, el: HTMLElement) => setOpen((o) => (o?.d.key === det.key ? null : { d: det, el }));
  const cap = (t: TimelineEvent) => hoursOf(t);
  return (
    <section className="hm-card hm-yday" aria-label="Your day" data-testid="your-day" data-day={today} data-sig={d ? daySignature(d) : ''}>
      <div className="hm-day-hd"><h2 className="hm-h3">Your day</h2>
        {c ? (
          <span className="hm-faint" data-testid="your-day-counts">
            {c.meetings} meeting{c.meetings === 1 ? '' : 's'}{c.calls > 0 && <> · {c.calls} call{c.calls === 1 ? '' : 's'}</>} · {c.focus} focus block{c.focus === 1 ? '' : 's'} · {dur(c.free)} free
            {c.done > 0 && <> · {c.done} done</>}
            {c.logged > 0 && <> · <Link to="/insights?tab=time" className="hm-logged">{dur(c.logged)} logged</Link></>}
          </span>
        ) : <span className="hm-faint">{q.isError ? 'Your day could not be read.' : 'Reading your day…'}</span>}
        <Link to="/?tab=calendar" className="hm-yday-cal">Calendar<Icon name="chevronR" size={11} /></Link>
      </div>
      <div className="hm-day-track tl">
        <div className="hm-lane a" /><div className="hm-lane b" /><div className="hm-lane m" />
        {d?.meets.map((m, i) => (
          <button type="button" key={m.key} className={`hm-cap ${MEET_TINTS[i % MEET_TINTS.length]}`} data-type="meeting" style={{ left: pct(m.start), width: width(m.start, m.end), top: 0 }}
            title={`${clockH(m.start)} · ${m.e.title}`} onClick={(ev) => show({ kind: 'meeting', key: `meeting:${m.key}`, m }, ev.currentTarget)}>
            {m.e.title}<small>{clockH(m.start)} – {clockH(m.end)}{m.e.joinUrl ? ' · Meet' : ''}</small>
          </button>
        ))}
        {d?.calls.map((t) => { const s = cap(t); return (
          <button type="button" key={t.id} className="hm-cap call" data-type="call" style={{ left: pct(s.start), width: width(s.start, Math.max(s.end, s.start + .25)), top: 0 }}
            title={`Call · ${t.title}`} onClick={(ev) => show({ kind: 'call', key: `call:${t.id}`, t }, ev.currentTarget)}>
            <Icon name="phone" size={10} /> {t.title}<small>{clockH(s.start)}{t.running ? ' · live' : ` – ${clockH(s.end)}`}</small>
          </button>
        ); })}
        {d?.time.map((t) => { const s = cap(t); return (
          <button type="button" key={t.id} className={`hm-cap logged${t.approximated ? ' ap' : ''}`} data-type="time" style={{ left: pct(s.start), width: width(s.start, Math.max(s.end, s.start + .25)), top: 46 }}
            title={`Logged · ${t.title}`} onClick={(ev) => show({ kind: 'time', key: `time:${t.id}`, t }, ev.currentTarget)}>
            {t.running ? 'Running · ' : ''}{t.title}<small>{t.approximated ? '≈ ' : ''}{clockH(s.start)}{t.running ? '' : ` – ${clockH(s.end)}`}</small>
          </button>
        ); })}
        {d?.focus.map((f) => (
          <button type="button" key={f.key} className="hm-cap focus" data-type="focus" style={{ left: pct(f.start), width: width(f.start, f.end), top: 46 }} title={`Focus · ${focusLabel(f.e)}`}
            onClick={(ev) => show({ kind: 'focus', key: f.key, f }, ev.currentTarget)}>
            Focus · {focusLabel(f.e)}<small>{clockH(f.start)} – {clockH(f.end)}</small>
          </button>
        ))}
        {d?.done.map((t) => { const s = cap(t); return (
          <button type="button" key={t.id} className="hm-pin done" data-type="done" style={{ left: pct(s.start) }} title={`Done ${clockH(s.start)} · ${t.key ?? ''} ${t.title}`}
            onClick={(ev) => show({ kind: 'done', key: `done:${t.id}`, t }, ev.currentTarget)}>
            <Icon name="check" size={9} />{t.key ?? t.title}
          </button>
        ); })}
        {d?.reminders.map((t) => { const s = cap(t); return (
          <button type="button" key={t.id} className="hm-pin rem" data-type="reminder" style={{ left: pct(s.start) }} title={`Reminder ${clockH(s.start)} · ${t.title}`}
            onClick={(ev) => show({ kind: 'reminder', key: `reminder:${t.id}`, t }, ev.currentTarget)}>
            <i aria-hidden="true" />{t.title}
          </button>
        ); })}
        {marks.map((m) => <DeadlineMark key={m.key} m={m} left={pct(m.at)} onOpen={(el) => show({ kind: 'deadline', key: `deadline:${m.e.date}:${m.e.type}:${m.e.id}`, e: m.e, others: [] }, el)} />)}
        {nowH >= h0 && nowH <= h1 && (
          <div className="hm-now" style={{ left: pct(nowH) }} aria-label={`Now, ${clockH(nowH)}`} data-testid="your-day-now"><span>{clockH(nowH)}</span></div>
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
  const actions = useActions(plan, savePlan);
  const [open, setOpen] = useState<{ d: Detail; el: HTMLElement | null } | null>(null);
  const nowH = hourOf(now);
  if (!d) return <section className="pt-card pt-day" aria-label="Your day"><p className="pt-quiet">{q.isError ? 'Your day could not be read.' : 'Reading your day…'}</p></section>;
  const c = dayCounts(d);
  type Row = { key: string; at: number; end: number | null; type: string; title: string; sub: string; det: Detail };
  const rows: Row[] = [
    ...d.meets.map((m) => ({ key: `meeting:${m.key}`, at: m.start, end: m.end, type: 'meeting', title: m.e.title, sub: m.e.projectName ?? 'Meeting', det: { kind: 'meeting', key: `meeting:${m.key}`, m } as Detail })),
    ...d.calls.map((t) => { const s = hoursOf(t); return { key: t.id, at: s.start, end: s.end, type: 'call', title: t.title, sub: `Call${t.people.length ? ` · ${t.people.length} people` : ''}`, det: { kind: 'call', key: `call:${t.id}`, t } as Detail }; }),
    ...d.time.map((t) => { const s = hoursOf(t); return { key: t.id, at: s.start, end: s.end, type: 'time', title: t.title, sub: `Logged ${fmtMins(t.minutes ?? 0)}${t.approximated ? ' · typed in' : ''}`, det: { kind: 'time', key: `time:${t.id}`, t } as Detail }; }),
    ...d.done.map((t) => { const s = hoursOf(t); return { key: t.id, at: s.start, end: null, type: 'done', title: t.title, sub: `Done${t.key ? ` · ${t.key}` : ''}`, det: { kind: 'done', key: `done:${t.id}`, t } as Detail }; }),
    ...d.reminders.map((t) => { const s = hoursOf(t); return { key: t.id, at: s.start, end: null, type: 'reminder', title: t.title, sub: 'Reminder', det: { kind: 'reminder', key: `reminder:${t.id}`, t } as Detail }; }),
    ...d.focus.map((f) => ({ key: f.key, at: f.start, end: f.end, type: 'focus', title: `Focus · ${focusLabel(f.e)}`, sub: 'Suggested focus', det: { kind: 'focus', key: f.key, f } as Detail })),
    ...dayMarks(d.day, d.due, now.getTime()).map((m) => ({ key: m.key, at: m.at, end: null, type: m.kind === 'sla' ? 'sla' : 'deadline',
      title: `${m.e.key ? `${m.e.key} ` : ''}${m.e.title}`, sub: m.kind === 'sla' ? `SLA ${m.late ? 'breached' : 'breach'} at ${clock24(m.iso)}` : `Due ${clock24(m.iso)}`,
      det: { kind: 'deadline', key: `deadline:${m.e.date}:${m.e.type}:${m.e.id}`, e: m.e, others: [] } as Detail })),
  ].sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
  return (
    <section className="pt-card pt-day" aria-label="Your day" data-testid="your-day" data-day={today} data-sig={daySignature(d)}>
      <div className="pt-eyebrow">YOUR DAY</div>
      <p className="pt-day-counts" data-testid="your-day-counts">{c.meetings} meeting{c.meetings === 1 ? '' : 's'}{c.calls ? ` · ${c.calls} call${c.calls === 1 ? '' : 's'}` : ''} · {c.focus} focus · {dur(c.free)} free{c.logged ? ` · ${dur(c.logged)} logged` : ''}</p>
      {rows.length === 0 ? <p className="pt-quiet">Nothing on your day yet.</p> : (
        <ul className="pt-day-list">
          {rows.map((r) => (
            <li key={r.key}>
              <button type="button" className={`pt-day-row t-${r.type}${r.end != null && r.end < nowH ? ' past' : ''}`} data-type={r.type} onClick={(ev) => { const el = ev.currentTarget; setOpen((o) => (o?.d.key === r.det.key ? null : { d: r.det, el })); }}>
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

