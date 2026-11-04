import { useEffect, useState } from 'react';
import { Logo, BRAND } from './Logo';
import './splash.css';

/**
 * While the app starts (or a whole screen loads): the purple ProjectTracker logo scales in with the spring, then pulses softly, with the name
 * and a thin bar sweeping under it (calm demo ?splash=1) - CSS only, no images. After a few seconds it says it is still connecting; without a connection it says so and offers to try again the moment the
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
      <div className="as-mark" aria-hidden="true"><Logo size={96} className="pt-logo as-logo" /></div>
      <div className="as-name">{BRAND}</div>
      <div className="as-bar" aria-hidden="true"><i /></div>
      <p className="as-text">{!online ? 'You are offline. It opens as soon as the connection is back.' : slow ? 'Still connecting - a slow network can take a moment.' : message}</p>
      {(!online || slow) && <button type="button" className="as-retry" onClick={() => window.location.reload()}>Try again</button>}
    </div>
  );
}
