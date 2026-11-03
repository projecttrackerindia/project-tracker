import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Icon } from '../Icon';
import { lockScroll } from '../../lib/scrollLock';
import { useIsMobile } from '../../lib/mobile';
import { presets } from '../../lib/motion';
import './calm-kit.css';

/**
 * A calm sheet over the blurred page. `side` slides in from the right as a floating 560px panel (task, ticket, plan sheets); `bottom`
 * rises as a centred 880px sheet (insights, summaries). On a phone both become a bottom sheet with a grab handle. Escape and the scrim
 * close it; focus moves into the sheet and back to where it was.
 */
export function CalmSheet({ open, onClose, title, sub, children, kind = 'side', width, label, actions }: {
  open: boolean; onClose: () => void; title?: ReactNode; sub?: ReactNode; children: ReactNode; kind?: 'side' | 'bottom'; width?: number; label?: string; actions?: ReactNode;
}) {
  const phone = useIsMobile();
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const back = document.activeElement as HTMLElement | null;
    const release = lockScroll();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', key);
    requestAnimationFrame(() => ref.current?.focus());
    return () => { release(); window.removeEventListener('keydown', key); back?.focus?.(); };
  }, [open, onClose]);
  const motionProps = phone || kind === 'bottom' ? presets.sheet : presets.panel;
  if (typeof document === 'undefined') return null;
  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div key="scrim" className="calm-scrim" {...presets.fade} onClick={onClose} aria-hidden="true" />
          <motion.div key="sheet" ref={ref} className={`calm-sheet ${kind}`} role="dialog" aria-modal="true" tabIndex={-1}
            aria-labelledby={title ? id : undefined} aria-label={title ? undefined : label}
            style={width ? ({ '--calm-sheet-w': `${width}px` } as React.CSSProperties) : undefined} {...motionProps}>
            <span className="calm-sheet-grab" aria-hidden="true" />
            <div className="calm-sheet-head">
              <div>{title && <h3 id={id}>{title}</h3>}{sub && <p>{sub}</p>}</div>
              {actions}
              <button type="button" className="calm-sheet-close" onClick={onClose} aria-label="Close"><Icon name="close" size={14} /></button>
            </div>
            <div className="calm-sheet-body">{children}</div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}
