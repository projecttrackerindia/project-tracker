import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { delegateApi, meetingApi } from '../../api/endpoints';
import type { MeetingParticipant } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Badge, ErrorState, Field, Modal, PageLoader } from '../../components/ui';
import { formatDate, formatTime } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useModule, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { BriefModal, DelegateModal, ReportModal } from '../command/CommandParts';
import { meetApi, type MeetItem, type Rsvp } from './meetApi';
import { wallInZone, zonedTimeToUtc } from './timezone';
import './meet.css';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const DAY = 24 * 60 * 60 * 1000;

export const NOTETAKER_LABEL: Record<MeetItem['notetaker'], string | null> = { off: null, project: null, transcript: 'Notetaker', voice: 'Notetaker with voice' };
export const RSVP_LABEL: Record<Rsvp, string> = { Organizer: 'You organize', Accepted: 'Going', Tentative: 'Maybe', Declined: 'Not going', NeedsAction: 'Not replied' };

/** Join: a Project Tracker call opens here, Google Meet and Teams in their own tab. */
export function JoinButton({ m, small = true }: { m: Pick<MeetItem, 'provider' | 'joinUrl' | 'providerName'>; small?: boolean }) {
  const cls = `btn btn-primary${small ? ' btn-sm' : ''}`;
  return m.provider === 'ours'
    ? <Link className={cls} to={m.joinUrl}>Join</Link>
    : <a className={cls} href={m.joinUrl} target="_blank" rel="noopener noreferrer" title={`Opens ${m.providerName}`}>Join</a>;
}

/** Joining makes sense from shortly before the start until the end (or whenever the call is already going). */
export const joinable = (m: MeetItem, now = Date.now()) => m.live || (new Date(m.start).getTime() - now < 15 * 60_000 && new Date(m.end).getTime() > now);

// ------------------------------------------------------------------ one meeting

type People = MeetingParticipant[];

/**
 * One meeting: when and where, the people and their replies, the agenda, the notetaker, and what can be done with it - join, reply (our own
 * calls; Google and Teams keep replies in their calendar), send the agent in my place, read the brief, and for the organizer move, invite,
 * remove, post the stand-up summary or cancel.
 */
