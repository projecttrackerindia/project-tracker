import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { meetingApi, taskApi, timeApi, workApi } from '../../api/endpoints';
import type { CalendarEvent, Task, TimeEntry, TimelineEvent, WorkTask } from '../../api/types';
import { Face } from '../../components/Face';
import { Icon } from '../../components/Icon';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { meetApi, type Rsvp } from '../meet/meetApi';
import { reminderApi } from '../reminders/api';
import { canComplete, canMoveDue, completeWork, editError, isoAt as isoAtHour, moveDue, moveReminder, refreshAfterEdit } from './calendarEdit';
import { appZone } from '../../lib/zone';
import { TimeEntryEditor, type WorkChoice } from './TimeEntryEditor';
import { KIND, countdown, END, MONTHS, START, SNAP, addDays, clockAP, dateOf, dayLabel, fmtMins, hourOf, hrefOf, type Detail, type Focus, type Meet } from './plannerModel';
import './eventDetail.css';

const KIND_NAME: Record<string, string> = { task: 'Task', action: 'Action item', work: 'Ticket', project: 'Project', milestone: 'Milestone', stage: 'Stage' };
const longDay = (day: string) => { const d = dateOf(day); return `${d.toLocaleDateString('en-GB', { weekday: 'long' })} ${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const keyOf = (e: CalendarEvent, task?: Task | null, work?: WorkTask | null) => task?.key ?? work?.key ?? e.key ?? /^[A-Z][A-Z0-9]+-\d+/.exec(e.title)?.[0] ?? null;
const ago = (s: string | null | undefined) => {
  if (!s) return null;
  const m = Math.round((Date.now() - Date.parse(s)) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const dueText = (date: string, today: string) => (date === today ? 'due today' : date < today ? `overdue since ${dayLabel(date, today)}` : `due ${dayLabel(date, today).replace(/^Tomorrow$/, 'tomorrow')}`);
export interface DetailActions {
  /** Move a focus block (a time you chose; kept on this device) or take its item out of the plan. */
  moveFocus: (f: Focus, day: string, start: number) => void;
  /** quiet: no Undo toast (the block became a time entry). */
  removeFocus: (f: Focus, quiet?: boolean) => void;
  /** Hide an item at once when it is marked done (the calendar then refetches). */
  done: (e: CalendarEvent) => void;
  /** Move a meeting you organise (the grid's own drag-to-move, with Undo). */
  moveMeeting: (m: Meet, day: string, start: number) => void;
  canMoveMeeting: (m: Meet) => string | null;
  /** Plan focus on an open item at a chosen time (kept with your plan). */
  planFocus?: (e: CalendarEvent, day: string, start: number, end: number) => void;
  /** Open items that can get focus time this week. */
  openItems?: CalendarEvent[];
  /** The timesheet's own entry behind a logged-time block (who may change it, its stamp), when it is mine. */
  entryOf?: (id: string) => TimeEntry | undefined;
  /** Work time can be logged on (this week's items and what time was logged on). */
  choices?: WorkChoice[];
}

/**
 * The card a calendar block opens, Apple Calendar style: anchored beside the block on a desktop (it springs out of it), a bottom sheet on a
 * phone. It says what the block is and why it is on the calendar, then what can be done with it right there.
 */
export function EventDetail({ detail, anchor, today, nowH, days, actions, onClose, inline = false }: {
  detail: Detail; anchor: HTMLElement | null; today: string; nowH: number; days: string[]; actions: DetailActions; onClose: () => void;
  /** Drawn at the top of the Day panel (a wide window) instead of a popover beside the block. */
  inline?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [isPhone] = useState(() => typeof window !== 'undefined' && window.innerWidth < 760);
  const phone = isPhone && !inline;
  const [pos, setPos] = useState<{ left: number; top: number; side: 'l' | 'r'; ox: number; oy: number } | null>(null);

  // place it beside the block, on the side with room, kept inside the window
  useLayoutEffect(() => {
    if (phone || inline || !anchor || !ref.current) return;
    const place = () => {
      const a = anchor.getBoundingClientRect(), el = ref.current!, w = el.offsetWidth, h = el.offsetHeight, gap = 10;
      const right = a.right + gap + w <= window.innerWidth - 12;
      const left = right ? a.right + gap : Math.max(12, a.left - gap - w);
      const top = Math.min(Math.max(12, a.top + Math.min(a.height, 40) / 2 - 36), window.innerHeight - h - 12);
      setPos({ left, top, side: right ? 'r' : 'l', ox: right ? 0 : w, oy: Math.max(16, Math.min(h - 16, a.top + Math.min(a.height, 40) / 2 - top)) });
    };
    place();
    const ro = new ResizeObserver(place); ro.observe(ref.current);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { ro.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [anchor, phone, inline, detail.key]);

  // a sheet holds the page still behind it
  useEffect(() => {
    if (!phone) return;
    const html = document.documentElement, before = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => { html.style.overflow = before; };
  }, [phone]);

  // Esc closes, a click outside closes, focus moves in and goes back to the block after
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      if ((t as HTMLElement).closest?.('[data-block]')) return;   // another block: it opens its own card
      if ((t as HTMLElement).closest?.('.talk-toast, .toast-root, [data-keep-detail]')) return;   // Undo, a toast, the Day panel's own rows
      onClose();
    };
    document.addEventListener('keydown', key, true);
    document.addEventListener('pointerdown', down, true);
    return () => { document.removeEventListener('keydown', key, true); document.removeEventListener('pointerdown', down, true); (anchor ?? prev)?.focus?.({ preventScroll: true }); };
  }, [anchor, onClose]);

  const k = KIND[detail.kind];
  const card = (
    <div ref={ref} role={inline ? 'region' : 'dialog'} aria-modal={inline ? undefined : phone} aria-label={`${k.label} details`} tabIndex={-1} data-testid="event-detail" data-kind={detail.kind}
      className={`ed${inline ? ' ed-inline' : phone ? ' ed-sheet' : ` ed-pop ed-${pos?.side ?? 'r'}`}`}
      style={{ ['--ed-tint' as string]: k.tint, ...(phone || inline ? {} : { left: pos?.left ?? -9999, top: pos?.top ?? 0, transformOrigin: `${pos?.ox ?? 0}px ${pos?.oy ?? 24}px`, visibility: pos ? undefined : 'hidden' }) }}>
      {phone && <div className="ed-grab" aria-hidden="true" />}
      <button type="button" className="ed-x" aria-label="Close" onClick={onClose}><Icon name="close" size={14} /></button>
      <Body detail={detail} today={today} nowH={nowH} days={days} actions={actions} onClose={onClose} />
    </div>
  );
  if (inline) return card;
  return createPortal(phone ? <div className="ed-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>{card}</div> : card, document.body);
}

// ------------------------------------------------------------------------------------------------------------------------ pieces
function Head({ kind, title, when, why, sub }: { kind: Detail['kind']; title: string; when: ReactNode; why: ReactNode; sub?: ReactNode }) {
  const k = KIND[kind];
  return (
    <header className="ed-hd">
      <div className="ed-kind"><span className="ed-ico" aria-hidden="true"><Icon name={k.icon} size={13} /></span>{k.label}{sub && <span className="ed-sub">{sub}</span>}</div>
      <h2 className="ed-title">{title}</h2>
      <p className="ed-when">{when}</p>
      <p className="ed-why" data-testid="ed-why"><span className="wp-orb sm" aria-hidden="true" /><span>{why}</span></p>
    </header>
  );
}
const Row = ({ label, children }: { label: string; children: ReactNode }) => <div className="ed-row"><span>{label}</span><div>{children}</div></div>;
function Pill({ tone, children }: { tone: 'gray' | 'blue' | 'green' | 'orange' | 'red'; children: ReactNode }) { return <span className={`ed-pill ${tone}`}>{children}</span>; }
const priTone = (p: string | null | undefined) => (p === 'Critical' || p === 'High' ? 'red' : p === 'Medium' ? 'orange' : 'gray') as 'red' | 'orange' | 'gray';
const statusTone = (c: string | null | undefined) => (c === 'Done' || c === 'Completed' ? 'green' : c === 'Active' || c === 'InProgress' ? 'blue' : 'gray') as 'green' | 'blue' | 'gray';
const slaTone = (s: string) => (s === 'Breached' || s === 'Missed' ? 'red' : s === 'AtRisk' ? 'orange' : s === 'Met' || s === 'OnTrack' ? 'green' : 'gray') as 'red' | 'orange' | 'green' | 'gray';
const SLA_TEXT: Record<string, string> = { OnTrack: 'SLA on track', AtRisk: 'SLA at risk', Breached: 'SLA breached', Met: 'SLA met', Missed: 'SLA missed', Paused: 'SLA paused', Stopped: 'SLA stopped' };

/** Pick a day (from today) and a start time, for a focus block or a meeting. */
function TimePicker({ days, today, day0, start0, len, onSave, onCancel }: { days: string[]; today: string; day0: string; start0: number; len: number; onSave: (day: string, start: number) => void; onCancel: () => void }) {
  const choices = days.filter((d) => d >= today);
  const [day, setDay] = useState(choices.includes(day0) ? day0 : choices[0] ?? day0);
  const [start, setStart] = useState(Math.min(END - len, start0));
  const times = Array.from({ length: Math.round((END - len - START) / SNAP) + 1 }, (_, i) => START + i * SNAP);
  return (
    <div className="ed-pick" data-testid="ed-pick">
      <label><span>Day</span><select className="ed-sel" aria-label="Day" value={day} onChange={(e) => setDay(e.target.value)}>{choices.map((d) => <option key={d} value={d}>{dayLabel(d, today)}</option>)}</select></label>
      <label><span>Starts</span><select className="ed-sel" aria-label="Start time" value={start} onChange={(e) => setStart(Number(e.target.value))}>{times.map((t) => <option key={t} value={t}>{clockAP(t)}</option>)}</select></label>
      <div className="ed-pick-act"><button type="button" className="ed-btn ghost" onClick={onCancel}>Cancel</button><button type="button" className="ed-btn primary" onClick={() => onSave(day, start)}>Move</button></div>
    </div>
  );
}

/** Choose a new due date, with the reason when it moves later (the same rule as the task form). */
function DatePicker({ current, onSave, onCancel, busy }: { current: string; onSave: (date: string, reason: string) => void; onCancel: () => void; busy: boolean }) {
  const [date, setDate] = useState(addDays(current, 1));
  const [reason, setReason] = useState('');
  const later = date > current;
  return (
    <form className="ed-pick" data-testid="ed-date" onSubmit={(e) => { e.preventDefault(); if (date && (!later || reason.trim())) onSave(date, reason.trim()); }}>
      <label><span>New date</span><input className="ed-sel" type="date" aria-label="New due date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      {later && <label className="wide"><span>Why it needs more time</span><input className="ed-sel" aria-label="Reason" value={reason} maxLength={500} placeholder="Waiting on the vendor's fix" onChange={(e) => setReason(e.target.value)} /></label>}
      <div className="ed-pick-act"><button type="button" className="ed-btn ghost" onClick={onCancel}>Cancel</button><button type="submit" className="ed-btn primary" disabled={busy || !date || date === current || (later && !reason.trim())}>{busy ? 'Saving…' : 'Move date'}</button></div>
    </form>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ body by kind
function Body({ detail, today, nowH, days, actions, onClose }: { detail: Detail; today: string; nowH: number; days: string[]; actions: DetailActions; onClose: () => void }) {
  switch (detail.kind) {
    case 'meeting': return <MeetingBody m={detail.m} today={today} nowH={nowH} days={days} actions={actions} onClose={onClose} />;
    case 'focus': return <WorkBody e={detail.f.e} focus={detail.f} today={today} nowH={nowH} days={days} actions={actions} onClose={onClose} />;
    case 'deadline': return <WorkBody e={detail.e} others={detail.others} today={today} days={days} actions={actions} onClose={onClose} />;
    case 'time': return <LoggedBody entries={[detail.t]} day={detail.t.date} single today={today} onClose={onClose} actions={actions} />;
    case 'loggedDay': return <LoggedBody entries={detail.entries} day={detail.day} today={today} onClose={onClose} />;
    case 'done': return <DoneBody t={detail.t} today={today} onClose={onClose} />;
    case 'call': return <CallBody t={detail.t} today={today} onClose={onClose} />;
    case 'reminder': return <ReminderBody t={detail.t} today={today} days={days} onClose={onClose} />;
    case 'create': return <CreateBody day={detail.day} start={detail.start} end={detail.end} today={today} nowH={nowH} actions={actions} onClose={onClose} />;
    case 'leave': return (
      <Head kind="leave" title={detail.note || 'On leave'} when={<>{longDay(detail.day)} · all day</>} why="Leave recorded on your timesheet for this day — no focus time is planned on it." />
    );
  }
}

function WorkBody({ e, focus, others, today, nowH = 0, days, actions, onClose }: { e: CalendarEvent; focus?: Focus; others?: CalendarEvent[]; today: string; nowH?: number; days: string[]; actions: DetailActions; onClose: () => void }) {
  const navigate = useNavigate();
  const wid = useWorkspaceId();
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<'none' | 'time' | 'date' | 'log'>('none');
  const task = useWsQuery(['task', e.id], () => taskApi.get(e.id), { enabled: e.type === 'task', staleTime: 30_000, retry: false });
  const work = useWsQuery(['work', 'task', e.id], () => workApi.get(e.id), { enabled: e.type === 'work', staleTime: 30_000, retry: false });
  const t = task.data?.task ?? null, w = work.data ?? null;
  const key = keyOf(e, t, w);
  const kindName = KIND_NAME[e.type] ?? 'Item';
  const priority = t?.priority ?? w?.priority ?? e.priority;
  const statusName = t?.statusName ?? (w ? w.status.replace(/([a-z])([A-Z])/g, '$1 $2').replace('To Do', 'To do') : e.status);
  const statusCat = t?.statusCategory ?? w?.status ?? e.category;
  const assignee = t?.assignee ?? w?.assignee ?? null;
  const logged = w ? w.loggedMinutes : t?.actualHours != null ? t.actualHours * 60 : null;
  const estimate = t?.estimatedHours ?? null;
  const last = ago(t?.updatedAt ?? w?.completedAt ?? w?.createdAt ?? null);
  const sla = w?.sla?.state ?? null;
  const isWork = e.type === 'task' || e.type === 'work' || e.type === 'action';
  const due = e.date;

  const why = focus
    ? <>Focus time {focus.pinned ? 'you placed' : 'planned by your day plan'} for <b>{key ?? e.title}</b>{priority ? ` · ${priority}` : ''} · {dueText(due, today)}</>
    : <>Deadline of <b>{key ?? e.title}</b>{e.projectName ? ` in ${e.projectName}` : ''}{priority && isWork ? ` · ${priority} priority` : ''}{e.overdue ? ' · overdue' : ''}</>;
  const when = focus ? <>{longDay(focus.day)} · {clockAP(focus.start)} – {clockAP(focus.end)}</> : <>{longDay(due)} · all day</>;

  const run = async (name: string, fn: () => Promise<unknown>, ok: string, after?: () => void) => {
    setBusy(name);
    try { await fn(); toast(ok, 'success'); after?.(); refreshAfterEdit(wid); }
    catch (err) { toast(editError(err, 'That could not be saved.'), 'error'); }
    finally { setBusy(null); }
  };
  const markDone = () => run('done', () => completeWork(e), `${key ?? e.title} marked done.`, () => { actions.done(e); onClose(); });
  const startTimer = () => run('timer', () => (e.type === 'work' ? timeApi.startOnWorkTask(e.id) : timeApi.start(e.id)), focus ? `Focus started — the timer is running on ${key ?? e.title}.` : `Timer started on ${key ?? e.title}.`);
  const moveDate = (date: string, reason: string) => run('date', () => moveDue(e, date, reason, t), `${key ?? e.title} now due ${dayLabel(date, today).toLowerCase()}.`, () => { setMode('none'); onClose(); });

  const canDone = isWork && !(statusCat === 'Done' || statusCat === 'Completed') && canComplete(e);
  const canTimer = e.type === 'task' || e.type === 'work';
  const canDate = canMoveDue(e);
  // A focus block that has started can become the time it was: logged on its item, at its hours (up to now).
  const canLog = !!focus && canTimer && (focus.day < today || (focus.day === today && focus.start < nowH));

  return (
    <>
      <Head kind={focus ? 'focus' : 'deadline'} title={e.title.replace(/^[A-Z][A-Z0-9]+-\d+\s*[·:\-–—]\s*/, '')} when={when} why={why} sub={key ? <code>{key}</code> : kindName} />
      <div className="ed-pills">
        {statusName && <Pill tone={statusTone(statusCat)}>{statusName}</Pill>}
        {priority && isWork && <Pill tone={priTone(priority)}>{priority}</Pill>}
        {sla && <Pill tone={slaTone(sla)}>{SLA_TEXT[sla] ?? sla}</Pill>}
        {e.overdue && <Pill tone="red">Overdue</Pill>}
      </div>
      <div className="ed-rows">
        {assignee && <Row label="Assignee"><span className="ed-person"><Face userId={assignee.id} name={assignee.name} className="ed-av" text={assignee.name.split(/\s+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase()} />{assignee.name}</span></Row>}
        {isWork && <Row label="Due">{dayLabel(due, today)}{e.projectName ? <span className="ed-faint"> · {e.projectName}</span> : null}</Row>}
        {!isWork && e.projectName && e.type !== 'project' && <Row label="Project">{e.projectName}</Row>}
        {(logged != null || estimate != null) && (
          <Row label="Time">
            <span>{logged != null ? `${fmtMins(logged)} logged` : 'Nothing logged'}{estimate ? ` of ${estimate}h` : ''}</span>
            {estimate ? <span className="ed-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, ((logged ?? 0) / (estimate * 60)) * 100)}%` }} /></span> : null}
          </Row>
        )}
        {t && t.subtaskTotal > 0 && <Row label="Subtasks">{t.subtaskDone} of {t.subtaskTotal} done</Row>}
        {last && <Row label="Last activity">{last}</Row>}
        {others && others.length > 0 && <Row label="Also due">{others.map((o) => <button key={o.id} type="button" className="link-btn ed-also" onClick={() => { onClose(); navigate(hrefOf(o)); }}>{o.title}</button>)}</Row>}
      </div>
      {mode === 'time' && focus && <TimePicker days={days} today={today} day0={focus.day} start0={focus.start} len={focus.end - focus.start} onCancel={() => setMode('none')} onSave={(d, s) => { actions.moveFocus(focus, d, s); setMode('none'); onClose(); }} />}
      {mode === 'date' && <DatePicker current={due} busy={busy === 'date'} onCancel={() => setMode('none')} onSave={moveDate} />}
      {mode === 'log' && focus && (
        <TimeEntryEditor entry={null} day={focus.day} start={focus.start} end={focus.day === today ? Math.min(focus.end, Math.floor(nowH * 4) / 4) : focus.end} today={today}
          choices={[{ kind: e.type === 'work' ? 'work' : 'task', id: e.id, key, title: e.title, projectName: e.projectName }, ...(actions.choices ?? []).filter((c) => c.id !== e.id)]}
          onCancel={() => setMode('none')} onDone={() => { setMode('none'); actions.removeFocus(focus, true); onClose(); }} />
      )}
      {mode === 'none' && (
        <div className="ed-acts">
          <div className="ed-main-acts">
            {canTimer && <button type="button" className="ed-btn primary" disabled={!!busy} data-testid="ed-start" onClick={() => void startTimer()}><Icon name="play" size={13} />{focus ? 'Start focus' : 'Start timer'}</button>}
            {canDone && <button type="button" className="ed-btn" disabled={!!busy} data-testid="ed-done" onClick={() => void markDone()}><Icon name="check" size={13} />{busy === 'done' ? 'Saving…' : 'Mark done'}</button>}
            <button type="button" className="ed-btn" onClick={() => { onClose(); navigate(hrefOf(e)); }}><Icon name="arrowRight" size={13} />Open</button>
          </div>
          <div className="ed-sub-acts">
            {focus && <button type="button" className="link-btn" data-testid="ed-move" onClick={() => setMode('time')}>Move to another time</button>}
            {canLog && <button type="button" className="link-btn" data-testid="ed-convert" onClick={() => setMode('log')}>Convert to time entry</button>}
            {focus && <button type="button" className="link-btn danger" data-testid="ed-remove" onClick={() => { actions.removeFocus(focus); onClose(); }}>Remove from plan</button>}
            {!focus && canDate && <button type="button" className="link-btn" data-testid="ed-more-time" onClick={() => setMode('date')}>Ask for more time · Move date</button>}
          </div>
        </div>
      )}
    </>
  );
}

