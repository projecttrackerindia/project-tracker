/**
 * "Sign out after inactivity": watches for real use of the app (keyboard, pointer, touch, wheel, scroll) and nothing else, so background
 * polling and realtime updates never keep a session open. Every tab of the browser shares one "last used" time (BroadcastChannel, with
 * localStorage as the fallback), so working in one tab keeps the others open, and they lock and unlock together.
 *
 * Two minutes before the workspace's time runs out it reports "warning" (with the time left), and at the time "locked". A laptop that slept
 * or a phone app that was in the background stops timers: the first check when the page can run again sees how long it has really been.
 */
export type IdlePhase = 'active' | 'warning' | 'locked';

export const WARN_BEFORE_MS = 2 * 60_000;
/** The server hears about real use at most this often (POST /auth/activity). */
export const PING_EVERY_MS = 60_000;
const SHARE_EVERY_MS = 5_000;
const LAST_KEY = 'pt-idle-last';
const EVENT_KEY = 'pt-idle-event';
const CHANNEL = 'pt-idle';
const ACTIVITY = ['mousemove', 'mousedown', 'keydown', 'pointerdown', 'touchstart', 'wheel', 'scroll'] as const;

type Message = { t: 'activity'; at: number } | { t: 'lock' } | { t: 'unlock'; at: number } | { t: 'signout' };

export interface IdleLockOptions {
  /** The workspace's time in ms; 0 = never lock. */
  timeoutMs: number;
  onPhase: (phase: IdlePhase, msLeft: number) => void;
  /** Real use worth telling the server about (throttled to PING_EVERY_MS). */
  onPing: () => void;
  /** This tab's timer ran out (lock the session on the server). */
  onLockDue: () => void;
  /** Another tab unlocked (renew this tab's token) or signed out. */
  onRemote?: (what: 'unlock' | 'signout' | 'lock') => void;
  now?: () => number;
  checkEveryMs?: number;
}

export interface IdleLock {
  phase: () => IdlePhase;
  /** "Stay signed in", or any real use. */
  touch: () => void;
  /** Locked by something else (a 401 from the server): show the lock here and in every tab. */
  lockNow: (tell?: boolean) => void;
  /** Unlocked here: carry on here and in every tab. */
  unlocked: () => void;
  signedOut: () => void;
  setTimeoutMs: (ms: number) => void;
  stop: () => void;
}

const readLast = () => { try { return Number(localStorage.getItem(LAST_KEY)) || 0; } catch { return 0; } };

export function createIdleLock(o: IdleLockOptions): IdleLock {
  const now = o.now ?? Date.now;
  let timeoutMs = o.timeoutMs;
  let last = now();
  let phase: IdlePhase = 'active';
  let lastPing = 0;
  let lastShared = 0;
  let reported = '';

  let channel: BroadcastChannel | null = null;
  try { channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null; } catch { channel = null; }
  const tell = (m: Message) => {
    if (channel) { try { channel.postMessage(m); return; } catch { /* closed */ } }
    // Fallback: a storage event reaches the other tabs (never this one).
    try { localStorage.setItem(EVENT_KEY, JSON.stringify({ ...m, n: Math.random() })); } catch { /* storage unavailable */ }
  };
  const share = (at: number) => {
    try { localStorage.setItem(LAST_KEY, String(at)); } catch { /* storage unavailable */ }
    tell({ t: 'activity', at });
  };

  const report = (p: IdlePhase, left: number) => {
    const key = p === 'warning' ? `${p}:${Math.ceil(left / 1000)}` : p;
    if (key === reported) return;
    reported = key; phase = p;
    o.onPhase(p, left);
  };

  const check = () => {
    if (phase === 'locked' || timeoutMs <= 0) { if (timeoutMs <= 0 && phase === 'warning') report('active', 0); return; }
    last = Math.max(last, readLast());
    const left = timeoutMs - (now() - last);
    if (left <= 0) { report('locked', 0); tell({ t: 'lock' }); o.onLockDue(); }
    else if (left <= WARN_BEFORE_MS) report('warning', left);
    else report('active', left);
  };

  const touch = () => {
    if (phase === 'locked') return;
    const t = now();
    // Back after the time ran out (the timers were asleep): that is not activity, it is the moment to lock.
    if (timeoutMs > 0 && t - Math.max(last, readLast()) >= timeoutMs) { check(); return; }
    last = t;
    if (t - lastShared >= SHARE_EVERY_MS) { lastShared = t; share(t); }
    if (t - lastPing >= PING_EVERY_MS) { lastPing = t; o.onPing(); }
    if (phase === 'warning') report('active', timeoutMs);
  };

  const onMessage = (m: Message | null) => {
    if (!m) return;
    if (m.t === 'activity') { last = Math.max(last, m.at); if (phase === 'warning') check(); }
    else if (m.t === 'lock') { if (phase !== 'locked') { report('locked', 0); o.onRemote?.('lock'); } }
    else if (m.t === 'unlock') { last = Math.max(last, m.at); reported = ''; phase = 'active'; o.onRemote?.('unlock'); check(); }
    else if (m.t === 'signout') o.onRemote?.('signout');
  };
  const onChannel = (e: MessageEvent<Message>) => onMessage(e.data);
  const onStorage = (e: StorageEvent) => {
    if (e.key === LAST_KEY && e.newValue) onMessage({ t: 'activity', at: Number(e.newValue) || 0 });
    if (e.key === EVENT_KEY && e.newValue) { try { onMessage(JSON.parse(e.newValue) as Message); } catch { /* not ours */ } }
  };
  channel?.addEventListener('message', onChannel);
  window.addEventListener('storage', onStorage);

  for (const name of ACTIVITY) window.addEventListener(name, touch, { passive: true, capture: true });
  const onVisible = () => { if (document.visibilityState === 'visible') check(); };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('pageshow', onVisible);
  window.addEventListener('focus', onVisible);
  const timer = window.setInterval(check, o.checkEveryMs ?? 1000);
  share(last);

  return {
    phase: () => phase,
    touch: () => { lastPing = 0; touch(); },
    lockNow: (shout = true) => { if (phase === 'locked') return; report('locked', 0); if (shout) tell({ t: 'lock' }); },
    unlocked: () => { const t = now(); last = t; lastPing = t; reported = ''; phase = 'active'; share(t); tell({ t: 'unlock', at: t }); check(); },
    signedOut: () => tell({ t: 'signout' }),
    setTimeoutMs: (ms) => { timeoutMs = ms; check(); },
    stop: () => {
      window.clearInterval(timer);
      for (const name of ACTIVITY) window.removeEventListener(name, touch, { capture: true });
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('storage', onStorage);
      channel?.removeEventListener('message', onChannel);
      try { channel?.close(); } catch { /* closed */ }
    },
  };
}

/** "1:59" for the warning's countdown. */
export const countdown = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
