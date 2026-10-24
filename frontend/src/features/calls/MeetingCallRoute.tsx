import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { callsApi } from './callsApi';

/**
 * /calls/meeting/:meetingId (and /calls/meeting/w/:meetingId for a workspace meeting): the join address of a meeting held as a Project
 * Tracker call. Opening it starts the call when nobody has yet, or joins the one already going, then shows the call itself.
 */
export function MeetingCallRoute({ workspace = false }: { workspace?: boolean }) {
  const { meetingId } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (!meetingId || started.current) return;
    started.current = true;
    callsApi.openMeeting(meetingId, workspace)
      .then((call) => navigate(`/calls/${call.id}`, { replace: true }))
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not open the meeting. Try again in a moment.'));
  }, [meetingId, workspace, navigate]);
  return (
    <div className="meeting-call-open" role="status" style={{ display: 'grid', placeItems: 'center', gap: 12, padding: '64px 16px', textAlign: 'center' }}>
      {error ? (
        <>
          <Icon name="alert" size={28} />
          <p style={{ margin: 0, maxWidth: '52ch' }}>{error}</p>
          <Link className="btn" to="/calendar">Back to the calendar</Link>
        </>
      ) : (
        <>
          <span className="spinner" />
          <p className="muted" style={{ margin: 0 }}>Opening the meeting…</p>
        </>
      )}
    </div>
  );
}
