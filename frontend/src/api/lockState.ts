/**
 * Whether this session is locked ("Sign out after inactivity"). While it is, requests wait instead of being sent (nothing is lost, nothing
 * reloads) and go out as soon as the person unlocks; a sign-out instead makes them fail. Every tab of the browser locks and unlocks together:
 * the lock screen tells the others (BroadcastChannel, with a localStorage event as the fallback).
 */
type Waiter = (unlocked: boolean) => void;
let locked = false;
let waiters: Waiter[] = [];
const listeners = new Set<(locked: boolean) => void>();

export const isSessionLocked = () => locked;

/** Something learned the session is locked (the timer, a 401 SESSION_IDLE_LOCKED, another tab). */
export function markLocked() {
  if (locked) return;
  locked = true;
  listeners.forEach((l) => l(true));
}

/** Unlocked (true: waiting requests go out) or signed out (false: they fail). */
export function markUnlocked(unlocked: boolean) {
  const wasLocked = locked;
  locked = false;
  const w = waiters; waiters = [];
  w.forEach((fn) => fn(unlocked));
  if (wasLocked) listeners.forEach((l) => l(false));
}

/** Resolves true at once when not locked, otherwise when the person unlocks (false when they sign out instead). */
export const waitForUnlock = (): Promise<boolean> => (locked ? new Promise<boolean>((r) => waiters.push(r)) : Promise.resolve(true));

export function onLockChange(fn: (locked: boolean) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