export function MeetingDetail({ kind, id, at, onClose, onProject, inline = false, headerExtra }: {
  kind: 'project' | 'workspace'; id: string; at: string | null; onClose: () => void; onProject: (projectId: string) => void;
  /** Draw it in a page's own pane (Talk) instead of a dialog. */ inline?: boolean; headerExtra?: React.ReactNode;
}) {
  const wid = useWorkspaceId();
  const me = useAuth((s) => s.ctx?.user.id);
  const role = useAuth((s) => s.ctx?.current?.role);
  const projects = useModule('projects') > 0;
  const projectQ = useWsQuery(['meetings', 'one', id], () => meetingApi.get(id), { enabled: kind === 'project' });
  const workspaceQ = useWsQuery(['meetings', 'workspace', id], () => meetingApi.workspaceGet(id), { enabled: kind === 'workspace' });
  const feed = useWsQuery(['meet', 'feed', 'upcoming', 'all'], () => meetApi.feed({ from: new Date(Date.now() - 3 * 60 * 60_000).toISOString(), to: new Date(Date.now() + 30 * DAY).toISOString() }), { staleTime: 30_000 });
  const calendar = useWsQuery(['agent', 'meetings'], () => delegateApi.meetings(), { enabled: projects && role !== 'Guest' && kind === 'project', staleTime: 60_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [delegate, setDelegate] = useState<{ meetingId: string; at: string; title?: string } | null>(null);
  const [brief, setBrief] = useState<{ meetingId: string; at?: string | null } | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [addingId, setAddingId] = useState('');
  const loading = kind === 'project' ? projectQ.isLoading : workspaceQ.isLoading;
  const failed = kind === 'project' ? projectQ.error : workspaceQ.error;
  const p = projectQ.data; const w = workspaceQ.data;
  const base = p ?? w;
  // The session asked for (from a reminder or the list), else the next one.
  const session = (feed.data?.items ?? []).filter((i) => i.id === id).sort((a, b) => Math.abs(new Date(a.start).getTime() - new Date(at ?? Date.now()).getTime()) - Math.abs(new Date(b.start).getTime() - new Date(at ?? Date.now()).getTime()))[0];
  const people: People = p?.participants ?? w?.attendees ?? [];
  const mine = people.find((x) => x.userId === me);
  const isOrganizer = base?.organizerUserId === me;
  const canManage = kind === 'project' ? (isOrganizer || session?.canManage) : !!w?.canManage;
  const ours = base?.provider === 'ours';
  const eligible = useWsQuery(['meetings', 'participants', p?.projectId ?? 'none'], () => meetingApi.participants(p!.projectId), { enabled: !!p && !!canManage && p.status === 'Scheduled' });
  const delegation = (calendar.data ?? []).find((c) => c.meetingId === id && (!session || Math.abs(new Date(c.startUtc).getTime() - new Date(session.start).getTime()) < 60_000));
  const refresh = () => { void invalidateWorkspace(wid, 'meet'); void invalidateWorkspace(wid, 'meetings'); void invalidateWorkspace(wid, 'calendar'); void invalidateWorkspace(wid, 'reminders'); };

  const run = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try { await fn(); toast(done); refresh(); }
    catch (e) { toast(errText(e, 'That did not work. Try again.'), 'error'); }
    finally { setBusy(null); }
  };
  const reply = (response: 'accepted' | 'tentative' | 'declined') => run(response, () => meetApi.rsvp({ kind, id }, response),
    response === 'accepted' ? 'You are going. A reminder is set.' : response === 'declined' ? 'Declined. The organizer is told.' : 'Marked as maybe.');
  const cancel = async () => {
    if (!base) return;
    if (!(await confirmDialog({ title: base.recurrenceRule ? 'Cancel the whole series?' : 'Cancel this meeting?', message: `Everyone invited is told${ours ? '' : ` through ${base.providerName}`}, and their reminders are taken back.`, confirmText: base.recurrenceRule ? 'Cancel series' : 'Cancel meeting', danger: true }))) return;
    await run('cancel', () => (kind === 'project' ? meetingApi.cancel(id) : meetingApi.workspaceCancel(id)), 'Meeting cancelled.');
    onClose();
  };
  const remove = async (userId: string, name: string) => {
    if (!(await confirmDialog({ title: `Remove ${name}?`, message: 'They are taken off the invitation and their reminder is taken back.', confirmText: 'Remove' }))) return;
    await run(userId, () => meetingApi.removeParticipant(id, userId), `${name} removed.`);
  };

  const title = base?.title ?? 'Meeting';
  const zone = base?.timeZone ?? 'UTC';
  const start = session?.start ?? base?.startTime;
  const end = session?.end ?? base?.endTime;
  const counts = { Accepted: 0, Tentative: 0, Declined: 0, NeedsAction: 0 };
  for (const x of people) if (x.role !== 'Organizer') counts[x.rsvpStatus]++;
  const notetaker = session?.notetaker ?? p?.notetaker ?? 'project';

  const subtitle = start ? `${formatDate(start)}, ${formatTime(start)}–${formatTime(end)}` : undefined;
  const content = (
    <>
      {loading ? <PageLoader /> : failed || !base ? <ErrorState error={failed} /> : (
        <div className="mt-detail">
          <div className="mt-detail-top">
            <div className="mt-badges">
              <Badge tone="neutral">{base.providerName ?? 'Meeting'}</Badge>
              {base.isScrum && <Badge tone="neutral">Stand-up</Badge>}
              {base.recurrenceRule && <Badge tone="neutral">Repeats{session?.sessionsLeft ? `, ${session.sessionsLeft} left` : ''}</Badge>}
              {NOTETAKER_LABEL[notetaker] && <Badge tone="purple">{NOTETAKER_LABEL[notetaker]}</Badge>}
              {base.status === 'Cancelled' && <Badge tone="danger">Cancelled</Badge>}
            </div>
            {base.status === 'Scheduled' && <JoinButton m={{ provider: base.provider ?? 'google', joinUrl: session?.joinUrl ?? base.meetUri, providerName: base.providerName ?? 'Meet' }} small={false} />}
          </div>

          <dl className="mt-props">
            <dt>When</dt><dd>{start && `${formatDate(start)}, ${formatTime(start)}–${formatTime(end)}`}{zone ? <small> · set in {zone}</small> : null}</dd>
            <dt>Organizer</dt><dd>{isOrganizer ? 'You' : base.organizerName}</dd>
            {p && <><dt>Project</dt><dd><button type="button" className="link" onClick={() => onProject(p.projectId)}>{session?.projectName ?? 'Open project meetings'}</button></dd></>}
            <dt>Notetaker</dt><dd>{notetaker === 'voice' ? 'Transcription, and it speaks up when something is missed' : notetaker === 'transcript' ? 'Transcription and minutes' : notetaker === 'off' ? 'Not needed' : kind === 'project' ? "As the project's agent settings say" : 'Not needed'}
              {session?.notes && <small> · {session.notes === 'done' ? 'notes ready in the project' : session.notes === 'failed' ? 'did not record' : session.notes.replace('_', ' ')}</small>}</dd>
          </dl>

          {base.status === 'Scheduled' && !isOrganizer && mine && (
            <div className="mt-reply">
              {ours ? <>
                <span>Going?</span>
                <div className="mt-kind" role="group" aria-label="Your reply">
                  {(['accepted', 'tentative', 'declined'] as const).map((r) => (
                    <button key={r} type="button" aria-pressed={mine.rsvpStatus.toLowerCase() === r} disabled={!!busy} onClick={() => void reply(r)}>{r === 'accepted' ? 'Yes' : r === 'tentative' ? 'Maybe' : 'No'}</button>
                  ))}
                </div>
              </> : <span className="mt-hint">Reply from the invitation in your {base.provider === 'microsoft' ? 'Outlook calendar' : 'Google Calendar'}; your reply shows here.</span>}
            </div>
          )}

          {base.description && <div><h3 className="mt-h">Agenda</h3><p className="mt-agenda">{base.description}</p></div>}

          <div>
            <h3 className="mt-h">People <small>{[counts.Accepted && `${counts.Accepted} going`, counts.Tentative && `${counts.Tentative} maybe`, counts.Declined && `${counts.Declined} not going`, counts.NeedsAction && `${counts.NeedsAction} not replied`].filter(Boolean).join(' · ')}</small></h3>
            <ul className="mt-people">
              {people.map((x) => (
                <li key={x.userId ?? x.email}>
                  <span>{x.name}{x.role === 'Organizer' && <small> · organizer</small>}</span>
                  <span className={`mt-rsvp rsvp-${x.role === 'Organizer' ? 'Organizer' : x.rsvpStatus}`}>{x.role === 'Organizer' ? '' : RSVP_LABEL[x.rsvpStatus]}</span>
                  {canManage && kind === 'project' && base.status === 'Scheduled' && x.role !== 'Organizer' && x.userId && (
                    <button type="button" className="btn-icon" aria-label={`Remove ${x.name}`} disabled={busy === x.userId} onClick={() => void remove(x.userId!, x.name)}><Icon name="close" size={13} /></button>
                  )}
                </li>
              ))}
            </ul>
            {canManage && kind === 'project' && base.status === 'Scheduled' && (eligible.data ?? []).some((e) => e.userId && !people.some((x) => x.userId === e.userId)) && (
              <div className="mt-row mt-row-start">
                <select className="select" aria-label="Invite someone" value={addingId} onChange={(e) => setAddingId(e.target.value)}>
                  <option value="">Invite someone…</option>
                  {(eligible.data ?? []).filter((e) => e.userId && !people.some((x) => x.userId === e.userId)).map((e) => <option key={e.userId} value={e.userId!}>{e.name}</option>)}
                </select>
                <button type="button" className="btn btn-ghost btn-sm" disabled={!addingId || busy === 'add'} onClick={() => void run('add', () => meetingApi.addParticipant(id, addingId), 'Invited.').then(() => setAddingId(''))}>Invite</button>
              </div>
            )}
          </div>

          {moving && <MoveForm kind={kind} id={id} start={base.startTime} end={base.endTime} zone={zone} onDone={() => { setMoving(false); refresh(); }} onCancel={() => setMoving(false)} />}

          {base.status === 'Scheduled' && (
            <div className="mt-detail-actions">
              {kind === 'project' && p && session && projects && role !== 'Guest' && <>
                {delegation?.delegationId && delegation.delegationStatus !== 'cancelled'
                  ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => setReport(delegation.delegationId!)}><Icon name="agent" size={14} />{delegation.delegationStatus === 'reported' ? 'Agent report' : 'Agent going for you'}</button>
                  : !isOrganizer && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDelegate({ meetingId: id, at: session.start, title })}><Icon name="agent" size={14} />Send the agent in my place</button>}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setBrief({ meetingId: id, at: session.start })}><Icon name="note" size={14} />Brief</button>
              </>}
              {canManage && kind === 'project' && base.isScrum && <button type="button" className="btn btn-ghost btn-sm" disabled={busy === 'summary'} onClick={() => void run('summary', () => meetingApi.standupSummary(id), 'Stand-up summary posted to the project chat.')}><Icon name="message" size={14} />Post stand-up summary</button>}
              {base.calendarUrl && !ours && <a className="btn btn-ghost btn-sm" href={base.calendarUrl} target="_blank" rel="noopener noreferrer"><Icon name="calendar" size={14} />Open in {base.provider === 'microsoft' ? 'Outlook' : 'Google Calendar'}</a>}
              <span className="mt-grow" />
              {canManage && (!base.recurrenceRule || ours) && !moving && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMoving(true)}>Move</button>}
              {canManage && <button type="button" className="btn btn-ghost btn-sm mt-danger" disabled={busy === 'cancel'} onClick={() => void cancel()}>{base.recurrenceRule ? 'Cancel series' : 'Cancel meeting'}</button>}
            </div>
          )}
          {canManage && base.recurrenceRule && !ours && <p className="mt-hint">To move one session of this series, open it in {base.provider === 'microsoft' ? 'Outlook' : 'Google Calendar'}.</p>}
        </div>
      )}
      {delegate && <DelegateModal target={delegate} onClose={() => setDelegate(null)} onDone={() => { setDelegate(null); void invalidateWorkspace(wid, 'agent'); }} />}
      {brief && <BriefModal meetingId={brief.meetingId} at={brief.at} onClose={() => setBrief(null)} onDelegate={(d) => { setBrief(null); setDelegate(d); }} />}
      {report && <ReportModal id={report} onClose={() => setReport(null)} />}
    </>
  );
  if (inline) return (
    <section className="mt-inline" aria-label={title}>
      <header className="mt-inline-head">
        <span className="mt-inline-ico" aria-hidden="true"><Icon name="video" size={18} /></span>
        <div className="mt-inline-title"><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        {headerExtra}
      </header>
      {content}
    </section>
  );
  return <Modal title={title} subtitle={subtitle} onClose={onClose} size="lg">{content}</Modal>;
}

