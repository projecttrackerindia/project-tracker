import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, useDragControls, useReducedMotion } from 'framer-motion';
import { Icon } from '../Icon';
import { spring } from '../../lib/motion';
import type { SaveState } from './state';
import './v2.css';

/**
 * The v2 right-hand panel: an item opens here instead of a pop-up form. Changes save as you go, so there is no Save / Cancel / Delete footer;
 * the head says "Saving…" / "Saved" instead. Esc, the close button or a click on the page beside it closes it.
 *
 * `docked`: the panel sits beside the page instead of over it (no scrim, the page makes room for it on wide screens), so the list it was
 * opened from stays readable and clickable: another row opens in the same panel. On a phone it still fills the screen.
 */
export function SidePanel({ title, eyebrow, ai, state = 'idle', width, flush, docked, actions, onClose, children, label }: {
  title: ReactNode; eyebrow?: ReactNode; /** The AI is talking (the copilot): the eyebrow is violet. */ ai?: boolean; state?: SaveState; width?: number;
  /** The body has no padding of its own (a conversation that scrolls by itself). */ flush?: boolean; docked?: boolean;
  /** Small controls beside the close button (a "···" menu). */ actions?: ReactNode; onClose: () => void; children: ReactNode; label?: string;
}) {
  const close = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    opener.current = document.activeElement as HTMLElement | null;
    close.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); closeRef.current(); } };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); const el = opener.current; if (el?.isConnected) el.focus({ preventScroll: true }); };
  }, []);
  // A docked panel: the page beside it makes room (see .v2-panel-docked in v2.css).
  useEffect(() => {
    if (!docked) return;
    const root = document.documentElement;
    root.classList.add('v2-panel-docked');
    root.style.setProperty('--v2-docked-w', `${width ?? 520}px`);
    return () => { root.classList.remove('v2-panel-docked'); root.style.removeProperty('--v2-docked-w'); };
  }, [docked, width]);
  const drag = useDragControls();
  const still = useReducedMotion();
  return createPortal(
    <>
      {!docked && <div className="v2-panel-scrim" onMouseDown={onClose} aria-hidden="true" />}
      <motion.aside className={`v2-panel ${docked ? 'docked' : ''}`}
        initial={still ? { opacity: 0 } : { x: 48, opacity: 0 }} animate={{ x: 0, opacity: 1 }} transition={still ? { duration: 0 } : spring.panel}
        // Drag the head to the right (past 120px) to close; the body keeps its own scrolling and text selection.
        drag={still ? false : 'x'} dragListener={false} dragControls={drag} dragConstraints={{ left: 0, right: 0 }} dragElastic={{ left: 0, right: 0.9 }} dragMomentum={false}
        onDragEnd={(_, info) => { if (info.offset.x > 120) closeRef.current(); }}
        role={docked ? 'complementary' : 'dialog'} aria-modal={docked ? undefined : true}
        aria-label={label ?? (typeof title === 'string' ? title : undefined)} style={width ? ({ '--panel-w': `${width}px` } as CSSProperties) : undefined}>
        <header className="v2-panel-head" onPointerDown={(e) => { if (!(e.target as HTMLElement).closest('button, a, input, select, textarea')) drag.start(e); }}>
          <div>{eyebrow && <span className={`v2-panel-eyebrow ${ai ? 'ai' : ''}`}>{eyebrow}</span>}<h2>{title}</h2></div>
          {state !== 'idle' && <span className={`v2-panel-state ${state}`} role="status">{state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : 'Not saved'}</span>}
          {actions && <span className="v2-panel-actions">{actions}</span>}
          <button ref={close} type="button" className="v2-panel-close" aria-label="Close" onClick={onClose}><Icon name="close" size={16} /></button>
        </header>
        <div className={`v2-panel-body ${flush ? 'flush' : ''}`}>{children}</div>
      </motion.aside>
    </>,
    document.body,
  );
}
