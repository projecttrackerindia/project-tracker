/**
 * Page modules are split so the first visit downloads a fraction of the app. Their loaders are registered here as they are declared, and
 * fetched one by one once the app is idle: after that a click renders the next page straight away (no blank pause while its code
 * arrives). Skipped when the person asked their browser to save data or is on a very slow connection.
 */
const loaders: (() => Promise<unknown>)[] = [];
let started = false;

export function registerPage(load: () => Promise<unknown>) {
  loaders.push(load);
}

export function prefetchPages() {
  if (started || typeof window === 'undefined') return;
  started = true;
  const c = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (c?.saveData || c?.effectiveType === '2g' || c?.effectiveType === 'slow-2g') return;
  const idle = (fn: () => void) => { if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(fn, { timeout: 4000 }); else globalThis.setTimeout(fn, 1500); };
  const queue = [...new Set(loaders)];
  const next = () => {
    const load = queue.shift();
    if (!load) return;
    load().catch(() => undefined).finally(() => idle(next));
  };
  window.setTimeout(() => idle(next), 2500);   // after the first page has settled
}
