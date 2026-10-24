import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { delegateApi, meetingApi, projectApi } from '../../api/endpoints';
import type { MeetingParticipant, MyMeeting } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Badge, EmptyState, ErrorState, Field, Modal, PageHead, PageLoader, RouteTabs } from '../../components/ui';
import { formatDate, formatTime } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useModule, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { BriefModal, DelegateModal, ReportModal, SettingsCard } from '../command/CommandParts';
import { NotetakerPanel } from '../notetaker/NotetakerPage';
import { meetApi, parseRef, type MeetItem, type Rsvp } from './meetApi';
import { MeetingForm } from './ScheduleMeeting';
import { NotetakerWorkspaceSettings } from './NotetakerWorkspaceSettings';
import { wallInZone, zonedTimeToUtc } from './timezone';
import '../command/command.css';
import './meet.css';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
type Section = 'upcoming' | 'series' | 'past' | 'notetaker';
const DAY = 24 * 60 * 60 * 1000;

const NOTETAKER_LABEL: Record<MeetItem['notetaker'], string | null> = { off: null, project: null, transcript: 'Notetaker', voice: 'Notetaker with voice' };
const RSVP_LABEL: Record<Rsvp, string> = { Organizer: 'You organize', Accepted: 'Going', Tentative: 'Maybe', Declined: 'Not going', NeedsAction: 'Not replied' };

/** Join: a Project Tracker call opens here, Google Meet and Teams in their own tab. */
function JoinButton({ m, small = true }: { m: Pick<MeetItem, 'provider' | 'joinUrl' | 'providerName'>; small?: boolean }) {
  const cls = `btn btn-primary${small ? ' btn-sm' : ''}`;
  return m.provider === 'ours'
    ? <Link className={cls} to={m.joinUrl}><Icon name="video" size={14} /> Join</Link>
    : <a className={cls} href={m.joinUrl} target="_blank" rel="noopener noreferrer" title={`Opens ${m.providerName}`}><Icon name="video" size={14} /> Join</a>;
}

/** Joining makes sense from shortly before the start until the end (or whenever the call is already going). */
const joinable = (m: MeetItem, now = Date.now()) => m.live || (new Date(m.start).getTime() - now < 15 * 60_000 && new Date(m.end).getTime() > now);

/**
 * Meet: every meeting and call in one place. Upcoming sessions (with the ones going on now first), repeating series, past meetings with
 * the notetaker's notes, and the notetaker itself. Scheduling and starting happen only here; Calendar, Reminders, chat and notifications
 * open the meeting here.
 */
