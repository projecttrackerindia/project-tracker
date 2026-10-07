import { documentApi } from '../../api/endpoints';
import { useWsQuery } from '../../lib/hooks';

/** The numbers over the documents this person may open (the same set the list shows). */
export function DocumentOverview() {
  const q = useWsQuery(['documents', 'dashboard'], documentApi.dashboard);
  const d = q.data;
  if (!d || d.total === 0) return null;
  const tiles: [string, number, boolean?][] = [['Documents', d.total], ['Mine', d.mine], ['Waiting for me', d.waitingForMe, d.waitingForMe > 0], ['Not published', d.unpublished], ['Updated this week', d.updatedThisWeek], ['Not updated in 90 days', d.notUpdatedIn90Days, d.notUpdatedIn90Days > 0]];
  return (
    <section className="doc-overview" aria-label="Documents overview">
      {tiles.map(([label, n, warn]) => <div key={label} className={`doc-stat${warn ? ' warn' : ''}`}><b>{n.toLocaleString()}</b><span>{label}</span></div>)}
      <div className="doc-stat-bars" aria-label="By status">
        {d.byStatus.map((s) => <span key={s.key} title={`${s.label}: ${s.count}`} style={{ flexGrow: s.count }} className={`st-${s.key.toLowerCase()}`} />)}
      </div>
    </section>
  );
}
