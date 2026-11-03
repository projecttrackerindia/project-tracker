import { COLOURS } from './planSheetTabs';
import './portfolioShell.css';

/** The one loading state for every tab: tinted project cards with shimmering rows, in the Plan sheet's shapes. */
export function PortfolioSkeleton({ label = 'Loading the portfolio', cards = 3 }: { label?: string; cards?: number }) {
  return (
    <div className="pfx-skel" role="status" aria-label={label} aria-busy="true">
      {Array.from({ length: cards }, (_, i) => (
        <div key={i} className={`pfx-skel-card pc-${COLOURS[i % COLOURS.length]}`}>
          <i className="h" />{[0, 1, 2].map((j) => <i key={j} className="r" style={{ width: `${88 - j * 14}%` }} />)}
        </div>
      ))}
    </div>
  );
}
