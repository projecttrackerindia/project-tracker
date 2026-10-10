import { useState } from 'react';
import { get, put } from '../../api/client';
import { workspaceApi, teamApi } from '../../api/endpoints.auth';
import { useWsQuery } from '../../lib/hooks';
import { useAuth } from '../../stores/auth';

interface Budget { id: string; scope: 'user' | 'team'; subjectId: string; name: string; monthlyLimit: number; enabled: boolean; spent: number; reserved: number }
interface Balance { spent: number; reserved: number; available: number; unlimited: boolean }

export function AiBudgetCard() {
  const role = useAuth(s => s.ctx?.current?.role);
  const allowed = role === 'Owner' || role === 'Admin';
  const [scope, setScope] = useState<'user' | 'team'>('user');
  const budgets = useWsQuery(['ai', 'budgets'], () => get<Budget[]>('/ai/credits/budgets'), { enabled: allowed });
  const balance = useWsQuery(['ai', 'credit-balance'], () => get<Balance>('/ai/credits/balance'), { enabled: allowed, refetchInterval: 30_000 });
  const members = useWsQuery(['ai', 'budget-members'], workspaceApi.members, { enabled: allowed });
  const teams = useWsQuery(['ai', 'budget-teams'], teamApi.list, { enabled: allowed && scope === 'team' });
  const [subjectId, setSubject] = useState(''); const [cap, setCap] = useState('100');
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  if (!allowed) return null;
  const save = async (subject: string, limit: number, enabled: boolean, targetScope = scope) => {
    setBusy(true); setError(null);
    try { await put('/ai/credits/budgets', { scope: targetScope, subjectId: subject, monthlyLimit: limit, enabled }); await budgets.refetch(); }
    catch (e) { setError(e instanceof Error ? e.message : 'The budget could not be saved.'); }
    finally { setBusy(false); }
  };
  const subjects = scope === 'user' ? members.data?.map(m => ({ id: m.userId, name: m.displayName })) : teams.data?.map(t => ({ id: t.id, name: t.name }));
  return <section className="card" style={{ marginTop: 18 }}><div className="card-body">
    <h4>AI credit budgets</h4>
    <p>Set optional monthly caps for new AI work. Every request still uses the shared plan allowance. Work by a member counts against each enabled budget for their teams; these caps do not create extra credits.</p>
    {balance.data && <p>{balance.data.spent.toLocaleString()} spent · {balance.data.reserved.toLocaleString()} reserved by active work · {balance.data.unlimited ? 'Unlimited plan allowance' : `${balance.data.available.toLocaleString()} available`}</p>}
    {(error || budgets.error || balance.error || members.error || teams.error) && <p role="alert">{error || budgets.error?.message || balance.error?.message || members.error?.message || teams.error?.message}</p>}
    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
      <label>Budget for <select value={scope} onChange={e => { setScope(e.target.value as 'user' | 'team'); setSubject(''); }}><option value="user">Person</option><option value="team">Team</option></select></label>
      <label>Name <select value={subjectId} onChange={e => setSubject(e.target.value)}><option value="">Choose a {scope === 'user' ? 'person' : 'team'}</option>{subjects?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>Monthly credits <input type="number" min="0" max="1000000000" value={cap} onChange={e => setCap(e.target.value)} /></label>
      <button className="btn btn-primary" disabled={busy || !subjectId || cap.trim() === '' || !Number.isSafeInteger(Number(cap)) || Number(cap) < 0} onClick={() => void save(subjectId, Number(cap), true)}>Save cap</button>
    </div>
    {budgets.data?.length ? <div className="table-wrap" style={{ marginTop: 14 }}><table><thead><tr><th>Person or team</th><th>Cap</th><th>Spent since enabled this month</th><th>Reserved</th><th>Status</th><th /></tr></thead><tbody>{budgets.data.map(b => <tr key={b.id}><td>{b.name} ({b.scope})</td><td>{b.monthlyLimit}</td><td>{b.spent}</td><td>{b.reserved}</td><td>{b.enabled ? 'Enabled' : 'Disabled'}</td><td><button className="btn" disabled={busy} onClick={() => void save(b.subjectId, b.monthlyLimit, !b.enabled, b.scope)}>{b.enabled ? 'Disable' : 'Enable'}</button></td></tr>)}</tbody></table></div> : <p>No optional caps configured.</p>}
  </div></section>;
}
