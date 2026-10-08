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

/** Reschedule the time, and add or remove participants - organizer only, on a still-scheduled meeting (spec sections 12 and 14). */
function ManageMeetingModal({ m, projectId, onClose, onChanged }: { m: Meeting; projectId: string; onClose: () => void; onChanged: () => void }) {
  const inHour = new Date(m.startTime);
  const [date, setDate] = useState(inHour.toISOString().slice(0, 10));
  const [startTime, setStartTime] = useState(inHour.toTimeString().slice(0, 5));
  const durationMin = Math.max(5, Math.round((new Date(m.endTime).getTime() - new Date(m.startTime).getTime()) / 60_000));
  const [duration, setDuration] = useState(durationMin);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addingId, setAddingId] = useState('');
  const picker = useWsQuery(['meetings', 'participants', projectId], () => meetingApi.participants(projectId));
  const invitedIds = new Set(m.participants.map((p) => p.userId).filter(Boolean));
  const eligible = (picker.data ?? []).filter((p) => p.userId && !invitedIds.has(p.userId));

  const reschedule = async () => {
    const start = new Date(`${date}T${startTime}:00`);
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
      <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
        <Field label="Date"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Start"><input className="input" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} /></Field>
        <Field label="Duration">
          <select className="select" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
            {[15, 30, 45, 60, 90].map((v) => <option key={v} value={v}>{v} minutes</option>)}
          </select>
        </Field>
      </div>
      <button type="button" className="btn btn-primary btn-sm" disabled={busy === 'reschedule'} onClick={() => void reschedule()}>{busy === 'reschedule' && <span className="spinner" />}Save new time</button>

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
  const cancel = async () => {
    if (!(await confirmDialog({ title: 'Cancel meeting?', message: `This will cancel the Google Calendar event and notify the ${m.participants.length - 1} other ${m.participants.length === 2 ? 'person' : 'people'} invited.`, confirmText: 'Cancel meeting' }))) return;
    try { await meetingApi.cancel(m.id); toast('Meeting cancelled.'); onCancelled(); }
    catch (e) { toast(errText(e, 'Could not cancel the meeting.'), 'error'); }
  };
  return (
    <article className="card gm-card">
      <div className="gm-card-head">
        <h4>{m.title}</h4>
        {m.status === 'Cancelled' && <Badge tone="danger">Cancelled</Badge>}
      </div>
      <p className="muted" style={{ fontSize: 13.5 }}>{formatDateTime(m.startTime)} – {formatDateTime(m.endTime)}</p>
      <p className="muted" style={{ fontSize: 13 }}>Organizer: {m.organizerName} · {m.participants.length} participant{m.participants.length === 1 ? '' : 's'}</p>
      <RsvpSummary participants={m.participants} />
      {m.description && <p style={{ fontSize: 13.5, marginTop: 8 }}>{m.description}</p>}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        {m.status === 'Scheduled' && <a className="btn btn-primary btn-sm" href={m.meetUri} target="_blank" rel="noopener noreferrer"><Icon name="video" size={14} /> Join</a>}
        {m.status === 'Scheduled' && canManage && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setManaging(true)}>Manage</button>}
        {m.status === 'Scheduled' && canManage && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void cancel()}>Cancel</button>}
      </div>
      {managing && <ManageMeetingModal m={m} projectId={projectId} onClose={() => setManaging(false)} onChanged={onCancelled} />}
    </article>
  );
}

/** Project > Meetings (spec section 9): every Google Meet organized from this project, upcoming first. */
export function MeetingsTab({ projectId }: { projectId: string }) {
  const wid = useWorkspaceId();
  const me = useAuth((s) => s.ctx!.user.id);
  const q = useWsQuery(['meetings', projectId], () => meetingApi.list(projectId));
  if (q.isLoading) return <PageLoader />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;

  const now = Date.now();
  const meetings = q.data ?? [];
  const upcoming = meetings.filter((m) => m.status === 'Scheduled' && new Date(m.endTime).getTime() >= now).sort((a, b) => a.startTime.localeCompare(b.startTime));
  const past = meetings.filter((m) => m.status !== 'Scheduled' || new Date(m.endTime).getTime() < now).sort((a, b) => b.startTime.localeCompare(a.startTime));
  const refresh = () => invalidateWorkspace(wid, 'meetings', projectId);

  if (meetings.length === 0) return <EmptyState icon="video" title="No meetings yet" text='Start or schedule a Google Meet from the "Google Meet" button above.' />;

  return (
    <div className="gm-tab">
      {upcoming.length > 0 && <><h3 className="section-title">Upcoming</h3><div className="gm-grid">{upcoming.map((m) => <MeetingCard key={m.id} m={m} projectId={projectId} canManage={m.organizerUserId === me} onCancelled={refresh} />)}</div></>}
      {past.length > 0 && <><h3 className="section-title" style={{ marginTop: upcoming.length > 0 ? 28 : 0 }}>Past</h3><div className="gm-grid">{past.map((m) => <MeetingCard key={m.id} m={m} projectId={projectId} canManage={false} onCancelled={refresh} />)}</div></>}
    </div>
  );
}
