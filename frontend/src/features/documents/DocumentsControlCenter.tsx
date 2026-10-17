import type { CSSProperties } from 'react';
import { documentApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { ErrorState } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import type { DocumentsView } from './DocumentsSidebar';

/** Per-status accent, same hues `DocStatusBadge` uses - the distribution bar and the badges read as one language. */
const STATUS_COLOR: Record<string, string> = {
  Draft: 'var(--ds-faint)', InReview: 'var(--ds-info)', ChangesRequested: 'var(--ds-warn)',
  Approved: 'var(--ds-accent)', Published: 'var(--ds-success)', Archived: 'var(--ds-faint)',
};

/**
 * The top of the Documents landing page, in DocTracker's control-center style: a hero with the published share, a grid of KPI cards
 * (each one a shortcut to the view that lists those documents), the status mix and the mix by type. The list of documents itself is the
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
  const health = pct >= 75 ? 'good' : pct >= 40 ? 'warn' : 'bad';
  const kpis: { label: string; value: number; sub?: string; tone: string; view?: DocumentsView }[] = [
    { label: 'Documents', value: d.total, tone: 'neutral', view: 'all' },
    { label: 'Mine', value: d.mine, sub: 'owned by you', tone: 'info', view: 'mine' },
    { label: 'Waiting for me', value: d.waitingForMe, sub: d.waitingForMe ? 'reviews and access requests' : 'nothing to do', tone: d.waitingForMe ? 'warn' : 'neutral', view: 'inbox' },
    { label: 'Not published', value: d.unpublished, sub: 'draft changes not released', tone: d.unpublished ? 'accent' : 'neutral' },
    { label: 'Updated this week', value: d.updatedThisWeek, tone: 'good' },
    { label: 'Untouched 90+ days', value: d.notUpdatedIn90Days, sub: d.notUpdatedIn90Days ? 'may be out of date' : 'all fresh', tone: d.notUpdatedIn90Days ? 'bad' : 'neutral' },
  ];
  const typeMax = Math.max(1, ...d.byType.map((t) => t.count));

  return (
    <section className="ds-cc" aria-label="Documents control center">
      <div className="ds-hero">
        <div className={`ds-hero-icon ${health}`}><Icon name="layers" size={24} /></div>
        <div className="ds-hero-copy">
          <h2>What&apos;s happening with your documents</h2>
          <p>A live rollup of {d.total.toLocaleString()} {d.total === 1 ? 'document' : 'documents'} across every project and team you can see.</p>
        </div>
        <div className="ds-hero-stat"><b className={health}>{pct}%</b><span>published</span></div>
      </div>

      <div className="ds-kpis">
        {kpis.map((k) => {
          const body = (
            <>
              <span className="ds-kpi-label">{k.label}</span>
              <span className="ds-kpi-value"><i className="ds-dot" />{k.value.toLocaleString()}</span>
              {k.sub && <span className="ds-kpi-sub">{k.sub}{k.view && ' — click to open'}</span>}
            </>
          );
          return k.view ? (
            <button type="button" key={k.label} className={`ds-kpi tone-${k.tone} link`} onClick={() => onView(k.view!)}>{body}</button>
          ) : <div key={k.label} className={`ds-kpi tone-${k.tone}`}>{body}</div>;
        })}
      </div>

      <div className="ds-split">
        <div className="ds-card">
          <div className="ds-section-title">Status <span>— where every document stands</span></div>
          <div className="ds-bar" aria-hidden="true">
            {d.byStatus.filter((s) => s.count > 0).map((s) => <span key={s.key} title={`${s.label}: ${s.count}`} style={{ flexGrow: s.count, background: STATUS_COLOR[s.key] ?? 'var(--ds-faint)' }} />)}
          </div>
          <ul className="ds-legend">
            {d.byStatus.map((s) => (
              <li key={s.key}><i style={{ background: STATUS_COLOR[s.key] ?? 'var(--ds-faint)' } as CSSProperties} />{s.label}<b>{s.count}</b></li>
            ))}
          </ul>
        </div>
        <div className="ds-card">
          <div className="ds-section-title">By type <span>— what kind of documentation you keep</span></div>
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
