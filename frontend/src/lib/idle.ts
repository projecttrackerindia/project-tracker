/**
 * Notices when the person has stopped using the app: no key, mouse, touch or scroll for a while. A laptop that went to sleep (or a
 * phone that was locked) stops the page's timers, so the first check after waking sees how long ago the last activity was and
 * reports idle at once - without that, a closed laptop would look "active" forever.
 */
export const IDLE_AFTER_MS = 5 * 60_000;
const CHECK_EVERY_MS = 15_000;
const ACTIVITY = ['mousemove', 'mousedown', 'keydown', 'pointerdown', 'touchstart', 'wheel', 'scroll'] as const;

export interface IdleOptions {
  idleAfterMs?: number;
  checkEveryMs?: number;
  /** Replaceable for tests. */
  now?: () => number;
}

export interface IdleTracker {
  isIdle: () => boolean;
  /** Counts as activity (for example, the person came back to the tab and interacted). */
  touch: () => void;
  stop: () => void;
}

/** Calls `onChange(true)` when the person becomes idle and `onChange(false)` when they are back. Starts out active. */
export function trackIdle(onChange: (idle: boolean) => void, options: IdleOptions = {}): IdleTracker {
  const limit = options.idleAfterMs ?? IDLE_AFTER_MS;
  const now = options.now ?? Date.now;
  let last = now();
  let idle = false;

  const set = (value: boolean) => { if (value !== idle) { idle = value; onChange(value); } };
  const touch = () => { last = now(); set(false); };
  const check = () => { if (now() - last >= limit) set(true); };

  for (const name of ACTIVITY) window.addEventListener(name, touch, { passive: true, capture: true });
  const timer = window.setInterval(check, options.checkEveryMs ?? CHECK_EVERY_MS);
  // Timers are slowed down in hidden tabs and stopped by sleep: look again the moment the page can run.
  const onVisible = () => check();
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('pageshow', onVisible);

  return {
    isIdle: () => idle,
    touch,
    stop: () => {
      window.clearInterval(timer);
      for (const name of ACTIVITY) window.removeEventListener(name, touch, { capture: true });
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onVisible);
    },
  };
}
