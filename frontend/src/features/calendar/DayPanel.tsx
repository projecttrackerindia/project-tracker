import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { CalendarEvent, TimeEntry, TimelineEvent } from '../../api/types';
import { Face } from '../../components/Face';
import { Icon } from '../../components/Icon';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { reminderApi } from '../reminders/api';
import { canComplete, completeWork, editError, overlapText, refreshAfterEdit } from './calendarEdit';
import { DOW3, MONTHS, RANK, clockH, countdown, dateOf, fmtMins, isDeadline, isDone, isWorkItem, type Detail, type Focus, type Meet } from './plannerModel';
import { dayCounts, focusLabel, hoursOf, type DayView } from './timeline';

const initials = (n: string) => n.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const longDay = (d: string) => { const x = dateOf(d); return `${x.toLocaleDateString('en-GB', { weekday: 'long' })} ${x.getDate()} ${MONTHS[x.getMonth()]}`; };
const span = (t: TimelineEvent) => { const h = hoursOf(t); return `${clockH(h.start)}${t.end && h.end > h.start ? ` – ${clockH(h.end)}` : ''}`; };

/**
 * The Day panel (Apple Calendar's inspector): everything on the chosen day from the same timeline the grid draws — now and next, meetings and
 * calls (Join, notes), work due (overdue first; complete it here), what was finished and when, the time logged against the day's capacity,
 * reminders (done, snooze) and attendance. A block chosen on the grid shows its detail and edit form at the top. The week in one line below.
 * It is empty only when the day truly has nothing.
 */
