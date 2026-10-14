import { useMemo, useState } from 'react';
import type { CSSProperties, MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { documentApi } from '../../api/endpoints';
import type { DocumentItem } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Avatar, EmptyState, ErrorState, PageLoader, Progress } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { useDebounced, useWsQuery } from '../../lib/hooks';
import { DocStatusBadge, TypeChip } from './docUi';

type SortKey = 'title' | 'type' | 'status' | 'owner' | 'updated';
type SortState = { key: SortKey; dir: 1 | -1 };

/** Per-status accent, same hues `DocStatusBadge` already uses - keeps the distribution bar and the badges reading as one language. */
const STATUS_COLOR: Record<string, string> = {
  Draft: 'var(--text-3)', InReview: 'var(--info)', ChangesRequested: 'var(--warning)',
  Approved: 'var(--success)', Published: 'var(--success)', Archived: 'var(--text-3)',
};

function sortRows(items: DocumentItem[], { key, dir }: SortState): DocumentItem[] {
  const by = (f: (d: DocumentItem) => string | number) => [...items].sort((a, b) => {
    const av = f(a), bv = f(b);
    return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
  });
  switch (key) {
    case 'title': return by((d) => d.title.toLowerCase());
    case 'type': return by((d) => d.typeName.toLowerCase());
    case 'status': return by((d) => d.status);
    case 'owner': return by((d) => d.owner.name.toLowerCase());
    case 'updated': default: return by((d) => d.updatedAt);
  }
}

function SortHead({ label, sortKey, sort, onSort }: { label: string; sortKey: SortKey; sort: SortState; onSort: (k: SortKey) => void }) {
  const active = sort.key === sortKey;
  return (
    <th aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
      <button type="button" onClick={() => onSort(sortKey)}>
        {label}
        {active && <Icon name={sort.dir === 1 ? 'chevronD' : 'chevronD'} size={11} style={sort.dir === 1 ? { transform: 'rotate(180deg)' } : undefined} />}
      </button>
    </th>
  );
}

/**
 * The Documents landing page: a hero banner, a KPI card grid and a "by status" bar built from `documentApi.dashboard()`
 * (the same numbers `DocumentOverview` showed, restyled), plus a searchable, sortable documents table.
 *
 * The table's data source is a FRESH `documentApi.list()` call, not the dashboard's `recent` array: the backend
 * (`DocumentDashboardService.GetAsync`) caps `recent` at 5 items on purpose - a "recently touched" strip, not a
 * browsable table. `list()` with no filters returns the workspace's documents in the server's own "recently
 * updated first" order (confirmed in `DocumentList.tsx`'s comment), so a plain, unfiltered call here is a real table.
 */
