import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Face } from '../Face';
import { projectColor } from '../../lib/calm';
import './calm-kit.css';

/**
 * A split calm screen: the main column (flex) and the right rail of small cards. On a phone (and below 900px) the rail drops under the
 * main column as one single column, so nothing is hidden and nothing scrolls sideways.
 */
export function CalmSplit({ children, rail, className = '', crumb, label }: { children: ReactNode; rail?: ReactNode; className?: string; crumb?: ReactNode; label?: string }) {
  return (
    <div className={`calm-split ${className}`.trim()} aria-label={label}>
      <div className="calm-split-main">{crumb && <div className="calm-page-crumb calm-split-crumb">{crumb}</div>}{children}</div>
      {rail && <aside className="calm-rail" aria-label="Details">{rail}</aside>}
    </div>
  );
}

/** One card in the rail: a quiet heading ("This week", with an optional link on the right) over rows. */
export function CalmRailCard({ title, aside, children, className = '', tone, link, to, onLink, label }: {
  title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; tone?: 'tip';
  /** A "›" link on the right of the heading: a route (`to`) or an action (`onLink`). */ link?: ReactNode; to?: string; onLink?: () => void; label?: string;
}) {
  if (link && !aside) aside = to ? <Link to={to}>{link}</Link> : <button type="button" onClick={onLink}>{link}</button>;
  return (
    <section className={`calm-rc${tone ? ` ${tone}` : ''} ${className}`.trim()} aria-label={label ?? (typeof title === 'string' ? title : undefined)}>
      {(title || aside) && <h4>{title}{aside && <span className="calm-rc-aside">{aside}</span>}</h4>}
      {children}
    </section>
  );
}

/** A row in a rail card: an optional lead (icon tile, avatar), a title with a quiet line under it, and a value on the right. */
export function CalmRailRow({ lead, title, sub, right, onClick, className = '', hot, to, label }: {
  lead?: ReactNode; title: ReactNode; sub?: ReactNode; right?: ReactNode; onClick?: () => void; className?: string; hot?: boolean; to?: string; label?: string;
}) {
  const body = <>{lead}<span className="calm-rr-t">{title}{sub && <small>{sub}</small>}</span>{right != null && <span className={`calm-rr-r${hot ? ' hot' : ''}`}>{right}</span>}</>;
  const cls = `calm-rr ${className}`.trim();
  if (to) return <Link to={to} className={cls} aria-label={label}>{body}</Link>;
  return onClick ? <button type="button" className={cls} onClick={onClick} aria-label={label}>{body}</button> : <div className={cls} aria-label={label}>{body}</div>;
}

/** A person: their photo, or their initials on a stable colour (the same person is always the same colour). */
export function CalmAvatar({ userId, name, size = 's' }: { userId?: string | null; name?: string | null; size?: 's' | 'm' }) {
  const style = { '--calm-av': projectColor(userId ?? name ?? '') } as CSSProperties;
  return <Face userId={userId ?? undefined} name={name ?? ''} className={`calm-av ${size}`} style={style} />;
}

/** A coloured 4px bar in front of a meeting row (the meeting's project colour). */
export function CalmBar({ color }: { color?: string | null }) {
  return <span className="calm-rr-bar" aria-hidden="true" style={color ? ({ '--calm-dot': color } as CSSProperties) : undefined} />;
}

/** Initials in a coloured circle at any size, for names without a user id (comments, waiting rows). */
export function CalmAv({ name, size = 26 }: { name: string; size?: number }) {
  const ini = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?';
  return <span className="calm-av" title={name} aria-hidden="true" style={{ width: size, height: size, fontSize: size * 0.38, '--calm-av': projectColor(name) } as CSSProperties}>{ini}</span>;
}
