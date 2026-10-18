import { create } from 'zustand';
import { createUpdateChecker, POLL_MS, runningBuild, VERSION_URL } from './appUpdate';

/** A newer release the server has (its build id), the one "Later" was chosen for, and whether a reload is under way. */
interface AppUpdateState { available: string | null; dismissed: string | null; reloading: boolean }
export const useAppUpdate = create<AppUpdateState>(() => ({ available: null, dismissed: null, reloading: false }));

let registration: ServiceWorkerRegistration | null = null;
let check: (force?: boolean) => void = () => undefined;
let reloadOnControllerChange = false;
let reloaded = false;

const reloadOnce = () => {
  if (reloaded) return;
  reloaded = true;
  window.location.reload();
};

/**
 * Starts watching for a newer release (production builds only, and only when the page knows its own build). The server is asked when the
 * tab becomes visible or focused again, when the connection returns, every few minutes while the tab is visible, and when something hints
 * at a release: a new service worker, or a page chunk that no longer exists on the server. Nothing is ever reloaded without being asked.
 */
export function startUpdateWatch() {
  if (!import.meta.env.PROD || typeof window === 'undefined') return;
  const running = runningBuild(document);
  if (!running) return;
  const checker = createUpdateChecker({
    running,
    fetchVersion: async () => {
      const res = await fetch(`${VERSION_URL}?t=${Date.now()}`, { cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`version check ${res.status}`);
      return res.json();
    },
    env: () => ({ hidden: document.visibilityState === 'hidden', online: navigator.onLine !== false }),
    onChange: (build) => {
      useAppUpdate.setState({ available: build });
      // Let the service worker fetch the new app shell too, so the reload starts from the new release even on a slow connection.
      if (build) void registration?.update().catch(() => undefined);
    },
  });
  check = (force = false) => { void checker.check(force); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  window.addEventListener('focus', () => check());
  window.addEventListener('online', () => check(true));
  // A lazily loaded page that is gone from the server is the surest sign that a release went out while this tab was open.
  window.addEventListener('vite:preloadError', () => check(true));
  window.setInterval(() => check(true), POLL_MS);
}

/** Follows the service worker's own update cycle: a newly installed worker is a hint to check, and it takes over when asked to reload. */
export function watchServiceWorker(reg: ServiceWorkerRegistration) {
  registration = reg;
  const sw = navigator.serviceWorker;
  const hadController = !!sw.controller;
  reg.addEventListener('updatefound', () => {
    const installing = reg.installing;
    installing?.addEventListener('statechange', () => { if (installing.state === 'installed' && sw.controller) check(true); });
  });
  sw.addEventListener('controllerchange', () => {
    if (reloadOnControllerChange) { reloadOnce(); return; }
    // A worker replacing an earlier one (not the very first install) means sw.js changed: usually a release.
    if (hadController) check(true);
  });
}

/** "Later": hide the banner until a build newer than this one is found. */
export function dismissUpdate() {
  useAppUpdate.setState((s) => ({ dismissed: s.available }));
}

/**
 * "Reload": a service worker still waiting to take over is told to, and the page reloads once it has (or after a few seconds regardless);
 * otherwise the page simply reloads. The navigation itself always goes to the network first (sw.js), so it gets the new release.
 */
export function reloadForUpdate() {
  useAppUpdate.setState({ reloading: true });
  const waiting = registration?.waiting;
  if (waiting && navigator.serviceWorker?.controller) {
    reloadOnControllerChange = true;
    waiting.postMessage('skip-waiting');
    window.setTimeout(reloadOnce, 4000);
    return;
  }
  reloadOnce();
}
