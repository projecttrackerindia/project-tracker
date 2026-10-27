import { useEffect, useState, type ReactNode } from 'react';
import './toolbarSlot.css';
import { createPortal } from 'react-dom';

/**
 * Puts a page's title (and, for Calendar, its Day · Week · Month switch) into the shell's toolbar on wide screens, as the designs draw it:
 * the title at the left, the switch just before the Ask field. The toolbar itself is not changed; the pieces are ordered with CSS.
 * Below 1100px the toolbar is hidden, and pages show their own head instead.
 */
export function ToolbarSlot({ title, children }: { title: ReactNode; children?: ReactNode }) {
  const [bar, setBar] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const find = () => document.querySelector<HTMLElement>('.v2-tb');
    const el = find();
    if (el) { setBar(el); return; }
    const t = window.setInterval(() => { const e = find(); if (e) { setBar(e); window.clearInterval(t); } }, 100);
    return () => window.clearInterval(t);
  }, []);
  if (!bar) return null;
  return createPortal(
    <>
      <span className="tb-slot-title">{title}</span>
      {children && <span className="tb-slot-tools">{children}</span>}
    </>,
    bar,
  );
}
