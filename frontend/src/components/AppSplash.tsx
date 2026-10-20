import { useEffect, useState } from 'react';
import { BrandMark } from './BrandMark';
import './splash.css';

/**
 * While the app starts (or a whole screen loads): the logo breathing inside a soft ring and a thin bar sweeping under it - CSS only, no
 * images. After a few seconds it says it is still connecting; without a connection it says so and offers to try again the moment the
 * network is back.
 */
export function AppSplash({ message = 'Loading your workspace' }: { message?: string }) {
  const [slow, setSlow] = useState(false);
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 6000);
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { clearTimeout(t); window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return (
    <div className={`app-splash ${online ? '' : 'is-offline'}`} role="status" aria-live="polite">
      <div className="as-mark" aria-hidden="true"><span className="as-ring" /><span className="as-ring as-ring-2" /><span className="as-badge"><BrandMark size={34} /></span></div>
      <div className="as-name">Project Tracker</div>
      <div className="as-bar" aria-hidden="true"><i /></div>
      <p className="as-text">{!online ? 'You are offline. It opens as soon as the connection is back.' : slow ? 'Still connecting - a slow network can take a moment.' : message}</p>
      {(!online || slow) && <button type="button" className="as-retry" onClick={() => window.location.reload()}>Try again</button>}
    </div>
  );
}

/** A small pill at the top while the connection is lost ("Back online" for a moment once it returns). */
export function NetworkPill() {
  const [state, setState] = useState<'online' | 'offline' | 'back'>(() => (typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'online'));
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = () => { clearTimeout(t); setState('offline'); };
    const on = () => { setState((s) => (s === 'offline' ? 'back' : s)); t = setTimeout(() => setState('online'), 2500); };
    window.addEventListener('offline', off); window.addEventListener('online', on);
    return () => { clearTimeout(t); window.removeEventListener('offline', off); window.removeEventListener('online', on); };
  }, []);
  if (state === 'online') return null;
  return <div className={`net-pill ${state === 'back' ? 'back' : ''}`} role="status" aria-live="polite"><i />{state === 'back' ? 'Back online' : 'You are offline - showing what was already loaded'}</div>;
}