export function DayPanel({ day, today, nowH, dv, meets, focus, overdue, peopleOf, entries, capacityMin, detail, detailKey, week, onOpen, onCreate, onDone }: {
  day: string; today: string; nowH: number; dv: DayView | undefined; meets: Meet[]; focus: Focus[]; overdue: CalendarEvent[];
  peopleOf: (sourceId: string) => string[]; entries: Map<string, TimeEntry>; capacityMin: number;
  /** The chosen block's detail (inline), shown first. */
  detail: ReactNode;
  detailKey?: string | null;
  /** The ✦ week line. */
  week: ReactNode;
  onOpen: (d: Detail, el: HTMLElement) => void;
  /** Log time on this day (opens the chooser at the next free quarter hour). */
  onCreate: (day: string) => void;
  /** An item was completed here: hide it at once. */
  onDone: (e: CalendarEvent) => void;
}) {
  const wid = useWorkspaceId();
  const [busy, setBusy] = useState<string | null>(null);
  const isToday = day === today;
  // A block chosen on the grid: its card is at the top of the panel, so the panel shows its top.
  const ref = useRef<HTMLElement>(null);
  const shown = !!detail;
  useEffect(() => { if (shown && ref.current) { ref.current.scrollTop = 0; if (ref.current.getBoundingClientRect().top < 0) ref.current.scrollIntoView({ block: 'start', behavior: 'smooth' }); } }, [shown, detailKey]);
  const calls = dv?.calls ?? [], time = dv?.time ?? [], done = dv?.done ?? [], reminders = dv?.reminders ?? [], attendance = dv?.attendance ?? [];
  const due = [...(isToday ? overdue : []), ...(dv?.due ?? [])]
    .filter((e, i, all) => !isDone(e) && all.findIndex((x) => x.type === e.type && x.id === e.id) === i)
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || (RANK[a.priority ?? ''] ?? 4) - (RANK[b.priority ?? ''] ?? 4) || a.date.localeCompare(b.date));
  // Logged and free time as Today counts them (dayCounts): today's logged time only up to now, free time from max(now, check-in) to the shift's end.
  const logged = dv?.loggedMin ?? 0;
  const free = dv && day >= today && !(dv.off.length) ? dayCounts(dv).free : null;
  const off = dv?.off ?? [];

  // ---- now and next (today only): what covers this minute, and the first thing still to come
  type Slot = { key: string; start: number; end: number; title: string; kind: 'meeting' | 'call' | 'focus' | 'reminder'; open: () => Detail };
  const slots: Slot[] = [
    ...meets.map((m): Slot => ({ key: `meeting:${day}:${m.key}`, start: m.start, end: m.end, title: m.e.title, kind: 'meeting', open: () => ({ kind: 'meeting', key: `meeting:${day}:${m.key}`, m }) })),
    ...calls.map((t): Slot => { const h = hoursOf(t); return { key: `call:${day}:${t.id}`, start: h.start, end: Math.max(h.end, h.start + .25), title: t.title, kind: 'call', open: () => ({ kind: 'call', key: `call:${day}:${t.id}`, t }) }; }),
    ...focus.map((f): Slot => ({ key: f.key, start: f.start, end: f.end, title: focusLabel(f.e), kind: 'focus', open: () => ({ kind: 'focus', key: f.key, f }) })),
    ...reminders.filter((t) => t.status === 'scheduled').map((t): Slot => { const h = hoursOf(t).start; return { key: `reminder:${day}:${t.id}`, start: h, end: h, title: t.title, kind: 'reminder', open: () => ({ kind: 'reminder', key: `reminder:${day}:${t.id}`, t }) }; }),
  ].sort((a, b) => a.start - b.start);
  const now = isToday ? slots.find((s) => s.kind !== 'reminder' && s.start <= nowH && s.end > nowH) ?? null : null;
  const next = isToday ? slots.find((s) => s.start > nowH) ?? null : null;
  const hero = isToday ? meets.filter((m) => m.end > nowH).sort((a, b) => a.start - b.start)[0] ?? null : null;

  const complete = async (e: CalendarEvent) => {
    setBusy(`${e.type}:${e.id}`);
    try { await completeWork(e); onDone(e); toast(`${e.key ?? e.title} marked done.`, 'success'); refreshAfterEdit(wid); }
    catch (err) { toast(editError(err, 'That could not be marked done.'), 'error'); }
    finally { setBusy(null); }
  };
  const remind = async (t: TimelineEvent, how: 'done' | 'snooze') => {
    setBusy(t.id);
    try { if (how === 'done') await reminderApi.done(t.sourceId); else await reminderApi.snooze(t.sourceId, '1h'); toast(how === 'done' ? 'Reminder done.' : 'Snoozed for an hour.', 'success'); refreshAfterEdit(wid); }
    catch (err) { toast(editError(err, 'The reminder could not be changed.'), 'error'); }
    finally { setBusy(null); }
  };
  const row = (d: Detail) => (ev: React.MouseEvent<HTMLElement>) => onOpen(d, ev.currentTarget);
  const nothing = !meets.length && !calls.length && !due.length && !done.length && !time.length && !reminders.length && !attendance.length && !focus.length && !off.length;
  const counts = [meets.length && `${meets.length} meeting${meets.length === 1 ? '' : 's'}`, calls.length && `${calls.length} call${calls.length === 1 ? '' : 's'}`,
    due.length && `${due.length} due`, done.length && `${done.length} done`, logged > 0 && `${fmtMins(logged)} logged`].filter(Boolean).join(' · ');

  return (
    <aside ref={ref} className="wp-insp wp-dayp" aria-label={`Day · ${longDay(day)}`} data-testid="day-panel" data-day={day} data-keep-detail>
      {detail}
      <header className="dp-hd">
        <h2>{isToday ? 'Today' : DOW3[dateOf(day).getDay()]}<span>{longDay(day).replace(/^\w+ /, '')}</span></h2>
        {(counts || free != null) && <p className="dp-sum">{counts}{free != null && <>{counts ? ' · ' : ''}<span data-testid="day-free">{fmtMins(free)} free</span></>}</p>}
        {off.map((o) => <span key={o.id} className="dp-off">{o.type === 'holiday' ? `Holiday · ${o.title}` : `On leave${o.note ? ` · ${o.note}` : ''}`}</span>)}
      </header>

      {nothing && (
        <div className="dp-empty" data-testid="day-empty">
          <p>Nothing on {isToday ? 'today' : longDay(day)}.</p>
          <button type="button" className="dp-link" onClick={() => onCreate(day)}>Log time, plan focus or schedule a meeting</button>
        </div>
      )}

      {(now || next || hero) && (
        <section className="dp-sec dp-now" aria-label="Now and next">
          {now && <button type="button" className="dp-nn" data-block-ref={now.key} onClick={row(now.open())}><em className="live">Now</em><b>{now.title}</b><small>until {clockH(now.end)}</small></button>}
          {hero && <MeetingHero m={hero} today={today} nowH={nowH} onOpen={row({ kind: 'meeting', key: `meeting:${day}:${hero.key}`, m: hero })} />}
          {next && (!hero || next.title !== hero.e.title) && <button type="button" className="dp-nn" onClick={row(next.open())}><em>Next</em><b>{next.title}</b><small>{clockH(next.start)} · {countdown(day, next.start, next.end, today, nowH) ?? ''}</small></button>}
        </section>
      )}

      {(meets.length > 0 || calls.length > 0) && (
        <section className="dp-sec" aria-label="Meetings and calls">
          <h3>Meetings &amp; calls</h3>
          {meets.map((m) => {
            const join = m.e.joinUrl ?? m.feed?.joinUrl ?? null;
            const ended = countdown(day, m.start, m.end, today, nowH) === 'ended';
            return (
              <div key={m.key} className="dp-row" data-type="meeting">
                <button type="button" className="dp-main" onClick={row({ kind: 'meeting', key: `meeting:${day}:${m.key}`, m })} title={m.e.title}>
                  <i className="dp-dot t" aria-hidden="true" /><span className="dp-t">{m.e.title}</span><small>{clockH(m.start)} – {clockH(m.end)}{m.e.projectName ? ` · ${m.e.projectName}` : ''}</small>
                </button>
                {join && !ended && (/^https?:/.test(join) ? <a className="dp-act" href={join} target="_blank" rel="noreferrer">Join</a> : <a className="dp-act" href={join}>Join</a>)}
                {ended && (m.e.notes || (m.feed && m.feed.notetaker !== 'off')) && <button type="button" className="dp-act ghost" onClick={row({ kind: 'meeting', key: `meeting:${day}:${m.key}`, m })}>Notes</button>}
              </div>
            );
          })}
          {calls.map((t) => (
            <div key={t.id} className="dp-row" data-type="call">
              <button type="button" className="dp-main" onClick={row({ kind: 'call', key: `call:${day}:${t.id}`, t })} title={t.title}>
                <Icon name="phone" size={11} /><span className="dp-t">{t.title}</span><small>{span(t)}{t.running ? ' · live' : ''}{t.people.length ? ` · ${t.people.length} people` : ''}</small>
              </button>
              {t.notes && <button type="button" className="dp-act ghost" onClick={row({ kind: 'call', key: `call:${day}:${t.id}`, t })}>Notes</button>}
            </div>
          ))}
        </section>
      )}

      {due.length > 0 && (
        <section className="dp-sec" aria-label="Work due">
          <h3>Work due<em>{due.length}</em></h3>
          {due.map((e) => {
            const owner = peopleOf(e.id)[0] ?? null;
            const flag = isDeadline(e) || e.overdue;
            const k = `${e.type}:${e.id}`;
            return (
              <div key={k} className={`dp-row${e.overdue ? ' late' : ''}`} data-type="due">
                {isWorkItem(e) && canComplete(e)
                  ? <button type="button" className="dp-check" aria-label={`Complete ${e.key ?? e.title}`} disabled={busy === k} onClick={() => void complete(e)} />
                  : <i className={`dp-dot ${flag ? 'r' : 'g'}`} aria-hidden="true" />}
                <button type="button" className="dp-main" title={e.title} onClick={row({ kind: 'deadline', key: `deadline:${e.date}:${e.type}:${e.id}`, e, others: [] })}>
                  <span className="dp-t">{e.key && <code>{e.key}</code>}{e.title}</span>
                  <small>
                    {e.overdue ? <b className="late">overdue · {DOW3[dateOf(e.date).getDay()]} {dateOf(e.date).getDate()}</b> : e.type === 'project' || e.type === 'milestone' || e.type === 'stage' ? e.type : 'due'}
                    {e.status && ` · ${e.status}`}{e.priority && ` · ${e.priority}`}
                    {e.projectName && ` · ${e.projectName}`}
                  </small>
                </button>
                {owner && <Face byName name={owner} className="dp-av" title={owner} text={initials(owner)} />}
              </div>
            );
          })}
        </section>
      )}

      {done.length > 0 && (
        <section className="dp-sec" aria-label="Done">
          <h3>Done<em>{done.length}</em></h3>
          {done.map((t) => (
            <div key={t.id} className="dp-row" data-type="done">
              <button type="button" className="dp-main" title={t.title} onClick={row({ kind: 'done', key: `done:${day}:${t.id}`, t })}>
                <i className="dp-tick" aria-hidden="true"><Icon name="check" size={9} /></i><span className="dp-t">{t.key && <code>{t.key}</code>}{t.title}</span><small>finished {clockH(hoursOf(t).start)}{t.projectName ? ` · ${t.projectName}` : ''}</small>
              </button>
            </div>
          ))}
        </section>
      )}

      {(time.length > 0 || day <= today) && !nothing && (
        <section className="dp-sec" aria-label="Logged time">
          <h3>Logged time<em>{fmtMins(logged)} of {fmtMins(capacityMin)}</em></h3>
          <span className="dp-cap" aria-hidden="true"><i style={{ width: `${Math.min(100, (logged / Math.max(1, capacityMin)) * 100)}%` }} className={logged > capacityMin ? 'over' : ''} /></span>
          {time.map((t) => {
            const en = entries.get(t.sourceId);
            const ov = dv?.overlaps.get(t.id) ?? [];
            return (
              <div key={t.id} className={`dp-row${ov.length ? ' ovl' : ''}`} data-type="time" data-overlaps={ov.length || undefined}>
                <button type="button" className="dp-main" title={t.title} onClick={row({ kind: 'time', key: `time:${t.date}:${t.id}`, t })}>
                  <i className="dp-dot g" aria-hidden="true" /><span className="dp-t">{en?.taskKey && <code>{en.taskKey}</code>}{t.title}</span>
                  <small>{t.approximated ? '≈ ' : ''}{span(t)}{t.projectName ? ` · ${t.projectName}` : ''}{en?.locked ? ' · locked' : ''}{t.note ? ` · ${t.note}` : ''}
                    {ov.length > 0 && <em className="dp-ovl" data-testid="dp-overlap">{overlapText(ov[0], entries.get(ov[0].sourceId)?.taskKey)}{ov.length > 1 ? ` +${ov.length - 1}` : ''} · Adjust</em>}</small>
                </button>
                <span className="dp-m">{t.running ? 'running' : fmtMins(t.minutes ?? 0)}</span>
              </div>
            );
          })}
          {day <= today && <button type="button" className="dp-link" data-testid="dp-log" onClick={() => onCreate(day)}>+ Log time</button>}
        </section>
      )}

      {reminders.length > 0 && (
        <section className="dp-sec" aria-label="Reminders">
          <h3>Reminders</h3>
          {reminders.map((t) => {
            const closed = t.status === 'done' || t.status === 'cancelled';
            return (
              <div key={t.id} className="dp-row" data-type="reminder">
                <button type="button" className="dp-main" title={t.title} onClick={row({ kind: 'reminder', key: `reminder:${day}:${t.id}`, t })}>
                  <i className="dp-ring" aria-hidden="true" /><span className="dp-t">{t.title}</span><small>{clockH(hoursOf(t).start)}{t.status !== 'scheduled' ? ` · ${closed ? 'done' : 'went off'}` : ''}</small>
                </button>
                {!closed && <button type="button" className="dp-act" disabled={busy === t.id} onClick={() => void remind(t, 'done')}>Done</button>}
                {!closed && <button type="button" className="dp-act ghost" disabled={busy === t.id} onClick={() => void remind(t, 'snooze')}>Snooze</button>}
              </div>
            );
          })}
        </section>
      )}

      {attendance.length > 0 && (
        <section className="dp-sec" aria-label="Attendance">
          <h3>Attendance</h3>
          {attendance.map((t) => (
            <div key={t.id} className="dp-row" data-type="attendance"><span className="dp-main static"><i className="dp-dot b" aria-hidden="true" /><span className="dp-t">{t.title}</span>
              <small>in {clockH(hoursOf(t).start)}{t.end ? ` · out ${clockH(hoursOf(t).end)}` : t.running ? ' · still in' : ''}{t.status === 'auto-closed' ? ' · closed automatically' : ''}</small></span></div>
          ))}
        </section>
      )}

      <section className="dp-week" aria-label="Week summary">{week}</section>
    </aside>
  );
}

