import { useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import { trustApi, type AuditFilter } from '../../api/endpoints';
import type { AuditLog } from '../../api/types';
import { CalmCard, CalmHero, CalmPicker, CalmPills, CalmRow, CalmSheet, type PickItem } from '../../components/calm';
import { Face } from '../../components/Face';
import { Icon } from '../../components/Icon';
import { EmptyState, ErrorState, PageLoader, Pager } from '../../components/ui';
import { formatDateTime, timeAgo } from '../../lib/format';
import { useDebounced, useWsQuery } from '../../lib/hooks';
import { useIsMobile } from '../../lib/mobile';
import { toast } from '../../stores/ui';
import { ChainBanner, VerifyChainButton } from '../activity/ActivityPages';
import './trust.css';

type Kind = '' | 'viewed' | 'exported' | 'changed' | 'signin' | 'security';
const KINDS: { value: Kind; label: string }[] = [
  { value: '', label: 'All' }, { value: 'viewed', label: 'Viewed' }, { value: 'exported', label: 'Exported' },
  { value: 'changed', label: 'Changed' }, { value: 'signin', label: 'Sign-ins' }, { value: 'security', label: 'Security' },
];

/** "vault.secret_revealed" → "Vault · secret revealed": the area, then what happened, in words. */
export function actionWords(action: string) {
  const [area, ...rest] = action.split('.');
  const what = rest.join(' ').replace(/_/g, ' ');
  const nice = area.replace(/_/g, ' ');
  return { area: nice.charAt(0).toUpperCase() + nice.slice(1), what: what || nice };
}

const pretty = (v: string | null) => {
  if (!v) return null;
  try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; }
};

/**
 * The admin's audit log: who viewed, exported or changed what. One sentence, the kind pills, then a single list; filters for person,
 * resource and dates sit in one quiet row (a sheet on the phone). A row opens its full record. "Export CSV" downloads what the filters show.
 */
export function AuditViewer() {
  const phone = useIsMobile();
  const [kind, setKind] = useState<Kind>('');
  const [userId, setUserId] = useState<string | null>(null);
  const [entityType, setEntityType] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [text, setText] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<AuditLog | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const q = useDebounced(text, 300);
  const filter: AuditFilter = { kind, userId: userId ?? undefined, entityType: entityType ?? undefined, from, to, q };
  const key = JSON.stringify(filter);
  const list = useWsQuery(['audit', 'viewer', key, page], () => trustApi.audit(filter, page), { placeholderData: (p) => p });
  const facets = useWsQuery(['audit', 'facets'], trustApi.auditFacets, { staleTime: 60_000 });
  const people: PickItem[] = useMemo(() => (facets.data?.people ?? []).map((p) => ({ id: p.id, label: p.name })), [facets.data]);
  const types: PickItem[] = useMemo(() => (facets.data?.entityTypes ?? []).map((t) => ({ id: t, label: t })), [facets.data]);
  const reset = (f: () => void) => { f(); setPage(1); };
  const active = [userId, entityType, from, to].filter(Boolean).length;

  const exportCsv = async () => {
    setExporting(true);
    try { await trustApi.auditCsv(filter); toast('Audit log exported. The export is recorded in the log.', 'success'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not export the audit log.', 'error'); }
    finally { setExporting(false); }
  };

  const filters = (
    <div className="tr-filters" data-testid="audit-filters">
      <CalmPicker label="Person" placeholder="Anyone" items={people} value={userId} allowClear onChange={(id) => reset(() => setUserId(id))} testId="audit-person" />
      <CalmPicker label="Resource" placeholder="Any resource" items={types} value={entityType} allowClear onChange={(id) => reset(() => setEntityType(id))} testId="audit-resource" />
      <label className="tr-date"><span>From</span><input type="date" value={from} max={to || undefined} onChange={(e) => reset(() => setFrom(e.target.value))} /></label>
      <label className="tr-date"><span>To</span><input type="date" value={to} min={from || undefined} onChange={(e) => reset(() => setTo(e.target.value))} /></label>
      {active > 0 && <button type="button" className="tr-link" onClick={() => reset(() => { setUserId(null); setEntityType(null); setFrom(''); setTo(''); })}>Clear</button>}
    </div>
  );

  const d = list.data;
  const total = d?.totalItems ?? 0;
  return (
    <div className="tr-page" data-testid="audit-viewer">
      <CalmHero title="Audit log." second={facets.data ? ` ${facets.data.total.toLocaleString()} events, chained and tamper-evident.` : ' Who viewed, exported or changed what.'}
        action={<span className="tr-actions"><VerifyChainButton />
          <button type="button" className="tr-btn" onClick={exportCsv} disabled={exporting} data-testid="audit-export"><Icon name="download" size={15} />{exporting ? 'Exporting…' : 'Export CSV'}</button></span>} />
      <ChainBanner />
      <div className="tr-bar">
        <CalmPills label="Kind of event" options={KINDS} value={kind} onChange={(v) => reset(() => setKind(v))} />
        <label className="tr-search"><Icon name="search" size={15} /><input placeholder="Search actions, people, IPs" value={text} onChange={(e) => reset(() => setText(e.target.value))} aria-label="Search the audit log" /></label>
        {phone ? <button type="button" className="tr-btn ghost" onClick={() => setFiltersOpen(true)} data-testid="audit-filters-open"><Icon name="filter" size={15} />Filters{active ? ` · ${active}` : ''}</button> : filters}
      </div>
      {phone && <CalmSheet open={filtersOpen} onClose={() => setFiltersOpen(false)} title="Filters" kind="bottom">{filters}</CalmSheet>}
      <CalmCard variant="list" aria-label="Audit events" className="tr-list">
        {list.isLoading ? <PageLoader /> : list.isError || !d ? <ErrorState error={list.error} retry={() => list.refetch()} /> : d.items.length === 0
          ? <EmptyState icon="shield" title="No events match" text="Try another kind, person or date range." />
          : d.items.map((l) => {
            const w = actionWords(l.action);
            return (
              <CalmRow key={l.id} onClick={() => setOpen(l)} label={`${l.userName ?? 'System'} ${w.what}`}
                lead={<Face userId={l.userId} name={l.userName ?? 'System'} className="calm-act-face" />}
                title={<><b>{l.userName ?? 'System'}</b> {w.what}</>}
                meta={<>{w.area} · {l.entityType}{l.ipAddress ? ` · ${l.ipAddress}` : ''}</>}
                right={<span title={formatDateTime(l.createdAt)}>{timeAgo(l.createdAt)}</span>} />
            );
          })}
        {d && <Pager page={d.page} totalPages={d.totalPages} totalItems={total} onPage={setPage} />}
      </CalmCard>
      <CalmSheet open={!!open} onClose={() => setOpen(null)} title={open ? actionWords(open.action).what : ''} sub={open ? formatDateTime(open.createdAt) : undefined} label="Audit event">
        {open && (
          <dl className="tr-detail" data-testid="audit-detail">
            <dt>Who</dt><dd>{open.userName ?? 'System'}</dd>
            <dt>Action</dt><dd><code>{open.action}</code></dd>
            <dt>Resource</dt><dd>{open.entityType}{open.entityId ? <small> · {open.entityId}</small> : null}</dd>
            <dt>IP address</dt><dd>{open.ipAddress ?? '—'}</dd>
            {open.oldValue && <><dt>Before</dt><dd><pre>{pretty(open.oldValue)}</pre></dd></>}
            {open.newValue && <><dt>After</dt><dd><pre>{pretty(open.newValue)}</pre></dd></>}
          </dl>
        )}
      </CalmSheet>
    </div>
  );
}
