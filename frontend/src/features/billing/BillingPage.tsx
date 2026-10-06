import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { payWithRazorpay, PaymentCancelled } from '../../lib/razorpay';
import { ApiError } from '../../api/client';
import { billingApi } from '../../api/endpoints';
import type { InvoiceBuyer, Plan, SubscriptionStatus } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Badge, ErrorState, PageHead, PageLoader, Progress } from '../../components/ui';
import { FEATURE_LABELS, formatDate, formatMoney, limitLabel } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { DEFAULT_POLICY, quote, type Period, type PricingPolicy, type Quote } from '../../lib/pricing';
import { queryClient, useAuth, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';

const STATUS_TONE: Record<SubscriptionStatus, 'success' | 'info' | 'warning' | 'danger' | 'neutral'> = {
  Active: 'success', Trial: 'info', PastDue: 'danger', Cancelled: 'warning', Expired: 'neutral',
};
const LIMITS = ['PROJECT_LIMIT', 'TASK_LIMIT', 'MAX_MEMBERS', 'MAX_TEAMS', 'STORAGE_LIMIT_MB', 'MAX_FILE_SIZE_MB', 'ACTIVITY_RETENTION_DAYS'];
const FLAGS = ['ADVANCED_REPORTS', 'CUSTOM_WORKFLOWS', 'ADVANCED_PERMISSIONS', 'AUDIT_LOG', 'ADVANCED_SECURITY', 'RESOURCE_MANAGEMENT', 'SERVICE_LEVELS', 'REMINDER_ESCALATION', 'CHAT_ATTACHMENTS'];

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

const AI_LEVELS = ['', 'Quick', 'Standard', 'Deep'];
const gb = (mb: number) => (mb >= 1024 ? `${+(mb / 1024).toFixed(1)} GB` : `${mb} MB`);

/** What the plan's AI includes, in a few lines. On a per-person plan the credits are per person and pooled across the team. */
function aiLines(f: Record<string, number>, perSeat: boolean, seats: number): string[] {
  if (!f.AI_ASSISTANT) return [];
  const top = f.AI_MODEL_TIER < 0 ? 3 : Math.min(Math.max(f.AI_MODEL_TIER, 1), 3);
  const levels = AI_LEVELS.slice(1, top + 1);
  const credits = f.AI_MONTHLY_CREDITS;
  return [
    `AI assistant: ${levels.length > 1 ? `${levels.slice(0, -1).join(', ')} and ${levels[levels.length - 1]}` : levels[0]} answers${top === 3 ? ' with deep reasoning' : ''}`,
    credits < 0 ? 'Unlimited AI credits'
      : perSeat ? `${limitLabel(credits)} AI credits per user each month, shared by the team (${limitLabel(credits * seats)} for ${seats})`
      : `${limitLabel(credits)} AI credits per month`,
    ...(f.AI_ATTACHMENTS ? ['AI reads images & documents'] : []),
    ...(f.AI_ACTIONS ? ['AI takes actions & sends reports'] : []),
  ];
}

/** "5 projects", "1 member", "30-day activity history", "Unlimited tasks"; on a per-person plan, members and storage are about the people you pay for. */
function planFeatureText(plan: Plan, key: string, seats: number) {
  const v = plan.features[key];
  if (plan.perSeat && key === 'MAX_MEMBERS') return 'Pay only for the people you add';
  if (plan.perSeat && key === 'STORAGE_LIMIT_MB' && v > 0) return `${gb(v)} files per user (${gb(v * seats)} for ${seats})`;
  return featureText(key, v);
}

function PlanCard({ plan, current, canManage, trialAvailable, busy, quote: q, seats, period, policy, purchased, purchasedPeriod, onChoose }: {
  plan: Plan; current: boolean; canManage: boolean; trialAvailable: boolean; busy: boolean; quote: Quote | null; seats: number; period: Period; policy: PricingPolicy;
  purchased: number; purchasedPeriod: Period; onChoose: (plan: Plan, trial: boolean) => void;
}) {
  const price = plan.priceMonthly;
  const perSeat = !!plan.perSeat;
  const discounted = !!q && q.totalPercent > 0;
  const sameAsNow = current && (!perSeat || (seats === purchased && period === purchasedPeriod));
  return (
    <div className={`plan-card ${current ? 'current' : ''}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="plan-name">{plan.name}</span>
        {current ? <Badge tone="purple">Current</Badge> : discounted ? <Badge tone="success">{q!.totalPercent}% off</Badge> : null}
      </div>
      {price === null ? <div className="plan-price">Custom</div> : (
        <div className="plan-price">
          {perSeat && discounted && <s className="plan-was">{formatMoney(price, plan.currency)}</s>}
          {formatMoney(perSeat && q ? Math.round(q.effectivePerSeatMonthly) : price, plan.currency)}
          <small>{perSeat ? ' / user / month' : price > 0 ? ' / month' : ''}</small>
        </div>
      )}
      {perSeat && q && (
        <p className="plan-total">
          {period === 'yearly'
            ? <><b>{formatMoney(q.chargePerCycle, plan.currency)}</b> a year for {q.seats} {q.seats === 1 ? 'user' : 'users'}{q.savedPerCycle > 0 && <> · you save {formatMoney(q.savedPerCycle, plan.currency)}</>}</>
            : <><b>{formatMoney(q.chargePerCycle, plan.currency)}</b> a month for {q.seats} {q.seats === 1 ? 'user' : 'users'}{q.savedPerCycle > 0 && <> · you save {formatMoney(q.savedPerCycle, plan.currency)}</>}</>}
        </p>
      )}
      <p className="muted" style={{ fontSize: 12.5 }}>{plan.description}</p>
      <ul className="plan-features">
        {LIMITS.map((k) => <li key={k}><Icon name="tick" />{planFeatureText(plan, k, seats)}</li>)}
        {FLAGS.map((k) => <li key={k} className={plan.features[k] ? '' : 'off'}><Icon name={plan.features[k] ? 'tick' : 'close'} />{FEATURE_LABELS[k]}</li>)}
        {plan.features.AI_ASSISTANT
          ? aiLines(plan.features, perSeat, seats).map((t) => <li key={t}><Icon name="tick" />{t}</li>)
          : <li className="off"><Icon name="close" />AI assistant</li>}
      </ul>
      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {sameAsNow ? <button className="btn btn-ghost" disabled>Your plan</button>
          : price === null ? <a className="btn btn-ghost" href="mailto:sales@projecttracker.in?subject=Enterprise%20plan">Contact sales</a>
          : (<>
            <button className="btn btn-primary" disabled={!canManage || busy} onClick={() => onChoose(plan, false)}>
              {price === 0 ? 'Switch to Free' : current ? `Update to ${seats} ${seats === 1 ? 'seat' : 'seats'}${period !== purchasedPeriod ? `, billed ${period}` : ''}` : `Choose ${plan.name}`}
            </button>
            {trialAvailable && price > 0 && !current && <button className="btn btn-ghost" disabled={!canManage || busy} onClick={() => onChoose(plan, true)}>Start 14-day free trial ({policy.trialSeats} people)</button>}
          </>)}
      </div>
    </div>
  );
}

/** Monthly or yearly, and how many people: set once above the plans, every plan card shows its own price for the choice. */
function PlanChooser({ seats, setSeats, minSeats, period, setPeriod, policy }: {
  seats: number; setSeats: (n: number) => void; minSeats: number; period: Period; setPeriod: (p: Period) => void; policy: PricingPolicy;
}) {
  const next = policy.volumeTiers.find((t) => seats < t.minSeats);
  return (
    <div className="plan-chooser">
      <div className="pc-block">
        <span className="pc-label">Billing</span>
        <div className="seg" role="group" aria-label="Billing period">
          <button type="button" className={period === 'monthly' ? 'on' : ''} onClick={() => setPeriod('monthly')}>Monthly</button>
          <button type="button" className={period === 'yearly' ? 'on' : ''} onClick={() => setPeriod('yearly')}>Yearly <span className="seg-save">save {policy.annualDiscountPercent}%</span></button>
        </div>
      </div>
      <div className="pc-block">
        <span className="pc-label">People</span>
        <div className="stepper">
          <button type="button" aria-label="One fewer" disabled={seats <= minSeats} onClick={() => setSeats(Math.max(minSeats, seats - 1))}>−</button>
          <input aria-label="Number of people" inputMode="numeric" value={seats} onChange={(e) => { const n = parseInt(e.target.value.replace(/\D/g, ''), 10); setSeats(Number.isFinite(n) ? Math.min(policy.maxSeats, Math.max(minSeats, n)) : minSeats); }} />
          <button type="button" aria-label="One more" disabled={seats >= policy.maxSeats} onClick={() => setSeats(seats + 1)}>+</button>
        </div>
      </div>
      <p className="pc-note">
        {minSeats > 1 ? `${minSeats} people (including invitations) are already in this workspace. ` : ''}
        {next ? `Teams of ${next.minSeats}+ get ${next.percent}% off automatically.` : 'Your team size already earns the best volume discount.'}
      </p>
    </div>
  );
}

export function BillingPage() {
  const wid = useWorkspaceId();
  const reload = useAuth((s) => s.reloadContext);
  const q = useWsQuery(['billing'], billingApi.overview);
  const [busy, setBusy] = useState(false);
  const me = useAuth((s) => s.ctx?.user);
  const hosted = (q.data?.paymentProvider ?? 'mock') !== 'mock';
  const [period, setPeriodState] = useState<Period | null>(null);
  const [seatsPick, setSeatsPick] = useState<number | null>(null);

  const refresh = async () => { await invalidateWorkspace(wid); await reload(); };
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok); await refresh(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Something went wrong.', 'error'); }
    finally { setBusy(false); }
  };

  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const b = q.data;
  const plan = b.plan;
  const policy = b.policy ?? DEFAULT_POLICY;
  const inUse = b.seats?.inUse ?? 1;
  const paid = plan.code !== 'FREE' && plan.status !== 'Trial' && !plan.downgraded;
  const purchased = paid ? b.seats?.purchased ?? 1 : Math.max(inUse, 1);
  const purchasedPeriod: Period = paid ? b.seats?.period ?? 'monthly' : 'monthly';
  const minSeats = Math.max(1, inUse);
  const seats = Math.max(minSeats, seatsPick ?? Math.max(purchased, minSeats));
  const chosenPeriod: Period = period ?? purchasedPeriod;

  const choose = async (target: Plan, trial: boolean) => {
    const price = target.priceMonthly ?? 0;
    const perSeat = !!target.perSeat;
    const qt = quote(policy, price, perSeat, seats, chosenPeriod);
    const per = chosenPeriod === 'yearly' ? 'year' : 'month';
    const what = perSeat ? `${qt.seats} ${qt.seats === 1 ? 'user' : 'users'}, billed ${chosenPeriod}` : 'billed monthly';
    const ok = await confirmDialog({
      title: trial ? `Start ${target.name} trial?` : price === 0 ? 'Switch to Free?' : target.code === plan.code ? `Update ${target.name}?` : `Switch to ${target.name}?`, danger: price === 0,
      confirmText: trial ? 'Start trial' : price === 0 ? 'Switch to Free' : 'Confirm',
      message: trial ? `You get 14 days of ${target.name} for up to ${policy.trialSeats} people, with ${policy.trialAiCredits} AI credits. No payment is taken now.`
        : price === 0 ? 'Limits of the Free plan apply immediately (one person). Existing data is kept, but you may not be able to add more until you are within the limits.'
        : hosted ? `${target.name} for ${what}: ${formatMoney(qt.chargePerCycle, target.currency)} per ${per}${qt.savedPerCycle > 0 ? ` (you save ${formatMoney(qt.savedPerCycle, target.currency)})` : ''}. Next you pay in a secure window. ${target.code === plan.code && paid ? 'New seats are available right away and the new amount starts at your next renewal, so nothing is charged twice. ' : ''}You can cancel any time; your plan stays until the end of the paid period.`
        : `${target.name} for ${what}: you will be charged ${formatMoney(qt.chargePerCycle, target.currency)} per ${per}. (Demo mode: payments are simulated.)`,
    });
    if (!ok) return;
    if (trial || price === 0 || !hosted) { await run(() => billingApi.checkout(target.code, trial, perSeat ? seats : undefined, chosenPeriod), trial ? 'Trial started.' : 'Plan updated.'); return; }
    // A real payment: the server opens it, the person pays in the provider's window, and the server confirms the signed result.
    setBusy(true);
    try {
      const started = await billingApi.checkout(target.code, false, perSeat ? seats : undefined, chosenPeriod);
      if (!started.payment) { toast('Plan updated.'); await refresh(); return; }
      const result = await payWithRazorpay(started.payment, { name: me?.displayName ?? '', email: me?.email ?? '' });
      await billingApi.confirm(result.paymentId, result.subscriptionId, result.signature);
      toast(`You are on ${target.name}. Thank you!`); await refresh();
    } catch (e) {
      if (e instanceof PaymentCancelled) toast('Payment not completed. Nothing was changed.', 'info');
      else toast(e instanceof ApiError || e instanceof Error ? e.message : 'The payment could not be completed.', 'error');
    } finally { setBusy(false); }
  };
  const renewal = b.seats?.renewal;
  const perSeatNow = !!b.seats?.perSeat;

  return (
    <>
      <PageHead title="Billing" sub="Your plan, people, usage and invoices for this workspace" />

      <div className="card mb-22">
        <div className="card-head">
          <div><h3>Current plan</h3><p>Limits are enforced by the server on every request.</p></div>
          <div className="row">
            {plan.status === 'Cancelled' && b.canManage && !hosted && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => run(billingApi.resume, 'Subscription resumed.')}>Resume subscription</button>}
            {['Active', 'Trial'].includes(plan.status) && plan.code !== 'FREE' && b.canManage && (
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={async () => {
                if (await confirmDialog({ title: 'Cancel subscription?', confirmText: 'Cancel subscription', message: 'You keep your plan until the end of the current period, then the workspace moves to the Free plan. No further payments are taken.' })) run(billingApi.cancel, 'Subscription cancelled.');
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
              : plan.periodEnd && plan.code !== 'FREE' ? `Renews on ${formatDate(plan.periodEnd)}${renewal ? `: ${formatMoney(renewal.chargePerCycle, b.plans.find((p) => p.code === plan.code)?.currency)} ${renewal.period === 'yearly' ? 'a year' : 'a month'}` : ''}.` : plan.code === 'FREE' ? 'You are on the Free plan: one person.' : ''}
          </p>
          {perSeatNow && b.seats && (
            <div className="seat-meter">
              <div className="usage-top"><span>Seats</span><span>{b.seats.inUse} of {b.seats.purchased} used</span></div>
              <Progress value={Math.min(100, (b.seats.inUse / Math.max(1, b.seats.purchased)) * 100)} tone={b.seats.inUse >= b.seats.purchased ? 'amber' : ''} />
              {b.seats.inUse >= b.seats.purchased && <span className="muted" style={{ fontSize: 12.5 }}>Every seat is taken: add seats below to invite more people.</span>}
            </div>
          )}
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
                  <div className="usage-top"><span>{u.key === 'MAX_MEMBERS' ? 'Seats (people and invitations)' : u.label}</span><span>{u.used.toLocaleString()} / {limitLabel(u.limit)}</span></div>
                  <Progress value={unlimited ? Math.min(100, u.used) : pct} tone={unlimited ? '' : pct >= 100 ? 'red' : pct >= 80 ? 'amber' : ''} />
                  {!unlimited && pct >= 100 && <span className="field-error">{u.key === 'MAX_MEMBERS' && perSeatNow ? 'All seats are taken — add seats to invite more people.' : 'Limit reached — upgrade to add more.'}</span>}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>Plans</h3>
      <PlanChooser seats={seats} setSeats={setSeatsPick} minSeats={minSeats} period={chosenPeriod} setPeriod={setPeriodState} policy={policy} />
      <div className="plan-grid mb-22">
        {b.plans.map((p) => (
          <PlanCard key={p.id} plan={p} current={p.code === plan.code && !plan.downgraded} canManage={b.canManage} trialAvailable={b.trialAvailable} busy={busy}
            quote={p.priceMonthly === null || p.priceMonthly === 0 ? null : quote(policy, p.priceMonthly, !!p.perSeat, seats, chosenPeriod)} seats={seats} period={chosenPeriod} policy={policy}
            purchased={purchased} purchasedPeriod={purchasedPeriod} onChoose={choose} />
        ))}
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: '-8px 0 22px' }}>Prices are per person and exclude GST. Credits and storage are pooled across the team. Yearly billing takes {policy.annualDiscountPercent}% off; larger teams get an automatic volume discount (together at most {policy.maxTotalDiscountPercent}%).</p>

      {b.canManage && <BillingDetailsCard />}
      {b.canManage && (
        <div className="card">
          <div className="card-head"><h3>Invoices</h3></div>
          {b.invoices.length === 0 ? <div className="card-body"><p className="muted" style={{ fontSize: 13 }}>No invoices yet.</p></div> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Invoice</th><th>Description</th><th>Date</th><th>Amount</th><th>Status</th><th><span className="sr-only">Download</span></th></tr></thead>
              <tbody>{b.invoices.map((i) => (
                <tr key={i.id}><td className="td-title">{i.number}</td><td className="cell-muted">{i.description}</td><td className="cell-muted">{formatDate(i.issuedAt)}</td>
                  <td>{formatMoney(i.amount, i.currency)}</td><td><Badge tone={i.status === 'Paid' ? 'success' : 'danger'}>{i.status}</Badge></td>
                  <td>{i.status === 'Paid' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void billingApi.downloadInvoice(i.id, i.number).catch((e) => toast(e instanceof ApiError ? e.message : 'Could not download the invoice.', 'error'))}><Icon name="download" size={15} />PDF</button>}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      )}
    </>
  );
}

/** What appears under "Bill to" on invoices: the company's legal name, address and tax id (GSTIN). Empty means the workspace name. */
function BillingDetailsCard() {
  const q = useQuery({ queryKey: ['billing', 'details'], queryFn: billingApi.details });
  const [draft, setDraft] = useState<InvoiceBuyer | null>(null);
  const [saving, setSaving] = useState(false);
  if (!q.data) return null;
  const v = draft ?? q.data;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(q.data);
  const set = (k: keyof InvoiceBuyer, val: string) => setDraft({ ...v, [k]: val });
  const save = async () => {
    setSaving(true);
    try { const saved = await billingApi.setDetails(v); queryClient.setQueryData(['billing', 'details'], saved); setDraft(null); toast('Billing details saved. New downloads use them.'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not save.', 'error'); }
    finally { setSaving(false); }
  };
  return (
    <div className="card mb-22">
      <div className="card-head"><div><h3>Billing details</h3><p>Shown under “Bill to” on your invoices. Leave empty to use the workspace name.</p></div></div>
      <div className="card-body">
        <div className="bd-grid">
          <label className="field"><span>Company name</span><input className="input" value={v.name} maxLength={120} onChange={(e) => set('name', e.target.value)} placeholder="Legal name of your company" /></label>
          <label className="field"><span>GSTIN / tax ID</span><input className="input" value={v.taxId} maxLength={40} onChange={(e) => set('taxId', e.target.value)} placeholder="Optional" /></label>
          <label className="field bd-wide"><span>Address</span><textarea className="input" rows={3} value={v.address} maxLength={400} onChange={(e) => set('address', e.target.value)} placeholder="Registered address" /></label>
        </div>
        <div className="row" style={{ gap: 8, marginTop: 10 }}>
          <button className="btn btn-primary" disabled={!dirty || saving} onClick={() => void save()}>{saving && <span className="spinner" />}Save details</button>
          {dirty && <button className="btn btn-ghost" onClick={() => setDraft(null)}>Discard</button>}
        </div>
      </div>
    </div>
  );
}
