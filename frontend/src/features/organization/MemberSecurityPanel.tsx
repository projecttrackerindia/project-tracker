import { useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import { workspaceApi } from '../../api/endpoints';
import type { MemberSecurity, SecurityIssue } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Badge, ErrorState, PageLoader } from '../../components/ui';
import { formatDate, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useCan, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';

const ISSUE: Record<SecurityIssue, { label: string; tone: 'danger' | 'warning' | 'neutral' }> = {
  'no-two-step': { label: 'No two-step', tone: 'danger' },
  'weak-password': { label: 'Short password', tone: 'warning' },
  'old-password': { label: 'Password over a year old', tone: 'warning' },
  inactive: { label: 'Not signed in for 90 days', tone: 'neutral' },
};
type Filter = 'all' | SecurityIssue;

/**
 * Members' account security, for owners and admins: who has no two-step verification, whose password is short or old (never the password
 * itself, only its length and age), who has not signed in for a while, and a one-click reminder to the people who need to act.
 */
export function MemberSecurityPanel() {
  const canManage = useCan('org.manage');
  const wid = useWorkspaceId();
  const q = useWsQuery(['org', 'security', 'members'], workspaceApi.securityMembers, { enabled: canManage });
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState(false);
  const people = useMemo(() => (q.data?.people ?? []).filter((p) => filter === 'all' ? true : p.issues.includes(filter)), [q.data, filter]);
  if (!canManage) return null;
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const d = q.data;

  const remind = async (who: MemberSecurity[], topic: 'two-step' | 'password') => {
    if (who.length === 0) return;
    setBusy(true);
    try {
      const r = await workspaceApi.securityRemind(who.map((p) => p.userId), topic);
      toast(r.sent === 0 ? 'Already reminded today.' : `Reminder sent to ${r.sent} ${r.sent === 1 ? 'person' : 'people'}.`, 'success');
      invalidateWorkspace(wid, 'org', 'security', 'members');
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not send the reminders.', 'error'); }
    finally { setBusy(false); }
  };
  const noTwoStep = d.people.filter((p) => p.issues.includes('no-two-step'));
  const weak = d.people.filter((p) => p.issues.includes('weak-password') || p.issues.includes('old-password'));

  return (
    <div className="card mss">
      <div className="card-head"><div><h3>Members' account security</h3><p>What protects each account. Passwords are never shown, only how long and how old they are.</p></div></div>
      <div className="card-body">
        <div className="mss-kpis">
          <button type="button" className={`mss-kpi ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}><b>{d.members}</b><span>members</span></button>
          <button type="button" className={`mss-kpi bad ${filter === 'no-two-step' ? 'on' : ''}`} onClick={() => setFilter('no-two-step')}><b>{d.withoutTwoStep}</b><span>without two-step</span></button>
          <button type="button" className={`mss-kpi warn ${filter === 'weak-password' ? 'on' : ''}`} onClick={() => setFilter('weak-password')}><b>{d.weakPasswords}</b><span>short passwords</span></button>
          <button type="button" className={`mss-kpi warn ${filter === 'old-password' ? 'on' : ''}`} onClick={() => setFilter('old-password')}><b>{d.oldPasswords}</b><span>passwords over a year old</span></button>
        </div>
        <div className="mss-actions">
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || noTwoStep.length === 0} onClick={() => void remind(noTwoStep, 'two-step')}>
            <Icon name="shield" size={14} /> Remind {noTwoStep.length} to turn on two-step
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy || weak.length === 0} onClick={() => void remind(weak, 'password')}>
            <Icon name="lock" size={14} /> Remind {weak.length} to change their password
          </button>
        </div>
        <div className="table-wrap">
          <table className="mss-table">
            <thead><tr><th>Member</th><th>Two-step</th><th>Password</th><th>Last sign-in</th><th>To fix</th><th /></tr></thead>
            <tbody>
              {people.length === 0 ? <tr><td colSpan={6} className="muted">Nobody here.</td></tr> : people.map((p) => (
                <tr key={p.userId}>
                  <td><b>{p.name}</b><div className="td-sub">{p.email} · {p.role}</div></td>
                  <td>{p.twoStep ? <Badge tone="success">On</Badge> : p.passkeys > 0 ? <Badge tone="success">Passkey</Badge> : <Badge tone="danger">Off</Badge>}</td>
                  <td>{p.passwordLength ? `${p.passwordLength >= 20 ? '20+' : p.passwordLength} characters` : 'Not known yet'}<div className="td-sub">{p.passwordChangedAt ? `changed ${formatDate(p.passwordChangedAt)}` : 'before this was tracked'}</div></td>
                  <td>{p.lastSignInAt ? timeAgo(p.lastSignInAt) : 'Never'}</td>
                  <td>{p.issues.length === 0 ? <span className="muted">Nothing</span> : p.issues.map((i) => <Badge key={i} tone={ISSUE[i].tone}>{ISSUE[i].label}</Badge>)}</td>
                  <td className="mss-row-act">
                    {p.remindedAt ? <span className="muted" title={`Reminded ${formatDate(p.remindedAt)}`}>Reminded</span>
                      : p.issues.includes('no-two-step') ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void remind([p], 'two-step')}>Remind</button>
                      : p.issues.some((i) => i === 'weak-password' || i === 'old-password') ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void remind([p], 'password')}>Remind</button>
                      : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
