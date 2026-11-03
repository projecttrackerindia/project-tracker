import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import './calm-split.css';

/**
 * A full-width calm screen with a right panel: the main column takes the room left of a 340px rail (Today, My work, a project). On a
 * phone the rail drops under the main column as ordinary cards, so nothing is hidden and nothing scrolls sideways.
 */
export function CalmSplit({ children, rail, crumb, className = '', label }: { children: ReactNode; rail?: ReactNode; crumb?: ReactNode; className?: string; label?: string }) {
  return (
    <div className={`calm-split ${rail ? '' : 'solo'} ${className}`.replace(/\s+/g, ' ').trim()} aria-label={label}>
      <div className="calm-split-main">
        {crumb && <div className="calm-page-crumb calm-split-crumb">{crumb}</div>}
        {children}
      </div>
      {rail && <aside className="calm-split-rail" aria-label="Details">{rail}</aside>}
    </div>
  );
}

/** One card of the right panel: a quiet title, an optional "All ›" link, then rows. */
export function CalmRailCard({ title, link, to, onLink, children, className = '', label }: {
  title?: ReactNode; link?: ReactNode; to?: string; onLink?: () => void; children: ReactNode; className?: string; label?: string;
}) {
  return (
    <section className={`calm-rc ${className}`.trim()} aria-label={label ?? (typeof title === 'string' ? title : undefined)}>
      {(title || link) && (
        <h4 className="calm-rc-h">
          <span>{title}</span>
          {link && (to ? <Link to={to}>{link}</Link> : <button type="button" onClick={onLink}>{link}</button>)}
        </h4>
      )}
      {children}
    </section>
  );
}

/** A rail row: a lead (avatar, ring, bar), the title with a quiet second line, and a right value (red when `hot`). */
export function CalmRailRow({ lead, title, sub, right, hot, to, onClick, label }: {
  lead?: ReactNode; title: ReactNode; sub?: ReactNode; right?: ReactNode; hot?: boolean; to?: string; onClick?: () => void; label?: string;
}) {
  const body = (
    <>
      {lead}
      <span className="calm-rr-t"><b>{title}</b>{sub && <small>{sub}</small>}</span>
      {right != null && <span className={`calm-rr-r${hot ? ' hot' : ''}`}>{right}</span>}
    </>
  );
  if (to) return <Link className="calm-rr" to={to} aria-label={label}>{body}</Link>;
  if (onClick) return <button type="button" className="calm-rr" onClick={onClick} aria-label={label}>{body}</button>;
  return <div className="calm-rr" aria-label={label}>{body}</div>;
}

/** A coloured 4px bar in front of a meeting row (the meeting's project colour). */
export function CalmBar({ color }: { color?: string | null }) {
  return <span className="calm-rr-bar" aria-hidden="true" style={color ? ({ '--calm-dot': color } as CSSProperties) : undefined} />;
}

/** Initials in a coloured circle: the calm avatar when there is no photo. */
export function CalmAv({ name, size = 26, color }: { name: string; size?: number; color?: string }) {
  const ini = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?';
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const tints = ['#0a84ff', '#30b158', '#af52de', '#ff9500', '#ff2d55', '#5856d6', '#14b8a6'];
  return <span className="calm-av" title={name} aria-hidden="true" style={{ width: size, height: size, fontSize: size * 0.38, background: color ?? tints[h % tints.length] }}>{ini}</span>;
}
