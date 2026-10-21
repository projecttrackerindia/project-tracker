import { useState } from 'react';
import { insightApi } from '../../api/endpoints';
import { Icon, type IconName } from '../../components/Icon';
import { EmptyState, ErrorState, PageLoader, Pager } from '../../components/ui';
import { formatDateTime, timeAgo } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { useModule } from '../../stores/auth';
import { InboxView } from '../documents/DocumentInbox';
import { MaskingSection, SecuritySettings } from '../documents/DocumentSecurity';

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
    <div className="dt-audit">
      <div className="dt-chips" role="radiogroup" aria-label="What to show">{AREAS.map((a) => <button key={a.prefix} role="radio" aria-checked={prefix === a.prefix} className={prefix === a.prefix ? 'on' : ''} onClick={() => { setPrefix(a.prefix); setPage(1); }}>{a.label}</button>)}</div>
      {q.isLoading ? <PageLoader /> : q.isError || !q.data ? <ErrorState error={q.error} retry={() => q.refetch()} /> : q.data.items.length === 0 ? <EmptyState icon="shield" title="Nothing recorded yet" /> : (
        <>
          <div className="dt-table-wrap"><table className="dt-table">
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
            <tbody>{q.data.items.map((l) => (
              <tr key={l.id}><td className="muted" title={formatDateTime(l.createdAt)}>{timeAgo(l.createdAt)}</td><td>{l.userName ?? '—'}</td><td><code>{l.action}</code></td>
                <td className="dt-audit-detail" title={[l.oldValue, l.newValue].filter(Boolean).join(' → ')}>{[l.oldValue, l.newValue].filter(Boolean).join(' → ') || '—'}</td></tr>
            ))}</tbody>
          </table></div>
          <Pager page={q.data.page} totalPages={q.data.totalPages} totalItems={q.data.totalItems} onPage={setPage} />
        </>
      )}
    </div>
  );
}

/** DocTracker's Security Center: what is masked, who asked for access, reveal time and keys, and who saw what. */
export function DtSecurity({ isAdmin }: { isAdmin: boolean }) {
  const audit = useModule('audit') > 0;
  const tabs: { id: Tab; label: string; icon: IconName; show: boolean }[] = [
    { id: 'masking', label: 'Masking rules', icon: 'eyeOff', show: true },
    { id: 'access', label: 'Access requests', icon: 'key', show: true },
    { id: 'keys', label: 'Reveal time and keys', icon: 'lock', show: isAdmin },
    { id: 'audit', label: 'Audit log', icon: 'shield', show: audit },
  ];
  const [tab, setTab] = useState<Tab>('masking');
  return (
    <div className="dt-sec">
      <section className="dt-hero sec">
        <span className="dt-sec-ic"><Icon name="shield" size={26} /></span>
        <div><h2>Security Center</h2><p className="muted">Personal and secret data in documents and APIs is masked before it leaves the server. Real values show only through a reveal that is time-limited and recorded.</p></div>
      </section>
      <div className="dt-tabs" role="tablist">{tabs.filter((t) => t.show).map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}><Icon name={t.icon} size={13} /> {t.label}</button>)}</div>
      <div className="dt-card dt-sec-body">
        {tab === 'masking' && <div className="dsec"><MaskingSection /></div>}
        {tab === 'access' && <InboxView />}
        {tab === 'keys' && isAdmin && <SecuritySettings />}
        {tab === 'audit' && audit && <Audit />}
      </div>
    </div>
  );
}
