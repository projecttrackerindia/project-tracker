import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/ui';
import { Link } from 'react-router-dom';
import { passkeysSupported, requestPasskey, wasCancelled } from '../../lib/passkeys';
import { vaultApi } from './api';
import { StepUpContext, type StepUpApi } from './stepUpContext';

/** The token lives only in memory, for the few minutes the server gives it, and never in storage or an address. */
export function StepUpProvider({ mfaEnabled, hasPasskeys = false, children }: { mfaEnabled: boolean; hasPasskeys?: boolean; children: ReactNode }) {
  const token = useRef<{ value: string; until: number } | null>(null);
  const [asking, setAsking] = useState<{ resolve: (t: string | null) => void; reason: string } | null>(null);
  const current = () => (token.current && token.current.until > Date.now() ? token.current.value : undefined);
  const prompt = useCallback((reason: string) => new Promise<string | null>((resolve) => setAsking({ resolve, reason })), []);

  const run = useCallback(async <T,>(fn: (t?: string) => Promise<T>, ask = false): Promise<T | null> => {
    let t = current();
    if (ask && !t) {
      t = (await prompt('This is protected with a two-step check.')) ?? undefined;
      if (!t) return null;
    }
    try { return await fn(t); }
    catch (e) {
      if (!(e instanceof ApiError) || e.code !== 'STEP_UP_REQUIRED') throw e;
      token.current = null;
      const fresh = await prompt(e.message);
      if (!fresh) return null;
      return await fn(fresh);
    }
  }, [prompt]);

  const value = useMemo<StepUpApi>(() => ({ run, forget: () => { token.current = null; }, fresh: () => !!current() }), [run]);
  return (
    <StepUpContext.Provider value={value}>
      {children}
      {asking && <StepUpModal reason={asking.reason} mfaEnabled={mfaEnabled} hasPasskeys={hasPasskeys}
        onClose={() => { asking.resolve(null); setAsking(null); }}
        onDone={(t) => { token.current = { value: t.token, until: Date.parse(t.expiresAt) - 5000 }; asking.resolve(t.token); setAsking(null); }} />}
    </StepUpContext.Provider>
  );
}

function StepUpModal({ reason, mfaEnabled, hasPasskeys, onClose, onDone }: { reason: string; mfaEnabled: boolean; hasPasskeys: boolean; onClose: () => void; onDone: (t: { token: string; expiresAt: string }) => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'code' | 'passkey' | null>(null);
  const passkey = hasPasskeys && passkeysSupported();
  if (!mfaEnabled && !passkey) return (
    <Modal title="Turn on two-step verification" size="sm" onClose={onClose}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Not now</button><Link className="btn btn-primary" to="/account/security" onClick={onClose}>Set it up</Link></>}>
      <p>{reason}</p>
      <p className="muted">Confidential items, earlier values and some workspace rules need a fresh check: a passkey (fingerprint, face or screen lock) or a code from an authenticator app. Set one up in My account → Security; it takes a minute.</p>
    </Modal>
  );
  // A passkey answers the server's challenge with this device's own key, after the fingerprint, face or PIN: nothing to type or phish.
  const withPasskey = async () => {
    setError(null); setBusy('passkey');
    try {
      const ch = await vaultApi.stepUpPasskeyOptions();
      onDone(await vaultApi.stepUpPasskey(ch.challengeId, await requestPasskey(ch.options)));
    } catch (err) {
      if (!wasCancelled(err)) setError(err instanceof ApiError ? err.message : 'The passkey check did not work. Try again or use a code.');
      setBusy(null);
    }
  };
  return (
    <Modal title="Confirm it is you" subtitle={reason} size="sm" onClose={onClose} className="vlt-scope"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!mfaEnabled) return;
        setError(null); setBusy('code');
        try { onDone(await vaultApi.stepUp(code.replace(/\s/g, ''))); }
        catch (err) { setError(err instanceof ApiError ? err.message : 'Could not check the code.'); setBusy(null); }
      }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>{mfaEnabled && <button className="btn btn-primary" disabled={busy !== null || code.replace(/\s/g, '').length < 6}>{busy === 'code' && <span className="spinner" />}Confirm</button>}</>}>
      {passkey && (
        <button type="button" className="btn btn-primary vlt-passkey-btn" disabled={busy !== null} onClick={() => void withPasskey()} data-testid="step-up-passkey">
          {busy === 'passkey' ? <span className="spinner" /> : <Icon name="key" size={16} />} Use a passkey
          <small>fingerprint, face or screen lock</small>
        </button>
      )}
      {passkey && mfaEnabled && <p className="vlt-or" aria-hidden="true"><span>or</span></p>}
      {mfaEnabled && (
        <label className="field"><span>Code from your authenticator app (or a recovery code)</span>
          <input className="input vlt-code-input" value={code} inputMode="numeric" autoComplete="one-time-code" autoFocus={!passkey} maxLength={20} onChange={(e) => setCode(e.target.value)} placeholder="123 456" aria-label="Two-step code" /></label>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      <p className="muted vlt-small">The check stays fresh for a few minutes on this page only.</p>
    </Modal>
  );
}
