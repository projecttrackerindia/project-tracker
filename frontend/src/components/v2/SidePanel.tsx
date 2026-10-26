import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../Icon';
import type { SaveState } from './state';
import './v2.css';

/**
 * The v2 right-hand panel: an item opens here instead of a pop-up form. Changes save as you go, so there is no Save / Cancel / Delete footer;
 * the head says "Saving…" / "Saved" instead. Esc, the close button or a click on the page beside it closes it.
 */
export function SidePanel({ title, eyebrow, ai, state = 'idle', width, flush, onClose, children, label }: {
  title: ReactNode; eyebrow?: ReactNode; /** The AI is talking (the copilot): the eyebrow is violet. */ ai?: boolean; state?: SaveState; width?: number;
  /** The body has no padding of its own (a conversation that scrolls by itself). */ flush?: boolean; onClose: () => void; children: ReactNode; label?: string;
}) {
  const close = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    opener.current = document.activeElement as HTMLElement | null;
    close.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); const el = opener.current; if (el?.isConnected) el.focus({ preventScroll: true }); };
  }, [onClose]);
  return createPortal(
    <>
      <div className="v2-panel-scrim" onMouseDown={onClose} aria-hidden="true" />
      <aside className="v2-panel" role="dialog" aria-modal="true" aria-label={label ?? (typeof title === 'string' ? title : undefined)} style={width ? ({ '--panel-w': `${width}px` } as CSSProperties) : undefined}>
        <header className="v2-panel-head">
          <div>{eyebrow && <span className={`v2-panel-eyebrow ${ai ? 'ai' : ''}`}>{eyebrow}</span>}<h2>{title}</h2></div>
          {state !== 'idle' && <span className="v2-panel-state" role="status">{state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : 'Not saved'}</span>}
          <button ref={close} type="button" className="v2-panel-close" aria-label="Close" onClick={onClose}><Icon name="close" size={16} /></button>
        </header>
        <div className={`v2-panel-body ${flush ? 'flush' : ''}`}>{children}</div>
      </aside>
    </>,
    document.body,
  );
}
