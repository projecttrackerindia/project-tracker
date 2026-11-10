import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { meApi } from '../../api/endpoints';
import type { AuthResponse } from '../../api/types';
import {
  sessionApprovalApi, type ApprovalHistoryItem, type ApprovalPrompt, type ApprovalStart, type ApprovalStatus,
} from '../../api/endpoints.sessionApproval';
import { Icon } from '../../components/Icon';
import { Badge, PageLoader } from '../../components/ui';
import { AuthLayout } from '../../layouts/AuthLayout';
import { formatDateTime, timeAgo } from '../../lib/format';
import { haptic } from '../../lib/mobile';
import { usePageTitle } from '../../lib/title';
import { queryClient, useAuth } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { SSwitch } from '../settings/Grouped';
import './sessionApproval.css';

/** Live events from the realtime connection (ChatRealtime re-broadcasts them on window). */
export const APPROVAL_EVENT = 'pm:session-approval';
export const APPROVAL_CLOSED_EVENT = 'pm:session-approval-closed';
export const SESSION_ENDED_EVENT = 'pm:session-ended';
/** Why this browser was signed out, shown once on the sign-in page. */
export const SIGNED_OUT_KEY = 'pm_signed_out_reason';

export const rememberSignedOut = (message: string) => { try { sessionStorage.setItem(SIGNED_OUT_KEY, message); } catch { /* storage unavailable */ } };
export const takeSignedOut = () => {
  try { const m = sessionStorage.getItem(SIGNED_OUT_KEY); sessionStorage.removeItem(SIGNED_OUT_KEY); return m; } catch { return null; }
};

const APP_LABEL: Record<string, string> = { web: 'Web browser', desktop: 'Desktop app', phone: 'Phone' };
const deviceIcon = (app: string) => (app === 'phone' ? 'phone' : 'monitor') as 'phone' | 'monitor';
const secondsLeft = (iso: string) => Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 1000));
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

// ------------------------------------------------------------------ the new device

/**
 * The new device after its password (and code) were accepted: it waits for a device that is already signed in to allow it, showing the same
 * two-digit code that device sees. After two minutes nobody answering counts as no, and the person can approve it themselves with an emailed link
 * or an authenticator code instead.
 */
