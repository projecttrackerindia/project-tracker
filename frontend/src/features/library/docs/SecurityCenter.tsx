import { useState } from 'react';
import { Link } from 'react-router-dom';
import { docTrackerApi, insightApi } from '../../../api/endpoints';
import { EmptyState, ErrorState, PageLoader, Pager, Segmented } from '../../../components/ui';
import { formatDateTime, timeAgo } from '../../../lib/format';
import { useWsQuery } from '../../../lib/hooks';
import { useModule } from '../../../stores/auth';
import { InboxView } from '../../documents/DocumentInbox';
import { MaskingSection, SecuritySettings } from '../../documents/DocumentSecurity';
import { docsPath } from './nav';
import './docs.css';

type Tab = 'masking' | 'access' | 'keys' | 'audit';
const AREAS: { prefix: string; label: string }[] = [
  { prefix: 'document.pii_revealed', label: 'Reveals in documents' }, { prefix: 'api.pii_revealed', label: 'Reveals in APIs' },
  { prefix: 'document.secret', label: 'Secrets' }, { prefix: 'document.masking', label: 'Masking changes' },
  { prefix: 'document.', label: 'All document events' }, { prefix: 'doctracker.', label: 'Architecture' },
];

function Audit() {
  const [prefix, setPrefix] = useState(AREAS[0].prefix);
  const [page, setPage] = useState(1);
  const q = useWsQuery(['audit', 'logs', 'doctracker', prefix, page], () => insightApi.audit(prefix, page), { placeholderData: (p) => p });
  return (
    <div className="dx-audit">
      <div className="dx-chiprow" role="radiogroup" aria-label="What to show">{AREAS.map((a) => <button key={a.prefix} type="button" role="radio" aria-checked={prefix === a.prefix} onClick={() => { setPrefix(a.prefix); setPage(1); }}>{a.label}</button>)}</div>
      {q.isLoading ? <PageLoader /> : q.isError || !q.data ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : q.data.items.length === 0 ? <EmptyState icon="shield" title="Nothing recorded yet" /> : (
        <>
          <ul className="dx-events">{q.data.items.map((l) => (
            <li key={l.id}>
              <time title={formatDateTime(l.createdAt)}>{timeAgo(l.createdAt)}</time>
              <span><b>{l.userName ?? 'System'}</b> <code>{l.action}</code></span>
              <small title={[l.oldValue, l.newValue].filter(Boolean).join(' → ')}>{[l.oldValue, l.newValue].filter(Boolean).join(' → ') || '—'}</small>
            </li>
          ))}</ul>
          <Pager page={q.data.page} totalPages={q.data.totalPages} totalItems={q.data.totalItems} onPage={setPage} />
        </>
      )}
    </div>
  );
}

/** Security Center: what is masked and how, who asked for access, how long a reveal lasts and the keys, and who saw what. */
export function SecurityCenter() {
  const catalog = useWsQuery(['documents', 'doctracker', 'catalog'], docTrackerApi.catalog, { staleTime: 20_000 });
  const isAdmin = !!catalog.data?.isAdmin;
  const audit = useModule('audit') > 0;
  const tabs = [
    { id: 'masking' as Tab, label: 'Masking' },
    { id: 'access' as Tab, label: 'Access requests' },
    ...(isAdmin ? [{ id: 'keys' as Tab, label: 'Reveal time & keys' }] : []),
    ...(audit ? [{ id: 'audit' as Tab, label: 'Audit log' }] : []),
  ];
  const [tab, setTab] = useState<Tab>('masking');
  return (
    <div className="page dx dx-sec" data-testid="security-center">
      <nav className="dx-crumb" aria-label="Breadcrumb"><Link to={docsPath.hub()}>Library</Link><span aria-hidden="true">›</span><span aria-current="page">Security Center</span></nav>
      <header className="dx-sec-head dx-reveal">
        <span className="dx-sec-i" aria-hidden="true"><svg viewBox="0 0 24 24" width="26" height="26"><path d="M12 2.5 4.5 5.4v6.1c0 4.6 3.1 8.7 7.5 10 4.4-1.3 7.5-5.4 7.5-10V5.4L12 2.5Z" fill="currentColor" /></svg></span>
        <div>
          <h1 className="dx-h1">Security Center</h1>
          <p className="dx-lede">Personal and secret data in documents and APIs is masked before it leaves the server. Real values show only through a reveal that is time-limited and recorded.</p>
        </div>
      </header>
      <Segmented label="Security area" value={tab} onChange={setTab} options={tabs} />
      <section className="dx-card dx-sec-body" key={tab}>
        {tab === 'masking' && <MaskingSection />}
        {tab === 'access' && <InboxView />}
        {tab === 'keys' && isAdmin && <SecuritySettings />}
        {tab === 'audit' && audit && <Audit />}
      </section>
    </div>
  );
}
