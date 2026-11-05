import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { adminApi, documentApi, insightApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { EmptyState, ErrorState, PageHead, PageLoader, Pager } from '../../components/ui';
import { formatDateTime, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useDebounced, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { CalmCard, CalmHero, CalmRow } from '../../components/calm';
import { Face } from '../../components/Face';
import './calm-activity.css';

export function ActivityPage() {
  const [page, setPage] = useState(1);
  const q = useWsQuery(['activity', page], () => insightApi.activity(page), { placeholderData: (p) => p });
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const d = q.data;
  const today = new Date().toDateString();
  const todayCount = d.items.filter((a) => new Date(a.createdAt).toDateString() === today).length;
  return (
    <div className="calm-act">
      <CalmHero title={d.items.length === 0 ? 'Quiet so far.' : todayCount ? `${todayCount} ${todayCount === 1 ? 'thing' : 'things'} happened today.` : 'Nothing new today.'}
        second={d.items[0] ? `Latest: ${d.items[0].actor ? `${d.items[0].actor.name.split(' ')[0]} ` : ''}${d.items[0].summary}`.slice(0, 80) : 'Everything that happens here shows up here.'} />
      <CalmCard variant="list" aria-label="Workspace activity">
          {d.items.length === 0 ? <EmptyState icon="activity" title="No activity yet" text="Actions in projects and tasks will appear here. History is kept according to your plan." /> : (
            <div className="activity-list">
              {d.items.map((a) => (
                <CalmRow key={a.id} lead={<Face userId={a.actor?.id} name={a.actor?.name ?? 'System'} className="calm-act-face" />}
                  title={<>{a.actor && <b>{a.actor.name} </b>}{a.summary}</>} right={<span title={formatDateTime(a.createdAt)}>{timeAgo(a.createdAt)}</span>} />
              ))}
            </div>
          )}
        <Pager page={d.page} totalPages={d.totalPages} totalItems={d.totalItems} onPage={setPage} />
      </CalmCard>
    </div>
  );
}

export function AuditPage({ admin }: { admin?: boolean }) {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const da = useDebounced(action, 300);
  const q = useWsQuery([admin ? 'admin' : 'audit', 'logs', da, page], () => admin ? adminApi.audit(da || undefined, page) : insightApi.audit(da || undefined, page), { placeholderData: (p) => p });
  const pick = (prefix: string) => { setAction(prefix); setPage(1); };
  const body = q.isLoading ? <PageLoader /> : q.isError || !q.data ? <ErrorState error={q.error} retry={() => q.refetch()} /> : (
    <>
      <div className="audit-filters">
        <div className="ds-chips" role="group" aria-label="Show">
          {AUDIT_KINDS.map((k) => (
            <button key={k.prefix} type="button" className={`ds-chip${da === k.prefix ? ' on' : ''}`} aria-pressed={da === k.prefix} onClick={() => pick(k.prefix)}>{k.label}</button>
          ))}
        </div>
        <label className="audit-search"><Icon name="search" size={15} /><input placeholder="Filter by action, e.g. member." value={action} onChange={(e) => pick(e.target.value)} aria-label="Filter by action" /></label>
      </div>
      <div className="card audit-card">
        {q.data.items.length === 0 ? <div className="card-body"><EmptyState icon="shield" title="No audit events" text={da ? 'Nothing recorded with this kind of action. Try All events.' : 'Security and business events are recorded here.'} /></div> : (
          <div className="table-wrap"><table>
            <thead><tr><th>When</th><th>Who</th><th>Action</th>{admin && <th>Workspace</th>}<th>Resource</th><th>Details</th><th>IP</th></tr></thead>
            <tbody>{q.data.items.map((l) => (
              <tr key={l.id}>
                <td className="cell-muted" style={{ whiteSpace: 'nowrap' }} title={formatDateTime(l.createdAt)}>{timeAgo(l.createdAt)}</td>
                <td className="audit-who">{l.userName ?? 'System'}</td>
                <td><span className={`audit-action t-${actionTone(l.action)}`}>{l.action}</span></td>
                {admin && <td className="cell-muted">{l.tenantName ?? '—'}</td>}
                <td className="cell-muted">{l.entityType}</td>
                <td className="cell-muted" style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={[l.oldValue, l.newValue].filter(Boolean).join(' → ')}>{[l.oldValue, l.newValue].filter(Boolean).join(' → ') || '—'}</td>
                <td className="audit-ip">{l.ipAddress ?? '—'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        <Pager page={q.data.page} totalPages={q.data.totalPages} totalItems={q.data.totalItems} onPage={setPage} />
      </div>
    </>
  );
  if (admin) return body;
  return (
    <>
      <PageHead title="Audit log" sub="Every event is chained to the one before it, so a changed or removed record is detected and named.">
        <VerifyChainButton />
      </PageHead>
      <ChainBanner />
      {body}
    </>
  );
}

/** Quick filters: an action's first word (the server matches actions that start with it). */
const AUDIT_KINDS = [
  { prefix: '', label: 'All events' }, { prefix: 'member', label: 'Members' }, { prefix: 'user', label: 'Sign-ins and accounts' },
  { prefix: 'vault', label: 'Vault' }, { prefix: 'document', label: 'Documents' }, { prefix: 'org', label: 'Access' },
  { prefix: 'workspace', label: 'Settings' }, { prefix: 'billing', label: 'Billing' },
];
/** Colour means status: removals and failures red, reveals and copies amber, approvals and restores green, the rest plain. */
const actionTone = (a: string) => /(delete|remove|revok|fail|denied|block|breach|lock)/i.test(a) ? 'danger'
  : /(reveal|copied|copy|export|step|decoy)/i.test(a) ? 'warning' : /(approv|restor|grant|verif|creat|invit|join)/i.test(a) ? 'success' : 'plain';

/** The audit trail's tamper check, as the design's banner: intact (green) with how many records, or which record failed (red). */
export function ChainBanner() {
  const q = useWsQuery(['audit', 'chain'], documentApi.security, { staleTime: 60_000, retry: false });
  const c = q.data?.chain;
  if (!c) return null;
  return c.intact ? (
    <div className="ds-banner ok audit-chain" role="status" data-testid="chain-banner">
      <span className="ico"><Icon name="shield" size={22} /></span>
      <div className="txt"><b>Chain intact · {c.records.toLocaleString()} events</b>
        <span>{c.verifiedAt ? `Last checked ${timeAgo(c.verifiedAt)}, up to record ${c.verifiedUpTo.toLocaleString()}.` : 'Checked every night.'}</span></div>
    </div>
  ) : (
    <div className="ds-banner risk audit-chain" role="alert" data-testid="chain-banner">
      <span className="ico"><Icon name="alert" size={22} /></span>
      <div className="txt"><b>The audit trail failed its tamper check</b>
        <span>{c.reason ?? 'A record was changed or removed'}{c.brokenSeq != null ? ` at record ${c.brokenSeq.toLocaleString()}` : ''}.</span></div>
    </div>
  );
}

/** Re-checks the whole chain now (owners and admins). */
export function VerifyChainButton() {
  const wid = useWorkspaceId();
  const run = useMutation({
    mutationFn: documentApi.verifyAudit,
    onSuccess: (r) => { toast(r.intact ? 'The audit trail is intact.' : 'The audit trail does not verify.', r.intact ? 'success' : 'error'); void invalidateWorkspace(wid, 'audit'); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not check the audit trail.', 'error'),
  });
  return <button type="button" className="btn btn-ghost" disabled={run.isPending} onClick={() => run.mutate()}><Icon name="shield" size={15} /> {run.isPending ? 'Checking…' : 'Verify chain'}</button>;
}