export function MeetPage({ section }: { section: Section }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const role = useAuth((s) => s.ctx?.current?.role);
  const projects = useModule('projects') > 0;
  const projectId = params.get('project');
  const opened = parseRef(params.get('open'));
  const [form, setForm] = useState<'now' | 'schedule' | null>(params.get('new') === 'schedule' ? 'schedule' : params.get('new') === 'now' ? 'now' : null);
  const projectQ = useWsQuery(['project', projectId], () => projectApi.get(projectId!), { enabled: !!projectId });
  const project = projectId && projectQ.data ? { id: projectId, name: projectQ.data.project.name } : null;
  const keep = projectId ? `?project=${projectId}` : '';
  const setParam = (k: string, v: string | null) => { const next = new URLSearchParams(params); if (v) next.set(k, v); else next.delete(k); setParams(next, { replace: true }); };
  const closeForm = () => { setForm(null); setParam('new', null); };

  return (
    <div className="mt-page">
      <PageHead title="Meet" sub={project ? `Meetings and calls of ${project.name}` : 'Meetings and calls: Google Meet, Teams or Project Tracker calls, in one place'}>
        {projectId && <button type="button" className="btn btn-ghost" onClick={() => setParam('project', null)}><Icon name="close" size={14} /> All meetings</button>}
        <button type="button" className="btn btn-ghost" onClick={() => setForm('now')}><Icon name="bolt" size={15} /> Start now</button>
        <button type="button" className="btn btn-primary" onClick={() => setForm('schedule')}><Icon name="calendar" size={15} /> Schedule</button>
      </PageHead>
      <RouteTabs label="Meet" tabs={[
        { to: `/meet${keep}`, label: 'Upcoming', icon: 'calendar' },
        { to: `/meet/series${keep}`, label: 'Series', icon: 'repeat' },
        { to: `/meet/past${keep}`, label: 'Past', icon: 'clock' },
        ...(projects && role !== 'Guest' ? [{ to: `/meet/notetaker${keep}`, label: 'Notetaker', icon: 'sparkle' as const }] : []),
      ]} />
      {section === 'upcoming' && <Upcoming projectId={projectId} onOpen={(m) => setParam('open', m.ref)} />}
      {section === 'series' && <Series projectId={projectId} onOpen={(m) => setParam('open', m.ref)} />}
      {section === 'past' && <Past projectId={projectId} onOpen={(m) => setParam('open', m.ref)} />}
      {section === 'notetaker' && <NotetakerSection />}
      {opened && <MeetingDetail kind={opened.kind} id={opened.id} at={params.get('at')} onClose={() => { const next = new URLSearchParams(params); next.delete('open'); next.delete('at'); setParams(next, { replace: true }); }}
        onProject={(pid) => navigate(`/meet?project=${pid}`)} />}
      {form && <MeetingForm mode={form} project={project} onClose={closeForm} />}
    </div>
  );
}

// ------------------------------------------------------------------ lists

function useFeed(projectId: string | null, from: Date, to: Date, key: string) {
  return useWsQuery(['meet', 'feed', key, projectId ?? 'all'], () => meetApi.feed({ from: from.toISOString(), to: to.toISOString(), projectId }), { refetchInterval: 60_000 });
}

function Upcoming({ projectId, onOpen }: { projectId: string | null; onOpen: (m: MeetItem) => void }) {
  const role = useAuth((s) => s.ctx?.current?.role);
  const projects = useModule('projects') > 0;
  const [range] = useState(() => ({ from: new Date(Date.now() - 3 * 60 * 60_000), to: new Date(Date.now() + 30 * DAY) }));
  const q = useFeed(projectId, range.from, range.to, 'upcoming');
  // Other calls on the person's own Google or Outlook calendar (not made here), and who is sending the agent where.
  const calendar = useWsQuery(['agent', 'meetings'], () => delegateApi.meetings(), { enabled: projects && role !== 'Guest' && !projectId, staleTime: 60_000 });
  const now = Date.now();
  const items = (q.data?.items ?? []).filter((m) => new Date(m.end).getTime() > now - 60_000);
  const live = items.filter((m) => m.live || (new Date(m.start).getTime() <= now && new Date(m.end).getTime() > now));
  const later = items.filter((m) => !live.includes(m));
  const days = useMemo(() => group(later), [later]);
  const outside = (calendar.data ?? []).filter((c) => !c.meetingId && c.meetUrl && new Date(c.endUtc).getTime() > now);
  if (q.isLoading) return <PageLoader />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  return (
    <div className="mt-lists">
      {items.length === 0 && outside.length === 0 && <EmptyState icon="video" title="Nothing coming up" text="Meetings you organize or are invited to show here, with their join link, your reply and a reminder before each one. Schedule one, or start a call now." />}
      {live.length > 0 && <section aria-label="Happening now"><h2 className="mt-day now">Now</h2><ul className="mt-list">{live.map((m) => <Row key={m.ref + m.start} m={m} onOpen={onOpen} />)}</ul></section>}
      {days.map(([day, list]) => (
        <section key={day} aria-label={day}><h2 className="mt-day">{day}</h2><ul className="mt-list">{list.map((m) => <Row key={m.ref + m.start} m={m} onOpen={onOpen} />)}</ul></section>
      ))}
      {outside.length > 0 && (
        <section aria-label="Also on your calendar">
          <h2 className="mt-day">Also on your calendar</h2>
          <ul className="mt-list">{outside.map((c) => <CalendarRow key={c.id} c={c} />)}</ul>
        </section>
      )}
      {q.data?.truncated && <p className="mt-hint">Showing the first 400 sessions. Choose a project to narrow the list.</p>}
    </div>
  );
}