/** A new time, typed in the meeting's own zone (never this browser's clock setting). */
export function MoveForm({ kind, id, start, end, zone, onDone, onCancel }: { kind: 'project' | 'workspace'; id: string; start: string; end: string; zone: string; onDone: () => void; onCancel: () => void }) {
  const at = wallInZone(new Date(start), zone);
  const [date, setDate] = useState(`${at.year}-${String(at.monthIndex + 1).padStart(2, '0')}-${String(at.day).padStart(2, '0')}`);
  const [time, setTime] = useState(`${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}`);
  const [duration, setDuration] = useState(Math.max(5, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60_000)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const [y, mo, d] = date.split('-').map(Number); const [h, mi] = time.split(':').map(Number);
    const s = zonedTimeToUtc(y, mo - 1, d, h, mi, zone);
    if (Number.isNaN(s.getTime())) { setError('Choose a date and a start time.'); return; }
    const body = { startTime: s.toISOString(), endTime: new Date(s.getTime() + duration * 60_000).toISOString() };
    setBusy(true); setError(null);
    try { if (kind === 'project') await meetingApi.reschedule(id, body); else await meetingApi.workspaceReschedule(id, body); toast('Moved. Everyone invited is told, and reminders move with it.'); onDone(); }
    catch (e) { setError(errText(e, 'Could not move the meeting.')); }
    finally { setBusy(false); }
  };
  return (
    <div className="mt-move">
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="gm-time-grid">
        <Field label="Date"><input className="input" type="date" aria-label="New date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Start"><input className="input" type="time" aria-label="New start" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
        <Field label="Duration"><select className="select" aria-label="New duration" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>{[15, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m} minutes</option>)}</select></Field>
      </div>
      <p className="mt-hint">In {zone}, the zone it was scheduled in.</p>
      <div className="mt-row"><button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Keep the time</button><button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void save()}>{busy && <span className="spinner" />}Save new time</button></div>
    </div>
  );
}
