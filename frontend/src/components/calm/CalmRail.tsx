import type { CSSProperties, ReactNode } from 'react';
import { Face } from '../Face';
import { projectColor } from '../../lib/calm';
import './calm-kit.css';

/**
 * A split calm screen: the main column (flex) and the right rail of small cards. On a phone (and below 1100px) the rail drops under the
 * main column as one single column, so nothing is hidden and nothing scrolls sideways.
 */
export function CalmSplit({ children, rail, className = '' }: { children: ReactNode; rail?: ReactNode; className?: string }) {
  return (
    <div className={`calm-split ${className}`.trim()}>
      <div className="calm-split-main">{children}</div>
      {rail && <aside className="calm-rail" aria-label="Details">{rail}</aside>}
    </div>
  );
}

/** One card in the rail: a quiet heading ("This week", with an optional link on the right) over rows. */
export function CalmRailCard({ title, aside, children, className = '', tone }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; tone?: 'tip' }) {
  return (
    <section className={`calm-rc${tone ? ` ${tone}` : ''} ${className}`.trim()}>
      {(title || aside) && <h4>{title}{aside && <span className="calm-rc-aside">{aside}</span>}</h4>}
      {children}
    </section>
  );
}

/** A row in a rail card: an optional lead (icon tile, avatar), a title with a quiet line under it, and a value on the right. */
export function CalmRailRow({ lead, title, sub, right, onClick, className = '' }: { lead?: ReactNode; title: ReactNode; sub?: ReactNode; right?: ReactNode; onClick?: () => void; className?: string }) {
  const body = <>{lead}<span className="calm-rr-t">{title}{sub && <small>{sub}</small>}</span>{right != null && <span className="calm-rr-r">{right}</span>}</>;
  return onClick ? <button type="button" className={`calm-rr ${className}`.trim()} onClick={onClick}>{body}</button> : <div className={`calm-rr ${className}`.trim()}>{body}</div>;
}

/** A person: their photo, or their initials on a stable colour (the same person is always the same colour). */
export function CalmAvatar({ userId, name, size = 's' }: { userId?: string | null; name?: string | null; size?: 's' | 'm' }) {
  const style = { '--calm-av': projectColor(userId ?? name ?? '') } as CSSProperties;
  return <Face userId={userId ?? undefined} name={name ?? ''} className={`calm-av ${size}`} style={style} />;
}
