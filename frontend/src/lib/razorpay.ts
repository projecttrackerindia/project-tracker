import type { HostedCheckout } from '../api/types';

/** What Razorpay's payment window hands back after a successful payment; the server checks its signature. */
export interface PaymentResult { paymentId: string; subscriptionId: string; signature: string }

interface RazorpayResponse { razorpay_payment_id: string; razorpay_subscription_id: string; razorpay_signature: string }
interface RazorpayWindow { open: () => void; on: (event: string, cb: (r: { error?: { description?: string } }) => void) => void }
declare global { interface Window { Razorpay?: new (options: Record<string, unknown>) => RazorpayWindow } }

let loading: Promise<void> | null = null;
/** Razorpay's own script, loaded the first time someone pays (and never for anyone who does not). */
function load(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js'; s.async = true;
    s.onload = () => resolve(); s.onerror = () => { loading = null; reject(new Error('The payment window could not be loaded. Check your connection and try again.')); };
    document.head.appendChild(s);
  });
  return loading;
}

/** Opens the payment window. Resolves with the signed result; rejects with `Cancelled` when the person closes it, or with the provider's message when the payment fails. */
export async function payWithRazorpay(c: HostedCheckout, who: { name: string; email: string }): Promise<PaymentResult> {
  await load();
  return new Promise<PaymentResult>((resolve, reject) => {
    const w = new window.Razorpay!({
      key: c.keyId, subscription_id: c.subscriptionId, name: c.name, description: c.description,
      prefill: { name: who.name, email: who.email }, theme: { color: '#7c3aed' },
      handler: (r: RazorpayResponse) => resolve({ paymentId: r.razorpay_payment_id, subscriptionId: r.razorpay_subscription_id, signature: r.razorpay_signature }),
      modal: { ondismiss: () => reject(new PaymentCancelled()) },
    });
    w.on('payment.failed', (r) => reject(new Error(r.error?.description ?? 'The payment failed. You were not charged.')));
    w.open();
  });
}

export class PaymentCancelled extends Error { constructor() { super('Payment cancelled'); this.name = 'PaymentCancelled'; } }
