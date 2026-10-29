import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { SheetRow } from './portfolioApi';
import { noteParts, STATUS_LABEL, statusKey, type StatusKey } from './planSheetQuery';

export const initials = (n: string | null | undefined) => (n ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
const HUES = [14, 245, 190, 330, 140, 44, 212, 280];
export const hue = (id: string | null | undefined) => HUES[[...(id ?? '')].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];
export const personColor = (id: string | null | undefined) => `hsl(${hue(id)} 62% 56%)`;

export function Av({ id, name, size = 20 }: { id: string | null | undefined; name: string | null | undefined; size?: number }) {
  return <span className="ps3-av" aria-hidden="true" title={name ?? undefined} style={{ '--h': hue(id), width: size, height: size, fontSize: Math.round(size * 0.42) } as CSSProperties}>{initials(name)}</span>;
}
export function Owner({ id, name, first }: { id: string | null; name: string | null; first?: boolean }) {
  if (!name) return <span className="ps3-dim">—</span>;
  return <span className="ps3-own"><Av id={id} name={name} /><span>{first ? name.split(' ')[0] : name}</span></span>;
}
export const toneVar: Record<StatusKey, string> = { done: 'var(--p-green)', late: 'var(--p-red)', risk: 'var(--p-orange)', prog: 'var(--p-blue)', todo: 'var(--p-ink2)' };
export const Dot = ({ k }: { k: StatusKey }) => <span className={`ps3-gl ${k}`} aria-hidden="true" />;
export function Status({ r }: { r: SheetRow }) {
  const k = statusKey(r);
  return <span className="ps3-st" title={r.status}><Dot k={k} />{STATUS_LABEL[k]}</span>;
}
export function Progress({ value, k }: { value: number | null; k: StatusKey }) {
  const v = value ?? 0;
  return <div className="ps3-pb"><div className="bar"><b style={{ width: `${v}%`, background: toneVar[k] }} /></div><span className="pct">{value == null ? '—' : `${v}%`}</span></div>;
}
export function Ring({ pct, color, size = 14 }: { pct: number; color: string; size?: number }) {
  return <span className="ps3-ring" aria-hidden="true" style={{ width: size, height: size, background: `conic-gradient(${color} 0 ${pct}%, var(--p-fill) 0)` }} />;
}
/** A note with @mentions in blue and links that open in a new tab. */
export function NoteText({ text }: { text: string }) {
  return <>{noteParts(text).map((p, i) => p.t === 'mention' ? <span key={i} className="ps3-mention">{p.v}</span>
    : p.t === 'link' ? <a key={i} href={p.v} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>{linkLabel(p.v)} ↗</a> : <span key={i}>{p.v}</span>)}</>;
}
const linkLabel = (u: string) => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname).replace(/\/$/, '').slice(0, 32); } catch { return u; } };

/**
 * A frosted panel floating by its anchor (below it, or above when there is no room), in a portal so the grid's scroll never clips it. Closes on a
 * click outside (not on the anchor) and on Esc.
 */
export function Floating({ anchor, onClose, width, children, className = '', label, role = 'dialog', place = 'below', style }: {
  anchor: HTMLElement | DOMRect | null; onClose: () => void; width: number; children: ReactNode; className?: string; label: string; role?: string; place?: 'below' | 'right' | 'above'; style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const close = useRef(onClose); close.current = onClose;
  useLayoutEffect(() => {
    const place0 = () => {
      const el = ref.current; if (!el || !anchor) return;
      const r = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor;
      const h = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
      let left = place === 'right' ? r.right + 8 : r.left, top = place === 'right' ? r.top + r.height / 2 - h / 2 : place === 'above' ? r.top - h - 8 : r.bottom + 6;
      if (place === 'right' && left + width > vw - 8) left = r.left - width - 8;
      if (place === 'below' && top + h > vh - 8) top = Math.max(8, r.top - h - 6);
      if (top + h > vh - 8) top = Math.max(8, vh - h - 8);
      if (top < 8) top = 8;
      left = Math.max(8, Math.min(left, vw - width - 8));
      setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }));
    };
    place0();
    const ro = new ResizeObserver(place0); if (ref.current) ro.observe(ref.current);
    window.addEventListener('resize', place0);
    return () => { ro.disconnect(); window.removeEventListener('resize', place0); };
  }, [anchor, width, place]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (anchor instanceof HTMLElement && anchor.contains(t)) return;
      if ((t as HTMLElement).closest?.('.ps3-float')) return;
      close.current();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close.current(); } };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key, true); };
  }, [anchor]);
  return createPortal(
    <div ref={ref} role={role} aria-label={label} className={`ps3-float ps3-pop ${className}`} style={{ width, left: pos?.left ?? -9999, top: pos?.top ?? -9999, ...style }}>{children}</div>,
    document.body,
  );
}
