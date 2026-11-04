/** A calm loading state: the page's shape (a title, then rows) breathing softly, so nothing jumps when the data lands. No spinner. */
export function CalmSkeleton({ rows = 5, title = true, label = 'Loading' }: { rows?: number; title?: boolean; label?: string }) {
  return (
    <div className="calm-skel" role="status" aria-label={label} aria-busy="true">
      {title && <><i className="calm-skel-t" /><i className="calm-skel-t2" /></>}
      <div className="calm-skel-card">{Array.from({ length: rows }, (_, i) => <i key={i} className="calm-skel-row" style={{ animationDelay: `${i * 60}ms` }} />)}</div>
    </div>
  );
}
