import { useState } from 'react';
import { ApiError } from '../../api/client';
import { resourcesApi } from '../../api/endpoints';
import type { ProjectFinancials } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/ui';
import { currencySymbol, formatMoney } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { formatMinutes } from './time';

const pct = (v: number | null) => (v === null ? null : Math.round(v * 100));

function BurnBar({ label, used, of, share, forecast, forecastOver }: { label: string; used: string; of: string | null; share: number | null; forecast?: string | null; forecastOver?: boolean }) {
  const p = pct(share);
  const state = p === null ? '' : p > 100 ? 'over' : p >= 85 ? 'near' : 'ok';
  return (
    <div className={`burn ${state}`}>
      <div className="burn-head"><span>{label}</span><b>{used}{of ? <span className="muted"> of {of}</span> : null}</b>{p !== null && <em>{p}%</em>}</div>
      <div className="burn-track"><span style={{ width: `${Math.min(100, p ?? 0)}%` }} />{p !== null && p > 100 && <i style={{ left: `${(100 / p) * 100}%` }} />}</div>
      {forecast && <div className={`burn-foot ${forecastOver ? 'bad' : ''}`}><Icon name="activity" size={12} /> On this pace: {forecast} by the due date</div>}
    </div>
  );
}

/** A project's budget against what it has used (hours for anyone with reports access; money for Owners, Admins and broad reports access). */
export function ProjectBudget({ projectId }: { projectId: string }) {
  const q = useWsQuery(['project', projectId, 'financials'], () => resourcesApi.project(projectId));
  const [editing, setEditing] = useState(false);
  // Loading, or not for this person: the tracked time below says the rest.
  if (q.isLoading || q.isError || !q.data) return null;
  const f = q.data;
  if (!f.entitled) return null;
  const money = (v: number | null) => (v === null ? null : formatMoney(Math.round(v * 100) / 100, f.currency));
  const hours = (h: number | null) => (h === null ? null : formatMinutes(Math.round(h * 60)));
  const nothingSet = f.budgetHours === null && f.budgetAmount === null && !f.isBillable;
  if (nothingSet && !f.canEdit) return null;

  return (
    <div className="card mb-22 budget-card">
      <div className="card-head">
        <div>
          <h3>Budget &amp; cost {f.isBillable ? <span className="badge badge-success" style={{ marginLeft: 6 }}>Billable</span> : <span className="badge badge-neutral" style={{ marginLeft: 6 }}>Internal</span>}</h3>
          <p>{f.showMoney ? 'Hours and money used against the budget. Costs use each person’s current rate.' : 'Hours used against the budget.'}</p>
        </div>
        {f.canEdit && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}><Icon name="edit" size={14} /> {nothingSet ? 'Set a budget' : 'Edit budget'}</button>}
      </div>
      <div className="card-body">
        {nothingSet ? <p className="muted" style={{ fontSize: 13 }}>No budget yet. Set the hours and money this project may use, and whether its time is billable to a client.</p> : (
          <>
            <div className="burn-grid">
              <BurnBar label="Hours" used={formatMinutes(f.loggedMinutes)} of={hours(f.budgetHours)} share={f.hoursUsed}
                forecast={hours(f.forecastHours)} forecastOver={f.budgetHours !== null && f.forecastHours !== null && f.forecastHours > f.budgetHours} />
              {f.showMoney && <BurnBar label="Cost" used={money(f.cost) ?? (f.loggedMinutes === 0 ? money(0)! : '—')} of={money(f.budgetAmount)} share={f.budgetUsed ?? (f.loggedMinutes === 0 && f.budgetAmount ? 0 : null)}
                forecast={money(f.forecastCost)} forecastOver={f.budgetAmount !== null && f.forecastCost !== null && f.forecastCost > f.budgetAmount} />}
            </div>
            <div className="budget-facts">
              <span><Icon name="coin" size={13} /> {formatMinutes(f.billableMinutes)} billable</span>
              {f.showMoney && f.billableValue !== null && <span>Worth <b>{money(f.billableValue)}</b>{f.billRate !== null ? ` at ${money(f.billRate)}/h` : ' at personal bill rates'}</span>}
              {f.showMoney && f.cost !== null && f.billableValue !== null && <span>Margin <b className={f.billableValue - f.cost < 0 ? 'neg' : 'pos'}>{money(f.billableValue - f.cost)}</b></span>}
              {f.showMoney && f.peopleWithoutCostRate > 0 && <span className="warn"><Icon name="alert" size={13} /> {f.peopleWithoutCostRate} {f.peopleWithoutCostRate === 1 ? 'person has' : 'people have'} no cost rate yet</span>}
            </div>
          </>
        )}
      </div>
      {editing && <BudgetModal f={f} onClose={() => setEditing(false)} />}
    </div>
  );
}

function BudgetModal({ f, onClose }: { f: ProjectFinancials; onClose: () => void }) {
  const wid = useWorkspaceId();
  const [billable, setBillable] = useState(f.isBillable);
  const [hours, setHours] = useState(f.budgetHours?.toString() ?? '');
  const [amount, setAmount] = useState(f.budgetAmount?.toString() ?? '');
  const [rate, setRate] = useState(f.billRate?.toString() ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const num = (s: string) => (s.trim() === '' ? null : Number(s));
  const save = async () => {
    setBusy(true); setError(null);
    try {
      await resourcesApi.setBudget(f.projectId, { isBillable: billable, budgetHours: num(hours), budgetAmount: num(amount), billRate: num(rate) });
      toast('Budget saved.');
      void invalidateWorkspace(wid, 'project', f.projectId);
      void invalidateWorkspace(wid, 'capacity');
      onClose();
    } catch (e) { setError(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not save the budget.'); }
    finally { setBusy(false); }
  };
  const sym = currencySymbol(f.currency);
  return (
    <Modal title="Project budget" subtitle={`Amounts are in ${f.currency}.`} onClose={onClose} onSubmit={(e) => { e.preventDefault(); void save(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy}>Save</button></>}>
      <div className="setting-row" style={{ paddingTop: 0 }}>
        <div className="setting-info"><h4>Billable to a client</h4><p>Time logged on this project starts out billable. Each entry can still be changed.</p></div>
        <button type="button" className={`switch ${billable ? 'on' : ''}`} role="switch" aria-checked={billable} aria-label="Billable" onClick={() => setBillable(!billable)} />
      </div>
      <div className="form-grid">
        <div className="field"><label htmlFor="b-hours">Hour budget</label><input id="b-hours" className="input" type="number" min={0} step={0.5} placeholder="No limit" value={hours} onChange={(e) => setHours(e.target.value)} /></div>
        <div className="field"><label htmlFor="b-amount">Money budget ({sym})</label><input id="b-amount" className="input" type="number" min={0} step={1} placeholder="No limit" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        <div className="field"><label htmlFor="b-rate">Bill rate ({sym}/h)</label><input id="b-rate" className="input" type="number" min={0} step={0.01} placeholder="Each person's own" value={rate} onChange={(e) => setRate(e.target.value)} /></div>
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}
    </Modal>
  );
}
