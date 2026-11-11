import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { ApiError, refreshSession, refreshWasRefused, setAccessToken } from '../../api/client';
import { idleApi, idleLabel, type LockState } from '../../api/endpoints.idle';
import { isSessionLocked, markLocked, markUnlocked, onLockChange } from '../../api/lockState';
import { Face } from '../../components/Face';
import { Icon } from '../../components/Icon';
import { useAfterFirstPaint } from '../../lib/afterFirstPaint';
import { countdown, createIdleLock, type IdleLock, type IdlePhase } from '../../lib/idleLock';
import { passkeysSupported, requestPasskey, wasCancelled } from '../../lib/passkeys';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import './idleLock.css';

const SIGNED_OUT_REASON = 'pm_signed_out_reason';

/**
 * "Sign out after inactivity" in the signed-in app: the shared idle timer, the "Still there?" card two minutes before the workspace's time, and the
 * lock screen at the time. The app stays mounted behind the lock (blurred and inert), so a half-written comment or an open sheet is exactly as it
 * was after unlocking; requests made meanwhile wait and go out then. Phones, the installed app and the desktop app lock the same way the moment
 * they come back after the time (their timers sleep in the background).
 */
export function IdleLockHost() {
  const wid = useWorkspaceId();
  // The lock time is not needed to draw the first screen: until it arrives the default below applies, so the read waits for the first paint.
  const painted = useAfterFirstPaint();
  const policy = useQuery({ queryKey: ['idle-policy', wid], queryFn: idleApi.policy, enabled: !!wid && painted, staleTime: 5 * 60_000, retry: false });
  const minutes = policy.data?.minutes ?? 30;
  const [phase, setPhase] = useState<IdlePhase>(isSessionLocked() ? 'locked' : 'active');
  const [left, setLeft] = useState(0);
  const lockRef = useRef<IdleLock | null>(null);
  const logout = useAuth((s) => s.logout);

  const signOut = useCallback(async (reason?: string) => {
    if (reason) { try { sessionStorage.setItem(SIGNED_OUT_REASON, reason); } catch { /* storage unavailable */ } }
    lockRef.current?.signedOut();
    markUnlocked(false);
    setPhase('active');
    await logout();
  }, [logout]);

  useEffect(() => {
    const lock = createIdleLock({
      timeoutMs: minutes * 60_000,
      onPhase: (p, ms) => { setLeft(ms); setPhase(p); if (p === 'locked') markLocked(); },
      onPing: () => { void idleApi.activity().catch(() => undefined); },
      onLockDue: () => { void idleApi.lock().catch(() => undefined); },
      onRemote: (what) => {
        if (what === 'lock') { markLocked(); return; }
        if (what === 'signout') { markUnlocked(false); void logout(); return; }
        // Another tab unlocked: the cookie it was given is this browser's, so a refresh here gets this tab its own access token.
        void refreshSession().then((auth) => {
          if (auth) { setPhase('active'); markUnlocked(true); }
          else if (refreshWasRefused()) { markUnlocked(false); void logout(); }
        });
      },
    });
    lockRef.current = lock;
    // A 401 SESSION_IDLE_LOCKED from the server (this device slept, another device's policy) locks here and in every tab too.
    const off = onLockChange((l) => { if (l && lock.phase() !== 'locked') { lock.lockNow(); setPhase('locked'); } });
    if (isSessionLocked()) { lock.lockNow(); setPhase('locked'); }
    return () => { off(); lock.stop(); lockRef.current = null; };
    // The timer is made once; a policy change only moves its limit (below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { lockRef.current?.setTimeoutMs(minutes * 60_000); }, [minutes]);

  const unlocked = useCallback(async (accessToken: string) => {
    setAccessToken(accessToken);
    lockRef.current?.unlocked();
    markUnlocked(true);
    setPhase('active');
    // Fresh context in the background (the page may have started from this device's saved copy while locked); nothing on screen is replaced.
    void useAuth.getState().reloadContext().catch(() => undefined);
  }, []);

  if (phase === 'warning') return <StillThere left={left} onStay={() => { lockRef.current?.touch(); setPhase('active'); }} />;
  if (phase === 'locked') return <LockScreen minutes={minutes} onUnlocked={unlocked} onSignOut={signOut} />;
  return null;
}

/** "Still there?": two minutes before the lock, with a live countdown. Any real use counts as "Stay signed in" too. */
function StillThere({ left, onStay }: { left: number; onStay: () => void }) {
  return (
    <div className="il-warn" role="alertdialog" aria-labelledby="il-warn-title" aria-describedby="il-warn-text" data-testid="idle-warning">
      <div className="il-warn-icon" aria-hidden="true"><Icon name="clock" /></div>
      <div className="il-warn-body">
        <h2 id="il-warn-title">Still there?</h2>
        <p id="il-warn-text">You'll be signed out in <b className="il-count" aria-live="off">{countdown(left)}</b></p>
      </div>
      <button type="button" className="btn btn-primary il-warn-btn" onClick={onStay} autoFocus>Stay signed in</button>
    </div>
  );
}

const FingerPrint = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
    <path d="M12 11c0 3.5-.9 6.6-2.5 9" /><path d="M8.5 8.9A4 4 0 0 1 16 11c0 1-.1 2-.2 3" /><path d="M5.4 7.2A8 8 0 0 1 20 11c0 2.4-.3 4.6-.9 6.6" />
    <path d="M4 11.5c0 1.5-.3 2.9-.8 4.1" /><path d="M14.7 17.3c-.3 1.4-.8 2.7-1.4 3.9" /><path d="M8 6.1A8 8 0 0 1 18.7 7" />
  </svg>
);

/** The lock screen: the person's face and name over the blurred app, a passkey first (this device's fingerprint, face or PIN), the password otherwise. */
function LockScreen({ minutes, onUnlocked, onSignOut }: { minutes: number; onUnlocked: (accessToken: string) => Promise<void>; onSignOut: (reason?: string) => Promise<void> }) {
  const me = useAuth((s) => s.ctx?.user);
  const [state, setState] = useState<LockState | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'password' | 'passkey' | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const canPasskey = passkeysSupported() && (state?.hasPasskey ?? false);

  useEffect(() => {
    let alive = true;
    idleApi.state().then((s) => { if (alive) setState(s); }).catch((e) => {
      // The session is over (signed out elsewhere, expired): there is nothing to unlock.
      if (alive && e instanceof ApiError && e.status === 401 && e.code !== 'SESSION_IDLE_LOCKED') void onSignOut(e.message);
    });
    return () => { alive = false; };
  }, [onSignOut]);

  // The app behind is inert while locked: no focus, no clicks, nothing read out. Nothing of it is unmounted.
  useEffect(() => {
    const root = document.getElementById('root');
    root?.setAttribute('inert', '');
    document.documentElement.classList.add('il-locked');
    return () => { root?.removeAttribute('inert'); document.documentElement.classList.remove('il-locked'); };
  }, []);
  useEffect(() => { if (state && !canPasskey) inputRef.current?.focus(); }, [state, canPasskey]);

  const failed = async (e: unknown, method: 'password' | 'passkey') => {
    if (method === 'passkey' && wasCancelled(e)) { setError(null); return; }
    if (e instanceof ApiError && (e.code === 'SESSION_UNLOCK_SIGNED_OUT' || e.code === 'SESSION_EXPIRED' || e.code === 'SESSION_REPLACED' || e.code === 'ACCOUNT_DISABLED')) {
      await onSignOut(e.message);
      return;
    }
    setError(e instanceof ApiError ? e.message : 'Could not unlock. Check your connection and try again.');
    if (e instanceof ApiError && e.code === 'UNLOCK_FAILED') setState((s) => (s ? { ...s, attemptsLeft: Math.max(0, s.attemptsLeft - 1) } : s));
    if (method === 'password') { setPassword(''); inputRef.current?.focus(); }
  };

  const withPassword = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!password || busy) return;
    setBusy('password'); setError(null);
    try { const auth = await idleApi.unlockWithPassword(password); await onUnlocked(auth.accessToken); }
    catch (e) { await failed(e, 'password'); }
    finally { setBusy(null); }
  };

  const withPasskey = async () => {
    if (busy) return;
    setBusy('passkey'); setError(null);
    try {
      const { challengeId, options } = await idleApi.passkeyOptions();
      // This device's own fingerprint, face or PIN first; a security key or a phone is still offered by the browser.
      const response = await requestPasskey({ ...options, hints: ['client-device'] });
      const auth = await idleApi.unlockWithPasskey(challengeId, response);
      await onUnlocked(auth.accessToken);
    } catch (e) { await failed(e, 'passkey'); }
    finally { setBusy(null); }
  };

  const name = state?.displayName ?? me?.displayName ?? '';
  const away = idleLabel(state?.idleMinutes || minutes);
  return createPortal(
    <div className="il-lock" role="dialog" aria-modal="true" aria-labelledby="il-lock-name" data-testid="idle-lock">
      <div className="il-lock-card">
        <Face className="il-face" userId={state?.userId ?? me?.id} name={name} hasAvatar={state?.hasAvatar ?? me?.hasAvatar} />
        <h1 id="il-lock-name" className="il-name">{name}</h1>
        <p className="il-sub"><Icon name="lock" /> Locked after {away === 'Never' ? 'a while' : away} away</p>

        {canPasskey && (
          <button type="button" className="il-passkey" onClick={() => void withPasskey()} disabled={!!busy} data-testid="unlock-passkey">
            <FingerPrint /> {busy === 'passkey' ? 'Waiting for your device…' : 'Unlock with passkey'}
          </button>
        )}
        {canPasskey && (state?.hasPassword ?? true) && <div className="il-or" aria-hidden="true"><span>or</span></div>}

        {(state?.hasPassword ?? true) && (
          <form className="il-form" onSubmit={(e) => void withPassword(e)}>
            <label className="sr-only" htmlFor="il-password">Password</label>
            <div className={`il-field${error ? ' il-field-error' : ''}`}>
              <input ref={inputRef} id="il-password" type="password" autoComplete="current-password" placeholder="Password" value={password}
                onChange={(e) => { setPassword(e.target.value); if (error) setError(null); }} disabled={busy === 'password'} aria-invalid={!!error} aria-describedby={error ? 'il-error' : undefined} />
              <button type="submit" className="il-go" aria-label="Unlock" disabled={!password || !!busy}><Icon name="arrowRight" /></button>
            </div>
          </form>
        )}
        <p id="il-error" className="il-error" role="alert">{error ?? ''}</p>

        <button type="button" className="il-signout" onClick={() => void onSignOut()}>Not you? <span>Sign out</span></button>
      </div>
    </div>,
    document.body,
  );
}
