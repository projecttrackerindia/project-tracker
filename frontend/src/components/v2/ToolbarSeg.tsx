import { useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Puts a page's segmented control (Mine · Team · Automations, Queue · Mine · Solved…) at the left of the app toolbar on wide screens,
 * vertically centred in the 52px bar; where the toolbar is hidden (below 1100px, phone) it renders inline above the page instead.
 * Pages must not pull their own bar up under the sticky toolbar with negative margins - that is what clipped the control's top.
 */
export function ToolbarSeg({ children, className = '' }: { children: ReactNode; className?: string }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const find = () => { const el = document.querySelector<HTMLElement>('.v2-tb'); setHost(el && getComputedStyle(el).display !== 'none' ? el : null); };
    find();
    window.addEventListener('resize', find);
    return () => window.removeEventListener('resize', find);
  }, []);
  return host ? createPortal(<div className={`mw-tbslot ${className}`}>{children}</div>, host) : <div className={`mw-tbslot inline ${className}`}>{children}</div>;
}
