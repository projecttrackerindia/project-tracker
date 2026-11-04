import { Suspense, useEffect, useState, type ReactNode } from 'react';

/**
 * Phones first: what is not on the screen at start (the live connection, prompts, background watchers) mounts only once the page has
 * painted and the browser is idle, so its code and its API reads do not compete with the page's own (docs/notifications-matrix.md, PR
 * "notify-speed"). At most a few seconds later than before; nothing is lost, since every such host reads its state from a store or the server.
 */
let painted = false;
const waiting = new Set<() => void>();
function whenIdle(go: () => void) {
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  const run = () => (w.requestIdleCallback ? w.requestIdleCallback(go, { timeout: 2500 }) : window.setTimeout(go, 1200));
  if (document.readyState === 'complete') run(); else window.addEventListener('load', run, { once: true });
}
function onPainted(cb: () => void): () => void {
  if (painted) { cb(); return () => undefined; }
  waiting.add(cb);
  if (waiting.size === 1) whenIdle(() => { painted = true; for (const f of [...waiting]) f(); waiting.clear(); });
  return () => { waiting.delete(cb); };
}

export function AfterFirstPaint({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(painted);
  useEffect(() => (ready ? undefined : onPainted(() => setReady(true))), [ready]);
  return ready ? <Suspense fallback={null}>{children}</Suspense> : null;
}

/** Mounts (and so downloads) a sheet's code the first time it is asked to open, and keeps it mounted after that (closing animations, follow-up forms). */
export function WhenFirstOpened({ open, children }: { open: boolean; children: ReactNode }) {
  const [seen, setSeen] = useState(open);
  useEffect(() => { if (open) setSeen(true); }, [open]);
  return seen || open ? <Suspense fallback={null}>{children}</Suspense> : null;
}

/** True once the page has painted and the browser is idle: for reads that only feed badges or menus (the sidebar's counts, mail unread). */
export function useAfterFirstPaint(): boolean {
  const [ready, setReady] = useState(painted);
  useEffect(() => (ready ? undefined : onPainted(() => setReady(true))), [ready]);
  return ready;
}