/** The meeting coming up (or on now): the design's inspector card — its time, how soon, Join, and whether notes are taken. */
function MeetingHero({ m, today, nowH, onOpen }: { m: Meet; today: string; nowH: number; onOpen: (ev: React.MouseEvent<HTMLElement>) => void }) {
  const e = m.e, f = m.feed;
  const join = e.joinUrl ?? f?.joinUrl ?? null;
  const cd = countdown(m.day, m.start, m.end, today, nowH);
  const notes = !!e.notes || (f ? f.notetaker === 'transcript' || f.notetaker === 'voice' : false);
  return (
    <div className="dp-hero">
      <div className="wp-insp-top">{e.projectName && <span className="wp-pill">{e.projectName}</span>}{cd && <span className={`wp-faint${cd === 'now' ? ' live' : ''}`}>{cd}</span>}</div>
      <h3><button type="button" className="dp-hero-t" onClick={onOpen}>{e.title}</button></h3>
      <p className="wp-when">{clockH(m.start)} – {clockH(m.end)}{f?.providerName ? ` · ${f.providerName}` : ''}</p>
      {join && (/^https?:/.test(join) ? <a className="wp-join" href={join} target="_blank" rel="noreferrer">Join meeting</a> : <a className="wp-join" href={join}>Join meeting</a>)}
      <div className="wp-notes">
        <span className="wp-orb" aria-hidden="true" />
        <div><b>Notes by Project Tracker</b><small>Summary &amp; action items after the call</small></div>
        <button type="button" role="switch" aria-checked={notes} aria-label="Notes by Project Tracker" className={`wp-sw${notes ? ' on' : ''}`} aria-disabled="true"
          title="The notetaker is set on the meeting — open it to change" onClick={onOpen} />
      </div>
    </div>
  );
}
