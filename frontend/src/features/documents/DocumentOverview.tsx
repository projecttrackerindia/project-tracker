import { documentApi } from '../../api/endpoints';
import { useWsQuery } from '../../lib/hooks';

/** The numbers over the documents this person may open (the same set the list shows). */
export function DocumentOverview() {
  const q = useWsQuery(['documents', 'dashboard'], documentApi.dashboard);
  const d = q.data;
  if (!d || d.total === 0) return null;
  const tiles: [string, number, boolean?][] = [[d.total === 1 ? 'document' : 'documents', d.total], ['mine', d.mine], ['waiting for me', d.waitingForMe, d.waitingForMe > 0], ['not published', d.unpublished], ['updated this week', d.updatedThisWeek], ['untouched for 90 days', d.notUpdatedIn90Days, d.notUpdatedIn90Days > 0]];
  return (
    <section className="doc-overview" aria-label="Documents overview">
      {tiles.map(([label, n, warn]) => <span key={label} className={`doc-stat${warn ? ' warn' : ''}`}><b>{n.toLocaleString()}</b>{label}</span>)}
      <div className="doc-stat-bars" aria-label="By status">
        {d.byStatus.map((s) => <span key={s.key} title={`${s.label}: ${s.count}`} style={{ flexGrow: s.count }} className={`st-${s.key.toLowerCase()}`} />)}
      </div>
    </section>
  );
}
