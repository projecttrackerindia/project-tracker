import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useInstall } from '../../lib/pwa';
import './install-banner.css';

const KEY = 'pt-install-dismissed';
const DAYS = 21;
// Never over a sign-in form: login, sign-up and the other auth screens.
const AUTH = /^\/(login|signup|register|auth|forgot-password|reset-password|verify-email|invite|approve-sign-in)(\/|$)/;
// Automated browsers (UI checks) never see the card unless a check opts in, so it can't block their clicks.
const automated = () => {
  try { return navigator.webdriver === true && localStorage.getItem('pt-install-test') !== '1'; } catch { return false; }
};
const dismissedRecently = () => {
  try { const t = Number(localStorage.getItem(KEY) || 0); return Date.now() - t < DAYS * 864e5; } catch { return false; }
};

/** A quiet "Install app" card on phones: Android gets the browser's one-tap install, iPhone gets the Share → Add to Home Screen hint.
 *  Shown once the user has been in the app a moment, never in the installed app, and not again for three weeks after "Not now". */
export function InstallBanner() {
  const inst = useInstall();
  const [ready, setReady] = useState(false);
  const [gone, setGone] = useState(dismissedRecently);
  const phone = typeof matchMedia !== 'undefined' && matchMedia('(max-width: 760px)').matches;
  useEffect(() => { const t = setTimeout(() => setReady(true), 4000); return () => clearTimeout(t); }, []);
  const ios = inst.platform === 'ios';
  const show = ready && !gone && !automated() && !AUTH.test(location.pathname) && phone && !inst.installed && (inst.canPrompt || ios);
  if (!show) return null;
  const close = () => { try { localStorage.setItem(KEY, String(Date.now())); } catch { /* private mode */ } setGone(true); };
  return createPortal(
    <div className="pt-install" role="dialog" aria-label="Install ProjectTracker">
      <img src="/icons/icon-96.png" width={44} height={44} alt="" />
      <div className="pt-install-text">
        <b>Install ProjectTracker</b>
        <span>{ios ? <>Tap <ShareGlyph /> Share, then “Add to Home Screen”.</> : 'Full screen, faster start and alerts on this phone.'}</span>
      </div>
      <div className="pt-install-act">
        {!ios && <button type="button" className="pt-install-go" onClick={() => { void inst.install().then((ok) => { if (ok) setGone(true); }); }}>Install</button>}
        <button type="button" className="pt-install-x" onClick={close}>{ios ? 'Got it' : 'Not now'}</button>
      </div>
    </div>,
    document.body,
  );
}

function ShareGlyph() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ verticalAlign: '-2px' }}><path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" /></svg>;
}
