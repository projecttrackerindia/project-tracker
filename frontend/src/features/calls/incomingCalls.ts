/**
 * Calls ringing for the signed-in person, wherever the news came from: the live connection ("call.incoming"), the list of live calls
 * (checked when notifications change, when the tab comes back and every few seconds - for a tab whose live connection is down), or a push
 * the service worker handed to this page. One call rings once, for at most {@link RING_MS}; a call answered, declined, ended or missed
 * never rings again on this page.
 *
 * Plain state with no React, so the live connection, the service worker bridge and the incoming-call card share it (and tests can drive it).
 */

export const RING_MS = 45_000;

export interface IncomingCall {
  callId: string;
  title: string;
  fromName: string;
  /** When it started ringing here (ms). */
  at: number;
}

type Listener = (calls: IncomingCall[]) => void;

let ringing: IncomingCall[] = [];
const done = new Set<string>();
const listeners = new Set<Listener>();

const emit = () => { for (const l of listeners) l(ringing); };

export const ringingCalls = () => ringing;

export function onRinging(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/**
 * Starts ringing a call. Returns true when it is new here (not already ringing, not answered, declined or over). A call that started
 * longer ago than the ring lasts does not ring (a tab coming back after an hour must not ring for a call long gone).
 */
export function ring(call: { callId: string; title?: string | null; fromName?: string | null; startedAt?: string | number | null }, now = Date.now()): boolean {
  if (!call.callId || done.has(call.callId) || ringing.some((c) => c.callId === call.callId)) return false;
  const started = typeof call.startedAt === 'string' ? Date.parse(call.startedAt) : call.startedAt ?? now;
  // Clocks differ a little between the server and this device: a start slightly "in the future" still rings.
  if (Number.isFinite(started) && now - started > RING_MS) return false;
  ringing = [...ringing, { callId: call.callId, title: call.title || 'Call', fromName: call.fromName || 'Someone', at: now }];
  emit();
  return true;
}

/** Stops a call ringing (answered, declined, ended, missed or rung out) - for good, on this page. */
export function stopRinging(callId: string) {
  done.add(callId);
  if (!ringing.some((c) => c.callId === callId)) return;
  ringing = ringing.filter((c) => c.callId !== callId);
  emit();
}

/** Calls that have rung for {@link RING_MS}: they stop (the server then files a missed call). Returns those that stopped. */
export function expire(now = Date.now()): IncomingCall[] {
  const old = ringing.filter((c) => now - c.at >= RING_MS);
  for (const c of old) stopRinging(c.callId);
  return old;
}

/**
 * The "X is calling" notice in the inbox: the incoming-call card already shows it (with its own sound and system notification), so the
 * banner and the desktop notifier leave it alone. The "Missed call from X" notice that follows is an ordinary notification.
 */
export function isRingNotice(n: { type: string; title: string; link?: string | null }): boolean {
  return n.type === 'Call' && !!n.link?.includes('/calls/') && !/^Missed call/i.test(n.title);
}

/** The call id in a link like /calls/{id} (or /org/calls/{id}). */
export function callIdOf(link: string | null | undefined): string | null {
  const m = /\/calls\/([0-9a-zA-Z-]+)/.exec(link ?? '');
  return m ? m[1] : null;
}

/** Forgets everything (tests, signing out). */
export function resetRinging() {
  ringing = [];
  done.clear();
  emit();
}

/** What the live connection says about calls (ChatRealtime forwards these as a window event). */
export const CALL_EVENT = 'pt-call';
export type CallEventDetail =
  | { event: 'incoming'; callId: string; title?: string; fromName?: string; startedAt?: string }
  | { event: 'stopped'; callId: string; reason?: string }
  | { event: 'declined'; callId: string; name?: string };

export const emitCallEvent = (detail: CallEventDetail) => window.dispatchEvent(new CustomEvent<CallEventDetail>(CALL_EVENT, { detail }));