const RSVP_TEXT: Record<Rsvp, string> = { Organizer: 'You organise this', Accepted: 'You accepted', Tentative: 'You said maybe', Declined: 'You declined', NeedsAction: 'Not answered yet' };

function MeetingBody({ m, today, nowH, days, actions, onClose }: { m: Meet; today: string; nowH: number; days: string[]; actions: DetailActions; onClose: () => void }) {
  const navigate = useNavigate();
  const wid = useWorkspaceId();
  const [mode, setMode] = useState<'none' | 'time' | 'edit'>('none');
  const [rsvp, setRsvp] = useState<Rsvp | null>(m.feed?.myRsvp ?? null);
  const e = m.e, f = m.feed;
  const join = e.joinUrl ?? f?.joinUrl ?? null;
  const inApp = !!join && !/^https?:/i.test(join);
  const provider = f?.providerName ?? (join ? (inApp ? 'Project Tracker call' : join.includes('meet.google') ? 'Google Meet' : join.includes('teams') ? 'Microsoft Teams' : 'Video call') : null);
  const cd = countdown(m.day, m.start, m.end, today, nowH);
  const organiser = f?.organizerName ?? e.people?.[0] ?? null;
  const people = e.people ?? [];
  const agenda = (f?.description ?? '').split(/\n+/).map((s) => s.trim().replace(/^[-•*]\s*|^\d+[.)]\s*/, '')).filter(Boolean).slice(0, 5);
  const source = f?.provider === 'google' ? 'Google Calendar' : f?.provider === 'microsoft' ? 'Outlook' : null;
  const why = <>{source ? `Meeting from ${source}` : e.projectName ? <>Meeting in <b>{e.projectName}</b></> : 'Workspace meeting'}{f?.isOrganizer ? ' · you organise it' : organiser ? ` · ${organiser} invited you` : ''}{f?.recurring ? ' · repeats' : ''}</>;
  const moveWhy = actions.canMoveMeeting(m);
  const answer = async (r: 'accepted' | 'tentative' | 'declined') => {
    if (!f) return;
    const before = rsvp;
    setRsvp(r === 'accepted' ? 'Accepted' : r === 'tentative' ? 'Tentative' : 'Declined');
    try { await meetApi.rsvp(f, r); void invalidateWorkspace(wid, 'meet'); }
    catch (err) { setRsvp(before); toast(err instanceof ApiError ? err.message : 'Your answer could not be sent.', 'error'); }
  };
  const copy = async () => {
    if (!join) return;
    const url = inApp ? new URL(join, window.location.origin).toString() : join;
    try { await navigator.clipboard.writeText(url); toast('Meeting link copied.', 'success'); } catch { toast(url, 'info'); }
  };
  const doJoin = () => { if (!join) return; onClose(); if (inApp) navigate(join); else window.open(join, '_blank', 'noopener'); };
  return (
    <>
      <Head kind="meeting" title={e.title} when={<>{longDay(m.day)} · {clockAP(m.start)} – {clockAP(m.end)}</>} why={why}
        sub={cd && <span className={`ed-cd${cd === 'now' ? ' live' : ''}`} data-testid="ed-countdown">{cd}</span>} />
      {join && cd !== 'ended' && (
        <div className="ed-join-row">
          <button type="button" className="ed-join" data-testid="ed-join" onClick={doJoin}><Icon name="video" size={15} />Join{provider ? ` ${provider}` : ''}</button>
          <button type="button" className="ed-icon-btn" aria-label="Copy link" title="Copy link" onClick={() => void copy()}><Icon name="copy" size={14} /></button>
        </div>
      )}
      <div className="ed-rows">
        {provider && <Row label="Where">{provider}{join && !inApp ? <span className="ed-faint ed-url"> · {join.replace(/^https?:\/\//, '')}</span> : null}</Row>}
        {organiser && <Row label="Organiser"><span className="ed-person"><Face byName name={organiser} className="ed-av" text={organiser.split(/\s+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase()} />{organiser}</span></Row>}
        {people.length > 1 && (
          <Row label={`People · ${f?.invited ?? people.length}`}>
            <span className="ed-faces">{people.slice(0, 5).map((p) => <Face key={p} byName name={p} className="ed-av" title={p} text={p.split(/\s+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase()} />)}</span>
            {f && <span className="ed-faint"> {f.accepted} accepted{f.declined ? ` · ${f.declined} declined` : ''}</span>}
          </Row>
        )}
        {e.projectName && <Row label="Project"><button type="button" className="link-btn" onClick={() => { onClose(); navigate(`/work/projects/${e.projectId}`); }}>{e.projectName}</button></Row>}
      </div>
      {agenda.length > 0 && <div className="ed-agenda"><b>Agenda</b><ol>{agenda.map((a) => <li key={a}>{a}</li>)}</ol></div>}
      {f && !f.isOrganizer && cd !== 'ended' && (
        <div className="ed-rsvp" role="group" aria-label="Going?">
          <span>{rsvp ? RSVP_TEXT[rsvp] : 'Going?'}</span>
          {(['accepted', 'tentative', 'declined'] as const).map((r) => {
            const on = rsvp === (r === 'accepted' ? 'Accepted' : r === 'tentative' ? 'Tentative' : 'Declined');
            return <button key={r} type="button" aria-pressed={on} className={on ? 'on' : ''} onClick={() => void answer(r)}>{r === 'accepted' ? 'Yes' : r === 'tentative' ? 'Maybe' : 'No'}</button>;
          })}
        </div>
      )}
      {mode === 'time' && <TimePicker days={days} today={today} day0={m.day} start0={m.start} len={m.end - m.start} onCancel={() => setMode('none')} onSave={(d, s) => { actions.moveMeeting(m, d, s); onClose(); }} />}
      {mode === 'edit' && f && <MeetingDetailsForm m={m} onCancel={() => setMode('none')} onSaved={() => { setMode('none'); onClose(); }} />}
      {mode === 'none' && (
        <div className="ed-acts">
          <div className="ed-main-acts">
            <button type="button" className="ed-btn" onClick={() => { onClose(); navigate(hrefOf(e)); }}><Icon name="note" size={13} />{e.notes || (f && f.notetaker !== 'off') ? 'Open notes' : 'Open meeting'}</button>
            {!moveWhy && <button type="button" className="ed-btn" data-testid="ed-move" onClick={() => setMode('time')}><Icon name="clock" size={13} />Move</button>}
            {f?.canManage && cd !== 'ended' && <button type="button" className="ed-btn" data-testid="ed-edit-meeting" onClick={() => setMode('edit')}
              title={f.provider === 'ours' ? 'Change the title and agenda' : `Held in ${f.providerName}: its title and agenda change there`}><Icon name="edit" size={13} />Edit</button>}
          </div>
          {(e.notes || (f && f.notetaker !== 'off')) && <p className="ed-foot"><span className="wp-orb sm" aria-hidden="true" />Notes by Project Tracker — summary &amp; action items after the call</p>}
        </div>
      )}
    </>
  );
}

const span = (t: TimelineEvent) => {
  const s = hourOf(new Date(t.start));
  return { s, e: t.end ? s + (Date.parse(t.end) - Date.parse(t.start)) / 3.6e6 : s };
};
const minsOf = (t: TimelineEvent) => t.minutes ?? (t.end ? Math.round((Date.parse(t.end) - Date.parse(t.start)) / 60_000) : 0);

function LoggedBody({ entries, day, single, today, onClose, actions }: { entries: TimelineEvent[]; day: string; single?: boolean; today: string; onClose: () => void; actions?: DetailActions }) {
  const navigate = useNavigate();
  const entry = single && entries[0] ? actions?.entryOf?.(entries[0].sourceId) : undefined;
  const total = entries.reduce((n, t) => n + minsOf(t), 0);
  const first = entries[0];
  const sp = first ? span(first) : null;
  const when = single && sp ? <>{longDay(day)} · {first.approximated ? 'about ' : ''}{clockAP(sp.s)}{first.running ? ' – now' : ` – ${clockAP(sp.e)}`}</> : <>{longDay(day)}</>;
  const why = single
    ? first.running ? <>Your timer is running on <b>{first.key || first.title}</b></>
      : <>Time logged on <b>{first.key || first.title}</b>{first.approximated ? ' — typed in as minutes, so it is placed from the start of your day' : ` at ${clockAP(sp!.s)} – ${clockAP(sp!.e)}`}</>
    : <>Logged {fmtMins(total)} {day === today ? 'today' : `on ${dayLabel(day, today)}`} across {entries.length} {entries.length === 1 ? 'entry' : 'entries'}</>;
  return (
    <>
      <Head kind={single ? 'time' : 'loggedDay'} title={single ? first.title : `${fmtMins(total)} logged`} when={when} why={why} sub={single && first.projectName ? first.projectName : null} />
      {single && entry && sp && !first.running && (
        <TimeEntryEditor key={`${entry.id}:${entry.stamp ?? ''}`} entry={entry} day={first.date} start={sp.s} end={Math.max(sp.e, sp.s + 0.25)} approximated={first.approximated}
          choices={actions?.choices ?? []} today={today} onDone={onClose} />
      )}
      {!(single && entry) && <ul className="ed-entries" data-testid="ed-entries">
        {entries.map((t) => (
          <li key={t.id}>
            <button type="button" onClick={() => { onClose(); navigate(t.link ?? '/insights?tab=time'); }}>
              <span className="ed-ent-t">{t.title}{t.note && <small>{t.note}</small>}</span>
              <span className="ed-ent-m">{t.running ? 'running' : fmtMins(minsOf(t))}{t.approximated ? <small>approx.</small> : null}</span>
            </button>
          </li>
        ))}
      </ul>}
      <div className="ed-acts"><div className="ed-main-acts"><button type="button" className={`ed-btn${single && entry ? ' ghost' : ' primary'}`} onClick={() => { onClose(); navigate('/insights?tab=time'); }}><Icon name="clock" size={13} />Open timesheet</button></div></div>
    </>
  );
}

const DONE_KIND: Record<string, string> = { task: 'Task', issue: 'Test issue', action: 'Action item', work: 'Ticket' };

function DoneBody({ t, today, onClose }: { t: TimelineEvent; today: string; onClose: () => void }) {
  const navigate = useNavigate();
  const at = hourOf(new Date(t.start));
  return (
    <>
      <Head kind="done" title={t.title} when={<>{longDay(t.date)} · finished at {clockAP(at)}</>} sub={t.key ? <code>{t.key}</code> : DONE_KIND[t.sourceType] ?? 'Item'}
        why={<>{DONE_KIND[t.sourceType] ?? 'Work'} marked done{t.date === today ? ' today' : ` on ${dayLabel(t.date, today)}`}{t.people[0] ? ` by ${t.people[0]}` : ''}{t.projectName ? <> in <b>{t.projectName}</b></> : null}</>} />
      <div className="ed-pills">{t.status && <Pill tone="green">{t.status}</Pill>}{t.priority && <Pill tone={priTone(t.priority)}>{t.priority}</Pill>}</div>
      <div className="ed-acts"><div className="ed-main-acts"><button type="button" className="ed-btn primary" data-testid="ed-open" onClick={() => { onClose(); navigate(t.link ?? '/work'); }}><Icon name="arrowRight" size={13} />Open</button></div></div>
    </>
  );
}

function CallBody({ t, today, onClose }: { t: TimelineEvent; today: string; onClose: () => void }) {
  const navigate = useNavigate();
  const sp = span(t);
  const mins = Math.max(1, Math.round((sp.e - sp.s) * 60));
  const live = t.running;
  return (
    <>
      <Head kind="call" title={t.title} when={<>{longDay(t.date)} · {clockAP(sp.s)}{live ? ' – now' : ` – ${clockAP(sp.e)}`}</>}
        sub={live ? <span className="ed-cd live">live</span> : fmtMins(mins)}
        why={<>{live ? 'A call going on now' : `A call you were in ${t.date === today ? 'today' : dayLabel(t.date, today).toLowerCase()}`}{t.projectName ? <> · <b>{t.projectName}</b></> : null}{t.notes ? ' · notes by Project Tracker' : ''}</>} />
      <div className="ed-rows">
        {t.people.length > 0 && (
          <Row label={`People · ${t.people.length}`}>
            <span className="ed-faces">{t.people.slice(0, 6).map((p) => <Face key={p} byName name={p} className="ed-av" title={p} text={p.split(/\s+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase()} />)}</span>
            <span className="ed-faint"> {t.people.slice(0, 3).join(', ')}{t.people.length > 3 ? ` +${t.people.length - 3}` : ''}</span>
          </Row>
        )}
        <Row label="Length">{fmtMins(mins)}</Row>
      </div>
      {t.link && (
        <div className="ed-acts"><div className="ed-main-acts">
          <button type="button" className="ed-btn primary" data-testid="ed-open" onClick={() => { onClose(); navigate(t.link!); }}><Icon name={live ? 'phone' : 'note'} size={13} />{live ? 'Rejoin' : t.notes ? 'Open notes' : 'Open'}</button>
        </div></div>
      )}
    </>
  );
}

function ReminderBody({ t, today, days, onClose }: { t: TimelineEvent; today: string; days: string[]; onClose: () => void }) {
  const navigate = useNavigate();
  const wid = useWorkspaceId();
  const at = hourOf(new Date(t.start));
  const fired = t.status !== 'scheduled';
  const closed = t.status === 'done' || t.status === 'cancelled';
  const [mode, setMode] = useState<'none' | 'time'>('none');
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok, 'success'); refreshAfterEdit(wid); onClose(); }
    catch (err) { toast(editError(err, 'The reminder could not be changed.'), 'error'); }
    finally { setBusy(false); }
  };
  return (
    <>
      <Head kind="reminder" title={t.title} when={<>{longDay(t.date)} · {clockAP(at)}</>} sub={t.key ? <code>{t.key}</code> : fired ? 'went off' : null}
        why={fired ? 'A reminder you set — it went off at this time.' : `A reminder you set — it pings you ${t.date === today ? 'today' : dayLabel(t.date, today).toLowerCase()} at this time.`} />
      {t.note && <p className="ed-foot">{t.note}</p>}
      {mode === 'time' && <TimePicker days={days} today={today} day0={t.date} start0={Math.round(at * 4) / 4} len={0.25} onCancel={() => setMode('none')}
        onSave={(d, h) => void act(() => moveReminder(t.sourceId, d, h), `Reminder moved to ${dayLabel(d, today)} ${clockAP(h)}.`)} />}
      {mode === 'none' && <div className="ed-acts"><div className="ed-main-acts">
        {!closed && <button type="button" className="ed-btn primary" data-testid="ed-rem-done" disabled={busy} onClick={() => void act(() => reminderApi.done(t.sourceId), 'Reminder done.')}><Icon name="check" size={13} />Done</button>}
        {!closed && <button type="button" className="ed-btn" data-testid="ed-rem-snooze" disabled={busy} onClick={() => void act(() => reminderApi.snooze(t.sourceId, '1h'), 'Snoozed for an hour.')}><Icon name="alarm" size={13} />Snooze 1h</button>}
        {!closed && !fired && <button type="button" className="ed-btn" data-testid="ed-move" disabled={busy} onClick={() => setMode('time')}><Icon name="clock" size={13} />Move</button>}
        {t.link && t.link !== '/?tab=reminders' && <button type="button" className="ed-btn" onClick={() => { onClose(); navigate(t.link!); }}><Icon name="arrowRight" size={13} />Open item</button>}
        <button type="button" className="ed-btn ghost" onClick={() => { onClose(); navigate('/?tab=reminders'); }}><Icon name="alarm" size={13} />Open reminders</button>
      </div></div>}
    </>
  );
}

/** The title and agenda of a meeting held by Project Tracker; a Google or Outlook meeting says where to change it (its invitation is there). */
function MeetingDetailsForm({ m, onCancel, onSaved }: { m: Meet; onCancel: () => void; onSaved: () => void }) {
  const wid = useWorkspaceId();
  const f = m.feed!;
  const [title, setTitle] = useState(m.e.title);
  const [agenda, setAgenda] = useState(f.description ?? '');
  const [busy, setBusy] = useState(false);
  if (f.provider !== 'ours') return (
    <div className="ed-pick"><p className="ed-note wide">This meeting is held in {f.providerName}. Change its title and agenda there, so the invitation everyone has says the same.</p>
      <div className="ed-pick-act"><button type="button" className="ed-btn ghost" onClick={onCancel}>Close</button>{f.calendarUrl && <a className="ed-btn primary" href={f.calendarUrl} target="_blank" rel="noreferrer">Open in {f.providerName}</a>}</div></div>
  );
  const save = async () => {
    setBusy(true);
    try {
      const body = { title: title.trim(), description: agenda.trim() || null };
      if (f.kind === 'workspace') await meetingApi.workspaceUpdateDetails(f.id, body); else await meetingApi.updateDetails(f.id, body);
      toast('Meeting updated.', 'success');
      void invalidateWorkspace(wid, 'meet'); refreshAfterEdit(wid);
      onSaved();
    } catch (err) { toast(editError(err, 'The meeting could not be changed.'), 'error'); }
    finally { setBusy(false); }
  };
  return (
    <form className="ed-pick" data-testid="ed-meeting-form" onSubmit={(e) => { e.preventDefault(); if (title.trim()) void save(); }}>
      <label className="wide"><span>Title</span><input className="ed-sel" aria-label="Meeting title" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="wide"><span>Agenda</span><textarea className="ed-sel ed-area" aria-label="Agenda" rows={4} maxLength={4000} value={agenda} placeholder={'1. Where we are\n2. Decisions'} onChange={(e) => setAgenda(e.target.value)} /></label>
      <div className="ed-pick-act"><button type="button" className="ed-btn ghost" onClick={onCancel}>Cancel</button><button type="submit" className="ed-btn primary" disabled={busy || !title.trim()}>{busy ? 'Saving…' : 'Save'}</button></div>
    </form>
  );
}

/**
 * What a span dragged over empty time becomes: logged time (only for time that has happened), a focus block on one of your open items, or a
 * meeting (held by Project Tracker; invite people from Messages). Each writes the real record.
 */
function CreateBody({ day, start, end, today, nowH, actions, onClose }: { day: string; start: number; end: number; today: string; nowH: number; actions: DetailActions; onClose: () => void }) {
  const wid = useWorkspaceId();
  const past = day < today || (day === today && start < nowH);
  const future = day > today || (day === today && end > nowH);
  const [tab, setTab] = useState<'log' | 'focus' | 'meet'>(past ? 'log' : 'focus');
  const items = actions.openItems ?? [];
  const [item, setItem] = useState(items[0] ? `${items[0].type}:${items[0].id}` : '');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const logEnd = day === today ? Math.min(end, Math.floor(nowH * 4) / 4) : end;
  const schedule = async () => {
    setBusy(true);
    try {
      await meetingApi.scheduleForWorkspace({ title: title.trim(), startTime: isoAtHour(day, start), endTime: isoAtHour(day, end), timeZone: appZone(), service: 'ours' });
      toast(`${title.trim()} scheduled ${dayLabel(day, today).toLowerCase()} ${clockAP(start)}.`, 'success');
      void invalidateWorkspace(wid, 'meet'); refreshAfterEdit(wid);
      onClose();
    } catch (err) { toast(editError(err, 'The meeting could not be scheduled.'), 'error'); }
    finally { setBusy(false); }
  };
  return (
    <>
      <Head kind="create" title={`${clockAP(start)} – ${clockAP(end)}`} when={<>{longDay(day)} · {fmtMins(Math.round((end - start) * 60))}</>}
        why={past && future ? 'Part of this has happened: log the time spent, or plan the rest.' : past ? 'Time that has happened: log what it was spent on.' : 'Time still to come: plan focus or a meeting.'} />
      <div className="ed-seg" role="tablist" aria-label="Make it">
        {([['log', 'Log time'], ['focus', 'Plan focus'], ['meet', 'Schedule meeting']] as const).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} disabled={(k === 'log' && !past) || (k === 'meet' && day < today)} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {tab === 'log' && past && <TimeEntryEditor entry={null} day={day} start={start} end={Math.max(logEnd, start + 0.25)} choices={actions.choices ?? []} today={today} onCancel={onClose} onDone={onClose} />}
      {tab === 'focus' && (items.length === 0 ? <p className="ed-note">No open work due this week to plan focus on.</p> : (
        <form className="ed-pick" data-testid="ed-focus-form" onSubmit={(e) => { e.preventDefault(); const it = items.find((x) => `${x.type}:${x.id}` === item); if (it && actions.planFocus) { actions.planFocus(it, day, start, end); onClose(); } }}>
          <label className="wide"><span>Focus on</span><select className="ed-sel" aria-label="Focus on" value={item} onChange={(e) => setItem(e.target.value)}>
            {items.map((x) => <option key={`${x.type}:${x.id}`} value={`${x.type}:${x.id}`}>{x.key ? `${x.key} · ` : ''}{x.title}</option>)}</select></label>
          <div className="ed-pick-act"><button type="button" className="ed-btn ghost" onClick={onClose}>Cancel</button><button type="submit" className="ed-btn primary">Plan focus</button></div>
        </form>
      ))}
      {tab === 'meet' && (
        <form className="ed-pick" data-testid="ed-meet-form" onSubmit={(e) => { e.preventDefault(); if (title.trim()) void schedule(); }}>
          <label className="wide"><span>Title</span><input className="ed-sel" aria-label="Meeting title" maxLength={200} value={title} placeholder="Sync on the release" onChange={(e) => setTitle(e.target.value)} /></label>
          <p className="ed-note wide">A Project Tracker call. Invite people from Messages › Meetings.</p>
          <div className="ed-pick-act"><button type="button" className="ed-btn ghost" onClick={onClose}>Cancel</button><button type="submit" className="ed-btn primary" disabled={busy || !title.trim()}>{busy ? 'Scheduling…' : 'Schedule'}</button></div>
        </form>
      )}
    </>
  );
}
