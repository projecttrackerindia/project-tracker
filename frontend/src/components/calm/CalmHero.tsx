import type { ReactNode } from 'react';
import './calm-kit.css';

/**
 * The headline of a calm screen: one large light sentence, a grey second line (inline, as in "Release Fri. / 2 blockers left.") and/or a
 * short subline, then at most one primary action (an ink pill) and one quiet link beside it.
 */
export function CalmHero({ title, second, sub, action, link, as: H = 'h1', className = '' }: {
  title: ReactNode; second?: ReactNode; sub?: ReactNode; action?: ReactNode; link?: ReactNode; as?: 'h1' | 'h2'; className?: string;
}) {
  return (
    <header className={`calm-hero ${className}`.trim()}>
      <H className="calm-hero-title">{title}{second && <em>{second}</em>}</H>
      {sub && <p className="calm-hero-sub">{sub}</p>}
      {(action || link) && <div className="calm-hero-acts">{action}{link}</div>}
    </header>
  );
}

/** The one primary action: an ink pill (green for "done"-type actions). Renders a button unless `href` is given. */
export function CalmGo({ children, onClick, href, tone, type = 'button', disabled }: {
  children: ReactNode; onClick?: () => void; href?: string; tone?: 'green'; type?: 'button' | 'submit'; disabled?: boolean;
}) {
  const cls = `calm-go${tone ? ` ${tone}` : ''}`;
  return href ? <a className={cls} href={href}>{children}</a> : <button type={type} className={cls} onClick={onClick} disabled={disabled}>{children}</button>;
}

/** The quiet secondary link beside the primary action. */
export function CalmLink({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return <button type="button" className="calm-link" onClick={onClick}>{children}</button>;
}
