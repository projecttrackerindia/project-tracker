import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { connectedAccountsApi, meetingApi, projectApi, type MeetingServiceKey, type NotetakerChoice } from '../../api/endpoints';
import type { MeetingParticipant, MeetingProvider } from '../../api/types';
import { Icon } from '../../components/Icon';
import { ErrorState, Field, Modal, PageLoader } from '../../components/ui';
import { TimeZonePicker } from '../../components/TimeZonePicker';
import { invalidateWorkspace, useDebounced, useWsQuery } from '../../lib/hooks';
import { appZone, zonedParts } from '../../lib/zone';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { meetApi } from './meetApi';
import { zonedTimeToUtc } from './timezone';
import './meet.css';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const copy = async (text: string, what: string) => {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied.`); }
  catch { toast('Could not copy. Select the text and copy it by hand.', 'warning'); }
};
const NOT_CONNECTED = ['GOOGLE_NOT_CONNECTED', 'MICROSOFT_NOT_CONNECTED', 'CALLS_UNAVAILABLE'];
/** "No project" in the project picker: the meeting is for the workspace as a whole. */
const NO_PROJECT = '';

/** In place of the form when the chosen service is not connected (or no service can hold a meeting): where to connect one. */
function ConnectPrompt({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="gm-connect">
      <Icon name="video" size={34} />
      <p>{message}</p>
      <div className="mt-row">
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <Link className="btn btn-primary" to="/account/integrations" onClick={onClose}>Open connected accounts</Link>
      </div>
    </div>
  );
}

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
    { key: 'ours', label: 'Project Tracker call', ok: !!c?.ownCallsReady },
  ];
  return (
    <Field label="Meeting service" hint={value === 'auto' ? c?.reason ?? q.data?.meetingProblem ?? undefined : value === 'ours' ? 'Held in Project Tracker. People join from the invitation in Meet.' : 'Sent from your own calendar, which delivers the invitations and keeps the replies.'}>
      <select className="select" aria-label="Meeting service" value={value} onChange={(e) => onChange(e.target.value as MeetingServiceKey)}>
        {options.filter((o) => o.ok || o.key === value).map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
      </select>
    </Field>
  );
}

/**
 * Who to invite. For a project: its owner and members, everyone selected by default. With no project: the workspace's active members,
 * nobody pre-selected, with a filter box once the list gets long. The parent remounts this (key) when the project changes.
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
  if (q.isError) return <Field label="People"><ErrorState error={q.error} retry={() => q.refetch()} /></Field>;
  const people = (q.data ?? []).filter((p): p is MeetingParticipant & { userId: string } => !!p.userId && p.userId !== organizerUserId);
  const f = filter.trim().toLowerCase();
  const shown = f ? people.filter((p) => p.name.toLowerCase().includes(f) || p.email.toLowerCase().includes(f)) : people;
  const toggle = (id: string) => { const s = new Set(selected); if (s.has(id)) s.delete(id); else s.add(id); onChange(s); };
  return (
    <Field label={`People${selected.size ? ` (${selected.size})` : ''}`} hint={projectId ? undefined : 'Anyone in the workspace. You are always included as the organizer.'}>
      {people.length > 8 && <input className="input gm-filter" type="search" autoComplete="off" aria-label="Filter people" placeholder="Filter by name or email" value={filter} onChange={(e) => setFilter(e.target.value)} />}
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
        <div className="mt-row mt-row-start">
          <button type="button" className="link" onClick={() => onChange(new Set([...selected, ...shown.map((p) => p.userId)]))}>Select {f ? 'shown' : 'all'}</button>
          <button type="button" className="link" onClick={() => onChange(new Set())}>Clear</button>
        </div>
      )}
    </Field>
  );
}

/**
 * The notetaker for this meeting: none, transcription, or transcription with spoken suggestions when something is being missed. It is the
 * project's agent in the meeting, so it needs a project with its agent allowed to read meetings; what is not possible says why.
 */
function NotetakerPicker({ projectId, value, onChange }: { projectId: string | null; value: NotetakerChoice; onChange: (v: NotetakerChoice) => void }) {
  const q = useWsQuery(['meet', 'notetaker', projectId ?? 'none'], () => meetApi.notetaker(projectId!), { enabled: !!projectId, staleTime: 30_000 });
  const r = q.data;
  useEffect(() => {
    // A choice the project cannot honour falls back to what it can.
    if (!r) return;
    if (!r.available && value !== 'off') onChange('off');
    else if (value === 'voice' && !r.voiceAvailable) onChange('transcript');
  }, [r, value, onChange]);
  if (!projectId) return (
    <fieldset className="mt-notetaker">
      <legend>Notetaker</legend>
      <p className="mt-hint">Choose a project to bring the notetaker. Its notes and follow-ups are kept in that project.</p>
    </fieldset>
  );
  const options: { key: NotetakerChoice; label: string; text: string; ok: boolean; why?: string | null }[] = [
    { key: 'off', label: 'Not needed', text: 'Nobody listens or records.', ok: true },
    { key: 'transcript', label: 'Transcription', text: 'Listens, writes the transcript and the minutes, and stays quiet.', ok: !!r?.available, why: r?.reason },
    { key: 'voice', label: 'Transcription + voice suggestions', text: 'Also speaks up, briefly, when an agenda point, an owner or a date is being missed.', ok: !!r?.voiceAvailable, why: r?.voiceReason },
  ];
  return (
    <fieldset className="mt-notetaker" aria-busy={q.isLoading}>
      <legend>Notetaker</legend>
      <div className="mt-choices" role="radiogroup" aria-label="Notetaker">
        {options.map((o) => (
          <label key={o.key} className={`mt-choice${value === o.key ? ' on' : ''}${o.ok ? '' : ' off'}`}>
            <input type="radio" name="notetaker" value={o.key} checked={value === o.key} disabled={!o.ok} onChange={() => onChange(o.key)} />
            <span><b>{o.label}</b><small>{o.ok || !o.why ? o.text : o.why}</small></span>
          </label>
        ))}
      </div>
      {r && !r.available && r.canSwitchOn && <p className="mt-hint"><Link to={`/projects/${projectId}?tab=agent`}>Open the project's agent settings</Link></p>}
    </fieldset>
  );
}

/** Searches every project on the server (a workspace may have hundreds); "No project" for a workspace meeting (not for guests). */
function ProjectPicker({ value, onChange }: { value: { id: string; name: string } | null; onChange: (p: { id: string; name: string } | null) => void }) {
  const isGuest = useAuth((s) => s.ctx?.current?.role === 'Guest');
  const [query, setQuery] = useState('');
  const dq = useDebounced(query.trim(), 250);
  const projects = useWsQuery(['projects', 'meeting-picker', dq], () => projectApi.list({ q: dq || undefined, pageSize: 50 }));
  const options = useMemo(() => {
    const items = (projects.data?.items ?? []).map((p) => ({ id: p.id, key: p.key as string, name: p.name }));
    return value && !items.some((p) => p.id === value.id) ? [{ id: value.id, key: '', name: value.name }, ...items] : items;
  }, [projects.data, value]);
  return (
    <Field label="Project" hint={value ? 'Invitees come from this project; the meeting is posted to its chat.' : isGuest ? 'Choose one of the projects you were invited to.' : 'No project: invite anyone in the workspace.'}>
      <div className="gm-project-pick">
        <input className="input" type="search" autoComplete="off" aria-label="Search projects" placeholder="Search projects" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select className="select" aria-label="Project" value={value?.id ?? NO_PROJECT} onChange={(e) => { const p = options.find((x) => x.id === e.target.value); onChange(p ? { id: p.id, name: p.name } : null); }}>
          {isGuest ? (!value && <option value={NO_PROJECT} disabled>Choose a project…</option>) : <option value={NO_PROJECT}>No project (whole workspace)</option>}
          {options.map((p) => <option key={p.id} value={p.id}>{p.key ? `${p.key} · ` : ''}{p.name}</option>)}
        </select>
      </div>
    </Field>
  );
}

type Ready = { title: string; meetUri: string; provider?: MeetingProvider; providerName?: string };

/** Once the meeting exists: the link, front and centre. A Project Tracker call opens here; Google Meet and Teams open in a new tab. */
function MeetReady({ ready, onClose }: { ready: Ready; onClose: () => void }) {
  const ours = ready.provider === 'ours';
  const slug = window.location.pathname.split('/').filter(Boolean)[0];
  const shareable = ours ? `${window.location.origin}${slug ? `/${slug}` : ''}${ready.meetUri}` : ready.meetUri;
  return (
    <div className="gm-ready" data-testid="meeting-ready">
      <Icon name="checkCircle" size={34} />
      <h4>{ready.providerName ?? 'Meeting'} ready</h4>
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

const MEETING_AGENDA = '';
const SCRUM_AGENDA = 'Progress since the last stand-up\nPriorities for today\nBlockers and help needed';

/**
 * The one form for meetings, used only on the Meet page: start one now, or schedule one (a meeting or a stand-up, once or as a series) in
 * Google Meet, Teams or a Project Tracker call, with or without a project, and with the notetaker the meeting needs.
 */
export function MeetingForm({ mode, project: initialProject, title: initialTitle, onClose }: { mode: 'now' | 'schedule'; project?: { id: string; name: string } | null; /** + New › Meeting: the words typed. */ title?: string | null; onClose: () => void }) {
  const wid = useWorkspaceId();
  const me = useAuth((s) => s.ctx?.user.id);
  const workspaceName = useAuth((s) => s.ctx?.current?.name ?? 'Team');
  const isGuest = useAuth((s) => s.ctx?.current?.role === 'Guest');
  const [kind, setKind] = useState<'meeting' | 'scrum'>('meeting');
  const [project, setProject] = useState<{ id: string; name: string } | null>(initialProject ?? null);
  const autoTitle = (k: typeof kind, p: { name: string } | null) => (k === 'scrum' ? `${p?.name ?? workspaceName} stand-up` : mode === 'now' ? `${p?.name ?? workspaceName} call` : '');
  const [title, setTitle] = useState(initialTitle?.trim() || autoTitle('meeting', initialProject ?? null));
  const [titleEdited, setTitleEdited] = useState(!!initialTitle?.trim());
  const [agenda, setAgenda] = useState(MEETING_AGENDA);
  // The organizer's own zone, visible and changeable: the typed wall-clock time is read in it, never in this browser's clock setting.
  const [tz, setTz] = useState(appZone());
  const [defaults] = useState(() => { const p = zonedParts(new Date(Date.now() + 60 * 60 * 1000), tz); return { date: `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`, time: `${String(p.hour).padStart(2, '0')}:00` }; });
  const [frequency, setFrequency] = useState<'Once' | 'Daily' | 'Weekdays' | 'Weekly'>('Once');
  const [occurrences, setOccurrences] = useState(10);
  const [date, setDate] = useState(defaults.date);
  const [startTime, setStartTime] = useState(defaults.time);
  const [duration, setDuration] = useState(30);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [service, setService] = useState<MeetingServiceKey>('auto');
  const [notetaker, setNotetaker] = useState<NotetakerChoice>('off');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsConnect, setNeedsConnect] = useState<string | null>(null);
  const [ready, setReady] = useState<Ready | null>(null);
  const settingsQ = useWsQuery(['account', 'connected'], connectedAccountsApi.get, { staleTime: 60_000 });
  const willBe = service === 'auto' ? settingsQ.data?.meetings?.provider : service;
  const calendarName = willBe === 'microsoft' ? 'Outlook' : willBe === 'ours' ? null : 'Google Calendar';

  const chooseKind = (k: typeof kind) => {
    setKind(k);
    if (!titleEdited) setTitle(autoTitle(k, project));
    if (k === 'scrum') { setAgenda((a) => a || SCRUM_AGENDA); setDuration(15); setFrequency((f) => (f === 'Once' ? 'Weekdays' : f)); }
    else { setAgenda((a) => (a === SCRUM_AGENDA ? '' : a)); setDuration(30); }
  };
  const chooseProject = (p: typeof project) => {
    setProject(p); setSelected(new Set());
    if (!p) setNotetaker('off');
    if (!titleEdited) setTitle(autoTitle(kind, p));
  };

  const submit = async () => {
    if (!project && isGuest) { setError('Choose a project for this meeting.'); return; }
    if (!title.trim()) { setError('Give the meeting a title.'); return; }
    setBusy(true); setError(null);
    try {
      let made: Ready;
      if (mode === 'now') {
        if (project) {
          const m = await meetingApi.start(project.id, { title: title.trim(), participantUserIds: Array.from(selected), service, notetaker });
          made = { title: m.title, meetUri: m.meetUri, provider: m.provider, providerName: m.providerName };
        } else {
          const start = new Date(); const end = new Date(start.getTime() + 60 * 60_000);
          const m = await meetingApi.scheduleForWorkspace({ title: title.trim(), startTime: start.toISOString(), endTime: end.toISOString(), timeZone: tz, participantUserIds: Array.from(selected), service });
          made = { title: m.title, meetUri: m.meetUri, provider: m.provider, providerName: m.providerName };
        }
      } else {
        if (frequency !== 'Once' && (!Number.isInteger(occurrences) || occurrences < 2 || occurrences > 120)) { setError('Choose 2 to 120 sessions, including the first.'); return; }
        const [y, mo, d] = date.split('-').map(Number);
        const [h, mi] = startTime.split(':').map(Number);
        if (!y || !mo || !d || Number.isNaN(h) || Number.isNaN(mi)) { setError('Choose a date and a start time.'); return; }
        const start = zonedTimeToUtc(y, mo - 1, d, h, mi, tz);
        if (Number.isNaN(start.getTime())) { setError('Choose a date and a start time.'); return; }
        const end = new Date(start.getTime() + duration * 60_000);
        const body = {
          title: title.trim(), description: agenda.trim() || undefined, startTime: start.toISOString(), endTime: end.toISOString(), timeZone: tz,
          participantUserIds: Array.from(selected), repeat: frequency === 'Once' ? undefined : { frequency, occurrences }, scrum: kind === 'scrum' || undefined, service,
        };
        const m = project ? await meetingApi.schedule(project.id, { ...body, notetaker }) : await meetingApi.scheduleForWorkspace(body);
        made = { title: m.title, meetUri: m.meetUri, provider: m.provider, providerName: m.providerName };
      }
      invalidateWorkspace(wid, 'meet'); invalidateWorkspace(wid, 'meetings'); invalidateWorkspace(wid, 'calendar'); invalidateWorkspace(wid, 'reminders');
      toast(mode === 'now' ? `${made.providerName ?? 'Meeting'} ready.` : frequency === 'Once' ? 'Invitation sent.' : 'Series created and invitations sent.');
      setReady(made);
    } catch (e) {
      if (e instanceof ApiError && NOT_CONNECTED.includes(e.code)) setNeedsConnect(e.message);
      else setError(errText(e, "The meeting couldn't be created. Try again."));
    } finally { setBusy(false); }
  };

  const heading = mode === 'now' ? 'Start a meeting now' : kind === 'scrum' ? 'Schedule a stand-up' : 'Schedule a meeting';
  if (ready) return <Modal title={heading} onClose={onClose}><MeetReady ready={ready} onClose={onClose} /></Modal>;
  if (needsConnect) return <Modal title={heading} onClose={onClose}><ConnectPrompt message={needsConnect} onClose={onClose} /></Modal>;
  return (
    <Modal title={heading} onClose={onClose} size="lg"
      footer={<>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>{busy && <span className="spinner" />}{mode === 'now' ? 'Start now' : frequency === 'Once' ? 'Send invitation' : 'Create series and invite'}</button>
      </>}>
      {error && <div className="form-error" role="alert">{error}</div>}
      {mode === 'schedule' && (
        <div className="mt-kind" role="group" aria-label="Kind of meeting">
          <button type="button" aria-pressed={kind === 'meeting'} onClick={() => chooseKind('meeting')}>Meeting</button>
          <button type="button" aria-pressed={kind === 'scrum'} onClick={() => chooseKind('scrum')}>Stand-up</button>
        </div>
      )}
      <ProjectPicker value={project} onChange={chooseProject} />
      <Field label="Title" required><input className="input" aria-label="Title" value={title} onChange={(e) => { setTitle(e.target.value); setTitleEdited(true); }} placeholder="Release readiness review" maxLength={200} /></Field>
      {mode === 'schedule' && <>
        <div className="gm-time-grid">
          <Field label="Date"><input className="input" type="date" aria-label="Date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Start"><input className="input" type="time" aria-label="Start" value={startTime} onChange={(e) => setStartTime(e.target.value)} /></Field>
          <Field label="Duration">
            <select className="select" aria-label="Duration" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {[15, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m} minutes</option>)}
            </select>
          </Field>
        </div>
        <div className="gm-repeat-grid">
          <Field label="Repeat"><select className="select" aria-label="Repeat" value={frequency} onChange={(e) => setFrequency(e.target.value as typeof frequency)}><option value="Once">Does not repeat</option><option value="Daily">Every day</option><option value="Weekdays">Every weekday (Mon–Fri)</option><option value="Weekly">Every week</option></select></Field>
          {frequency !== 'Once' && <Field label="Sessions" hint="Including the first, up to 120"><input className="input" aria-label="Total sessions" type="number" min={2} max={120} value={occurrences} onChange={(e) => setOccurrences(Number(e.target.value))} /></Field>}
        </div>
        <p className="gm-invite-note">{calendarName
          ? (frequency === 'Once' ? `One ${calendarName} invitation.` : `${occurrences} sessions in ${tz}. ${calendarName} sends the invitations; one session is changed in ${calendarName}.`)
          : (frequency === 'Once' ? 'One Project Tracker call. Everyone invited is told in the app and can reply in Meet.' : `${occurrences} Project Tracker calls in ${tz}. Everyone invited can reply in Meet.`)}
          {' '}Everyone invited sees it on their Calendar and gets a reminder 10 minutes before.</p>
      </>}
      <ServicePicker value={service} onChange={setService} />
      <NotetakerPicker projectId={project?.id ?? null} value={notetaker} onChange={setNotetaker} />
      {mode === 'schedule' && <Field label="Agenda" hint="Optional. The notetaker checks it during the meeting."><textarea className="input" rows={3} aria-label="Agenda" value={agenda} onChange={(e) => setAgenda(e.target.value)} maxLength={4000} /></Field>}
      {(project || !isGuest) && <ParticipantPicker key={project?.id ?? 'workspace'} projectId={project?.id ?? null} organizerUserId={me} selected={selected} onChange={setSelected} />}
      {mode === 'schedule' && (
        <div className="field">
          <TimeZonePicker value={tz} onChange={(z) => z && setTz(z)} label="Time zone" />
          <p className="field-hint">The date and time above are read in this zone.</p>
        </div>
      )}
    </Modal>
  );
}
