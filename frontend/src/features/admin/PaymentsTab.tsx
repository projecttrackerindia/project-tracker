import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { adminApi } from '../../api/endpoints';
import type { AdminUpiPayment, UpiStatus } from '../../api/types';
import { Badge, EmptyState, ErrorState, Field, Modal, PageLoader } from '../../components/ui';
import { formatDate, formatMoney, timeAgo } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { toast } from '../../stores/ui';

const TONE: Record<UpiStatus, 'success' | 'info' | 'warning' | 'danger' | 'neutral'> = {
  submitted: 'info', confirmed: 'success', rejected: 'danger', failed: 'warning', awaiting: 'neutral', cancelled: 'neutral',
};
const LABEL: Record<UpiStatus, string> = {
  submitted: 'To confirm', confirmed: 'Confirmed', rejected: 'Rejected', failed: 'QR failed', awaiting: 'Waiting to be paid', cancelled: 'Cancelled',
};
const FILTERS: { key: string; label: string }[] = [
  { key: 'submitted', label: 'To confirm' }, { key: 'confirmed', label: 'Confirmed' }, { key: 'rejected', label: 'Rejected' }, { key: 'failed', label: 'QR failed' }, { key: 'all', label: 'All' },
];

/**
 * UPI payments (until a payment gateway is connected): a customer paid by QR and gave the UTR; an administrator finds that UTR and amount in
 * the bank account's statement, then confirms (the plan is switched on and the invoice recorded) or rejects with a reason the customer sees.
 */
