import type { ReactNode } from 'react';
import './calm-kit.css';

/**
 * A calm screen: a centred column that fills the height of the page, so nothing is left as dead space below the content.
 * `layout="even"` spreads the sections evenly down the screen (Today), `center` centres a short page, `stack` (default) stacks with a 22px gap.
 * `width="wide"` (1100px) or `full` for split views; the default is the 860px reading column.
 */
export function CalmPage({ children, crumb, layout = 'stack', width = 'col', className = '', label }: {
  children: ReactNode; crumb?: ReactNode; layout?: 'stack' | 'even' | 'center'; width?: 'col' | 'wide' | 'full'; className?: string; label?: string;
}) {
  return (
    <div className={`calm-page ${layout === 'stack' ? '' : layout} ${width === 'col' ? '' : width} ${className}`.replace(/\s+/g, ' ').trim()} aria-label={label}>
      {crumb && <div className="calm-page-crumb">{crumb}</div>}
      <div className="calm-page-col">{children}</div>
    </div>
  );
}
