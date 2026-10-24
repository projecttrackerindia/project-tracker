import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { connectedAccountsApi, meetingApi, projectApi, type MeetingServiceKey } from '../../api/endpoints';
import type { MeetingParticipant, MeetingProvider } from '../../api/types';
import { Icon } from '../../components/Icon';
import { ErrorState, Field, Modal, PageLoader } from '../../components/ui';
import { invalidateWorkspace, useDebounced, useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import './meetings.css';
import { toast } from '../../stores/ui';
import { zonedTimeToUtc } from './timezone';
import { TimeZonePicker } from '../../components/TimeZonePicker';
import { appZone, zonedParts } from '../../lib/zone';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const copy = async (text: string, what: string) => {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied.`); }
  catch { toast('Could not copy. Select the text and copy it by hand.', 'warning'); }
};

/** In place of the form when the chosen service is not connected (or no service can hold a meeting): where to connect one. */
function ConnectPrompt({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="gm-connect">
      <Icon name="video" size={34} />
      <p>{message}</p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <Link className="btn btn-primary" to="/account/integrations" onClick={onClose}>Open connected accounts</Link>
      </div>
    </div>
  );
}

const NOT_CONNECTED = ['GOOGLE_NOT_CONNECTED', 'MICROSOFT_NOT_CONNECTED', 'CALLS_UNAVAILABLE'];

/**
 * Which service holds this meeting: automatic (the organizer's own choice, else Google, Teams, our own call) or one they connected. Says
 * where automatic will put it, so nobody is surprised by the link they get.
 */
function ServicePicker({ value, onChange }: { value: MeetingServiceKey; onChange: (v: MeetingServiceKey) => void }) {
  const q = useWsQuery(['account', 'connected'], connectedAccountsApi.get, { staleTime: 60_000 });
  const c = q.data?.meetings;
  const saved = q.data?.meetingService;
  const autoName = c?.name ?? 'the best connected service';
  const options: { key: MeetingServiceKey; label: string; ok: boolean }[] = [
    { key: 'auto', label: `Automatic (${saved && saved !== 'auto' ? 'your choice: ' : ''}${autoName})`, ok: true },
    { key: 'google', label: 'Google Meet', ok: !!c?.googleReady },
    { key: 'microsoft', label: 'Microsoft Teams', ok: !!c?.microsoftReady },
    { key: 'ours', label: 'Project Tracker call (the agent can join)', ok: !!c?.ownCallsReady },
  ];
  return (
    <Field label="Meeting service" hint={value === 'auto' ? c?.reason ?? q.data?.meetingProblem ?? undefined : value === 'ours' ? 'Held in Project Tracker. People join from the invitation in the app; the project agent comes along when it is on.' : 'Sent from your own calendar, which delivers the invitations and keeps the replies.'}>
      <select className="select" aria-label="Meeting service" value={value} onChange={(e) => onChange(e.target.value as MeetingServiceKey)}>
        {options.filter((o) => o.ok || o.key === value).map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
      </select>
    </Field>
  );
}

/**
 * Who to invite, with checkboxes. For a project: its owner and members, everyone selected by default (spec: "Default selected people:
 * Project owner, Project members"). With no project: the workspace's active members, nobody pre-selected (a whole organization is rarely
 * the audience of one stand-up), with a filter box once the list gets long. The parent remounts this (key) when the project changes.
 */
function ParticipantPicker({ projectId, organizerUserId, selected, onChange }: { projectId: string | null; organizerUserId?: string; selected: Set<string>; onChange: (s: Set<string>) => void }) {
  const q = useWsQuery(['meetings', 'participants', projectId ?? 'workspace'], () => (projectId ? meetingApi.participants(projectId) : meetingApi.workspaceParticipants()));
  const [filter, setFilter] = useState('');
  const defaulted = useRef(false);
  useEffect(() => {
    if (defaulted.current || !q.data) return;
    defaulted.current = true;
    onChange(projectId ? new Set(q.data.filter((p) => p.userId && p.userId !== organizerUserId).map((p) => p.userId!)) : new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data]);
  if (q.isLoading) return <PageLoader />;
  if (q.isError) return <Field label="Participants"><ErrorState error={q.error} retry={() => q.refetch()} /></Field>;
  const people = (q.data ?? []).filter((p): p is MeetingParticipant & { userId: string } => !!p.userId && p.userId !== organizerUserId);
  const f = filter.trim().toLowerCase();
  const shown = f ? people.filter((p) => p.name.toLowerCase().includes(f) || p.email.toLowerCase().includes(f)) : people;
  const toggle = (id: string) => { const s = new Set(selected); if (s.has(id)) s.delete(id); else s.add(id); onChange(s); };
  return (
    <Field label={`Participants${selected.size ? ` · ${selected.size} selected` : ''}`} hint={projectId ? undefined : 'Anyone in the workspace (guests excluded). You are always included as the organizer.'}>
      {people.length > 8 && <input className="input gm-filter" type="search" aria-label="Filter people" placeholder="Filter people by name or email" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      <div className="gm-picker">
        {people.length === 0 && <p className="muted" style={{ margin: 0 }}>{projectId ? 'No other members are on this project yet.' : 'No one else is in this workspace yet.'}</p>}
        {people.length > 0 && shown.length === 0 && <p className="muted" style={{ margin: 0 }}>No one matches “{filter}”.</p>}
        {shown.map((p) => (
          <label key={p.userId} className="gm-person">
            <input type="checkbox" checked={selected.has(p.userId)} onChange={() => toggle(p.userId)} />
            <span>{p.name}</span><small className="muted">{p.role}</small>
          </label>
        ))}
      </div>
      {people.length > 0 && (
        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <button type="button" className="link" onClick={() => onChange(new Set([...selected, ...shown.map((p) => p.userId)]))}>Select {f ? 'shown' : 'all'}</button>
          <button type="button" className="link" onClick={() => onChange(new Set())}>Clear all</button>
        </div>
      )}
    </Field>
  );
}

type Ready = { title: string; meetUri: string; provider?: MeetingProvider; providerName?: string };

/**
 * Once the meeting exists: the link, front and center, so the organizer can get into it (or send it) in one click. A Project Tracker call
 * opens here in the app; Google Meet and Teams open in a new tab.
 */
function MeetReady({ ready, onClose }: { ready: Ready; onClose: () => void }) {
  const ours = ready.provider === 'ours';
  const shareable = ours ? `${window.location.origin}${window.location.pathname.split('/').filter(Boolean)[0] ? `/${window.location.pathname.split('/').filter(Boolean)[0]}` : ''}${ready.meetUri}` : ready.meetUri;
  return (
    <div className="gm-ready" data-testid="meeting-ready">
      <Icon name="checkCircle" size={34} />
      <h4>{ready.providerName ?? 'Google Meet'} ready</h4>
      <p className="muted">{ready.title}</p>
      {ours
        ? <Link className="btn btn-primary btn-lg" to={ready.meetUri} onClick={onClose}><Icon name="video" size={16} /> Join Meeting</Link>
        : <a className="btn btn-primary btn-lg" href={ready.meetUri} target="_blank" rel="noopener noreferrer"><Icon name="video" size={16} /> Join Meeting</a>}
      <div className="gm-link-row">
        <code>{shareable}</code>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy(shareable, 'Meeting link')}><Icon name="copy" size={14} /> Copy link</button>
      </div>
      <button type="button" className="btn btn-ghost" style={{ marginTop: 14 }} onClick={onClose}>Done</button>
    </div>
  );
}

function StartMeetingModal({ projectId, projectName, organizerUserId, onClose }: { projectId: string; projectName: string; organizerUserId?: string; onClose: () => void }) {
  const [title, setTitle] = useState(`${projectName} Discussion`);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsConnect, setNeedsConnect] = useState<string | null>(null);
  const [ready, setReady] = useState<Ready | null>(null);
  const [service, setService] = useState<MeetingServiceKey>('auto');

  const start = async () => {
    setBusy(true); setError(null);
    try {
      const m = await meetingApi.start(projectId, { title: title.trim() || undefined, participantUserIds: Array.from(selected), service });
      toast(`${m.providerName ?? 'Meeting'} ready.`);
      setReady({ title: m.title, meetUri: m.meetUri, provider: m.provider, providerName: m.providerName });
    } catch (e) {
      if (e instanceof ApiError && NOT_CONNECTED.includes(e.code)) setNeedsConnect(e.message);
      else setError(errText(e, "We couldn't create the meeting right now. Please try again."));
    } finally { setBusy(false); }
  };

  if (ready) return <Modal title="Start a meeting" onClose={onClose}><MeetReady ready={ready} onClose={onClose} /></Modal>;
  if (needsConnect) return <Modal title="Start a meeting" onClose={onClose}><ConnectPrompt message={needsConnect} onClose={onClose} /></Modal>;
  return (
    <Modal title="Start a meeting" subtitle={projectName} onClose={onClose}
      footer={<>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void start()}>{busy && <span className="spinner" />}Start Meeting</button>
      </>}>
      {error && <div className="form-error" role="alert">{error}</div>}
      <Field label="Meeting title"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></Field>
      <ServicePicker value={service} onChange={setService} />
      <ParticipantPicker projectId={projectId} organizerUserId={organizerUserId} selected={selected} onChange={setSelected} />
    </Modal>
  );
}

/** "No project" in the project picker: the meeting is for the workspace as a whole. */
const NO_PROJECT = '';

/**
 * Schedule a meeting (one call or a series) in Google Meet, Teams or a Project Tracker call. From a project, the project is fixed. From the Calendar's "Scrum call" (`pickProject`),
 * the project is a choice whose default is "No project" - a team stand-up does not have to belong to any one project - and the title and
 * invitee list follow whichever project is picked until the organizer edits the title themselves.
 */
export function ScheduleMeetingModal({ projectId, projectName, organizerUserId, onClose, scrum = false, pickProject = false }: {
  projectId: string | null; projectName: string | null; organizerUserId?: string; onClose: () => void; scrum?: boolean; pickProject?: boolean;
}) {
  const wid = useWorkspaceId();
  const workspaceName = useAuth((s) => s.ctx?.current?.name ?? 'Team');
  // A guest only ever sees the projects they were invited to, so a whole-workspace call is not theirs to make: they must pick a project.
  const isGuest = useAuth((s) => s.ctx?.current?.role === 'Guest');
  const [project, setProject] = useState<{ id: string; name: string } | null>(projectId ? { id: projectId, name: projectName ?? '' } : null);
  const [projectQuery, setProjectQuery] = useState('');
  const dq = useDebounced(projectQuery.trim(), 250);
  // Searched on the server, so a workspace with hundreds of projects can still reach every one of them.
  const projects = useWsQuery(['projects', 'meeting-picker', dq], () => projectApi.list({ q: dq || undefined, pageSize: 50 }), { enabled: pickProject });
  const projectOptions = useMemo(() => {
    const items = (projects.data?.items ?? []).map((p) => ({ id: p.id, key: p.key as string, name: p.name }));
    return project && !items.some((p) => p.id === project.id) ? [{ id: project.id, key: '', name: project.name }, ...items] : items;
  }, [projects.data, project]);
  // The organizer's own choice, not just a silent guess: the app's zone (profile, else workspace, else this device) is only the starting
  // suggestion, and the typed wall-clock time is always read in this explicit, visible value - never in the browser's own clock setting.
  const [tz, setTz] = useState(appZone());
  // Default: the next whole hour, as a wall-clock time in that zone (not in this machine's zone, which may differ).
  const [defaults] = useState(() => { const p = zonedParts(new Date(Date.now() + 60 * 60 * 1000), tz); return { date: `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`, time: `${String(p.hour).padStart(2, '0')}:00` }; });
  const autoTitle = (name: string | null) => (scrum ? `${name ?? workspaceName} Scrum` : '');
  const [title, setTitle] = useState(autoTitle(projectName));
  const [titleEdited, setTitleEdited] = useState(false);
  const [agenda, setAgenda] = useState(scrum ? 'Progress since the last stand-up\nPriorities for today\nBlockers and help needed' : '');
  const [frequency, setFrequency] = useState<'Once' | 'Daily' | 'Weekdays' | 'Weekly'>('Once');
  const [occurrences, setOccurrences] = useState(10);
  const [date, setDate] = useState(defaults.date);
  const [startTime, setStartTime] = useState(defaults.time);
  const [duration, setDuration] = useState(scrum ? 15 : 30);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsConnect, setNeedsConnect] = useState<string | null>(null);
  const [ready, setReady] = useState<Ready | null>(null);
  const [service, setService] = useState<MeetingServiceKey>('auto');
  const settingsQ = useWsQuery(['account', 'connected'], connectedAccountsApi.get, { staleTime: 60_000 });
  const willBe = service === 'auto' ? settingsQ.data?.meetings?.provider : service;

  const chooseProject = (id: string) => {
    const p = id === NO_PROJECT ? null : projectOptions.find((x) => x.id === id);
    const next = p ? { id: p.id, name: p.name } : null;
    setProject(next); setSelected(new Set());
    if (!titleEdited) setTitle(autoTitle(next?.name ?? null));
  };

  const schedule = async () => {
    if (!project && isGuest) { setError('Choose a project for this call.'); return; }
    if (!title.trim()) { setError('Give the meeting a title.'); return; }
    if (frequency !== 'Once' && (!Number.isInteger(occurrences) || occurrences < 2 || occurrences > 120)) { setError('Choose 2 to 120 sessions, including the first.'); return; }
    const [y, mo, d] = date.split('-').map(Number);
    const [h, mi] = startTime.split(':').map(Number);
    if (!y || !mo || !d || Number.isNaN(h) || Number.isNaN(mi)) { setError('Choose a date and a start time.'); return; }
    // The typed date/time means that wall-clock moment in `tz` - the zone the organizer picked below, never this browser's own clock
    // setting, so the resulting instant (and so the Calendar invite everyone receives) matches what they actually meant.
    const start = zonedTimeToUtc(y, mo - 1, d, h, mi, tz);
    if (Number.isNaN(start.getTime())) { setError('Choose a date and a start time.'); return; }
    const end = new Date(start.getTime() + duration * 60_000);
    const body = {
      title: title.trim(), description: agenda.trim() || undefined, startTime: start.toISOString(), endTime: end.toISOString(), timeZone: tz,
      participantUserIds: Array.from(selected), repeat: frequency === 'Once' ? undefined : { frequency, occurrences }, scrum: scrum || undefined, service,
    };
    setBusy(true); setError(null);
    try {
      const m = project ? await meetingApi.schedule(project.id, body) : await meetingApi.scheduleForWorkspace(body);
      invalidateWorkspace(wid, 'meetings'); invalidateWorkspace(wid, 'calendar');
      toast(frequency === 'Once' ? 'Meeting scheduled.' : 'Recurring series scheduled.');
      setReady({ title: m.title, meetUri: m.meetUri, provider: m.provider, providerName: m.providerName });
    } catch (e) {
      if (e instanceof ApiError && NOT_CONNECTED.includes(e.code)) setNeedsConnect(e.message);
      else setError(errText(e, "We couldn't schedule the meeting right now. Please try again."));
    } finally { setBusy(false); }
  };

  const heading = scrum ? 'Schedule scrum call' : 'Schedule meeting';
  const calendarName = willBe === 'microsoft' ? 'Outlook' : willBe === 'ours' ? null : 'Google Calendar';
  if (ready) return <Modal title={heading} onClose={onClose}><MeetReady ready={ready} onClose={onClose} /></Modal>;
  if (needsConnect) return <Modal title={heading} onClose={onClose}><ConnectPrompt message={needsConnect} onClose={onClose} /></Modal>;
  return (
    <Modal title={heading} subtitle={pickProject ? 'An invitation for your team - with or without a project.' : projectName ?? undefined} onClose={onClose}
      footer={<>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void schedule()}>{busy && <span className="spinner" />}{frequency === 'Once' ? 'Send invitation' : 'Create series & invite'}</button>
      </>}>
      {error && <div className="form-error" role="alert">{error}</div>}
      {pickProject && (
        <Field label="Project" hint={project ? 'Invitees come from this project, and the call is posted to its chat and Meetings tab.' : isGuest ? 'Choose one of the projects you were invited to.' : `No project: invite anyone in the workspace.${calendarName ? ` The call lives in ${calendarName}.` : ''}`}>
          <div className="gm-project-pick">
            <input className="input" type="search" aria-label="Search projects" placeholder="Search projects" value={projectQuery} onChange={(e) => setProjectQuery(e.target.value)} />
            <select className="select" aria-label="Project" value={project?.id ?? NO_PROJECT} onChange={(e) => chooseProject(e.target.value)}>
              {isGuest ? (!project && <option value={NO_PROJECT} disabled>Choose a project…</option>) : <option value={NO_PROJECT}>No project · whole workspace</option>}
              {projectOptions.map((p) => <option key={p.id} value={p.id}>{p.key ? `${p.key} · ` : ''}{p.name}</option>)}
            </select>
          </div>
        </Field>
      )}
      <Field label="Title" required><input className="input" aria-label="Title" value={title} onChange={(e) => { setTitle(e.target.value); setTitleEdited(true); }} placeholder="e.g. TLS 1.3 UAT Validation Discussion" maxLength={200} /></Field>
      <div className="gm-time-grid">
        <Field label="Date"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Start"><input className="input" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} /></Field>
        <Field label="Duration">
          <select className="select" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
            {[15, 30, 45, 60, 90].map((m) => <option key={m} value={m}>{m} minutes</option>)}
          </select>
        </Field>
      </div>
      <div className="gm-repeat-panel"><div className="gm-repeat-heading"><Icon name="repeat" size={18} /><div><strong>Meeting rhythm</strong><p>One call or a connected series for your team.</p></div></div><div className="gm-repeat-grid">
        <Field label="Repeat"><select className="select" aria-label="Repeat" value={frequency} onChange={e => setFrequency(e.target.value as typeof frequency)}><option value="Once">Does not repeat</option><option value="Daily">Every day</option><option value="Weekdays">Every weekday (Mon-Fri)</option><option value="Weekly">Every week</option></select></Field>
        {frequency !== 'Once' && <Field label="Total sessions" hint="Including the first; maximum 120"><input className="input" aria-label="Total sessions" type="number" min={2} max={120} value={occurrences} onChange={e => setOccurrences(Number(e.target.value))} /></Field>}
      </div><p className="gm-invite-note">{calendarName
        ? (frequency === 'Once' ? `One ${calendarName} invitation.` : `${occurrences} sessions in ${tz}. ${calendarName} handles repeat invitations and reminders. Individual occurrences can be changed in ${calendarName}.`)
        : (frequency === 'Once' ? 'One Project Tracker call. Everyone invited is notified and joins from the app.' : `${occurrences} Project Tracker calls in ${tz}. Everyone invited is notified and joins from the app.`)}</p></div>
      <ServicePicker value={service} onChange={setService} />
      <Field label="Agenda" hint="Optional"><textarea className="input" rows={3} value={agenda} onChange={(e) => setAgenda(e.target.value)} maxLength={4000} /></Field>
      {(project || !isGuest) && <ParticipantPicker key={project?.id ?? 'workspace'} projectId={project?.id ?? null} organizerUserId={organizerUserId} selected={selected} onChange={setSelected} />}
      <div className="field">
        <TimeZonePicker value={tz} onChange={(z) => z && setTz(z)} label="Time zone" />
        <p className="field-hint">The date and time above are read in this zone. Change it if it is not the one you meant.</p>
      </div>
    </Modal>
  );
}

/**
 * The project header's meeting entry point (spec section 1): a fast "Start Meeting" plus "Schedule Meeting" and a link to the
 * project's Meetings tab, in a small menu next to the project's other quick actions.
 */
export function GoogleMeetButton({ projectId, projectName, organizerUserId, compact, toolbar }: { projectId: string; projectName: string; organizerUserId?: string; compact?: boolean; toolbar?: boolean }) {
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [scrum, setScrum] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <>
      <div className="menu-wrap" ref={ref}>
        {toolbar ? (
          <button type="button" className="btn-icon sm" aria-haspopup="menu" aria-expanded={open} aria-label="Meetings" title="Meetings" onClick={() => setOpen((o) => !o)}>
            <Icon name="video" size={15} />
          </button>
        ) : compact ? (
          <button type="button" className="btn-icon chat-head-action" aria-haspopup="menu" aria-expanded={open} aria-label="Meetings" title="Meetings" onClick={() => setOpen((o) => !o)}>
            <Icon name="video" size={17} />
          </button>
        ) : (
          <button type="button" className="btn btn-ghost" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} title="Meetings">
            <Icon name="video" /> Meeting
          </button>
        )}
        {open && (
          <div className={`menu-pop ${toolbar ? 'up' : ''}`} role="menu">
            <button type="button" role="menuitem" onClick={() => { setOpen(false); setStarting(true); }}><Icon name="bolt" size={15} /> Start meeting now</button>
            <button type="button" role="menuitem" onClick={() => { setOpen(false); setScrum(false); setScheduling(true); }}><Icon name="calendar" size={15} /> Schedule meeting</button>
            <button type="button" role="menuitem" onClick={() => { setOpen(false); setScrum(true); setScheduling(true); }}><Icon name="repeat" size={15} /> Schedule scrum call</button>
            <Link role="menuitem" to={`/projects/${projectId}?tab=meetings`} onClick={() => setOpen(false)}><Icon name="list" size={15} /> Upcoming meetings</Link>
          </div>
        )}
      </div>
      {starting && <StartMeetingModal projectId={projectId} projectName={projectName} organizerUserId={organizerUserId} onClose={() => setStarting(false)} />}
      {scheduling && <ScheduleMeetingModal scrum={scrum} projectId={projectId} projectName={projectName} organizerUserId={organizerUserId} onClose={() => setScheduling(false)} />}
    </>
  );
}