function Past({ projectId, onOpen }: { projectId: string | null; onOpen: (m: MeetItem) => void }) {
  const [range] = useState(() => ({ from: new Date(Date.now() - 30 * DAY), to: new Date() }));
  const q = useFeed(projectId, range.from, range.to, 'past');
  const items = (q.data?.items ?? []).filter((m) => new Date(m.end).getTime() <= Date.now()).reverse();
  const days = useMemo(() => group(items), [items]);
  if (q.isLoading) return <PageLoader />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (items.length === 0) return <EmptyState icon="clock" title="No meetings in the last 30 days" text="Past meetings show here with the notetaker's notes when it came." />;
  return <div className="mt-lists">{days.map(([day, list]) => <section key={day} aria-label={day}><h2 className="mt-day">{day}</h2><ul className="mt-list">{list.map((m) => <Row key={m.ref + m.start} m={m} onOpen={onOpen} past />)}</ul></section>)}</div>;
}

function Series({ projectId, onOpen }: { projectId: string | null; onOpen: (m: MeetItem) => void }) {
  const q = useWsQuery(['meet', 'series', projectId ?? 'all'], () => meetApi.series(projectId));
  if (q.isLoading) return <PageLoader />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (!q.data?.length) return <EmptyState icon="repeat" title="No repeating meetings" text="Stand-ups and other series show here with their next session. Schedule one and choose how often it repeats." />;
  return <ul className="mt-list mt-lists">{q.data.map((m) => <Row key={m.ref} m={m} onOpen={onOpen} series />)}</ul>;
}

/** Sessions grouped by day: "Today", "Tomorrow", then the date. */
function group(items: MeetItem[]): [string, MeetItem[]][] {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const label = (iso: string) => {
    const d = new Date(iso); d.setHours(0, 0, 0, 0);
    const diff = Math.round((d.getTime() - today.getTime()) / DAY);
    return diff === 0 ? `Today · ${formatDate(iso)}` : diff === 1 ? `Tomorrow · ${formatDate(iso)}` : diff === -1 ? `Yesterday · ${formatDate(iso)}` : formatDate(iso);
  };
  const map = new Map<string, MeetItem[]>();
  for (const m of items) { const k = label(m.start); map.set(k, [...(map.get(k) ?? []), m]); }
  return [...map.entries()];
}

