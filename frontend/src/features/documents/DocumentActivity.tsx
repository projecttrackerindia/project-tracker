import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { documentApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { Avatar, EmptyState, ErrorState, Modal, PageLoader } from '../../components/ui';
import { formatDateTime, timeAgo } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { useCan, useEntitlement } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { useQuery } from '@tanstack/react-query';
import { useWorkspaceId } from '../../stores/auth';

function ActivityList({ id }: { id: string }) {
  const q = useWsQuery(['documents', id, 'activity'], () => documentApi.activity(id));
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (q.data.length === 0) return <EmptyState icon="clock" title="Nothing yet" />;
  return (
    <ul className="act">{q.data.map((a) => <li key={a.id}><Avatar name={a.by?.name ?? '?'} userId={a.by?.id} /><div><span>{a.summary}</span><small title={formatDateTime(a.at)}>{a.by?.name ?? 'Someone'} · {timeAgo(a.at)}</small></div></li>)}</ul>
  );
}

function AuditTrail({ id }: { id: string }) {
  const wid = useWorkspaceId();
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const page = cursors[cursors.length - 1];
  const q = useQuery({ queryKey: [wid, 'documents', id, 'audit', page ?? ''], queryFn: () => documentApi.audit(id, page), retry: false });
  const exp = useMutation({ mutationFn: () => documentApi.exportAudit(id), onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not export.', 'error') });
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  return (
    <div className="aud">
      <div className="aud-bar"><span className="muted">Who did what, from where. Reading this trail is recorded too.</span><button className="btn btn-ghost btn-sm" disabled={exp.isPending} onClick={() => exp.mutate()}><Icon name="download" size={14} /> Export CSV</button></div>
      <div className="table-wrap"><table className="table aud-table">
        <thead><tr><th>When</th><th>What</th><th>Who</th><th>From</th><th>Change</th></tr></thead>
        <tbody>{q.data.items.map((e) => (
          <tr key={e.id}><td title={formatDateTime(e.at)}>{formatDateTime(e.at)}</td><td><code>{e.action}</code></td><td>{e.by?.name ?? '—'}</td><td className="muted" title={e.device ?? ''}>{e.ip ?? '—'}</td>
            <td className="aud-change">{e.newValue ? <code title={`${e.oldValue ?? ''} → ${e.newValue}`}>{e.newValue.length > 90 ? `${e.newValue.slice(0, 90)}…` : e.newValue}</code> : '—'}</td></tr>
        ))}</tbody>
      </table></div>
      <div className="aud-pager">
        <button className="btn btn-ghost btn-sm" disabled={cursors.length === 1} onClick={() => setCursors((c) => c.slice(0, -1))}>Newer</button>
        <button className="btn btn-ghost btn-sm" disabled={!q.data.nextCursor} onClick={() => setCursors((c) => [...c, q.data!.nextCursor!])}>Older</button>
      </div>
    </div>
  );
}

/** What happened to the document: the activity everyone who can open it sees, and (Business, with the audit permission) the full trail. */
export function ActivityModal({ id, title, onClose }: { id: string; title: string; onClose: () => void }) {
  const auditEntitled = useEntitlement('AUDIT_LOG') > 0;
  const hasAuditPermission = useCan('audit.view');
  const canAudit = auditEntitled && hasAuditPermission;
  const [tab, setTab] = useState<'activity' | 'audit'>('activity');
  return (
    <Modal title="Activity" subtitle={title} size="xl" onClose={onClose} footer={<button className="btn btn-ghost" onClick={onClose}>Close</button>}>
      <div className="seg" role="tablist" aria-label="View">
        <button role="tab" aria-selected={tab === 'activity'} className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}>Activity</button>
        {canAudit && <button role="tab" aria-selected={tab === 'audit'} className={tab === 'audit' ? 'on' : ''} onClick={() => setTab('audit')}>Audit trail</button>}
      </div>
      {tab === 'activity' ? <ActivityList id={id} /> : <AuditTrail id={id} />}
    </Modal>
  );
}

export function ActivityCard({ id, title }: { id: string; title: string }) {
  const [open, setOpen] = useState(false);
  const q = useWsQuery(['documents', id, 'activity'], () => documentApi.activity(id));
  return (
    <div className="card doc-side-card">
      <div className="card-head"><div><h3>Activity</h3></div><button className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>All</button></div>
      <div className="card-body">
        {(q.data ?? []).length === 0 ? <p className="muted">Nothing yet.</p> : (
          <ul className="act mini">{(q.data ?? []).slice(0, 5).map((a) => <li key={a.id}><div><span>{a.summary}</span><small title={formatDateTime(a.at)}>{a.by?.name ?? 'Someone'} · {timeAgo(a.at)}</small></div></li>)}</ul>
        )}
      </div>
      {open && <ActivityModal id={id} title={title} onClose={() => setOpen(false)} />}
    </div>
  );
}
