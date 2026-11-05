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

/**
 * Runs `cb` once the first screen has settled: 2.5 s after it painted (index.html's splash has gone, see 'pt-first-screen'), at the first
 * tap or key press if that comes sooner, and in any case 8 s after the page loaded. On a slow phone this keeps what the first screen does
 * not need (the late styles, the animation engine) from queueing ahead of the first screen's own data.
 */
let settledQueue: (() => void)[] | null = [];
const settle = () => { if (!settledQueue) return; const q = settledQueue; settledQueue = null; q.forEach((f) => f()); };
if (typeof window !== 'undefined') {
  const w = window as Window & { __ptFirstScreen?: boolean };
  const painted = () => setTimeout(settle, 2500);
  if (w.__ptFirstScreen) painted(); else window.addEventListener('pt-first-screen', painted, { once: true });
  for (const e of ['pointerdown', 'keydown'] as const) window.addEventListener(e, settle, { once: true, capture: true, passive: true });
  const late = () => setTimeout(settle, 8000);
  if (document.readyState === 'complete') late(); else window.addEventListener('load', late, { once: true });
}
export function whenSettled(cb: () => void) {
  if (settledQueue) settledQueue.push(cb); else cb();
}

/** The late styles once the first screen has settled (see whenSettled). */
export function loadLateStylesSoon() {
  whenSettled(() => void loadLateStyles());
}
