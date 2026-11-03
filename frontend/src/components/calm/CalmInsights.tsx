import { Fragment, type ReactNode } from 'react';
import './calm-kit.css';

export type CalmInsight = { key: string; label: ReactNode; onClick?: () => void; href?: string };

/** The underlined insight line ("3h 45m of 7h logged · 2 overdue · Focus 74"), each fact a quiet dotted-underlined link. */
export function CalmInsights({ items, label = 'Insights' }: { items: CalmInsight[]; label?: string }) {
  if (!items.length) return null;
  return (
    <div className="calm-ins" role="group" aria-label={label}>
      {items.map((x, i) => (
        <Fragment key={x.key}>
          {i > 0 && <i aria-hidden="true">·</i>}
          {x.href ? <a href={x.href}>{x.label}</a> : <button type="button" onClick={x.onClick}>{x.label}</button>}
        </Fragment>
      ))}
    </div>
  );
}

/** The foot of a calm screen: the insight line above the Aura sentence. */
export function CalmFoot({ children }: { children: ReactNode }) { return <footer className="calm-foot">{children}</footer>; }