export function PaymentsTab() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('submitted');
  const list = useWsQuery(['admin', 'upi', status], () => adminApi.upiPayments(status), { refetchInterval: 60_000 });
  const accounts = useWsQuery(['admin', 'upi-accounts'], adminApi.upiAccounts);
  const [deciding, setDeciding] = useState<{ p: AdminUpiPayment; confirm: boolean } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const decide = async () => {
    if (!deciding) return;
    setBusy(true);
    try {
      if (deciding.confirm) await adminApi.confirmUpi(deciding.p.id, note.trim() || undefined);
      else await adminApi.rejectUpi(deciding.p.id, note.trim());
      toast(deciding.confirm ? `Confirmed: ${deciding.p.workspace} is on ${deciding.p.planCode}.` : 'Rejected. The customer sees your reason.');
      setDeciding(null); setNote('');
      await qc.invalidateQueries({ predicate: (q) => q.queryKey.includes('admin') });
    } catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not save.', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="card mb-18">
        <div className="card-head"><div><h3>UPI accounts</h3><p>One QR is shown at a time, in this order. An account is skipped for new payments after repeated failures since its last confirmed payment.</p></div></div>
        <div className="card-body">
          {accounts.isLoading ? <PageLoader /> : accounts.isError || !accounts.data ? <ErrorState error={accounts.error} retry={() => accounts.refetch()} />
            : accounts.data.length === 0 ? <p className="muted">UPI payments are off. Set <code>Billing__Upi__Enabled</code> and <code>Billing__Upi__Accounts__0__Id</code> on the API (see DEPLOY.md).</p> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Account</th><th>UPI ID</th><th>State</th><th>Recent failures</th><th>Confirmed</th><th>Last confirmed</th><th>Last failure</th></tr></thead>
              <tbody>{accounts.data.map((a) => (
                <tr key={a.upiId}><td><b>{a.bankLabel ?? '—'}</b></td><td className="cell-muted">{a.upiId}</td>
                  <td>{!a.enabled ? <Badge tone="neutral">Off</Badge> : a.inUse ? <Badge tone="success">Shown first</Badge> : a.recentFailures > 0 ? <Badge tone="warning">Fallback</Badge> : <Badge tone="info">Standby</Badge>}</td>
                  <td>{a.recentFailures}</td><td>{a.confirmed}</td>
                  <td className="cell-muted">{a.lastConfirmedAt ? timeAgo(a.lastConfirmedAt) : '—'}</td><td className="cell-muted">{a.lastFailedAt ? timeAgo(a.lastFailedAt) : '—'}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div><h3>Payments</h3><p>Match the UTR and amount with the bank statement of the account shown before confirming.</p></div>
          <div className="seg" role="group" aria-label="Show">{FILTERS.map((f) => <button key={f.key} type="button" aria-pressed={status === f.key} className={status === f.key ? 'active' : ''} onClick={() => setStatus(f.key)}>{f.label}</button>)}</div>
        </div>
        <div className="card-body">
          {list.isLoading ? <PageLoader /> : list.isError || !list.data ? <ErrorState error={list.error} retry={() => list.refetch()} />
            : list.data.length === 0 ? <EmptyState icon="coin" title={status === 'submitted' ? 'Nothing to confirm' : 'No payments'} /> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Organization</th><th>Plan</th><th>Amount</th><th>Paid to</th><th>UTR</th><th>Reference</th><th>Status</th><th>When</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>{list.data.map((p) => (
                <tr key={p.id} data-upi-row={p.status}>
                  <td><b>{p.workspace}</b>{p.submittedByEmail && <div className="cell-muted" style={{ fontSize: 12 }}>{p.submittedByEmail}</div>}</td>
                  <td><Badge tone="purple">{p.planCode}</Badge><div className="cell-muted" style={{ fontSize: 12 }}>{p.seats} seat{p.seats === 1 ? '' : 's'} · {p.period}</div></td>
                  <td><b>{formatMoney(p.amount, p.currency)}</b></td>
                  <td>{p.bankLabel ?? '—'}<div className="cell-muted" style={{ fontSize: 12 }}>{p.upiId}{p.attempt > 1 ? ` · QR ${p.attempt}` : ''}</div></td>
                  <td>{p.utr ? <code>{p.utr}</code> : '—'}</td>
                  <td className="cell-muted">{p.reference}</td>
                  <td><Badge tone={TONE[p.status]}>{LABEL[p.status]}</Badge>{(p.decisionNote || p.failureReason) && <div className="cell-muted" style={{ fontSize: 12 }}>{p.decisionNote ?? p.failureReason}</div>}</td>
                  <td className="cell-muted" title={formatDate(p.submittedAt ?? p.createdAt)}>{timeAgo(p.decidedAt ?? p.submittedAt ?? p.createdAt)}</td>
                  <td>{p.status === 'submitted' && (
                    <div className="row" style={{ gap: 6 }}>
                      <button className="btn btn-primary btn-sm" onClick={() => { setNote(''); setDeciding({ p, confirm: true }); }}>Confirm</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => { setNote(''); setDeciding({ p, confirm: false }); }}>Reject</button>
                    </div>
                  )}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      </div>

      {deciding && (
        <Modal title={deciding.confirm ? 'Confirm this payment?' : 'Reject this payment?'} onClose={() => setDeciding(null)}
          footer={<><button className="btn btn-ghost" onClick={() => setDeciding(null)}>Back</button>
            <button className={`btn ${deciding.confirm ? 'btn-primary' : 'btn-danger'}`} disabled={busy || (!deciding.confirm && note.trim().length < 3)} onClick={() => void decide()}>{busy && <span className="spinner" />}{deciding.confirm ? 'Confirm and switch on the plan' : 'Reject'}</button></>}>
          <p>{deciding.confirm
            ? <>Only confirm after finding UTR <code>{deciding.p.utr}</code> for <b>{formatMoney(deciding.p.amount, deciding.p.currency)}</b> in the statement of {deciding.p.bankLabel ?? deciding.p.upiId}. {deciding.p.workspace} is switched to {deciding.p.planCode} ({deciding.p.seats} seat{deciding.p.seats === 1 ? '' : 's'}, {deciding.p.period}) and the invoice is recorded.</>
            : <>The customer sees your reason and can pay again with a fresh QR.</>}</p>
          <Field label={deciding.confirm ? 'Note (optional, kept in the audit log)' : 'Reason (the customer sees this)'}>
            <textarea className="input" rows={3} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder={deciding.confirm ? 'e.g. Seen in the Kotak statement' : 'e.g. No payment with this UTR reached our account.'} />
          </Field>
        </Modal>
      )}
    </>
  );
}
