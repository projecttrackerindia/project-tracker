import type { HTMLAttributes, ReactNode } from 'react';
import './calm-kit.css';

/**
 * A calm surface: frosted, no border, soft depth. `variant` hero (28px radius, roomy), list (tight padding for CalmRow lists), flush (no
 * padding) or tile (a quiet fill inside a sheet or card).
 */
export function CalmCard({ children, variant, title, aside, className = '', as: Tag = 'section', ...rest }: {
  children: ReactNode; variant?: 'hero' | 'list' | 'flush' | 'tile'; title?: ReactNode; aside?: ReactNode; className?: string; as?: 'section' | 'div' | 'article';
} & Omit<HTMLAttributes<HTMLElement>, 'title'>) {
  return (
    <Tag className={`calm-card ${variant ?? ''} ${className}`.replace(/\s+/g, ' ').trim()} {...rest}>
      {(title || aside) && <div className="calm-card-head">{title && <h3>{title}</h3>}{aside && <span className="calm-card-aside">{aside}</span>}</div>}
      {children}
    </Tag>
  );
}

/** A small section label above a card ("Milestones this week", with an optional link on the right). */
export function CalmSection({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return <div className="calm-sec"><span>{children}</span>{aside}</div>;
}
