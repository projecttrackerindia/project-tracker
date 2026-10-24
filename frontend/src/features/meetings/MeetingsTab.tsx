import { Link } from 'react-router-dom';
import { useState } from 'react';
import { ApiError } from '../../api/client';
import { meetingApi } from '../../api/endpoints';
import type { Meeting } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Badge, EmptyState, ErrorState, Field, Modal, PageLoader } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { wallInZone, zonedTimeToUtc } from './timezone';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);

/** "N accepted · N tentative · N awaiting a response" - never an accept/decline button of our own; this only reflects what Google already knows. */
function RsvpSummary({ participants }: { participants: Meeting['participants'] }) {
  const counts = { Accepted: 0, Tentative: 0, Declined: 0, NeedsAction: 0 };
  for (const p of participants) counts[p.rsvpStatus]++;
  const parts = [
    counts.Accepted > 0 && `${counts.Accepted} accepted`,
    counts.Tentative > 0 && `${counts.Tentative} tentative`,
    counts.Declined > 0 && `${counts.Declined} declined`,
    counts.NeedsAction > 0 && `${counts.NeedsAction} awaiting a response`,
  ].filter(Boolean);
  return <span className="muted" style={{ fontSize: 13 }}>{parts.join(' · ') || 'No one invited yet'}</span>;
}

const RSVP_ICON: Record<Meeting['participants'][number]['rsvpStatus'], string> = { Accepted: '✓', Declined: '✕', Tentative: '?', NeedsAction: '…' };

/** "Live now" between start and end, "Starts in N minutes/hours" within the next couple of hours - otherwise nothing (the date/time line
 * already says enough for a meeting that is not imminent). */
function LiveStatus({ m }: { m: Meeting }) {
  if (m.status !== 'Scheduled') return null;
  const now = Date.now();
  const start = new Date(m.startTime).getTime();
  const end = new Date(m.endTime).getTime();
  if (now >= start && now < end) return <Badge tone="success">Live now</Badge>;
  const minutesToStart = Math.round((start - now) / 60_000);
  if (minutesToStart > 0 && minutesToStart <= 120) return <Badge tone="warning">Starts in {minutesToStart < 60 ? `${minutesToStart} min` : `${Math.round(minutesToStart / 60)} hr`}</Badge>;
  return null;
}

