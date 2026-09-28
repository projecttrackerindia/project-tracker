import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { billingApi } from '../../api/endpoints';
import type { Plan, SubscriptionStatus } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Badge, ErrorState, PageHead, PageLoader, Progress } from '../../components/ui';
import { FEATURE_LABELS, formatDate, formatMoney, limitLabel } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';

const STATUS_TONE: Record<SubscriptionStatus, 'success' | 'info' | 'warning' | 'danger' | 'neutral'> = {
  Active: 'success', Trial: 'info', PastDue: 'danger', Cancelled: 'warning', Expired: 'neutral',
};
const LIMITS = ['PROJECT_LIMIT', 'TASK_LIMIT', 'MAX_MEMBERS', 'MAX_TEAMS', 'STORAGE_LIMIT_MB', 'MAX_FILE_SIZE_MB', 'ACTIVITY_RETENTION_DAYS'];
const FLAGS = ['ADVANCED_REPORTS', 'CUSTOM_WORKFLOWS', 'ADVANCED_PERMISSIONS', 'AUDIT_LOG'];

/** "5 projects", "1 member", "30-day activity history", "Unlimited tasks". */
function featureText(key: string, value: number) {
  const n = limitLabel(value);
  const one = value === 1;
  switch (key) {
    case 'PROJECT_LIMIT': return `${n} project${one ? '' : 's'}`;
    case 'TASK_LIMIT': return `${n} task${one ? '' : 's'}`;
    case 'MAX_MEMBERS': return `${n} member${one ? '' : 's'}`;
    case 'MAX_TEAMS': return `${n} team${one ? '' : 's'}`;
    case 'STORAGE_LIMIT_MB': return value === -1 ? 'Unlimited file storage' : `${value >= 1024 ? `${value / 1024} GB` : `${value} MB`} file storage`;
    case 'MAX_FILE_SIZE_MB': return `${value} MB per file`;
    case 'ACTIVITY_RETENTION_DAYS': return value === -1 ? 'Unlimited activity history' : `${value}-day activity history`;
    default: return `${n} ${FEATURE_LABELS[key]?.toLowerCase() ?? key}`;
  }
}

