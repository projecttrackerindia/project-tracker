import { ApiError } from '../../api/client';
import { meetingApi } from '../../api/endpoints';
import type { Meeting } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Badge, EmptyState, ErrorState, PageLoader } from '../../components/ui';
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

function MeetingCard({ m, canCancel, onCancelled }: { m: Meeting; canCancel: boolean; onCancelled: () => void }) {
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
        {m.status === 'Scheduled' && canCancel && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void cancel()}>Cancel</button>}
      </div>
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
      {upcoming.length > 0 && <><h3 className="section-title">Upcoming</h3><div className="gm-grid">{upcoming.map((m) => <MeetingCard key={m.id} m={m} canCancel={m.organizerUserId === me} onCancelled={refresh} />)}</div></>}
      {past.length > 0 && <><h3 className="section-title" style={{ marginTop: upcoming.length > 0 ? 28 : 0 }}>Past</h3><div className="gm-grid">{past.map((m) => <MeetingCard key={m.id} m={m} canCancel={false} onCancelled={refresh} />)}</div></>}
    </div>
  );
}
