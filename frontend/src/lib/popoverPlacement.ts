/** The geometry behind lib/popover: where a floating box goes beside its trigger. Pure, so it is unit-tested without a DOM. */

export interface Box { top: number; left: number; right: number; bottom: number }
export type Side = 'top' | 'bottom';
export type Align = 'start' | 'end';
export interface Placement { top: number; left: number; maxHeight?: number; side: Side; align: Align }

/** The part two boxes share (may be empty: bottom < top). */
export const intersect = (a: Box, b: Box): Box => ({ top: Math.max(a.top, b.top), left: Math.max(a.left, b.left), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });

/**
 * Where a floating box of `size` goes next to `anchor`, inside `bounds`. Prefers `side` (below / above) and `align` (start = left edges
 * line up, end = right edges line up); flips either when it does not fit and the other way does, and when neither side fits takes the
 * roomier one with a max height so the box scrolls instead of spilling out. `pad` keeps it off the edges of the bounds.
 */
export function placeFloating(anchor: Box, size: { width: number; height: number }, bounds: Box,
  { side = 'bottom', align = 'end', gap = 6, pad = 8 }: { side?: Side; align?: Align; gap?: number; pad?: number } = {}): Placement {
  const below = bounds.bottom - pad - (anchor.bottom + gap);
  const above = anchor.top - gap - (bounds.top + pad);
  let s: Side = side;
  const fits = (x: Side) => (x === 'bottom' ? below : above) >= size.height;
  if (!fits(s)) s = fits(s === 'bottom' ? 'top' : 'bottom') ? (s === 'bottom' ? 'top' : 'bottom') : (below >= above ? 'bottom' : 'top');
  const room = Math.max(0, s === 'bottom' ? below : above);
  const height = Math.min(size.height, room);
  let top = s === 'bottom' ? anchor.bottom + gap : anchor.top - gap - height;
  // Never outside the bounds even when the anchor itself sits half outside them.
  top = Math.max(bounds.top + pad, Math.min(top, bounds.bottom - pad - height));

  const startLeft = anchor.left, endLeft = anchor.right - size.width;
  const fitsX = (l: number) => l >= bounds.left + pad && l + size.width <= bounds.right - pad;
  let a: Align = align;
  if (!fitsX(a === 'start' ? startLeft : endLeft) && fitsX(a === 'start' ? endLeft : startLeft)) a = a === 'start' ? 'end' : 'start';
  let left = a === 'start' ? startLeft : endLeft;
  left = Math.max(bounds.left + pad, Math.min(left, bounds.right - pad - size.width));
  return { top: Math.round(top), left: Math.round(left), maxHeight: height < size.height ? Math.floor(height) : undefined, side: s, align: a };
}

const viewport = (): Box => ({ top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight });

/** The box a popover must stay inside: the viewport, narrowed to the nearest element matching `within` (e.g. the messages list). */
export function boundsFor(anchor: Element, within?: string): Box {
  const v = viewport();
  const box = within ? anchor.closest(within) : null;
  if (!box) return v;
  const r = box.getBoundingClientRect();
  const b = intersect(v, r);
  return b.bottom - b.top < 80 ? v : b;   // a box too small to hold anything useful: the viewport rather than nothing
}

