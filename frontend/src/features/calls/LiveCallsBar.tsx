import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useWsQuery } from '../../lib/hooks';
import { useAuth } from '../../stores/auth';
import { callsApi } from './callsApi';
import './calls.css';

/** A thin bar at the top of the app when a call you can join is on (invited, or in your project or chat), with a Join button. */
export function LiveCallsBar() {
  const { pathname } = useLocation();
  const me = useAuth((s) => s.ctx?.user.id);
  const status = useWsQuery(['calls', 'status'], callsApi.status, { staleTime: 600_000, retry: false });
  const live = useWsQuery(['calls', 'live'], callsApi.live, { enabled: !!status.data?.available, refetchInterval: 30_000, retry: false });
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  if (pathname.startsWith('/calls/')) return null;
  const call = (live.data ?? []).find((c) => !hidden.has(c.id) && !c.people.some((p) => p.userId === me && p.inCall) && c.people.some((p) => p.inCall));
  if (!call) return null;
  const inCall = call.people.filter((p) => p.inCall);
  return (
    <div className="call-live-bar" role="status" data-testid="call-live-bar">
      <i className="dot" aria-hidden="true" />
      <span><b>{inCall.slice(0, 2).map((p) => p.name).join(', ')}{inCall.length > 2 ? ` and ${inCall.length - 2} more` : ''}</b> {inCall.length === 1 ? 'is' : 'are'} in “{call.title}”</span>
      <Link className="btn btn-primary btn-sm" to={`/calls/${call.id}`}>Join</Link>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setHidden((s) => new Set(s).add(call.id))}>Not now</button>
    </div>
  );
}
