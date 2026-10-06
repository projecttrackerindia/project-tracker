import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { emailAdminApi } from '../../api/endpoints';
import { Badge, PageLoader } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { timeAgo } from '../../lib/format';
import { queryClient } from '../../stores/auth';
import { toast } from '../../stores/ui';

const TONE = { Sent: 'success', Queued: 'warning', Failed: 'danger', Suppressed: 'neutral' } as const;
const CHECK_TONE = { ok: 'success', warn: 'warning', fail: 'danger' } as const;

/** Health → E-mail: whether messages are really arriving, who is blocked, and whether the sending domain is set up to reach inboxes. */
export function EmailPanel() {
  const [status, setStatus] = useState<string>('');
  const [domain, setDomain] = useState('');
  const overview = useQuery({ queryKey: ['admin', 'email', status], queryFn: () => emailAdminApi.overview(status || undefined), refetchInterval: 20_000 });
  const blocked = useQuery({ queryKey: ['admin', 'email', 'blocked'], queryFn: emailAdminApi.blocked });
  const check = useMutation({ mutationFn: () => emailAdminApi.domain(domain.trim() || undefined), onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not check the domain.', 'error') });
  const unblock = async (id: string) => { await emailAdminApi.unblock(id); void queryClient.invalidateQueries({ queryKey: ['admin', 'email'] }); toast('Address unblocked.'); };
  const o = overview.data;

  return (
    <div className="card mb-22">
      <div className="card-head"><div><h3>E-mail</h3><p>Everything the server tried to send, the addresses it will not write to, and a check of your sending domain.</p></div>{o && <Badge tone={o.provider === 'log' ? 'warning' : 'success'}>{o.provider === 'log' ? 'Not connected (log only)' : `via ${o.provider}`}</Badge>}</div>
      <div className="card-body">
        {overview.isLoading || !o ? <PageLoader /> : (
          <>
            <div className="em-stats">
              <div><b>{o.sent24h}</b><span>sent, 24 h</span></div>
              <div className={o.failed24h ? 'bad' : ''}><b>{o.failed24h}</b><span>failed, 24 h</span></div>
              <div><b>{o.queued}</b><span>waiting to retry</span></div>
              <div><b>{o.suppressed}</b><span>blocked addresses</span></div>
            </div>
            <div className="em-filter" role="tablist" aria-label="Show">
              {['', 'Failed', 'Queued', 'Suppressed', 'Sent'].map((s) => <button key={s || 'all'} type="button" role="tab" aria-selected={status === s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>{s || 'All'}</button>)}
            </div>
            {o.recent.length === 0 ? <p className="muted">Nothing here yet.</p> : (
              <div className="table-wrap"><table>
                <thead><tr><th>To</th><th>Subject</th><th>Result</th><th>When</th></tr></thead>
                <tbody>{o.recent.map((r) => (
                  <tr key={r.id}><td>{r.to}</td><td>{r.subject}{r.error && <small className="em-err">{r.error}</small>}</td><td><Badge tone={TONE[r.status]}>{r.status}{r.status === 'Queued' || r.status === 'Failed' ? ` · try ${r.attempts}` : ''}</Badge></td><td>{timeAgo(r.createdAt)}</td></tr>
                ))}</tbody>
              </table></div>
            )}
          </>
        )}

        {!!blocked.data?.length && (
          <div className="em-block"><h4>Blocked addresses</h4><p className="muted">An address is blocked when it bounces for good or someone reports a message as spam. Unblock it only if you know the problem is fixed.</p>
            {blocked.data.map((b) => <div className="em-row" key={b.id}><span><b>{b.email}</b><small>{b.reason} · {timeAgo(b.createdAt)}</small></span><button className="btn btn-ghost btn-sm" onClick={() => void unblock(b.id)}>Unblock</button></div>)}
          </div>
        )}

        <div className="em-block"><h4>Will your mail reach inboxes?</h4>
          <p className="muted">Checks SPF, DKIM and DMARC for the domain you send from. Leave it empty to use your sender address.</p>
          <form className="em-domain" onSubmit={(e) => { e.preventDefault(); check.mutate(); }}>
            <input className="input" placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="Domain to check" />
            <button className="btn btn-primary" disabled={check.isPending}>{check.isPending && <span className="spinner" />}<Icon name="shield" size={16} />Check domain</button>
          </form>
          {check.data && (
            <div className="em-checks">{check.data.checks.map((c) => (
              <div className={`em-check ${c.status}`} key={c.id}><Badge tone={CHECK_TONE[c.status]}>{c.title}</Badge><span>{c.detail}{c.fix && <small>{c.fix}</small>}</span></div>
            ))}</div>
          )}
        </div>
      </div>
    </div>
  );
}
