import { useEffect, useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/**
 * One way to place every small menu and popover (Talk's message "···", the composer "+", the AI rewrite list, the emoji grid, the
 * header ⓘ, and DotsMenu app-wide): rendered in a portal with fixed positioning so no scrolling box or overflow clips it, measured
 * against the space actually free around its trigger, flipped up/down and left/right to fit, clamped inside the viewport and the
 * scroll box it belongs to (so a menu on the last message opens upward and never hides behind the composer), and re-placed on
 * scroll and resize. Closes on Escape, an outside click, or when its trigger scrolls out of view; arrow keys move between its items
 * and focus goes back to the trigger when it closes. Small on purpose — not worth a dependency.
 */

import { boundsFor, placeFloating, type Align, type Side } from './popoverPlacement';

export type { Align, Side } from './popoverPlacement';

// Keyboard or pointer: a menu opened from the keyboard puts focus on its first item, one opened with the mouse does not move it there.
let lastKeyboard = false;
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', () => { lastKeyboard = true; }, true);
  window.addEventListener('pointerdown', () => { lastKeyboard = false; }, true);
}

const ITEMS = '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled), [role="option"]:not(:disabled)';
const trigger = (anchor: HTMLElement): HTMLElement =>
  (anchor.matches('button, [tabindex]') ? anchor : anchor.querySelector<HTMLElement>('[aria-expanded], button')) ?? anchor;

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** The trigger, or the small wrapper around it. Clicks inside it are not "outside". */
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  className?: string;
  role?: string;
  'aria-label'?: string;
  side?: Side;
  align?: Align;
  gap?: number;
  /** A selector for the scrolling box the popover must also stay inside (and whose scrolling-away closes it), e.g. ".chat-messages". */
  within?: string;
  /** Move focus into the popover when it opens by mouse too (menus: yes; the composer's popovers keep the typing caret: no). */
  focusOnOpen?: boolean;
  /** Return focus to the trigger on close (default yes). */
  restoreFocus?: boolean;
  style?: CSSProperties;
}

export function Popover({ open, ...rest }: PopoverProps) {
  if (!open || typeof document === 'undefined') return null;
  return createPortal(<Floating {...rest} />, document.body);
}

function Floating({ onClose, anchorRef, children, className = '', role, side = 'bottom', align = 'end', gap = 6, within, focusOnOpen = true, restoreFocus = true, style, ...aria }: Omit<PopoverProps, 'open'>) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });

  // Place now (before paint), and again whenever anything could have moved it.
  useLayoutEffect(() => {
    const el = ref.current, anchor = anchorRef.current;
    if (!el || !anchor) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      if (a.width === 0 && a.height === 0) { close.current(); return; }   // the trigger was hidden or removed
      const bounds = boundsFor(anchor, within);
      // Scrolled away: the trigger is no longer inside the box it lives in.
      if (a.bottom < bounds.top || a.top > bounds.bottom || a.right < bounds.left || a.left > bounds.right) { close.current(); return; }
      const keep = el.scrollTop;   // re-placing must not throw a scrolled menu back to its top
      el.style.maxHeight = '';
      const size = { width: el.offsetWidth, height: el.scrollHeight };
      let p = placeFloating(a, size, bounds, { side, align, gap });
      // Too little room inside a short scroll box (a pinned card above it, a small window): let it rise over the header rather than
      // shrink to a few rows, but keep its bottom inside the box, so it never covers the composer below.
      if (p.maxHeight !== undefined && within) p = placeFloating(a, size, { ...bounds, top: 8 }, { side, align, gap });
      el.style.top = `${p.top}px`; el.style.left = `${p.left}px`;
      if (p.maxHeight !== undefined) { el.style.maxHeight = `${p.maxHeight}px`; el.style.overflowY = 'auto'; el.style.overscrollBehavior = 'contain'; el.scrollTop = keep; }
      el.dataset.side = p.side; el.dataset.align = p.align;
      el.style.visibility = '';
    };
    place();
    let frame = 0;
    const later = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
    // Scrolling inside the popover itself must not re-place it: that reset its height and threw the list back to the top, so a long
    // menu could not be scrolled.
    const onScroll = (e: Event) => { if (e.target instanceof Node && el.contains(e.target)) return; later(); };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', later);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(later) : null;
    ro?.observe(el);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', later); ro?.disconnect(); };
  }, [anchorRef, within, side, align, gap]);

  // Outside click, Escape, focus in and back out.
  useEffect(() => {
    const el = ref.current, anchor = anchorRef.current;
    if (!el) return;
    const back = anchor ? trigger(anchor) : null;
    const items = () => Array.from(el.querySelectorAll<HTMLElement>(ITEMS));
    if (lastKeyboard) (items()[0] ?? el).focus({ preventScroll: true });
    else if (focusOnOpen) el.focus({ preventScroll: true });
    const down = (e: PointerEvent | MouseEvent) => {
      const t = e.target as Node;
      if (el.contains(t) || anchorRef.current?.contains(t)) return;
      close.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopPropagation();
      close.current();
      back?.focus({ preventScroll: true });
    };
    document.addEventListener('mousedown', down, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('mousedown', down, true);
      document.removeEventListener('keydown', key, true);
      // Focus was in the popover (or nowhere): give it back to the trigger rather than dropping it on <body>.
      const active = document.activeElement;
      if (restoreFocus && back && back.isConnected && (!active || active === document.body || el.contains(active))) back.focus({ preventScroll: true });
    };
  }, [anchorRef, focusOnOpen, restoreFocus]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = Array.from(ref.current?.querySelectorAll<HTMLElement>(ITEMS) ?? []);
    if (!list.length) return;
    const i = list.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === 'ArrowDown' || (e.key === 'ArrowRight' && i >= 0 && list[i].closest('[role="group"]'))) next = i < 0 ? 0 : (i + 1) % list.length;
    else if (e.key === 'ArrowUp' || (e.key === 'ArrowLeft' && i >= 0 && list[i].closest('[role="group"]'))) next = i <= 0 ? list.length - 1 : i - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else if (e.key === 'Tab') { close.current(); return; }
    if (next < 0) return;
    e.preventDefault();
    list[next].focus();
  };

  return (
    <div ref={ref} className={`floating ${className}`} role={role} aria-label={aria['aria-label']} tabIndex={-1} onKeyDown={onKeyDown}
      style={{ position: 'fixed', top: 0, left: 0, right: 'auto', bottom: 'auto', margin: 0, visibility: 'hidden', ...style }}>
      {children}
    </div>
  );
}
