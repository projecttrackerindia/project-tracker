import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { deviceLoginApi } from '../../api/endpoints';
import type { AuthResponse, DeviceLoginPending, DeviceLoginStart } from '../../api/types';
import { Icon } from '../../components/Icon';
import { AuthLayout } from '../../layouts/AuthLayout';
import { haptic } from '../../lib/mobile';
import { queryClient } from '../../stores/auth';

/**
 * Signing in on this screen by approving on the phone: the screen shows a number, the phone is sent a prompt and has to pick the same number out of
 * three, and this page (which alone holds the secret to redeem it) is signed in the moment the phone says yes. What is said here is the same
 * whether or not the address has a phone set up, so nothing is revealed about who has an account.
 */
export function PhoneStep({ email, onApproved, onBack }: { email: string; onApproved: (auth: AuthResponse) => void; onBack: () => void }) {
  const [req, setReq] = useState<DeviceLoginStart | null>(null);
  const [outcome, setOutcome] = useState<'waiting' | 'denied' | 'expired' | 'failed'>('waiting');
  const [left, setLeft] = useState(120);
  const done = useRef(false);

  const begin = useCallback(async () => {
    done.current = false; setReq(null); setOutcome('waiting');
    try { const r = await deviceLoginApi.start(email); setReq(r); setLeft(Math.max(1, Math.round((Date.parse(r.expiresAt) - Date.now()) / 1000))); }
    catch (e) { setOutcome('failed'); void e; }
  }, [email]);
  // Once per visit: the effect may run twice in development, and each run would send the phone its own prompt.
  const started = useRef(false);
  useEffect(() => { if (started.current) return; started.current = true; void begin(); }, [begin]);

  // Ask every second and a half until the phone has answered.
  useEffect(() => {
    if (!req || outcome !== 'waiting') return;
    const timer = setInterval(async () => {
      if (done.current) return;
      try {
        const r = await deviceLoginApi.poll(req.requestId, req.secret);
        if (r.status === 'approved' && r.auth) { done.current = true; haptic(15); onApproved(r.auth); }
        else if (r.status === 'denied') { done.current = true; setOutcome('denied'); }
        else if (r.status === 'expired') { done.current = true; setOutcome('expired'); }
      } catch (e) { if (e instanceof ApiError && e.status === 429) return; }
    }, 1500);
    return () => clearInterval(timer);
  }, [req, outcome, onApproved]);
  useEffect(() => {
    if (!req || outcome !== 'waiting') return;
    const t = setInterval(() => setLeft((s) => { if (s <= 1) { setOutcome('expired'); return 0; } return s - 1; }), 1000);
    return () => clearInterval(t);
  }, [req, outcome]);

  const footer = <button type="button" className="link" onClick={onBack}>Use my password instead</button>;
  if (outcome !== 'waiting') return (
    <AuthLayout title={outcome === 'denied' ? 'Not approved' : outcome === 'failed' ? 'Could not start' : 'Timed out'} footer={footer}
      sub={outcome === 'denied' ? 'The request was declined on the phone, so nobody was signed in.' : outcome === 'failed' ? 'Something went wrong asking for approval.' : 'Nobody approved it in time.'}>
      <div className="ps-result"><span className={`ps-icon ${outcome}`}><Icon name={outcome === 'denied' ? 'close' : 'alarm'} size={30} /></span></div>
      <button type="button" className="auth-submit" onClick={() => void begin()}><span className="label">Try again<Icon name="refresh" /></span></button>
    </AuthLayout>
  );
  const frac = Math.max(0, Math.min(1, left / 120));
  return (
    <AuthLayout title="Check your phone" sub="If this email has a phone set up for sign-in, we sent it a prompt. Open it and pick the number below." footer={footer}>
      <div className="ps-stage" aria-live="polite">
        <span className="ps-ring r1" /><span className="ps-ring r2" /><span className="ps-ring r3" />
        <svg className="ps-timer" viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="54" /><circle className="go" cx="60" cy="60" r="54" style={{ strokeDashoffset: 339.3 * (1 - frac) }} /></svg>
        <div className="ps-number" aria-label={req ? `Pick ${req.number} on your phone` : 'Starting'}>{req ? req.number : '…'}</div>
      </div>
      <p className="ps-note"><b>Tap {req ? req.number : '…'}</b> on your phone to sign in.<br /><span>Waiting for approval · {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</span></p>
    </AuthLayout>
  );
}

/** The phone's side: who is asking and three numbers to choose from. Used in the island at the top of the screen and on the approval page. */
export function ApprovePrompt({ item, onDone, compact = false }: { item: DeviceLoginPending; onDone: (approved: boolean) => void; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choose = async (n: number) => {
    setBusy(true); setError(null); haptic(10);
    try { await deviceLoginApi.approve(item.id, n); haptic([20, 40, 20]); onDone(true); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Could not approve.'); haptic(40); if (e instanceof ApiError && (e.status === 409 || e.status === 404)) onDone(false); else void queryClient.invalidateQueries({ queryKey: ['device-login'] }); }
    finally { setBusy(false); }
  };
  const deny = async () => { setBusy(true); try { await deviceLoginApi.deny(item.id); } catch { /* already gone */ } onDone(false); setBusy(false); };
  return (
    <div className={`ap ${compact ? 'compact' : ''}`}>
      <p className="ap-who"><Icon name="monitor" size={16} />{compact ? <span>{item.ip ? `From ${item.ip}` : 'From another screen'}</span> : <><b>{item.device}</b>{item.ip ? <> · {item.ip}</> : null}</>}</p>
      <p className="ap-ask">Pick the number shown on that screen. If you did not just try to sign in, deny it.</p>
      <div className="ap-nums">{item.choices.map((n) => <button key={n} type="button" disabled={busy} onClick={() => void choose(n)}>{n}</button>)}</div>
      {error && <p className="ap-err" role="alert">{error}</p>}
      <button type="button" className="ap-deny" disabled={busy} onClick={() => void deny()}>That was not me</button>
    </div>
  );
}
