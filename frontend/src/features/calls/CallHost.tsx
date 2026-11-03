import { lazy, Suspense } from 'react';
import { matchPath, useLocation } from 'react-router-dom';

const CallPage = lazy(() => import('./CallPage').then((m) => ({ default: m.CallPage })));

/** The call a location opens: /calls/:id (old links, notifications) or Meetings with ?call= (the call's home), unless it is over. */
export function callIdAt(pathname: string, search: string): string | null {
  const old = matchPath('/calls/:id', pathname)?.params.id;
  if (old && old !== 'meeting') return old;
  if (pathname !== '/meetings') return null;
  const q = new URLSearchParams(search);
  return q.has('over') ? null : q.get('call');
}

/**
 * Where a call lives. It is drawn once, beside the app's frame rather than inside it, and follows the address: when the frame changes - a
 * window narrowed to phone width, a tablet turned - the page inside it is rebuilt, and a call drawn there would hang up. When the call is over
 * (left, or ended), the address becomes Meetings › the call (?call=…&over=1): its people, notes, transcript and summary.
 */
export function CallHost() {
  const { pathname, search } = useLocation();
  const id = callIdAt(pathname, search);
  if (!id) return null;
  return <Suspense fallback={null}><CallPage key={id} id={id} audio={new URLSearchParams(search).has('audio')} /></Suspense>;
}

/** The route itself holds nothing: the call is drawn by {@link CallHost}. */
export function CallRoute() {
  return <div className="call-route" aria-hidden="true" />;
}
