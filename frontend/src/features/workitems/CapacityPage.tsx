import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { resourcesApi } from '../../api/endpoints';
import type { MemberRate, UtilisationPerson, WorkloadScope } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { Avatar, EmptyState, ErrorState, PageLoader, RoleBadge, StatCard } from '../../components/ui';
import { currencySymbol, formatMoney, todayISO } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { addDaysIso, mondayOf } from '../time/Approvals';
import { formatMinutes } from '../time/time';

type Preset = 'week' | 'last4' | 'month' | 'lastMonth' | 'custom';
const PRESETS: { id: Preset; label: string }[] = [
  { id: 'week', label: 'This week' }, { id: 'last4', label: 'Last 4 weeks' }, { id: 'month', label: 'This month' }, { id: 'lastMonth', label: 'Last month' }, { id: 'custom', label: 'Custom' },
];
const SCOPE_LABEL: Record<WorkloadScope, string> = { Reports: 'Direct reports', Everyone: 'Everyone', Me: 'Just me' };

function rangeOf(p: Preset): { from: string; to: string } {
  const today = todayISO();
  const monday = mondayOf(today);
  const d = new Date(`${today}T00:00:00`);
  const iso = (y: number, m: number, day: number) => `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  switch (p) {
    case 'week': return { from: monday, to: addDaysIso(monday, 6) };
    case 'month': return { from: iso(d.getFullYear(), d.getMonth(), 1), to: iso(d.getFullYear(), d.getMonth(), new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()) };
    case 'lastMonth': { const m = new Date(d.getFullYear(), d.getMonth() - 1, 1); return { from: iso(m.getFullYear(), m.getMonth(), 1), to: iso(m.getFullYear(), m.getMonth(), new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate()) }; }
    default: return { from: addDaysIso(monday, -21), to: addDaysIso(monday, 6) };
  }
}

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
/** Under 70% is light, up to 100% healthy, above that over capacity. */
const tone = (v: number | null) => (v === null ? '' : v > 1 ? 'over' : v >= 0.7 ? 'healthy' : 'light');

function UtilBar({ p }: { p: UtilisationPerson }) {
  const cap = Math.max(1, p.capacityMinutes);
  const scale = Math.max(1.2, p.loggedMinutes / cap);   // leave room past 100% so overtime shows
  const w = (m: number) => `${Math.min(100, (m / cap / scale) * 100)}%`;
  return (
    <div className={`util-bar ${tone(p.utilisation)}`} role="img" aria-label={`${formatMinutes(p.loggedMinutes)} of ${formatMinutes(p.capacityMinutes)} capacity, ${formatMinutes(p.billableMinutes)} billable`}>
      <span className="util-logged" style={{ width: w(p.loggedMinutes) }} />
      <span className="util-billable" style={{ width: w(p.billableMinutes) }} />
      <i className="util-cap" style={{ left: `${(1 / scale) * 100}%` }} title="Capacity" />
    </div>
  );
}

/**
 * Workload → Capacity & cost: time logged against each person's capacity, the billable share, and (for Owners, Admins and people with
 * access to everyone's reports) what it cost and what the billable part is worth. Owners and Admins set capacity and rates here.
 */
export function CapacityPage() {
  const isAdmin = useAuth((s) => s.ctx?.current?.role === 'Owner' || s.ctx?.current?.role === 'Admin');
  const [preset, setPreset] = useState<Preset>('last4');
  const [custom, setCustom] = useState(() => rangeOf('last4'));
  const [scope, setScope] = useState<WorkloadScope | undefined>(undefined);
  const range = preset === 'custom' ? custom : rangeOf(preset);
  const q = useWsQuery(['capacity', range.from, range.to, scope ?? ''], () => resourcesApi.utilisation({ from: range.from, to: range.to, scope }), { enabled: range.to >= range.from });

  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const u = q.data;
  const money = (v: number | null) => (v === null ? '—' : formatMoney(Math.round(v * 100) / 100, u.currency));

  if (!u.entitled) return (
    <div className="card"><div className="card-body">
      <EmptyState icon="gauge" title="Capacity and cost come with the Business plan" text="See how much of each person's week is logged and billable, what projects cost against their budgets, and approve timesheets." action={isAdmin ? <Link className="btn btn-primary" to="/settings/billing">See plans</Link> : undefined} />
    </div></div>
  );

  const t = u.totals;
  return (
    <>
      <div className="toolbar cap-toolbar">
        <div className="seg" role="group" aria-label="Period">
          {PRESETS.map((p) => <button key={p.id} type="button" className={preset === p.id ? 'active' : ''} aria-pressed={preset === p.id} onClick={() => setPreset(p.id)}>{p.label}</button>)}
        </div>
        {preset === 'custom' && (
          <>
            <input className="input filter-input" type="date" aria-label="From" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
            <input className="input filter-input" type="date" aria-label="To" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
          </>
        )}
        {u.available.length > 1 && (
          <div className="seg" role="group" aria-label="Whose capacity" style={{ marginLeft: 'auto' }}>
            {u.available.map((s) => <button key={s} type="button" className={u.scope === s ? 'active' : ''} aria-pressed={u.scope === s} onClick={() => setScope(s)}>{SCOPE_LABEL[s]}</button>)}
          </div>
        )}
      </div>

      <div className="stat-grid">
        <StatCard icon="gauge" tone="blue" value={formatMinutes(t.capacityMinutes)} label="Capacity" foot={`${u.workingDays} working day${u.workingDays === 1 ? '' : 's'} · ${u.people.length} ${u.people.length === 1 ? 'person' : 'people'}`} />
        <StatCard icon="clock" tone="purple" value={pct(t.utilisation)} label="Utilisation" foot={`${formatMinutes(t.loggedMinutes)} logged`} />
        <StatCard icon="coin" tone="green" value={pct(t.billableShare)} label="Billable" foot={`${formatMinutes(t.billableMinutes)} of capacity`} />
        {u.showMoney && <StatCard icon="card" tone="amber" value={money(t.cost)} label="Cost" foot="At each person's cost rate" />}
        {u.showMoney && <StatCard icon="chart" tone="green" value={money(t.billableValue)} label="Billable value" foot="At project or personal bill rates" />}
      </div>

      <div className="card mb-22">
        <div className="card-head">
          <div><h3>Utilisation per person</h3><p>Logged time against capacity (Monday to Friday). Under 70% is light, over 100% is overtime.</p></div>
          <ul className="chart-key" aria-label="Bar colours">
            <li><i style={{ background: '#a78bfa' }} /><b>Logged</b></li><li><i style={{ background: '#10b981' }} /><b>Billable</b></li><li><i className="util-key cap" style={{ background: 'var(--text)' }} /><b>Capacity</b></li>
          </ul>
        </div>
        {u.people.length === 0 ? <div className="card-body"><EmptyState icon="users" title="Nobody to show" /></div> : (
          <div className="util-list">
            {u.people.map((p) => (
              <div className="util-row" key={p.userId}>
                <div className="util-who"><Avatar name={p.name} size="sm" userId={p.userId} /><div><b>{p.name}</b><span>{formatMinutes(p.loggedMinutes)} of {formatMinutes(p.capacityMinutes)}</span></div></div>
                <UtilBar p={p} />
                <div className={`util-pct ${tone(p.utilisation)}`}>{pct(p.utilisation)}</div>
                <div className="util-meta">
                  <span title="Billable share of capacity"><Icon name="coin" size={12} /> {pct(p.billableShare)}</span>
                  <span title="On project tasks / on operational work">{formatMinutes(p.projectMinutes)} projects · {formatMinutes(p.operationalMinutes)} ops</span>
                  {u.showMoney && <span title="Cost / billable value">{money(p.cost)} · {money(p.billableValue)}</span>}
                </div>
                <Link className="btn btn-ghost btn-sm" to={`/timesheet?user=${p.userId}`}>Timesheet</Link>
              </div>
            ))}
          </div>
        )}
      </div>

      {isAdmin && <RatesCard />}
    </>
  );
}

/** Owners and Admins: each person's weekly capacity, cost rate and bill rate, and the currency they are in. */
function RatesCard() {
  const wid = useWorkspaceId();
  const q = useWsQuery(['capacity', 'rates'], resourcesApi.rates);
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const r = q.data;
  const setCurrency = async (code: string) => {
    try { await resourcesApi.setCurrency(code); toast(`Budgets and rates are now in ${code}.`); void invalidateWorkspace(wid, 'capacity'); void invalidateWorkspace(wid, 'project'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not change the currency.', 'error'); }
  };
  return (
    <div className="card">
      <div className="card-head">
        <div><h3>Capacity and rates</h3><p>Only Owners and Admins see this. Costs use each person's current rate. Empty capacity means the standard 40 hours.</p></div>
        <label className="row" style={{ gap: 8, fontSize: 12.5 }}>Currency
          <Select className="select" value={r.currency} aria-label="Currency" disabled={!r.entitled} onChange={(e) => void setCurrency(e.target.value)}>
            {r.currencies.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}
          </Select>
        </label>
      </div>
      <div className="table-wrap">
        <table className="rates-table">
          <thead><tr><th>Person</th><th>Hours a week</th><th>Cost rate ({currencySymbol(r.currency)}/h)</th><th>Bill rate ({currencySymbol(r.currency)}/h)</th><th /></tr></thead>
          <tbody>{r.members.map((m) => <RateRow key={m.userId} m={m} disabled={!r.entitled} />)}</tbody>
        </table>
      </div>
    </div>
  );
}

function RateRow({ m, disabled }: { m: MemberRate; disabled: boolean }) {
  const wid = useWorkspaceId();
  const initial = () => ({ cap: m.standardCapacity ? '' : String(m.weeklyCapacityHours), cost: m.costRate?.toString() ?? '', bill: m.billRate?.toString() ?? '' });
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => setV(initial()), [m.weeklyCapacityHours, m.standardCapacity, m.costRate, m.billRate]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(v) !== JSON.stringify(initial());
  const num = (s: string) => (s.trim() === '' ? null : Number(s));
  const save = async () => {
    setBusy(true);
    try {
      await resourcesApi.setRates(m.userId, { weeklyCapacityHours: num(v.cap), costRate: num(v.cost), billRate: num(v.bill) });
      toast(`Saved ${m.name}'s capacity and rates.`);
      void invalidateWorkspace(wid, 'capacity');
    } catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not save.', 'error'); }
    finally { setBusy(false); }
  };
  return (
    <tr>
      <td><span className="row" style={{ gap: 8 }}><Avatar name={m.name} size="sm" userId={m.userId} /><span><b>{m.name}</b> <RoleBadge role={m.role} /></span></span></td>
      <td><input className="input rate-input" type="number" min={0} max={100} step={0.5} placeholder="40" aria-label={`${m.name} hours a week`} value={v.cap} disabled={disabled} onChange={(e) => setV({ ...v, cap: e.target.value })} /></td>
      <td><input className="input rate-input" type="number" min={0} step={0.01} placeholder="—" aria-label={`${m.name} cost rate`} value={v.cost} disabled={disabled} onChange={(e) => setV({ ...v, cost: e.target.value })} /></td>
      <td><input className="input rate-input" type="number" min={0} step={0.01} placeholder="—" aria-label={`${m.name} bill rate`} value={v.bill} disabled={disabled} onChange={(e) => setV({ ...v, bill: e.target.value })} /></td>
      <td>{dirty && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void save()}>Save</button>}</td>
    </tr>
  );
}
