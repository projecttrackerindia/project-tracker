import { useState } from 'react';
import { ApiError } from '../../api/client';
import { meetingApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { Badge, ErrorState, Field, Modal, PageLoader } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { wallInZone, zonedTimeToUtc } from './timezone';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const repeatLabel = (rule: string) => `${rule.includes('BYDAY') ? 'Every weekday' : rule.includes('DAILY') ? 'Every day' : 'Every week'} · ${rule.split('COUNT=')[1] ?? '?'} sessions`;

/**
 * A meeting for the whole workspace (a stand-up with no project), opened from the Calendar or its notification: join it, and - for the
 * organizer or an Owner/Admin - move a one-off meeting or cancel it. Google Calendar holds the event; a series is edited there.
 */
export function WorkspaceMeetingModal({ id, onClose }: { id: string; onClose: () => void }) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['meetings', 'workspace', id], () => meetingApi.workspaceGet(id), { retry: false });
  const [moving, setMoving] = useState(false);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [busy, setBusy] = useState<'move' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const m = q.data;
  const refresh = () => { invalidateWorkspace(wid, 'meetings'); invalidateWorkspace(wid, 'calendar'); };

  const startMove = () => {
    if (!m) return;
    const w = wallInZone(new Date(m.startTime), m.timeZone);
    setDate(`${w.year}-${String(w.monthIndex + 1).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`);
    setTime(`${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`);
    setMoving(true);
  };
  const move = async () => {
    if (!m) return;
    const [y, mo, d] = date.split('-').map(Number); const [h, mi] = time.split(':').map(Number);
    if (!y || !mo || !d || Number.isNaN(h) || Number.isNaN(mi)) { setError('Choose a date and a start time.'); return; }
    const start = zonedTimeToUtc(y, mo - 1, d, h, mi, m.timeZone);
    const end = new Date(start.getTime() + (new Date(m.endTime).getTime() - new Date(m.startTime).getTime()));
    setBusy('move'); setError(null);
    try { await meetingApi.workspaceReschedule(m.id, { startTime: start.toISOString(), endTime: end.toISOString() }); toast('Meeting moved. Google Calendar tells everyone invited.'); refresh(); setMoving(false); void q.refetch(); }
    catch (e) { setError(errText(e, "We couldn't move the meeting. Please try again.")); }
    finally { setBusy(null); }
  };
  const cancel = async () => {
    if (!m) return;
    if (!(await confirmDialog({ title: m.recurrenceRule ? 'Cancel the whole series?' : 'Cancel this meeting?', message: `Google Calendar cancels the event and tells the ${Math.max(0, m.attendees.length - 1)} other people invited.`, confirmText: m.recurrenceRule ? 'Cancel series' : 'Cancel meeting' }))) return;
    setBusy('cancel');
    try { await meetingApi.workspaceCancel(m.id); toast('Meeting cancelled.'); refresh(); onClose(); }
    catch (e) { setError(errText(e, 'Could not cancel the meeting.')); setBusy(null); }
  };

  return (
    <Modal title={m?.title ?? 'Meeting'} subtitle={m ? 'Workspace meeting · no project' : undefined} onClose={onClose}
      footer={m && m.status === 'Scheduled' ? <>
        {m.canManage && <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => void cancel()}>{busy === 'cancel' && <span className="spinner" />}{m.recurrenceRule ? 'Cancel series' : 'Cancel meeting'}</button>}
        <a className="btn btn-primary" href={m.meetUri} target="_blank" rel="noopener noreferrer"><Icon name="video" size={15} /> Join</a>
      </> : <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>}>
      {q.isLoading ? <PageLoader /> : q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : m && (
        <div className="wm-detail">
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="wm-badges">
            {m.isScrum && <Badge tone="neutral">Stand-up</Badge>}
            {m.recurrenceRule && <Badge tone="info">{repeatLabel(m.recurrenceRule)}</Badge>}
            {m.status === 'Cancelled' && <Badge tone="danger">Cancelled</Badge>}
          </div>
          <dl className="wm-props">
            <dt>{m.recurrenceRule ? 'First session' : 'When'}</dt><dd>{formatDateTime(m.startTime)} – {formatDateTime(m.endTime)}</dd>
            <dt>Time zone</dt><dd>{m.timeZone}</dd>
            <dt>Organizer</dt><dd>{m.organizerName}</dd>
            <dt>Invited</dt><dd>{m.attendees.map((a) => a.name).join(', ')}</dd>
          </dl>
          {m.description && <p className="wm-agenda">{m.description}</p>}
          {m.calendarUrl && (m.calendarUrl.startsWith('https://calendar.google.com/') || m.calendarUrl.startsWith('https://www.google.com/calendar/')) &&
            <a className="link" href={m.calendarUrl} target="_blank" rel="noopener noreferrer">Open in Google Calendar</a>}
          {m.status === 'Scheduled' && m.canManage && !m.recurrenceRule && !moving && <button type="button" className="btn btn-ghost btn-sm wm-move" onClick={startMove}><Icon name="calendar" size={14} /> Move to another time</button>}
          {m.status === 'Scheduled' && m.canManage && m.recurrenceRule && <p className="gm-invite-note">To move one session or change the repeat schedule, open the series in Google Calendar.</p>}
          {moving && (
            <div className="wm-move-form">
              <div className="gm-time-grid">
                <Field label="Date"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
                <Field label={`Start (${m.timeZone})`}><input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
                <div className="wm-move-actions">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMoving(false)}>Back</button>
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => void move()}>{busy === 'move' && <span className="spinner" />}Save time</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
