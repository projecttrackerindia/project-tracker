import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { actionItemApi, opsApi, projectApi, taskApi, timeApi, workApi } from '../../api/endpoints';
import type { CalendarEvent, Task, TimeEntry, WorkTask } from '../../api/types';
import { Face } from '../../components/Face';
import { Icon } from '../../components/Icon';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { meetApi, type Rsvp } from '../meet/meetApi';
import { KIND, countdown, END, MONTHS, START, SNAP, addDays, clockAP, dateOf, dayLabel, fmtMins, hourOf, hrefOf, type Detail, type Focus, type Meet } from './plannerModel';
import './eventDetail.css';

const KIND_NAME: Record<string, string> = { task: 'Task', action: 'Action item', work: 'Ticket', project: 'Project', milestone: 'Milestone', stage: 'Stage' };
const longDay = (day: string) => { const d = dateOf(day); return `${d.toLocaleDateString('en-GB', { weekday: 'long' })} ${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const keyOf = (e: CalendarEvent, task?: Task | null, work?: WorkTask | null) => task?.key ?? work?.key ?? /^[A-Z][A-Z0-9]+-\d+/.exec(e.title)?.[0] ?? null;
const ago = (s: string | null | undefined) => {
  if (!s) return null;
  const m = Math.round((Date.now() - Date.parse(s)) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const dueText = (date: string, today: string) => (date === today ? 'due today' : date < today ? `overdue since ${dayLabel(date, today)}` : `due ${dayLabel(date, today).replace(/^Tomorrow$/, 'tomorrow')}`);
export interface DetailActions {
  /** Move a focus block (a time you chose; kept on this device) or take its item out of the plan. */
  moveFocus: (f: Focus, day: string, start: number) => void;
  removeFocus: (f: Focus) => void;
  /** Hide an item at once when it is marked done (the calendar then refetches). */
  done: (e: CalendarEvent) => void;
  /** Move a meeting you organise (the grid's own drag-to-move, with Undo). */
  moveMeeting: (m: Meet, day: string, start: number) => void;
  canMoveMeeting: (m: Meet) => string | null;
}

/**
 * The card a calendar block opens, Apple Calendar style: anchored beside the block on a desktop (it springs out of it), a bottom sheet on a
 * phone. It says what the block is and why it is on the calendar, then what can be done with it right there.
 */
export function EventDetail({ detail, anchor, today, nowH, days, actions, onClose }: {
  detail: Detail; anchor: HTMLElement | null; today: string; nowH: number; days: string[]; actions: DetailActions; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [phone] = useState(() => typeof window !== 'undefined' && window.innerWidth < 760);
  const [pos, setPos] = useState<{ left: number; top: number; side: 'l' | 'r'; ox: number; oy: number } | null>(null);

  // place it beside the block, on the side with room, kept inside the window
  useLayoutEffect(() => {
    if (phone || !anchor || !ref.current) return;
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
  }, [anchor, phone, detail.key]);

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
      onClose();
    };
    document.addEventListener('keydown', key, true);
    document.addEventListener('pointerdown', down, true);
    return () => { document.removeEventListener('keydown', key, true); document.removeEventListener('pointerdown', down, true); (anchor ?? prev)?.focus?.({ preventScroll: true }); };
  }, [anchor, onClose]);

  const k = KIND[detail.kind];
  const card = (
    <div ref={ref} role="dialog" aria-modal={phone} aria-label={`${k.label} details`} tabIndex={-1} data-testid="event-detail" data-kind={detail.kind}
      className={`ed${phone ? ' ed-sheet' : ` ed-pop ed-${pos?.side ?? 'r'}`}`}
      style={{ ['--ed-tint' as string]: k.tint, ...(phone ? {} : { left: pos?.left ?? -9999, top: pos?.top ?? 0, transformOrigin: `${pos?.ox ?? 0}px ${pos?.oy ?? 24}px`, visibility: pos ? undefined : 'hidden' }) }}>
      {phone && <div className="ed-grab" aria-hidden="true" />}
      <button type="button" className="ed-x" aria-label="Close" onClick={onClose}><Icon name="close" size={14} /></button>
      <Body detail={detail} today={today} nowH={nowH} days={days} actions={actions} onClose={onClose} />
    </div>
  );
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
    case 'focus': return <WorkBody e={detail.f.e} focus={detail.f} today={today} days={days} actions={actions} onClose={onClose} />;
    case 'deadline': return <WorkBody e={detail.e} others={detail.others} today={today} days={days} actions={actions} onClose={onClose} />;
    case 'logged': return <LoggedBody entries={[detail.entry]} day={detail.entry.workDate} single today={today} onClose={onClose} />;
    case 'loggedDay': return <LoggedBody entries={detail.entries} day={detail.day} today={today} onClose={onClose} />;
    case 'reminder': return <ReminderBody r={detail.r} today={today} onClose={onClose} />;
    case 'leave': return (
      <Head kind="leave" title={detail.note || 'On leave'} when={<>{longDay(detail.day)} · all day</>} why="Leave recorded on your timesheet for this day — no focus time is planned on it." />
    );
  }
}

function WorkBody({ e, focus, others, today, days, actions, onClose }: { e: CalendarEvent; focus?: Focus; others?: CalendarEvent[]; today: string; days: string[]; actions: DetailActions; onClose: () => void }) {
  const navigate = useNavigate();
  const wid = useWorkspaceId();
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<'none' | 'time' | 'date'>('none');
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
    try { await fn(); toast(ok, 'success'); after?.(); void invalidateWorkspace(wid, 'calendar'); void invalidateWorkspace(wid, 'time'); }
    catch (err) { toast(err instanceof ApiError ? err.message : 'That could not be saved.', 'error'); }
    finally { setBusy(null); }
  };
  const markDone = () => run('done', async () => {
    if (e.type === 'work') await workApi.setStatus(e.id, 'Completed');
    else if (e.type === 'action') await actionItemApi.setStatus(e.projectId!, e.id, 'Completed');
    else {
      const p = await projectApi.get(e.projectId!);
      const done = p.statuses.find((s) => s.category === 'Done');
      if (!done) throw new ApiError(400, 'This project has no Done status.', []);
      await taskApi.move(e.id, { statusId: done.id });
    }
  }, `${key ?? e.title} marked done.`, () => { actions.done(e); onClose(); });
  const startTimer = () => run('timer', () => (e.type === 'work' ? timeApi.startOnWorkTask(e.id) : timeApi.start(e.id)), focus ? `Focus started — the timer is running on ${key ?? e.title}.` : `Timer started on ${key ?? e.title}.`);
  const moveDate = (date: string, reason: string) => run('date', async () => {
    if (e.type === 'work') await opsApi.bulk({ ids: [e.id], dueDate: date });
    else {
      const x = t ?? (await taskApi.get(e.id)).task;
      await taskApi.update(e.id, { title: x.title, description: x.description, priority: x.priority, assigneeId: x.assignee?.id ?? null, startDate: x.startDate, dueDate: date,
        estimatedHours: x.estimatedHours, labelIds: x.labels.map((l) => l.id), milestoneId: x.milestoneId, statusId: x.statusId, actualHours: x.actualHours, version: x.version,
        dueDateReason: reason || null, dueDateDependency: null });
    }
  }, `${key ?? e.title} now due ${dayLabel(date, today).toLowerCase()}.`, () => { setMode('none'); onClose(); });

  const canDone = isWork && !(statusCat === 'Done' || statusCat === 'Completed') && (e.type !== 'action' || !!e.projectId) && (e.type !== 'task' || !!e.projectId);
  const canTimer = e.type === 'task' || e.type === 'work';
  const canDate = e.type === 'task' || e.type === 'work';

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
      {mode === 'none' && (
        <div className="ed-acts">
          <div className="ed-main-acts">
            {canTimer && <button type="button" className="ed-btn primary" disabled={!!busy} data-testid="ed-start" onClick={() => void startTimer()}><Icon name="play" size={13} />{focus ? 'Start focus' : 'Start timer'}</button>}
            {canDone && <button type="button" className="ed-btn" disabled={!!busy} data-testid="ed-done" onClick={() => void markDone()}><Icon name="check" size={13} />{busy === 'done' ? 'Saving…' : 'Mark done'}</button>}
            <button type="button" className="ed-btn" onClick={() => { onClose(); navigate(hrefOf(e)); }}><Icon name="arrowRight" size={13} />Open</button>
          </div>
          <div className="ed-sub-acts">
            {focus && <button type="button" className="link-btn" data-testid="ed-move" onClick={() => setMode('time')}>Move to another time</button>}
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
  const [mode, setMode] = useState<'none' | 'time'>('none');
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
      {mode === 'none' && (
        <div className="ed-acts">
          <div className="ed-main-acts">
            <button type="button" className="ed-btn" onClick={() => { onClose(); navigate(hrefOf(e)); }}><Icon name="note" size={13} />{e.notes || (f && f.notetaker !== 'off') ? 'Open notes' : 'Open meeting'}</button>
            {!moveWhy && <button type="button" className="ed-btn" data-testid="ed-move" onClick={() => setMode('time')}><Icon name="clock" size={13} />Move</button>}
          </div>
          {(e.notes || (f && f.notetaker !== 'off')) && <p className="ed-foot"><span className="wp-orb sm" aria-hidden="true" />Notes by Project Tracker — summary &amp; action items after the call</p>}
        </div>
      )}
    </>
  );
}

function LoggedBody({ entries, day, single, today, onClose }: { entries: TimeEntry[]; day: string; single?: boolean; today: string; onClose: () => void }) {
  const navigate = useNavigate();
  const total = entries.reduce((n, t) => n + t.minutes, 0);
  const first = entries[0];
  const st = first?.startedAt ? hourOf(new Date(first.startedAt)) : null;
  const when = single && st != null ? <>{longDay(day)} · {clockAP(st)}{first.isRunning ? ' – now' : ` – ${clockAP(st + first.minutes / 60)}`}</> : <>{longDay(day)}</>;
  const why = single
    ? first.isRunning ? <>Your timer is running on <b>{first.taskKey || first.taskTitle}</b></> : <>Time you logged on <b>{first.taskKey || first.taskTitle}</b>{first.startedAt ? ' with the timer' : ''}</>
    : <>Logged {fmtMins(total)} {day === today ? 'today' : `on ${dayLabel(day, today)}`} across {entries.length} {entries.length === 1 ? 'entry' : 'entries'}</>;
  return (
    <>
      <Head kind={single ? 'logged' : 'loggedDay'} title={single ? first.taskTitle : `${fmtMins(total)} logged`} when={when} why={why} sub={single ? (first.taskKey ? <code>{first.taskKey}</code> : null) : null} />
      <ul className="ed-entries" data-testid="ed-entries">
        {entries.map((t) => (
          <li key={t.id}>
            <button type="button" onClick={() => { onClose(); navigate(t.workTaskId ? `/work?item=${t.workTaskId}` : t.taskId ? `/work?item=${t.taskId}` : '/insights?tab=time'); }}>
              <span className="ed-ent-t">{t.taskKey && <code>{t.taskKey}</code>}{t.taskTitle}{t.note && <small>{t.note}</small>}</span>
              <span className="ed-ent-m">{t.isRunning ? 'running' : fmtMins(t.minutes)}{t.billable ? <small>billable</small> : null}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="ed-acts"><div className="ed-main-acts"><button type="button" className="ed-btn primary" onClick={() => { onClose(); navigate('/insights?tab=time'); }}><Icon name="clock" size={13} />Open timesheet</button></div></div>
    </>
  );
}

function ReminderBody({ r, today, onClose }: { r: { id: string; title: string; nextFireAt: string | null }; today: string; onClose: () => void }) {
  const navigate = useNavigate();
  const at = r.nextFireAt ? new Date(r.nextFireAt) : null;
  const day = at ? `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}` : today;
  return (
    <>
      <Head kind="reminder" title={r.title} when={<>{longDay(day)}{at ? ` · ${clockAP(hourOf(at))}` : ''}</>} why="A reminder you set — it pings you at this time." />
      <div className="ed-acts"><div className="ed-main-acts"><button type="button" className="ed-btn" onClick={() => { onClose(); navigate('/?tab=reminders'); }}><Icon name="alarm" size={13} />Open reminders</button></div></div>
    </>
  );
}