export function DocumentsControlCenter() {
  const dash = useWsQuery(['documents', 'dashboard'], documentApi.dashboard);
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortState>({ key: 'updated', dir: -1 });
  const dq = useDebounced(q.trim(), 300);
  const table = useWsQuery(['documents', 'control-center-table', dq], () => documentApi.list({ q: dq || undefined, limit: 25 }));

  const rows = useMemo(() => sortRows(table.data?.items ?? [], sort), [table.data, sort]);
  const onSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  const rowClick = (id: string) => (e: MouseEvent<HTMLTableRowElement>) => {
    if ((e.target as HTMLElement).closest('a')) return;   // the title's own <Link> already navigated
    nav(`/documents/${id}`);
  };

  const d = dash.data;
  if (dash.isLoading) return <PageLoader />;
  if (dash.isError) return <ErrorState error={dash.error} retry={() => dash.refetch()} />;
  if (!d || d.total === 0) return null;

  const published = d.total - d.unpublished;
  const publishedPct = Math.round((published / d.total) * 100);
  const health = publishedPct >= 75 ? 'good' : publishedPct >= 40 ? 'warn' : 'bad';

  // Same "is this concerning" rule `DocumentOverview` used: only waitingForMe and notUpdatedIn90Days ever warn.
  const kpis: { label: string; value: number; warn: boolean; accent: string }[] = [
    { label: d.total === 1 ? 'document' : 'documents', value: d.total, warn: false, accent: 'var(--primary)' },
    { label: 'mine', value: d.mine, warn: false, accent: 'var(--info)' },
    { label: 'waiting for me', value: d.waitingForMe, warn: d.waitingForMe > 0, accent: d.waitingForMe > 0 ? 'var(--warning)' : 'var(--text-3)' },
    { label: 'not published', value: d.unpublished, warn: false, accent: 'var(--purple)' },
    { label: 'updated this week', value: d.updatedThisWeek, warn: false, accent: 'var(--success)' },
    { label: 'untouched for 90 days', value: d.notUpdatedIn90Days, warn: d.notUpdatedIn90Days > 0, accent: d.notUpdatedIn90Days > 0 ? 'var(--danger)' : 'var(--text-3)' },
  ];

  return (
    <section className="cc" aria-label="Documents control center">
      <div className="cc-hero">
        <div className={`cc-hero-icon ${health}`}><Icon name="layers" size={26} /></div>
        <div className="cc-hero-main">
          <h2>What&apos;s happening with your documents</h2>
          <p>{d.total.toLocaleString()} {d.total === 1 ? 'document' : 'documents'} across every project and team you can see.</p>
        </div>
        <div className="cc-hero-stat">
          <b>{publishedPct}%</b>
          <span>published</span>
          <Progress value={publishedPct} tone="auto" />
        </div>
      </div>

      <div className="cc-kpi-grid" aria-label="Key numbers">
        {kpis.map((k) => (
          <div className={`cc-kpi${k.warn ? ' warn' : ''}`} style={{ '--accent': k.accent } as CSSProperties} key={k.label}>
            <span className="cc-kpi-label">{k.label}</span>
            <span className="cc-kpi-value">{k.value.toLocaleString()}</span>
          </div>
        ))}
      </div>

      <div className="cc-status">
        <div className="cc-status-head"><span>By status</span></div>
        <div className="cc-status-bar" aria-hidden="true">
          {d.byStatus.map((s) => <span key={s.key} title={`${s.label}: ${s.count}`} style={{ flexGrow: s.count, background: STATUS_COLOR[s.key] ?? 'var(--text-3)' }} />)}
        </div>
        <div className="cc-status-legend">
          {d.byStatus.map((s) => (
            <span key={s.key}><span className="dot" style={{ background: STATUS_COLOR[s.key] ?? 'var(--text-3)' }} />{s.label} <b>{s.count}</b></span>
          ))}
        </div>
      </div>

      <div className="cc-table-head">
        <h3>Documents</h3>
        <div className="cc-table-search"><Icon name="search" size={15} /><input className="input" type="search" placeholder="Search titles, text and tags, or DOC-12…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search documents" /></div>
      </div>
      <div className="cc-table-wrap">
        {table.isLoading ? <PageLoader /> : table.isError ? <ErrorState error={table.error} retry={() => table.refetch()} /> : rows.length === 0 ? (
          <EmptyState icon="note" title={dq ? 'No documents match' : 'No documents yet'} text={dq ? 'Try a different word.' : 'Write a document and it will show up here.'} />
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <SortHead label="Title" sortKey="title" sort={sort} onSort={onSort} />
                <SortHead label="Type" sortKey="type" sort={sort} onSort={onSort} />
                <SortHead label="Status" sortKey="status" sort={sort} onSort={onSort} />
                <SortHead label="Owner" sortKey="owner" sort={sort} onSort={onSort} />
                <SortHead label="Updated" sortKey="updated" sort={sort} onSort={onSort} />
              </tr>
            </thead>
            <tbody>
              {rows.map((doc) => (
                <tr key={doc.id} onClick={rowClick(doc.id)}>
                  <td>
                    <div className="cc-table-title-cell">
                      <TypeChip doc={doc} size={24} />
                      <span>
                        <span className="cc-table-key">{doc.key}</span>
                        <Link className="cc-table-title" to={`/documents/${doc.id}`}>{doc.title}</Link>
                      </span>
                    </div>
                  </td>
                  <td>{doc.typeName}</td>
                  <td><DocStatusBadge status={doc.status} /></td>
                  <td><span className="cc-table-owner"><Avatar name={doc.owner.name} userId={doc.owner.id} /> {doc.owner.name}</span></td>
                  <td className="muted">{timeAgo(doc.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