export function ApprovalWait({ start, onApproved, onBack }: { start: Pick<ApprovalStart, 'approvalId' | 'code' | 'device' | 'expiresAt'> & { secret?: string | null; location?: string | null; app?: string }; onApproved: (auth: AuthResponse) => void; onBack: () => void }) {
  usePageTitle('Waiting for approval');
  const [st, setSt] = useState<ApprovalStatus>(() => ({ status: 'pending', code: start.code, device: start.device, expiresAt: start.expiresAt, canEmail: false, canCode: false, emailSent: false }));
  const [left, setLeft] = useState(() => secondsLeft(start.expiresAt));
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);

  const poll = useCallback(async () => {
    if (done.current) return;
    try {
      const r = await sessionApprovalApi.status(start.approvalId, start.secret);
      if (r.status === 'approved' && r.auth) { done.current = true; haptic(15); onApproved(r.auth); return; }
      if (r.status === 'rejected' || r.status === 'closed') done.current = true;
      setSt((s) => ({ ...s, ...r, code: r.code || s.code, device: r.device || s.device }));
    } catch (e) { if (!(e instanceof ApiError) || e.status !== 429) setError(null); }
  }, [start.approvalId, start.secret, onApproved]);

  useEffect(() => {
    if (st.status === 'rejected' || st.status === 'closed') return;
    void poll();
    const t = setInterval(() => void poll(), 2000);
    return () => clearInterval(t);
  }, [poll, st.status]);
  useEffect(() => {
    if (st.status !== 'pending') return;
    const t = setInterval(() => setLeft(secondsLeft(st.expiresAt)), 1000);
    return () => clearInterval(t);
  }, [st.status, st.expiresAt]);

  const sendEmail = async () => {
    setBusy(true); setError(null);
    try { setSt(await sessionApprovalApi.email(start.approvalId, start.secret)); toast('Check your inbox for the approval link.', 'info'); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Could not send the link.'); }
    finally { setBusy(false); }
  };
  const submitCode = async () => {
    if (!code.trim()) return;
    setBusy(true); setError(null);
    try { await sessionApprovalApi.code(start.approvalId, code.trim(), start.secret); await poll(); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Could not check the code.'); haptic(40); }
    finally { setBusy(false); }
  };

  const footer = <button type="button" className="link" onClick={onBack}>Cancel and go back</button>;
  const chip = (
    <p className="saw-device"><Icon name={deviceIcon(start.app ?? 'web')} size={15} /><span>This device: <b>{st.device || start.device}</b>{start.location ? ` · ${start.location}` : ''}</span></p>
  );

  if (st.status === 'rejected' || st.status === 'closed') return (
    <AuthLayout title={st.status === 'rejected' ? 'Sign-in rejected' : 'This request ended'} footer={footer}
      sub={st.status === 'rejected' ? 'Your other device said no, so this device was not signed in.' : (st.message ?? 'Sign in again to start a new request.')}>
      <div className="ps-result"><span className={`ps-icon ${st.status === 'rejected' ? 'denied' : 'expired'}`}><Icon name={st.status === 'rejected' ? 'close' : 'alarm'} size={30} /></span></div>
      <button type="button" className="auth-submit" onClick={onBack}><span className="label">Back to sign in<Icon name="arrowRight" /></span></button>
    </AuthLayout>
  );

  if (st.status === 'timed_out') return (
    <AuthLayout title="No answer from your other device" sub="It counts as denied. You can still approve this sign-in yourself." footer={footer}>
      {chip}
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="saw-fallback">
        <button type="button" className="auth-submit" disabled={busy || !st.canEmail} onClick={() => void sendEmail()}>
          <span className="label"><Icon name="mail" />{st.emailSent ? 'Send the link again' : 'Email me an approval link'}</span>
        </button>
        {st.emailSent && <p className="saw-hint" role="status">Link sent to your verified email. Open it on any device: this page signs in by itself.</p>}
        {st.canCode && (
          <form className="saw-code" onSubmit={(e) => { e.preventDefault(); void submitCode(); }}>
            <label htmlFor="saw-code">Or enter a code from your authenticator app</label>
            <div className="saw-code-row">
              <input id="saw-code" className="input" inputMode="text" autoComplete="one-time-code" placeholder="6-digit or recovery code" value={code} onChange={(e) => setCode(e.target.value)} />
              <button type="submit" className="btn btn-ghost" disabled={busy || !code.trim()}>Verify</button>
            </div>
          </form>
        )}
      </div>
    </AuthLayout>
  );

  const frac = Math.max(0, Math.min(1, left / 120));
  return (
    <AuthLayout title="Waiting for approval" sub="Allow this sign-in on the device you are already signed in on." footer={footer}>
      {chip}
      <div className="ps-stage" aria-live="polite">
        <span className="ps-ring r1" /><span className="ps-ring r2" /><span className="ps-ring r3" />
        <svg className="ps-timer" viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="54" /><circle className="go" cx="60" cy="60" r="54" style={{ strokeDashoffset: 339.3 * (1 - frac) }} /></svg>
        <div className="ps-number" aria-label={`Code ${st.code}`}>{st.code}</div>
      </div>
      <p className="ps-note">Check that your other device shows <b>{st.code}</b>, then tap <b>Allow</b>.<br /><span>Waiting for your other device · {clock(left)}</span></p>
    </AuthLayout>
  );
}

/** A redirect sign-in (single sign-on, Google…) that must wait: it arrives here with the request id; the secret is in this browser's cookie. */
export function ApprovalWaitFromRedirect({ id, onApproved, onBack }: { id: string; onApproved: (auth: AuthResponse) => void; onBack: () => void }) {
  const q = useQuery({ queryKey: ['session-approval', id], queryFn: () => sessionApprovalApi.status(id), retry: false, staleTime: Infinity });
  if (q.isLoading) return <PageLoader />;
  const s = q.data;
  return <ApprovalWait start={{ approvalId: id, code: s?.code ?? 0, device: s?.device ?? 'This device', expiresAt: s?.expiresAt ?? new Date().toISOString() }} onApproved={onApproved} onBack={onBack} />;
}

/** The emailed link: shows what it approves; nothing changes until the person taps Allow (mail scanners open links too). */
export function ApproveSignInPage() {
  usePageTitle('Approve sign-in');
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const q = useQuery({ queryKey: ['session-approval-email', token], queryFn: () => sessionApprovalApi.emailPreview(token), retry: false, enabled: !!token });
  const [result, setResult] = useState<'allowed' | 'failed' | null>(null);
  const [busy, setBusy] = useState(false);
  const allow = async () => {
    setBusy(true);
    try { await sessionApprovalApi.emailConfirm(token); setResult('allowed'); }
    catch { setResult('failed'); }
    finally { setBusy(false); }
  };
  if (q.isLoading) return <PageLoader />;
  const d = q.data;
  return (
    <div className="ap-page">
      <div className="ap-card sa-card">
        {result === 'allowed' ? (
          <div className="ap-done"><span className="ps-icon ok"><Icon name="tick" size={30} /></span><h2>Sign-in allowed</h2><p>Go back to the new device: it signs in by itself.</p></div>
        ) : !d || result === 'failed' ? (
          <div className="ap-done"><span className="ps-icon expired"><Icon name="alarm" size={30} /></span><h2>This link has ended</h2><p>It was already used or has expired. Sign in again on the new device to get a new one.</p></div>
        ) : (
          <>
            <span className="sa-device" aria-hidden="true"><Icon name={deviceIcon(d.app)} size={30} /></span>
            <h2>Allow this sign-in?</h2>
            <dl className="sa-facts">
              <div><dt>Device</dt><dd>{d.device}</dd></div>
              <div><dt>App</dt><dd>{APP_LABEL[d.app] ?? d.app}</dd></div>
              {d.location && <div><dt>Near</dt><dd>{d.location}</dd></div>}
              {d.ipAddress && <div><dt>IP address</dt><dd>{d.ipAddress}</dd></div>}
              <div><dt>Time</dt><dd>{formatDateTime(d.createdAt)}</dd></div>
            </dl>
            <div className="sa-actions one"><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void allow()}>Allow sign-in</button></div>
            <p className="sa-foot">Not you? Close this page and change your password.</p>
          </>
        )}
        <Link className="link" to="/login" style={{ marginTop: 10 }}>Go to sign in</Link>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ a device already signed in

/**
 * The question a signed-in device is asked when the account signs in somewhere new: a calm sheet in the middle of the screen (a bottom sheet on a
 * phone) naming the device, app, place, address and time, with the code the new device shows. Allow signs this device out once the new one is in.
 */
export function SessionApprovalHost() {
  const wid = useAuth((s) => s.ctx?.current?.id);
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  useEffect(() => { const f = () => setVisible(document.visibilityState === 'visible'); document.addEventListener('visibilitychange', f); return () => document.removeEventListener('visibilitychange', f); }, []);
  const policy = useQuery({ queryKey: ['session-policy'], queryFn: sessionApprovalApi.policy, enabled: !!wid, staleTime: 5 * 60_000 });
  const on = !!policy.data?.effective;
  const q = useQuery({ queryKey: ['session-approval', 'pending'], queryFn: sessionApprovalApi.pending, enabled: !!wid && on && visible, refetchInterval: 8000, refetchIntervalInBackground: false });
  const [live, setLive] = useState<ApprovalPrompt[]>([]);
  const [gone, setGone] = useState<string[]>([]);
  const [after, setAfter] = useState<'allowed' | null>(null);

  useEffect(() => {
    const onPrompt = (e: Event) => { const p = (e as CustomEvent<ApprovalPrompt>).detail; if (p?.id) setLive((l) => [p, ...l.filter((x) => x.id !== p.id)]); };
    const onClosed = (e: Event) => { const id = (e as CustomEvent<{ id: string }>).detail?.id; if (id) setGone((g) => [...g, id]); };
    const onEnded = (e: Event) => {
      rememberSignedOut((e as CustomEvent<{ message?: string }>).detail?.message ?? 'You were signed out because you signed in on another device.');
      void useAuth.getState().logout();
    };
    window.addEventListener(APPROVAL_EVENT, onPrompt);
    window.addEventListener(APPROVAL_CLOSED_EVENT, onClosed);
    window.addEventListener(SESSION_ENDED_EVENT, onEnded);
    return () => {
      window.removeEventListener(APPROVAL_EVENT, onPrompt); window.removeEventListener(APPROVAL_CLOSED_EVENT, onClosed); window.removeEventListener(SESSION_ENDED_EVENT, onEnded);
    };
  }, []);

  const item = [...live, ...(Array.isArray(q.data) ? q.data : [])].find((p) => !gone.includes(p.id) && secondsLeft(p.expiresAt) > 0) ?? null;
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!item) return;
    haptic([30, 60, 30]);
    const tick = () => setLeft(secondsLeft(item.expiresAt));
    tick(); const t = setInterval(tick, 1000); return () => clearInterval(t);
  }, [item?.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  // After allowing, this device is signed out as soon as the new one is in: check every couple of seconds (a 401 ends the session here).
  useEffect(() => {
    if (after !== 'allowed') return;
    let n = 0;
    const t = setInterval(() => { if (++n > 30) { clearInterval(t); setAfter(null); return; } void meApi.fingerprint().catch(() => undefined); }, 2000);
    return () => clearInterval(t);
  }, [after]);

  if (after === 'allowed') return (
    <div className="sa-scrim" role="presentation">
      <div className="sa-sheet" role="status" aria-live="polite">
        <span className="sa-device ok" aria-hidden="true"><Icon name="tick" size={30} /></span>
        <h2>Allowed</h2>
        <p className="sa-lede">The new device is signing in. This device will sign out in a moment.</p>
      </div>
    </div>
  );
  if (!item || left <= 0) return null;
  const close = () => { setGone((g) => [...g, item.id]); void queryClient.invalidateQueries({ queryKey: ['session-approval'] }); };
  return <ApprovalSheet key={item.id} item={item} left={left} onDone={(outcome) => { close(); if (outcome === 'allowed') setAfter('allowed'); }} />;
}

function ApprovalSheet({ item, left, onDone }: { item: ApprovalPrompt; left: number; onDone: (outcome: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logout = useAuth((s) => s.logout);
  const answer = async (decision: 'allow' | 'reject' | 'not-me') => {
    if (decision === 'not-me' && !(await confirmDialog({
      title: 'Secure your account?', danger: true, confirmText: 'Sign out everywhere',
      message: 'Every device, including this one, is signed out and your password stops working. We email you a link to choose a new one.',
    }))) return;
    setBusy(decision); setError(null); haptic(10);
    try {
      const r = await sessionApprovalApi.decide(item.id, item.token, decision);
      haptic([20, 40, 20]);
      if (decision === 'reject') toast(`Sign-in from ${item.device} was rejected.`, 'warning');
      if (decision === 'not-me') {
        rememberSignedOut('Your account was secured. Check your email for a link to choose a new password.');
        onDone(r.outcome); await logout(); return;
      }
      onDone(r.outcome);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not send your answer.');
      if (e instanceof ApiError && (e.status === 409 || e.status === 404 || e.status === 403)) setTimeout(() => onDone('closed'), 1800);
    } finally { setBusy(null); }
  };
  return (
    <div className="sa-scrim" role="presentation">
      <div className="sa-sheet" role="alertdialog" aria-modal="true" aria-labelledby="sa-title" aria-describedby="sa-lede">
        <span className="sa-device" aria-hidden="true"><Icon name={deviceIcon(item.app)} size={30} /></span>
        <h2 id="sa-title">Sign-in on a new device</h2>
        <p id="sa-lede" className="sa-lede">Your password was entered on <b>{item.device}</b>. Allow it only if this is you.</p>
        <div className="sa-code" aria-label={`Code ${item.code}`}><span>{item.code}</span><small>The new device shows this code</small></div>
        <dl className="sa-facts">
          <div><dt>Device</dt><dd>{item.device}</dd></div>
          <div><dt>App</dt><dd>{APP_LABEL[item.app] ?? item.app}</dd></div>
          <div><dt>Near</dt><dd>{item.location ?? 'Unknown'}</dd></div>
          <div><dt>IP address</dt><dd>{item.ipAddress ?? 'Unknown'}</dd></div>
          <div><dt>Time</dt><dd><time dateTime={item.createdAt}>{formatDateTime(item.createdAt)}</time></dd></div>
        </dl>
        {error && <p className="sa-err" role="alert">{error}</p>}
        <div className="sa-actions">
          <button type="button" className="btn btn-ghost" disabled={!!busy} onClick={() => void answer('reject')}>Reject</button>
          <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => void answer('allow')}>Allow</button>
        </div>
        <p className="sa-foot">Allowing signs this device out · {clock(left)} left</p>
        <button type="button" className="sa-notme" disabled={!!busy} onClick={() => void answer('not-me')}><Icon name="alert" size={14} />This wasn't me — secure my account</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ settings

/** Settings › Security › "Two devices at a time": my own switch, and the organizations that already require it. */
export function SingleSessionRow() {
  const q = useQuery({ queryKey: ['session-policy'], queryFn: sessionApprovalApi.policy });
  const [busy, setBusy] = useState(false);
  const set = async (v: boolean) => {
    setBusy(true);
    try { queryClient.setQueryData(['session-policy'], await sessionApprovalApi.setPolicy(v)); toast(v ? 'New devices now need your approval, and two devices can be signed in at once.' : 'The two-device limit is off.'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not save.', 'error'); }
    finally { setBusy(false); }
  };
  const p = q.data;
  const requiredBy = Array.isArray(p?.requiredBy) ? p.requiredBy : [];
  return (
    <div className="setting-row" data-setting="account.single-session">
      <div className="setting-info">
        <h4>Two devices at a time</h4>
        <p>Stay signed in on two devices, like your phone and your computer. A new device must be allowed from one you are already signed in on, and a third signs out the one you used longest ago.
          {requiredBy.length > 0 && <> <b>Required by {requiredBy.join(', ')}.</b></>}</p>
      </div>
      <SSwitch label="Two devices at a time" on={!!p?.singleSession || requiredBy.length > 0} locked={requiredBy.length > 0} disabled={busy || !p} onChange={(v) => void set(v)} />
    </div>
  );
}

const OUTCOME: Record<ApprovalHistoryItem['outcome'], { label: string; tone: 'success' | 'danger' | 'warning' | 'neutral' }> = {
  allowed: { label: 'Allowed', tone: 'success' }, rejected: { label: 'Rejected', tone: 'danger' }, reported: { label: 'Reported', tone: 'danger' },
  timed_out: { label: 'Timed out', tone: 'warning' }, pending: { label: 'Waiting', tone: 'neutral' },
};
const VIA: Record<string, string> = { session: 'on a signed-in device', email: 'with an emailed link', code: 'with a code' };

/** Every new-device sign-in that asked for approval in the last 90 days, and how it was answered. */
export function ApprovalHistory() {
  const q = useQuery({ queryKey: ['session-approval', 'history'], queryFn: sessionApprovalApi.history });
  if (q.isLoading) return <PageLoader />;
  const rows = Array.isArray(q.data) ? q.data : [];
  return (
    <div className="sih" role="list" aria-label="Approval history">
      {rows.length === 0 && <p className="muted">No new-device sign-ins asked for approval in the last 90 days.</p>}
      {rows.slice(0, 10).map((r) => (
        <div key={r.id} role="listitem" className="sih-row">
          <span className={`sih-dot ${r.outcome === 'allowed' ? 'on' : ''}`} aria-hidden />
          <div className="sih-main">
            <b>{r.device}<Badge tone={OUTCOME[r.outcome].tone}>{OUTCOME[r.outcome].label}</Badge></b>
            <small><time dateTime={r.createdAt}>{formatDateTime(r.createdAt)}</time>{r.location ? ` · ${r.location}` : ''}{r.ipAddress ? ` · ${r.ipAddress}` : ''}{r.decidedVia ? ` · ${VIA[r.decidedVia] ?? r.decidedVia}` : ''}</small>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Workspace settings › Sign-in rules: the organization requires "Two devices at a time" of every member. */
export function WorkspaceSessionPolicyRow() {
  const q = useQuery({ queryKey: ['workspace-session-policy'], queryFn: sessionApprovalApi.workspacePolicy });
  const [busy, setBusy] = useState(false);
  const set = async (v: boolean) => {
    setBusy(true);
    try {
      queryClient.setQueryData(['workspace-session-policy'], await sessionApprovalApi.setWorkspacePolicy(v));
      void queryClient.invalidateQueries({ queryKey: ['session-policy'] });
      toast(v ? 'Members can now be signed in on two devices, and a new device must be approved from one of them.' : 'The two-device rule is no longer required.');
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not save.', 'error'); }
    finally { setBusy(false); }
  };
  if (!q.data || typeof q.data.singleActiveSession !== 'boolean') return null;
  return (
    <div className="setting-row sa-ws-row" data-setting="security.single-session">
      <div className="setting-info">
        <h4>Two devices at a time</h4>
        <p>Each member can be signed in on two devices at once, such as a phone and a computer. A new device waits until the member allows it from a device already signed in; a third signs out the one used longest ago.</p>
      </div>
      <SSwitch label="Require two devices at a time" on={q.data.singleActiveSession} disabled={busy || !q.data.canManage} onChange={(v) => void set(v)} />
    </div>
  );
}

/** "Chrome on Windows · near Kolkata · 203.0.113.7 · active 2 min ago" for a session row. */
export function sessionLine(s: { device?: string | null; location?: string | null; ipAddress: string | null; lastSeenAt: string }) {
  return [s.location ? `near ${s.location}` : null, s.ipAddress ?? 'Unknown IP', `active ${timeAgo(s.lastSeenAt)}`].filter(Boolean).join(' · ');
}