function Row({ m, onOpen, past = false, series = false }: { m: MeetItem; onOpen: (m: MeetItem) => void; past?: boolean; series?: boolean }) {
  const wid = useWorkspaceId();
  const [busy, setBusy] = useState(false);
  const reply = async (response: 'accepted' | 'declined') => {
    setBusy(true);
    try { await meetApi.rsvp(m, response); toast(response === 'accepted' ? 'You are going. A reminder is set.' : 'Declined. The organizer is told.'); void invalidateWorkspace(wid, 'meet'); void invalidateWorkspace(wid, 'reminders'); }
    catch (e) { toast(errText(e, 'Could not send your reply.'), 'error'); }
    finally { setBusy(false); }
  };
  const nt = NOTETAKER_LABEL[m.notetaker];
  return (
    <li className={`mt-item${m.live ? ' live' : ''}${m.myRsvp === 'Declined' ? ' declined' : ''}`}>
      <button type="button" className="mt-item-main" onClick={() => onOpen(m)} aria-label={`${m.title}, ${formatDate(m.start)} ${formatTime(m.start)}`}>
        <span className="mt-time"><b>{formatTime(m.start)}</b><small>{series ? formatDate(m.start) : formatTime(m.end)}</small></span>
        <span className="mt-what">
          <b>{m.title}</b>
          <small>
            {[m.projectKey ?? (m.kind === 'workspace' ? 'Workspace' : null), m.providerName, series && m.sessionsLeft ? `${m.sessionsLeft} sessions left` : null,
              m.isOrganizer ? 'You organize' : `By ${m.organizerName}`, m.provider === 'ours' && m.invited > 1 ? `${m.accepted} of ${m.invited} going` : null].filter(Boolean).join(' · ')}
          </small>
        </span>
        <span className="mt-tags">
          {m.live && <Badge tone="success">Live</Badge>}
          {m.isScrum && <Badge tone="neutral">Stand-up</Badge>}
          {m.recurring && !series && <Badge tone="neutral">Repeats</Badge>}
          {nt && <Badge tone="purple">{nt}</Badge>}
          {past && m.notes === 'done' && <Badge tone="info">Notes</Badge>}
          {!m.isOrganizer && !past && <span className={`mt-rsvp rsvp-${m.myRsvp}`}>{RSVP_LABEL[m.myRsvp]}</span>}
        </span>
      </button>
      {!past && m.status === 'Scheduled' && (
        <span className="mt-actions">
          {m.provider === 'ours' && !m.isOrganizer && m.myRsvp === 'NeedsAction' && <>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void reply('accepted')}>Accept</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void reply('declined')}>Decline</button>
          </>}
          {joinable(m) && <JoinButton m={m} />}
        </span>
      )}
    </li>
  );
}

function CalendarRow({ c }: { c: MyMeeting }) {
  const send = `/meet/notetaker?url=${encodeURIComponent(c.meetUrl ?? '')}&title=${encodeURIComponent(c.title)}`;
  return (
    <li className="mt-item">
      <span className="mt-item-main mt-static">
        <span className="mt-time"><b>{formatTime(c.startUtc)}</b><small>{formatDate(c.startUtc)}</small></span>
        <span className="mt-what"><b>{c.title}</b><small>On your calendar{c.overlapsWith.length ? ` · overlaps ${c.overlapsWith.join(', ')}` : ''}</small></span>
      </span>
      <span className="mt-actions">
        <Link className="btn btn-ghost btn-sm" to={send}><Icon name="sparkle" size={14} /> Send notetaker</Link>
        {c.meetUrl && <a className="btn btn-ghost btn-sm" href={c.meetUrl} target="_blank" rel="noopener noreferrer"><Icon name="video" size={14} /> Join</a>}
      </span>
    </li>
  );
}

// ------------------------------------------------------------------ notetaker

function NotetakerSection() {
  const role = useAuth((s) => s.ctx?.current?.role);
  const admin = role === 'Owner' || role === 'Admin';
  return (
    <div className="mt-notetaker-page">
      <NotetakerPanel />
      <div className="mt-notetaker-side">
        <SettingsCard />
        {admin && <NotetakerWorkspaceSettings />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ one meeting

type People = MeetingParticipant[];

/**
 * One meeting: when and where, the people and their replies, the agenda, the notetaker, and what can be done with it - join, reply (our own
 * calls; Google and Teams keep replies in their calendar), send the agent in my place, read the brief, and for the organizer move, invite,
 * remove, post the stand-up summary or cancel.
 */
function MeetingDetail({ kind, id, at, onClose, onProject }: { kind: 'project' | 'workspace'; id: string; at: string | null; onClose: () => void; onProject: (projectId: string) => void }) {
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

  return (
    <Modal title={title} subtitle={start ? `${formatDate(start)}, ${formatTime(start)}–${formatTime(end)}` : undefined} onClose={onClose} size="lg">
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
    </Modal>
  );
}

/** A new time, typed in the meeting's own zone (never this browser's clock setting). */
function MoveForm({ kind, id, start, end, zone, onDone, onCancel }: { kind: 'project' | 'workspace'; id: string; start: string; end: string; zone: string; onDone: () => void; onCancel: () => void }) {
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
