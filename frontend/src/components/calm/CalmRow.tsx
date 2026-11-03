import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../Icon';
import './calm-kit.css';

/** The project dot: the only place a project's colour appears in a row. */
export function CalmDot({ color, label }: { color?: string | null; label?: string }) {
  return <span className="calm-dot" style={color ? ({ '--calm-dot': color } as CSSProperties) : undefined} aria-label={label} aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} />;
}

/**
 * One row in a calm list: project dot, the title (with a quiet key after it), a right-hand value (red and bold when `hot`) and a chevron
 * when it leads somewhere. A link with `to`, a button with `onClick`, otherwise a plain row.
 */
export function CalmRow({ title, meta, right, hot, dot, to, onClick, selected, chevron, lead, className = '', label }: {
  title: ReactNode; meta?: ReactNode; right?: ReactNode; hot?: boolean; dot?: string | null; to?: string; onClick?: () => void;
  selected?: boolean; chevron?: boolean; lead?: ReactNode; className?: string; label?: string;
}) {
  const body = (
    <>
      {lead ?? (dot !== undefined && <CalmDot color={dot} />)}
      <span className="calm-row-t">{title}{meta && <small>{meta}</small>}</span>
      {right != null && <span className={`calm-row-r${hot ? ' hot' : ''}`}>{right}</span>}
      {(chevron ?? !!(to || onClick)) && <span className="calm-row-chev" aria-hidden="true"><Icon name="chevronR" size={14} /></span>}
    </>
  );
  const cls = `calm-row${selected ? ' sel' : ''} ${className}`.trim();
  if (to) return <Link to={to} className={cls} aria-label={label} aria-current={selected ? 'true' : undefined}>{body}</Link>;
  if (onClick) return <button type="button" className={cls} onClick={onClick} aria-label={label} aria-pressed={selected}>{body}</button>;
  return <div className={cls} aria-label={label}>{body}</div>;
}

/** A group label inside a list (a project's dot and name above its rows). */
export function CalmGroup({ children, dot }: { children: ReactNode; dot?: string | null }) {
  return <div className="calm-grp">{dot !== undefined && <CalmDot color={dot} />}{children}</div>;
}
