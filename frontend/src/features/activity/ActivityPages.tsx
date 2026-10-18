import { useState } from 'react';
import { adminApi, insightApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { EmptyState, ErrorState, PageHead, PageLoader, Pager } from '../../components/ui';
import { formatDateTime, timeAgo } from '../../lib/format';
import { useDebounced, useWsQuery } from '../../lib/hooks';
import { activityIcon } from '../dashboard/DashboardPage';

export function ActivityPage() {
  const [page, setPage] = useState(1);
  const q = useWsQuery(['activity', page], () => insightApi.activity(page), { placeholderData: (p) => p });
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const d = q.data;
  return (
    <>
      <PageHead title="Activity" sub="Everything that happened in this workspace" />
      <div className="card">
        <div className="card-body">
          {d.items.length === 0 ? <EmptyState icon="activity" title="No activity yet" text="Actions in projects and tasks will appear here. History is kept according to your plan." /> : (
            <div className="activity-list">
              {d.items.map((a) => {
                const ic = activityIcon(a.action);
                return (
                  <div className="act-item" key={a.id}>
                    <div className={`act-ico ${ic.tone}`}><Icon name={ic.icon} /></div>
                    <div className="act-body"><div className="act-text">{a.actor && <b>{a.actor.name} </b>}{a.summary}</div><div className="act-time" title={formatDateTime(a.createdAt)}>{timeAgo(a.createdAt)}</div></div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <Pager page={d.page} totalPages={d.totalPages} totalItems={d.totalItems} onPage={setPage} />
      </div>
    </>
  );
}

export function AuditPage({ admin }: { admin?: boolean }) {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const da = useDebounced(action, 300);
  const q = useWsQuery([admin ? 'admin' : 'audit', 'logs', da, page], () => admin ? adminApi.audit(da || undefined, page) : insightApi.audit(da || undefined, page), { placeholderData: (p) => p });
  const body = q.isLoading ? <PageLoader /> : q.isError || !q.data ? <ErrorState error={q.error} retry={() => q.refetch()} /> : (
    <div className="card">
      <div className="toolbar"><div className="search-field"><Icon name="search" /><input className="input" placeholder="Filter by action, e.g. member." value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} aria-label="Filter by action" /></div></div>
      {q.data.items.length === 0 ? <div className="card-body"><EmptyState icon="shield" title="No audit events" text="Security and business events are recorded here." /></div> : (
        <div className="table-wrap"><table>
          <thead><tr><th>When</th><th>Action</th><th>User</th>{admin && <th>Workspace</th>}<th>Entity</th><th>Details</th><th>IP</th></tr></thead>
          <tbody>{q.data.items.map((l) => (
            <tr key={l.id}>
              <td className="cell-muted" style={{ whiteSpace: 'nowrap' }} title={formatDateTime(l.createdAt)}>{timeAgo(l.createdAt)}</td>
              <td><code style={{ fontSize: 12 }}>{l.action}</code></td>
              <td className="cell-muted">{l.userName ?? '—'}</td>
              {admin && <td className="cell-muted">{l.tenantName ?? '—'}</td>}
              <td className="cell-muted">{l.entityType}</td>
              <td className="cell-muted" style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={[l.oldValue, l.newValue].filter(Boolean).join(' → ')}>{[l.oldValue, l.newValue].filter(Boolean).join(' → ') || '—'}</td>
              <td className="cell-muted">{l.ipAddress ?? '—'}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <Pager page={q.data.page} totalPages={q.data.totalPages} totalItems={q.data.totalItems} onPage={setPage} />
    </div>
  );
  return admin ? body : <><PageHead title="Audit log" sub="Security and business events for this workspace" />{body}</>;
}
