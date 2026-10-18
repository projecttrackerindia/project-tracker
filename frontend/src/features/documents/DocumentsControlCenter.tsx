import type { CSSProperties } from 'react';
import { documentApi } from '../../api/endpoints';
import { ErrorState } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import type { DocumentsView } from './DocumentsSidebar';

/** Per-status accent, same hues `DocStatusBadge` uses - the distribution bar and the badges read as one language. */
const STATUS_COLOR: Record<string, string> = {
  Draft: 'var(--border-strong)', InReview: 'var(--info)', ChangesRequested: 'var(--warning)',
  Approved: 'var(--primary-fill)', Published: 'var(--success)', Archived: 'var(--text-3)',
};

/**
 * The top of the Documents landing page: one strip of headline numbers (the ones that are views are shortcuts to them), the status mix
 * and the mix by type. The list of documents itself is the
 * filterable list right below it - this component no longer renders a second table of the same documents.
 */
export function DocumentsControlCenter({ onView }: { onView: (v: DocumentsView) => void }) {
  const dash = useWsQuery(['documents', 'dashboard'], documentApi.dashboard);
  const d = dash.data;
  if (dash.isLoading) return <div className="ds-skeleton" aria-busy="true"><span /><span /><span /></div>;
  if (dash.isError) return <ErrorState error={dash.error} retry={() => dash.refetch()} />;
  if (!d || d.total === 0) return null;

  const published = d.total - d.unpublished;
  const pct = Math.round((published / d.total) * 100);
  const kpis: { label: string; value: number; sub: string; tone?: 'warn' | 'bad'; view?: DocumentsView }[] = [
    { label: 'All documents', value: d.total, sub: `${pct}% published`, view: 'all' },
    { label: 'Owned by me', value: d.mine, sub: 'Documents you own', view: 'mine' },
    { label: 'Waiting for me', value: d.waitingForMe, sub: d.waitingForMe ? 'Reviews and access requests' : 'Nothing to do', tone: d.waitingForMe ? 'warn' : undefined, view: 'inbox' },
    { label: 'Never published', value: d.unpublished, sub: 'Drafts not yet released', view: 'attention' },
    { label: 'Updated this week', value: d.updatedThisWeek, sub: 'Edited in the last 7 days' },
    { label: 'Not updated in 90 days', value: d.notUpdatedIn90Days, sub: d.notUpdatedIn90Days ? 'May be out of date' : 'Everything is current', tone: d.notUpdatedIn90Days ? 'bad' : undefined, view: 'attention' },
  ];
  const typeMax = Math.max(1, ...d.byType.map((t) => t.count));

  return (
    <section className="ds-cc" aria-label="Documents overview">
      <div className="ds-stats">
        {kpis.map((k) => {
          const body = (
            <>
              <span className="ds-stat-label">{k.label}</span>
              <span className={`ds-stat-value${k.tone ? ` ${k.tone}` : ''}`}>{k.value.toLocaleString()}</span>
              <span className="ds-stat-sub">{k.sub}</span>
            </>
          );
          return k.view
            ? <button type="button" key={k.label} className="ds-stat link" onClick={() => onView(k.view!)} title={`Show ${k.label.toLowerCase()}`}>{body}</button>
            : <div key={k.label} className="ds-stat">{body}</div>;
        })}
      </div>

      <div className="ds-split">
        <div className="ds-card">
          <div className="ds-card-head"><h3>Status</h3><span>Where every document stands</span></div>
          <div className="ds-bar" aria-hidden="true">
            {d.byStatus.filter((s) => s.count > 0).map((s) => <span key={s.key} title={`${s.label}: ${s.count}`} style={{ flexGrow: s.count, background: STATUS_COLOR[s.key] ?? 'var(--text-3)' }} />)}
          </div>
          <ul className="ds-legend">
            {d.byStatus.map((s) => (
              <li key={s.key}><i style={{ background: STATUS_COLOR[s.key] ?? 'var(--text-3)' } as CSSProperties} />{s.label}<b>{s.count}</b></li>
            ))}
          </ul>
        </div>
        <div className="ds-card">
          <div className="ds-card-head"><h3>By type</h3><span>What kind of documentation you keep</span></div>
          <ul className="ds-types">
            {d.byType.map((t) => (
              <li key={t.key}>
                <span className="ds-types-label">{t.label}</span>
                <span className="ds-track"><span style={{ width: `${(t.count / typeMax) * 100}%` }} /></span>
                <b>{t.count}</b>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
