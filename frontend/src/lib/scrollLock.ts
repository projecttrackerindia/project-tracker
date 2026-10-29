/**
 * Holding the page still behind a sheet, dialog or full-screen panel. Each holder takes a lock and gives it back; the page scrolls again
 * once the last one is given back. (Saving and restoring `overflow` per holder leaves the page stuck when two overlap and close in the
 * other order - a dialog opened over a sheet, or two panels unmounting together on navigation - which froze People & Roles.)
 */
type Target = 'body' | 'html';
const held: Record<Target, number> = { body: 0, html: 0 };
const el = (t: Target) => (t === 'body' ? document.body : document.documentElement);

export function lockScroll(target: Target = 'body'): () => void {
  if (typeof document === 'undefined') return () => undefined;
  held[target]++;
  el(target).style.overflow = 'hidden';
  let done = false;
  return () => {
    if (done) return;
    done = true;
    held[target] = Math.max(0, held[target] - 1);
    if (held[target] === 0) el(target).style.overflow = '';
  };
}

/** How many holders each target has (tests). */
export const scrollLocks = () => ({ ...held });
