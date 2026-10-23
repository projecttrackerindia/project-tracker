import { lazy, Suspense } from 'react';
import { matchPath, useLocation } from 'react-router-dom';

const CallPage = lazy(() => import('./CallPage').then((m) => ({ default: m.CallPage })));

/**
 * Where a call lives. It is drawn once, beside the app's frame rather than inside it, and follows the address (/calls/:id): when the
 * frame changes - a window narrowed to phone width, a tablet turned - the page inside it is rebuilt, and a call drawn there would hang up.
 */
export function CallHost() {
  const { pathname } = useLocation();
  const id = matchPath('/calls/:id', pathname)?.params.id;
  if (!id) return null;
  return <Suspense fallback={null}><CallPage key={id} id={id} /></Suspense>;
}

/** The route itself holds nothing: the call is drawn by {@link CallHost}. */
export function CallRoute() {
  return <div className="call-route" aria-hidden="true" />;
}
