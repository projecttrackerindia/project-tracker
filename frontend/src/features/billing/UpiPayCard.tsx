import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { ApiError } from '../../api/client';
import { billingApi } from '../../api/endpoints';
import type { UpiPayment } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Badge } from '../../components/ui';
import { formatDate, formatMoney } from '../../lib/format';
import { SUPPORT_EMAIL, supportMailto } from '../../lib/support';
import { confirmDialog, toast } from '../../stores/ui';

const REASONS = ['The app said the payment failed', 'The bank server is down', 'The QR could not be scanned', 'The payee could not be verified', 'Something else'];
const UTR = /^[A-Za-z0-9]{10,22}$/;

/**
 * Paying for a plan by UPI: one account's QR at a time. When paying it fails, "Try another QR" shows the next account's QR for the same
 * amount. After paying, the payer enters the UTR (UPI transaction id) and the plan is switched on once a platform administrator has matched
 * it with the bank statement.
 */
export function UpiPayCard({ pay, onChanged }: { pay: UpiPayment; onChanged: () => Promise<void> }) {
  const [qr, setQr] = useState('');
  const [utr, setUtr] = useState('');
  const [reason, setReason] = useState(REASONS[0]);
  const [failing, setFailing] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (pay.status !== 'awaiting') return;
    QRCode.toDataURL(pay.upiUri, { margin: 1, width: 232, errorCorrectionLevel: 'M' }).then(setQr).catch(() => setQr(''));
  }, [pay.upiUri, pay.status]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try { await fn(); if (ok) toast(ok); await onChanged(); }
    catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Something went wrong.', 'error'); }
    finally { setBusy(false); }
  };
  const copy = (text: string, what: string) => { void navigator.clipboard?.writeText(text).then(() => toast(`${what} copied.`), () => undefined); };
  const amount = formatMoney(pay.amount, pay.currency);
  const cleanUtr = utr.replace(/\s+/g, '');

  if (pay.status === 'submitted') return (
    <div className="card mb-22 upi-card" data-upi="submitted">
      <div className="card-head"><div><h3>Payment received, being confirmed</h3><p>{pay.description}</p></div><Badge tone="info">Confirming</Badge></div>
      <div className="card-body">
        <p>Thank you. We are matching UPI transaction <b className="mono">{pay.utr}</b> ({amount} to {pay.bankLabel ?? 'our account'}) with the bank statement.
          Your plan is switched on as soon as it is confirmed, usually within a few working hours, and you get a notification.</p>
        <p className="muted" style={{ fontSize: 12.5 }}>Reference {pay.reference}. If the money left your account but this is not confirmed within a day, write to <a href={supportMailto(`UPI payment ${pay.reference}`)}>{SUPPORT_EMAIL}</a> with this reference.</p>
      </div>
    </div>
  );

  if (pay.status === 'rejected') return (
    <div className="card mb-22 upi-card" data-upi="rejected">
      <div className="card-head"><div><h3>We could not confirm your payment</h3><p>{pay.description}</p></div><Badge tone="danger">Not confirmed</Badge></div>
      <div className="card-body">
        <p>UPI transaction <b className="mono">{pay.utr}</b> could not be matched{pay.decisionNote ? `: ${pay.decisionNote}` : '.'}</p>
        <p className="muted" style={{ fontSize: 12.5 }}>Check the UTR in your payment app and choose the plan again below to pay with a fresh QR. If money was taken from your account, write to <a href={supportMailto(`UPI payment ${pay.reference}`)}>{SUPPORT_EMAIL}</a> with reference {pay.reference}.</p>
        <button className="btn btn-sm" disabled={busy} onClick={() => void act(() => billingApi.upiCancel(pay.id))}>Dismiss</button>
      </div>
    </div>
  );

  return (
    <div className="card mb-22 upi-card" data-upi="awaiting">
      <div className="card-head">
        <div><h3>Pay {amount} by UPI</h3><p>{pay.description}</p></div>
        {pay.attempt > 1 && <Badge tone="warning">QR {pay.attempt}</Badge>}
      </div>
      <div className="card-body upi-body">
        <div className="upi-qr">
          {qr ? <img src={qr} width={232} height={232} alt={`UPI QR code to pay ${amount} to ${pay.payeeName}`} /> : <div className="upi-qr-empty"><span className="spinner" /></div>}
          <span className="muted" style={{ fontSize: 12 }}>Scan with any UPI app: PhonePe, Google Pay, Paytm, BHIM or your bank's app</span>
        </div>
        <div className="upi-info">
          <dl className="upi-dl">
            <dt>Amount</dt><dd><b>{amount}</b></dd>
            <dt>Pay to</dt><dd>{pay.payeeName}{pay.bankLabel ? ` · ${pay.bankLabel}` : ''}</dd>
            <dt>UPI ID</dt><dd><span className="mono">{pay.upiId}</span> <button type="button" className="btn btn-ghost btn-sm btn-icon-xs" onClick={() => copy(pay.upiId, 'UPI ID')} aria-label="Copy UPI ID"><Icon name="copy" size={13} /></button></dd>
            <dt>Note</dt><dd><span className="mono">{pay.reference}</span> <button type="button" className="btn btn-ghost btn-sm btn-icon-xs" onClick={() => copy(pay.reference, 'Reference')} aria-label="Copy reference"><Icon name="copy" size={13} /></button></dd>
            <dt>Valid until</dt><dd>{formatDate(pay.expiresAt)}</dd>
          </dl>
          <a className="btn btn-sm upi-open" href={pay.upiUri}><Icon name="phone" size={14} />Open in UPI app</a>
          <p className="muted" style={{ fontSize: 12.5 }}>Pay exactly {amount}. The QR fills in the amount and the note; if you type the UPI ID by hand, add the note {pay.reference}.</p>

          <form className="upi-utr" onSubmit={(e) => { e.preventDefault(); if (UTR.test(cleanUtr)) void act(() => billingApi.upiPaid(pay.id, cleanUtr), 'Thank you! We are confirming your payment.'); }}>
            <label className="field"><span>After paying: UPI transaction id (UTR)</span>
              <input className="input mono" inputMode="text" autoComplete="off" maxLength={26} value={utr} onChange={(e) => setUtr(e.target.value)} placeholder="12-digit UTR / UPI Ref No." />
            </label>
            <button className="btn btn-primary" type="submit" disabled={busy || !UTR.test(cleanUtr)}>{busy && <span className="spinner" />}I have paid</button>
          </form>
          <p className="muted" style={{ fontSize: 12 }}>Find it in your payment app under the payment's details ("UTR", "UPI Ref No." or "Transaction ID"). Your plan is switched on once we have matched it.</p>

          {!failing ? (
            <div className="row wrap" style={{ gap: 8 }}>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setFailing(true)}>Payment failed? Try another QR</button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={async () => {
                if (await confirmDialog({ title: 'Cancel this payment?', confirmText: 'Cancel payment', message: 'Only cancel if you have not paid. Your plan stays as it is.' })) void act(() => billingApi.upiCancel(pay.id), 'Payment cancelled.');
              }}>Cancel</button>
            </div>
          ) : (
            <div className="upi-fail">
              <label className="field"><span>What happened?</span>
                <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>{REASONS.map((r) => <option key={r}>{r}</option>)}</select>
              </label>
              <p className="muted" style={{ fontSize: 12 }}>Only if no money left your account. {pay.otherQrAvailable ? 'You get the QR of another bank account for the same amount.' : 'We show the QR again; you can retry in a little while.'}</p>
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void act(() => billingApi.upiFailed(pay.id, reason), pay.otherQrAvailable ? 'Here is another QR.' : 'Here is a fresh QR.').then(() => setFailing(false))}>Show another QR</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFailing(false)}>Back</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
