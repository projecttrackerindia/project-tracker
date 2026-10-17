import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { integrationsApi, meetingApi } from '../../api/endpoints';
import type { MeetingParticipant } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Field, Modal, PageLoader } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import './meetings.css';
import { toast } from '../../stores/ui';
import { allTimeZones, zonedTimeToUtc } from './timezone';
import { appZone } from '../../lib/zone';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const copy = async (text: string, what: string) => {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied.`); }
  catch { toast('Could not copy. Select the text and copy it by hand.', 'warning'); }
};

/** Shown inside a Meet modal in place of the form, when this person has not connected a Google account yet (spec section 24). */
function ConnectGooglePrompt({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const connect = async () => {
    setBusy(true);
    // Always lands on My account > Google Workspace (not back here): that page is the one that shows the connected toast and
    // cleans up the ?google=... marker, and there is nothing to resume on this page after a full-page round trip to Google anyway.
    try { const { url } = await integrationsApi.googleConnectUrl('/account/integrations'); window.location.assign(url); }
    catch (e) { toast(errText(e, 'Could not start the Google connection.'), 'error'); setBusy(false); }
  };
  return (
    <div className="gm-connect">
      <Icon name="video" size={34} />
      <p>Connect your Google account to schedule Google Meet meetings.</p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void connect()}>{busy && <span className="spinner" />}Connect Google account</button>
      </div>
    </div>
  );
}

/** The project's owner and members, with checkboxes; everyone is selected by default (spec: "Default selected people: Project owner, Project members"). */
function ParticipantPicker({ projectId, organizerUserId, selected, onChange }: { projectId: string; organizerUserId?: string; selected: Set<string>; onChange: (s: Set<string>) => void }) {
  const q = useWsQuery(['meetings', 'participants', projectId], () => meetingApi.participants(projectId));
  const defaulted = useRef(false);
  useEffect(() => {
    if (defaulted.current || !q.data) return;
    defaulted.current = true;
    onChange(new Set(q.data.filter((p) => p.userId && p.userId !== organizerUserId).map((p) => p.userId!)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data]);
  if (q.isLoading) return <PageLoader />;
  const people = (q.data ?? []).filter((p): p is MeetingParticipant & { userId: string } => !!p.userId && p.userId !== organizerUserId);
  const toggle = (id: string) => { const s = new Set(selected); if (s.has(id)) s.delete(id); else s.add(id); onChange(s); };
  return (
    <Field label="Participants">
      <div className="gm-picker">
        {people.length === 0 && <p className="muted" style={{ margin: 0 }}>No other members are on this project yet.</p>}
        {people.map((p) => (
          <label key={p.userId} className="gm-person">
            <input type="checkbox" checked={selected.has(p.userId)} onChange={() => toggle(p.userId)} />
            <span>{p.name}</span><small className="muted">{p.role}</small>
          </label>
        ))}
      </div>
      {people.length > 0 && (
        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <button type="button" className="link" onClick={() => onChange(new Set(people.map((p) => p.userId)))}>Select all</button>
          <button type="button" className="link" onClick={() => onChange(new Set())}>Clear all</button>
        </div>
      )}
    </Field>
  );
}

/** Once the meeting exists: the link, front and center, so the organizer can get into it (or send it) in one click. */
function MeetReady({ title, meetUri, onClose }: { title: string; meetUri: string; onClose: () => void }) {
  return (
    <div className="gm-ready">
      <Icon name="checkCircle" size={34} />
      <h4>Google Meet ready</h4>
      <p className="muted">{title}</p>
      <a className="btn btn-primary btn-lg" href={meetUri} target="_blank" rel="noopener noreferrer"><Icon name="video" size={16} /> Join Meeting</a>
      <div className="gm-link-row">
        <code>{meetUri}</code>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy(meetUri, 'Meeting link')}><Icon name="copy" size={14} /> Copy link</button>
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
  const [needsGoogle, setNeedsGoogle] = useState(false);
  const [ready, setReady] = useState<{ title: string; meetUri: string } | null>(null);

  const start = async () => {
    setBusy(true); setError(null);
    try {
      const m = await meetingApi.start(projectId, { title: title.trim() || undefined, participantUserIds: Array.from(selected) });
      toast('Google Meet ready.');
      setReady({ title: m.title, meetUri: m.meetUri });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'GOOGLE_NOT_CONNECTED') setNeedsGoogle(true);
      else setError(errText(e, "We couldn't create the Google Meet right now. Please try again."));
    } finally { setBusy(false); }
  };

  if (ready) return <Modal title="Start Google Meet" onClose={onClose}><MeetReady title={ready.title} meetUri={ready.meetUri} onClose={onClose} /></Modal>;
  if (needsGoogle) return <Modal title="Start Google Meet" onClose={onClose}><ConnectGooglePrompt onClose={onClose} /></Modal>;
  return (
    <Modal title="Start Google Meet" subtitle={projectName} onClose={onClose}
      footer={<>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void start()}>{busy && <span className="spinner" />}Start Meeting</button>
      </>}>
      {error && <div className="form-error" role="alert">{error}</div>}
      <Field label="Meeting title"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></Field>
      <ParticipantPicker projectId={projectId} organizerUserId={organizerUserId} selected={selected} onChange={setSelected} />
    </Modal>
  );
}

export function ScheduleMeetingModal({ projectId, projectName, organizerUserId, onClose, scrum = false }: { projectId: string; projectName: string; organizerUserId?: string; onClose: () => void; scrum?: boolean }) {
  const wid = useWorkspaceId();
  // The organizer's own choice, not just a silent guess: this device's detected zone is only the starting suggestion. A machine whose
  // system clock reports UTC (common on shared/VDI desktops) must not silently schedule "9:00" as 9:00 UTC when the organizer meant
  // 9:00 Central - so the zone used to turn the typed wall-clock time into a real instant is always this explicit, visible value.
  const [tz, setTz] = useState(appZone());
  const zones = useState(allTimeZones)[0];
  const inHour = new Date(Date.now() + 60 * 60 * 1000);
  const [title, setTitle] = useState(scrum ? `${projectName} Scrum` : '');
  const [agenda, setAgenda] = useState(scrum ? 'Progress since the last stand-up\nPriorities for today\nBlockers and help needed' : '');
  const [frequency, setFrequency] = useState<'Once' | 'Daily' | 'Weekdays' | 'Weekly'>('Once');
  const [occurrences, setOccurrences] = useState(10);
  const [date, setDate] = useState(`${inHour.getFullYear()}-${String(inHour.getMonth() + 1).padStart(2, '0')}-${String(inHour.getDate()).padStart(2, '0')}`);
  const [startTime, setStartTime] = useState(inHour.toTimeString().slice(0, 5));
  const [duration, setDuration] = useState(scrum ? 15 : 30);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsGoogle, setNeedsGoogle] = useState(false);
  const [ready, setReady] = useState<{ title: string; meetUri: string } | null>(null);

  const schedule = async () => {
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
    setBusy(true); setError(null);
    try {
      const m = await meetingApi.schedule(projectId, {
        title: title.trim(), description: agenda.trim() || undefined, startTime: start.toISOString(), endTime: end.toISOString(), timeZone: tz,
        participantUserIds: Array.from(selected), repeat: frequency === 'Once' ? undefined : { frequency, occurrences },
      });
      invalidateWorkspace(wid, 'meetings');
      toast(frequency === 'Once' ? 'Meeting scheduled.' : 'Recurring series scheduled.');
      setReady({ title: m.title, meetUri: m.meetUri });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'GOOGLE_NOT_CONNECTED') setNeedsGoogle(true);
      else setError(errText(e, "We couldn't schedule the Google Meet right now. Please try again."));
    } finally { setBusy(false); }
  };

  if (ready) return <Modal title={scrum ? "Schedule scrum call" : "Schedule meeting"} onClose={onClose}><MeetReady title={ready.title} meetUri={ready.meetUri} onClose={onClose} /></Modal>;
  if (needsGoogle) return <Modal title={scrum ? "Schedule scrum call" : "Schedule meeting"} onClose={onClose}><ConnectGooglePrompt onClose={onClose} /></Modal>;
  return (
    <Modal title={scrum ? "Schedule scrum call" : "Schedule meeting"} subtitle={projectName} onClose={onClose}
      footer={<>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void schedule()}>{busy && <span className="spinner" />}{frequency === 'Once' ? 'Send invitation' : 'Create series & invite'}</button>
      </>}>
      {error && <div className="form-error" role="alert">{error}</div>}
      <Field label="Title" required><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. TLS 1.3 UAT Validation Discussion" maxLength={200} /></Field>
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
      </div><p className="gm-invite-note">{frequency === 'Once' ? 'One Google Calendar invitation.' : `${occurrences} sessions in ${tz}. Google Calendar handles repeat invitations and reminders. Individual occurrences can be changed in Google Calendar.`}</p></div>
      <Field label="Agenda" hint="Optional"><textarea className="input" rows={3} value={agenda} onChange={(e) => setAgenda(e.target.value)} maxLength={4000} /></Field>
      <ParticipantPicker projectId={projectId} organizerUserId={organizerUserId} selected={selected} onChange={setSelected} />
      <Field label="Time zone" hint="The date and time above are read in this zone - change it if it is not the one you meant.">
        <select className="select" aria-label="Time zone" value={tz} onChange={(e) => setTz(e.target.value)}>
          {!zones.includes(tz) && <option value={tz}>{tz}</option>}
          {zones.map((z) => <option key={z} value={z}>{z}</option>)}
        </select>
      </Field>
    </Modal>
  );
}

/**
 * The project header's "Google Meet" entry point (spec section 1): a fast "Start Meeting" plus "Schedule Meeting" and a link to the
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
          <button type="button" className="btn-icon sm" aria-haspopup="menu" aria-expanded={open} aria-label="Google Meet" title="Google Meet" onClick={() => setOpen((o) => !o)}>
            <Icon name="video" size={15} />
          </button>
        ) : compact ? (
          <button type="button" className="btn-icon chat-head-action" aria-haspopup="menu" aria-expanded={open} aria-label="Google Meet" title="Google Meet" onClick={() => setOpen((o) => !o)}>
            <Icon name="video" size={17} />
          </button>
        ) : (
          <button type="button" className="btn btn-ghost" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} title="Google Meet">
            <Icon name="video" /> Google Meet
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
