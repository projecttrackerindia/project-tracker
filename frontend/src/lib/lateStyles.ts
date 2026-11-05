/**
 * The global styles the first screen does not need (styles/late.css: documents, chat, org charts, reminders, notification settings, the
 * sign-in pages …) are a stylesheet of their own, so a phone opening Today does not wait for them. They are fetched once the first screen
 * has painted, or at once when another page is opened first (every page but Today waits for them, see App.tsx), and the <link> goes
 * straight after the app's own stylesheets from index.html: ahead of any page's stylesheet, where these rules always were, so which rule
 * wins is exactly as before.
 */
import lateHref from '../styles/late.css?url';

// The stylesheets index.html started with (the module scripts run before any page adds its own).
const initial = typeof document === 'undefined' ? [] : [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')];
let ready: Promise<void> | null = null;

export function loadLateStyles(): Promise<void> {
  if (ready) return ready;
  if (import.meta.env.DEV) return (ready = import('../styles/late.css').then(() => undefined));
  ready = new Promise<void>((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = lateHref;
    link.dataset.late = '';
    // Never hold a page back for long: on a failed or very slow load it shows anyway (the rules arrive when the file does).
    const done = () => resolve();
    link.addEventListener('load', done);
    link.addEventListener('error', done);
    setTimeout(done, 8000);
    const anchor = initial[initial.length - 1];
    if (anchor?.parentNode) anchor.parentNode.insertBefore(link, anchor.nextSibling);
    else document.head.appendChild(link);
  });
  return ready;
}

/** After the first screen: when the browser is next idle (or within 2 s) once the page has loaded. */
export function loadLateStylesSoon() {
  const go = () => {
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (idle) idle(() => void loadLateStyles(), { timeout: 2000 }); else setTimeout(() => void loadLateStyles(), 300);
  };
  if (document.readyState === 'complete') go(); else window.addEventListener('load', go, { once: true });
}