/** Reschedule the time, and add or remove participants - organizer only, on a still-scheduled meeting (spec sections 12 and 14). */
function ManageMeetingModal({ m, projectId, onClose, onChanged }: { m: Meeting; projectId: string; onClose: () => void; onChanged: () => void }) {
  // Read and re-typed in the meeting's own time zone (spec/established pattern, same as scheduling) - never this browser's own clock
  // setting, which may not match the zone the meeting was actually scheduled in.
  const inHour = wallInZone(new Date(m.startTime), m.timeZone);
  const [date, setDate] = useState(`${inHour.year}-${String(inHour.monthIndex + 1).padStart(2, '0')}-${String(inHour.day).padStart(2, '0')}`);
  const [startTime, setStartTime] = useState(`${String(inHour.hour).padStart(2, '0')}:${String(inHour.minute).padStart(2, '0')}`);
  const durationMin = Math.max(5, Math.round((new Date(m.endTime).getTime() - new Date(m.startTime).getTime()) / 60_000));
  const [duration, setDuration] = useState(durationMin);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addingId, setAddingId] = useState('');
  const picker = useWsQuery(['meetings', 'participants', projectId], () => meetingApi.participants(projectId));
  const invitedIds = new Set(m.participants.map((p) => p.userId).filter(Boolean));
  const eligible = (picker.data ?? []).filter((p) => p.userId && !invitedIds.has(p.userId));

  const reschedule = async () => {
    const [y, mo, d] = date.split('-').map(Number);
    const [h, mi] = startTime.split(':').map(Number);
    if (!y || !mo || !d || Number.isNaN(h) || Number.isNaN(mi)) { setError('Choose a date and a start time.'); return; }
    const start = zonedTimeToUtc(y, mo - 1, d, h, mi, m.timeZone);
    if (Number.isNaN(start.getTime())) { setError('Choose a date and a start time.'); return; }
    const end = new Date(start.getTime() + duration * 60_000);
    setBusy('reschedule'); setError(null);
    try { await meetingApi.reschedule(m.id, { startTime: start.toISOString(), endTime: end.toISOString() }); toast('Meeting rescheduled.'); onChanged(); onClose(); }
    catch (e) { setError(errText(e, "We couldn't reschedule the meeting. Please try again.")); }
    finally { setBusy(null); }
  };
  const addParticipant = async () => {
    if (!addingId) return;
    setBusy('add'); setError(null);
    try { await meetingApi.addParticipant(m.id, addingId); setAddingId(''); toast('Added to the meeting.'); onChanged(); }
    catch (e) { setError(errText(e, 'Could not add that person.')); }
    finally { setBusy(null); }
  };
  const removeParticipant = async (userId: string, name: string) => {
    if (!(await confirmDialog({ title: 'Remove from meeting?', message: `${name} will be removed from the Google Calendar invitation.`, confirmText: 'Remove' }))) return;
    setBusy(userId); setError(null);
    try { await meetingApi.removeParticipant(m.id, userId); toast('Removed from the meeting.'); onChanged(); }
    catch (e) { setError(errText(e, 'Could not remove that person.')); }
    finally { setBusy(null); }
  };

  return (
    <Modal title="Manage meeting" subtitle={m.title} onClose={onClose}>
      {error && <div className="form-error" role="alert">{error}</div>}
      {!m.recurrenceRule && <div className="gm-time-grid">
        <Field label="Date"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Start"><input className="input" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} /></Field>
        <Field label="Duration">
          <select className="select" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
            {[15, 30, 45, 60, 90].map((v) => <option key={v} value={v}>{v} minutes</option>)}
          </select>
        </Field>
      </div>}
      {!m.recurrenceRule && <p className="muted" style={{ fontSize: 12.5, marginTop: -4 }}>Time zone: {m.timeZone} (set when the meeting was scheduled; cancel and reschedule to change it)</p>}
      {!m.recurrenceRule && <button type="button" className="btn btn-primary btn-sm" disabled={busy === 'reschedule'} onClick={() => void reschedule()}>{busy === 'reschedule' && <span className="spinner" />}Save new time</button>}
      {m.recurrenceRule && <p className="gm-invite-note">Participant changes affect the whole series. Open Google Calendar to change individual occurrences or the repeat schedule.</p>}

      <Field label="Participants" full>
        <div className="gm-picker">
          {m.participants.map((p) => (
            <div key={p.userId ?? p.email} className="gm-person">
              <span>{p.name}{p.role === 'Organizer' && <small className="muted"> · Organizer</small>}</span>
              <small className="muted" title={p.rsvpStatus}>{RSVP_ICON[p.rsvpStatus]}</small>
              {p.role !== 'Organizer' && p.userId && (
                <button type="button" className="btn-icon" aria-label={`Remove ${p.name}`} disabled={busy === p.userId} onClick={() => void removeParticipant(p.userId!, p.name)}><Icon name="close" size={13} /></button>
              )}
            </div>
          ))}
        </div>
        {eligible.length > 0 && (
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <select className="select" value={addingId} onChange={(e) => setAddingId(e.target.value)}>
              <option value="">Add someone…</option>
              {eligible.map((p) => <option key={p.userId} value={p.userId!}>{p.name}</option>)}
            </select>
            <button type="button" className="btn btn-ghost btn-sm" disabled={!addingId || busy === 'add'} onClick={() => void addParticipant()}>{busy === 'add' && <span className="spinner" />}Add</button>
          </div>
        )}
      </Field>
    </Modal>
  );
}