function PlanCard({ plan, current, canManage, trialAvailable, busy, onChoose }: {
  plan: Plan; current: boolean; canManage: boolean; trialAvailable: boolean; busy: boolean; onChoose: (plan: Plan, trial: boolean) => void;
}) {
  const price = plan.priceMonthly;
  return (
    <div className={`plan-card ${current ? 'current' : ''}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}><span className="plan-name">{plan.name}</span>{current && <Badge tone="purple">Current</Badge>}</div>
      <div className="plan-price">{price === null ? 'Custom' : formatMoney(price, plan.currency)}{price !== null && <small> / month</small>}</div>
      <p className="muted" style={{ fontSize: 12.5, minHeight: 36 }}>{plan.description}</p>
      <ul className="plan-features">
        {LIMITS.map((k) => <li key={k}><Icon name="tick" />{featureText(k, plan.features[k])}</li>)}
        {FLAGS.map((k) => <li key={k} className={plan.features[k] ? '' : 'off'}><Icon name={plan.features[k] ? 'tick' : 'close'} />{FEATURE_LABELS[k]}</li>)}
      </ul>
      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {current ? <button className="btn btn-ghost" disabled>Your plan</button>
          : price === null ? <a className="btn btn-ghost" href="mailto:sales@example.com?subject=Enterprise%20plan">Contact sales</a>
          : (<>
            <button className="btn btn-primary" disabled={!canManage || busy} onClick={() => onChoose(plan, false)}>{price === 0 ? 'Switch to Free' : `Choose ${plan.name}`}</button>
            {trialAvailable && price > 0 && <button className="btn btn-ghost" disabled={!canManage || busy} onClick={() => onChoose(plan, true)}>Start 14-day free trial</button>}
          </>)}
      </div>
    </div>
  );
}

export function BillingPage() {
  const wid = useWorkspaceId();
  const reload = useAuth((s) => s.reloadContext);
  const q = useWsQuery(['billing'], billingApi.overview);
  const [busy, setBusy] = useState(false);

  const refresh = async () => { await invalidateWorkspace(wid); await reload(); };
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok); await refresh(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Something went wrong.', 'error'); }
    finally { setBusy(false); }
  };

  const choose = async (plan: Plan, trial: boolean) => {
    const price = plan.priceMonthly ?? 0;
    const ok = await confirmDialog({
      title: trial ? `Start ${plan.name} trial?` : price === 0 ? 'Switch to Free?' : `Switch to ${plan.name}?`, danger: price === 0, confirmText: trial ? 'Start trial' : price === 0 ? 'Switch to Free' : 'Confirm',
      message: trial ? `You get 14 days of ${plan.name} for free. No payment is taken now.`
        : price === 0 ? 'Limits of the Free plan apply immediately. Existing data is kept, but you may not be able to add more until you are within the limits.'
        : `You will be charged ${formatMoney(price, plan.currency)} per month. (Demo mode: payments are simulated.)`,
    });
    if (ok) run(() => billingApi.checkout(plan.code, trial), trial ? 'Trial started.' : 'Plan updated.');
  };
  const cancel = useMutation({ mutationFn: billingApi.cancel });

  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const b = q.data;
  const plan = b.plan;

  return (
    <>
      <PageHead title="Billing" sub="Your plan, usage and invoices for this workspace" />

      <div className="card mb-22">
        <div className="card-head">
          <div><h3>Current plan</h3><p>Limits are enforced by the server on every request.</p></div>
          <div className="row">
            {plan.status === 'Cancelled' && b.canManage && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => run(billingApi.resume, 'Subscription resumed.')}>Resume subscription</button>}
            {['Active', 'Trial'].includes(plan.status) && plan.code !== 'FREE' && b.canManage && (
              <button className="btn btn-ghost btn-sm" disabled={busy || cancel.isPending} onClick={async () => {
                if (await confirmDialog({ title: 'Cancel subscription?', confirmText: 'Cancel subscription', message: 'You keep your plan until the end of the current period, then the workspace moves to the Free plan.' })) run(billingApi.cancel, 'Subscription cancelled.');
              }}>Cancel subscription</button>
            )}
          </div>
        </div>
        <div className="card-body">
          <div className="row wrap" style={{ gap: 14 }}>
            <span style={{ fontSize: 22, fontWeight: 750 }}>{plan.name}</span><Badge tone={STATUS_TONE[plan.status]}>{plan.status === 'PastDue' ? 'Past due' : plan.status}</Badge>
            {plan.downgraded && <Badge tone="warning">Subscription ended — Free limits apply</Badge>}
          </div>
          <p className="text-2" style={{ fontSize: 13, marginTop: 8 }}>
            {plan.status === 'Trial' && plan.trialEnd ? `Trial ends on ${formatDate(plan.trialEnd)}.`
              : plan.status === 'Cancelled' && plan.periodEnd ? `Cancelled — access continues until ${formatDate(plan.periodEnd)}.`
              : plan.periodEnd && plan.code !== 'FREE' ? `Renews on ${formatDate(plan.periodEnd)}.` : plan.code === 'FREE' ? 'You are on the Free plan.' : ''}
          </p>
          {!b.canManage && <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>Only people with billing permission can change the plan.</p>}
        </div>
      </div>

      <div className="card mb-22">
        <div className="card-head"><h3>Usage</h3></div>
        <div className="card-body">
          <div className="grid-2" style={{ gap: 22 }}>
            {b.usage.map((u) => {
              const unlimited = u.limit === -1;
              const pct = unlimited ? 0 : u.limit === 0 ? 100 : (u.used / u.limit) * 100;
              return (
                <div className="usage-row" key={u.key}>
                  <div className="usage-top"><span>{u.label}</span><span>{u.used.toLocaleString()} / {limitLabel(u.limit)}</span></div>
                  <Progress value={unlimited ? Math.min(100, u.used) : pct} tone={unlimited ? '' : pct >= 100 ? 'red' : pct >= 80 ? 'amber' : ''} />
                  {!unlimited && pct >= 100 && <span className="field-error">Limit reached — upgrade to add more.</span>}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>Plans</h3>
      <div className="plan-grid mb-22">
        {b.plans.map((p) => <PlanCard key={p.id} plan={p} current={p.code === plan.code && !plan.downgraded} canManage={b.canManage} trialAvailable={b.trialAvailable} busy={busy} onChoose={choose} />)}
      </div>

      {b.canManage && (
        <div className="card">
          <div className="card-head"><h3>Invoices</h3></div>
          {b.invoices.length === 0 ? <div className="card-body"><p className="muted" style={{ fontSize: 13 }}>No invoices yet.</p></div> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Invoice</th><th>Description</th><th>Date</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>{b.invoices.map((i) => (
                <tr key={i.id}><td className="td-title">{i.number}</td><td className="cell-muted">{i.description}</td><td className="cell-muted">{formatDate(i.issuedAt)}</td>
                  <td>{formatMoney(i.amount, i.currency)}</td><td><Badge tone={i.status === 'Paid' ? 'success' : 'danger'}>{i.status}</Badge></td></tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      )}
    </>
  );
}
