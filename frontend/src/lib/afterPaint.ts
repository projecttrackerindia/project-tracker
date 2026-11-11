import { useEffect, useState } from 'react';

/**
 * Whether the first screen has been painted and the browser has gone quiet.
 *
 * The frame mounts a few readers whose answers nothing on the first screen shows: whether a call is in progress, how long until the screen
 * locks, whether this device needs approving. Each used to make its own request while the first screen was still being drawn, so they
 * competed with the reads the screen does show. Gating them on this hook moves them just past the first paint; they still run on their own
 * a moment later, so nothing is lost and no caller has to change what it does with the answer.
 *
 * It resolves once per page load and every caller flips together, so the deferred reads go out as one group rather than trickling. The
 * timeout is the floor, not the target: a browser that never reports an idle moment (a busy phone, a background tab) still continues.
 */
const QUIET_MS = 1200;

let quiet = typeof window === 'undefined';
const waiting = new Set<() => void>();

function goQuiet() {
  if (quiet) return;
  quiet = true;
  for (const f of waiting) f();
  waiting.clear();
}

if (typeof window !== 'undefined') {
  const idle = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  // After paint, then at the browser's first quiet moment, and in any case once the timeout is up.
  requestAnimationFrame(() => {
    if (idle) idle(goQuiet, { timeout: QUIET_MS });
    window.setTimeout(goQuiet, QUIET_MS);
  });
}

/** True once the first paint is done and the browser is quiet. Use it as a query's `enabled` for a read the first screen does not show. */
export function useAfterFirstPaint(): boolean {
  const [ready, setReady] = useState(quiet);
  useEffect(() => {
    if (quiet) { if (!ready) setReady(true); return; }
    const flip = () => setReady(true);
    waiting.add(flip);
    return () => { waiting.delete(flip); };
  }, [ready]);
  return ready;
}