function MeetingCard({ m, projectId, canManage, onCancelled }: { m: Meeting; projectId: string; canManage: boolean; onCancelled: () => void }) {
  const [managing, setManaging] = useState(false);
  const [posting, setPosting] = useState(false);
  const postSummary = async () => {
    setPosting(true);
    try { const c = await meetingApi.standupSummary(m.id); toast(`Stand-up summary posted to the project chat: ${c.doneCount} done, ${c.doingCount} in progress, ${c.overdueCount} overdue.`); }
    catch (e) { toast(errText(e, 'Could not post the summary.'), 'error'); }
    finally { setPosting(false); }
  };
  const cancel = async () => {
    if (!(await confirmDialog({ title: m.recurrenceRule ? 'Cancel entire series?' : 'Cancel meeting?', message: `This will cancel ${m.recurrenceRule ? 'every occurrence in the series' : 'the Google Calendar event'} and notify the ${m.participants.length - 1} other ${m.participants.length === 2 ? 'person' : 'people'} invited.`, confirmText: m.recurrenceRule ? 'Cancel series' : 'Cancel meeting' }))) return;
    try { await meetingApi.cancel(m.id); toast('Meeting cancelled.'); onCancelled(); }
    catch (e) { toast(errText(e, 'Could not cancel the meeting.'), 'error'); }
  };
  return (
    <article className="card gm-card">
      <div className="gm-card-head">
        <h4>{m.title}</h4>{m.providerName && <Badge tone="neutral">{m.providerName}</Badge>}{m.isScrum && <Badge tone="neutral">Stand-up</Badge>}{m.recurrenceRule && <Badge tone="info">Recurring</Badge>}
        {m.status === 'Cancelled' ? <Badge tone="danger">Cancelled</Badge> : <LiveStatus m={m} />}
      </div>
      <p className="muted" style={{ fontSize: 13.5 }}>{m.recurrenceRule && 'First session: '}{formatDateTime(m.startTime)} – {formatDateTime(m.endTime)}</p>
      <p className="muted" style={{ fontSize: 13 }}>Organizer: {m.organizerName} · {m.participants.length} participant{m.participants.length === 1 ? '' : 's'}</p>
      {m.recurrenceRule && <p className="gm-invite-note">{m.recurrenceRule.includes('BYDAY') ? 'Weekdays' : m.recurrenceRule.includes('DAILY') ? 'Daily' : 'Weekly'} · {m.recurrenceRule.split('COUNT=')[1]} sessions.{m.provider === 'ours' ? '' : ` View upcoming dates and exceptions in ${m.provider === 'microsoft' ? 'Outlook' : 'Google Calendar'}.`}</p>}
      {m.provider !== 'ours' && <RsvpSummary participants={m.participants} />}
      {m.description && <p style={{ fontSize: 13.5, marginTop: 8 }}>{m.description}</p>}
      <div className="gm-card-actions">
        {(m.calendarUrl?.startsWith('https://calendar.google.com/') || m.calendarUrl?.startsWith('https://www.google.com/calendar/') || m.calendarUrl?.startsWith('https://outlook.office365.com/') || m.calendarUrl?.startsWith('https://outlook.live.com/')) && <a className="btn btn-ghost btn-sm" href={m.calendarUrl} target="_blank" rel="noopener noreferrer"><Icon name="calendar" size={14} /> Open calendar</a>}
        {m.status === 'Scheduled' && (m.provider === 'ours'
          // A Project Tracker call opens here; Google Meet and Teams open in a new tab.
          ? <Link className="btn btn-primary btn-sm" to={m.meetUri}><Icon name="video" size={14} /> Join call</Link>
          : <a className="btn btn-primary btn-sm" href={m.meetUri} target="_blank" rel="noopener noreferrer" title={m.providerName}><Icon name="video" size={14} /> Join</a>)}
        {m.status === 'Scheduled' && canManage && m.isScrum && <button type="button" className="btn btn-ghost btn-sm" disabled={posting} onClick={() => void postSummary()} title="Post what got done, what is in progress and what is overdue to the project chat">{posting && <span className="spinner" />}<Icon name="message" size={14} /> Post summary</button>}
        {m.status === 'Scheduled' && canManage && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setManaging(true)}>Manage</button>}
        {m.status === 'Scheduled' && canManage && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void cancel()}>{m.recurrenceRule ? 'Cancel series' : 'Cancel'}</button>}
      </div>
      {managing && <ManageMeetingModal m={m} projectId={projectId} onClose={() => setManaging(false)} onChanged={onCancelled} />}
    </article>
  );
}

/** Project > Meetings (spec section 9): every meeting organized from this project (Google Meet, Teams or Project Tracker call), upcoming first. */
export function MeetingsTab({ projectId }: { projectId: string }) {
  const wid = useWorkspaceId();
  const me = useAuth((s) => s.ctx!.user.id);
  const q = useWsQuery(['meetings', projectId], () => meetingApi.list(projectId));
  if (q.isLoading) return <PageLoader />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;

  const now = Date.now();
  const meetings = q.data ?? [];
  const series = meetings.filter(m => m.recurrenceRule && m.status === 'Scheduled');
  const upcoming = meetings.filter((m) => !m.recurrenceRule && m.status === 'Scheduled' && new Date(m.endTime).getTime() >= now).sort((a, b) => a.startTime.localeCompare(b.startTime));
  const past = meetings.filter((m) => m.status !== 'Scheduled' || (!m.recurrenceRule && new Date(m.endTime).getTime() < now)).sort((a, b) => b.startTime.localeCompare(a.startTime));
  const refresh = () => invalidateWorkspace(wid, 'meetings', projectId);

  if (meetings.length === 0) return <EmptyState icon="video" title="No meetings yet" text='Start or schedule one from the "Meeting" button above.' />;

  return (
    <div className="gm-tab">
      {meetings.some((m) => m.isScrum && m.status === 'Scheduled') && <p className="gm-invite-note" style={{ marginTop: 0 }}>After each stand-up session, a summary of what got done, what is in progress and what is overdue is posted to this project's chat.</p>}
      {series.length > 0 && <><h3 className="section-title">Recurring series</h3><div className="gm-grid">{series.map(m => <MeetingCard key={m.id} m={m} projectId={projectId} canManage={m.organizerUserId === me} onCancelled={refresh} />)}</div></>}
      {upcoming.length > 0 && <><h3 className="section-title">Upcoming</h3><div className="gm-grid">{upcoming.map((m) => <MeetingCard key={m.id} m={m} projectId={projectId} canManage={m.organizerUserId === me} onCancelled={refresh} />)}</div></>}
      {past.length > 0 && <><h3 className="section-title" style={{ marginTop: upcoming.length > 0 ? 28 : 0 }}>Past</h3><div className="gm-grid">{past.map((m) => <MeetingCard key={m.id} m={m} projectId={projectId} canManage={false} onCancelled={refresh} />)}</div></>}
    </div>
  );
}
