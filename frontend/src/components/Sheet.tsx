import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { haptic } from '../lib/mobile';

/**
 * Lets a sheet be dragged down to close, from its grab handle and header, like a native bottom sheet: it follows the finger, closes when pulled far
 * or flicked, and springs back otherwise. Returns the pointer handlers to put on the draggable part; `sheet` is the element that moves.
 */
export function useSheetDrag(sheet: () => HTMLElement | null, onClose: () => void) {
  const from = useRef<{ y: number; t: number } | null>(null);
  const move = (e: ReactPointerEvent) => {
    const s = sheet(); if (!from.current || !s) return;
    const dy = Math.max(0, e.clientY - from.current.y);
    s.style.transform = `translateY(${dy}px)`;
    const overlay = s.parentElement; if (overlay) overlay.style.setProperty('--fade', String(Math.max(0, 1 - dy / 420)));
  };
  const end = (e: ReactPointerEvent) => {
    const s = sheet(); const f = from.current; from.current = null;
    if (!s || !f) return;
    const dy = Math.max(0, e.clientY - f.y); const v = dy / Math.max(1, Date.now() - f.t);
    if (dy > 110 || (dy > 30 && v > 0.55)) {
      haptic(6);
      s.style.transition = 'transform .2s ease-in'; s.style.transform = 'translateY(100%)';
      setTimeout(onClose, 180);
    } else {
      s.style.transition = 'transform .28s cubic-bezier(.2,.8,.2,1)'; s.style.transform = '';
      s.parentElement?.style.setProperty('--fade', '1');
    }
  };
  return {
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.pointerType === 'mouse') return;
      const s = sheet(); if (!s) return;
      from.current = { y: e.clientY, t: Date.now() };
      s.style.transition = 'none';
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
    },
    onPointerMove: move, onPointerUp: end, onPointerCancel: end,
  };
}

/** A bottom sheet: what a phone app uses for menus, pickers and short forms. It slides up, can be dragged away, and locks the page behind it. */
export function Sheet({ title, onClose, children, footer, label }: { title?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useSheetDrag(() => ref.current, onClose);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div className="sheet-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className="sheet" role="dialog" aria-modal="true" aria-label={label ?? title ?? 'Menu'}>
        <div className="sheet-drag" {...drag}>
          <i className="sheet-grab" aria-hidden="true" />
          {title && <div className="sheet-head"><h3>{title}</h3><button type="button" className="sheet-x" aria-label="Close" onClick={onClose}><Icon name="close" size={18} /></button></div>}
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
