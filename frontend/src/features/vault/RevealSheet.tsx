import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { passkeysSupported, requestPasskey, wasCancelled } from '../../lib/passkeys';
import { vaultApi } from './api';
import './reveal-sheet.css';

export interface RevealGrant { token: string; expiresAt: string }

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/** A padlock whose shackle lifts when the check passes. */
function LockGlyph({ open }: { open: boolean }) {
  return (
    <svg className={`rv-lock${open ? ' open' : ''}`} width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path className="rv-shackle" d="M8 11V8a4 4 0 0 1 8 0v3" />
      <rect x="5" y="11" width="14" height="10" rx="2.5" />
      <path d="M12 15v2" />
    </svg>
  );
}

/**
 * The check before a vault value is shown on screen: the account password AND a two-step code or a passkey. The server checks both and
 * gives a reveal grant for a few minutes; this sheet only collects them. It rises with a spring; on success the lock opens (the shackle
 * lifts), and the sheet shrinks into the field it was opened from, where the dots then turn into characters. A wrong answer shakes the
 * field once. With reduced motion, it simply appears and goes.
 */
export function RevealSheet({ mfaEnabled, hasPasskeys, anchor, onClose, onDone }: {
  mfaEnabled: boolean; hasPasskeys: boolean; anchor: HTMLElement | null; onClose: () => void; onDone: (g: RevealGrant) => void;
}) {
  const titleId = useId();
  const sheet = useRef<HTMLDivElement>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'code' | 'passkey' | null>(null);
  const [phase, setPhase] = useState<'ask' | 'unlocked' | 'morph'>('ask');
  const [shake, setShake] = useState<'password' | 'code' | null>(null);
  const [morph, setMorph] = useState<CSSProperties | undefined>();
  const passkey = hasPasskeys && passkeysSupported();
  const none = !mfaEnabled && !passkey;

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && phase === 'ask') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose, phase]);

  const fail = (field: 'password' | 'code', message: string) => {
    setError(message); setBusy(null);
    setShake(null);
    window.requestAnimationFrame(() => setShake(field));
  };

  const succeed = async (g: RevealGrant) => {
    if (reducedMotion()) { onDone(g); return; }
    setPhase('unlocked');
    await wait(300);   // the shackle lifts
    const from = sheet.current?.getBoundingClientRect(), to = anchor?.getBoundingClientRect();
    if (from && to && to.width > 0) {
      const sx = Math.max(0.08, to.width / from.width), sy = Math.max(0.04, to.height / from.height);
      const dx = to.left + to.width / 2 - (from.left + from.width / 2), dy = to.top + to.height / 2 - (from.top + from.height / 2);
      setMorph({ transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0 });
    } else setMorph({ transform: 'scale(.9)', opacity: 0 });
    setPhase('morph');
    await wait(280);   // the sheet settles into the field
    onDone(g);
  };

  const failure = (err: unknown) => {
    if (!(err instanceof ApiError)) return fail('password', 'Could not check that. Try again.');
    if (err.code === 'REVEAL_SECOND_FACTOR_REQUIRED') return fail('code', err.message);
    const field = /password/i.test(err.message) ? 'password' : 'code';
    return fail(field, err.message);
  };

  const withCode = async () => {
    if (!password) return fail('password', 'Enter your account password.');
    setError(null); setBusy('code');
    const c = code.replace(/\s/g, '');
    try { await succeed(await vaultApi.revealStepUp(c ? { password, code: c } : { password })); }
    catch (err) { failure(err); }
  };

  const withPasskey = async () => {
    if (!password) return fail('password', 'Enter your account password first.');
    setError(null); setBusy('passkey');
    try {
      const ch = await vaultApi.stepUpPasskeyOptions();
      const response = await requestPasskey(ch.options);
      await succeed(await vaultApi.revealStepUp({ password, challengeId: ch.challengeId, response }));
    } catch (err) {
      if (wasCancelled(err)) { setBusy(null); return; }
      failure(err);
    }
  };

  return (
    <div className={`rv-scrim${phase === 'morph' ? ' out' : ''}`} onMouseDown={(e) => { if (e.target === e.currentTarget && phase === 'ask' && !busy) onClose(); }}>
      <div ref={sheet} className={`rv-sheet ${phase}`} role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="reveal-sheet" style={morph}>
        <div className="rv-head">
          <LockGlyph open={phase !== 'ask'} />
          <h2 id={titleId}>{none ? 'Turn on two-step verification' : 'Reveal value'}</h2>
          <p>{none
            ? 'Turn on two-step verification or add a passkey to reveal values.'
            : 'Values stay copy-only. To show one on screen, confirm your password and a second check.'}</p>
        </div>
        {none ? (
          <>
            <p className="rv-note">You can still copy values; the clipboard clears itself.</p>
            <div className="rv-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>Not now</button>
              <Link className="btn btn-primary" to="/account/security" onClick={onClose}>Open Settings › Security</Link>
            </div>
          </>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); if (mfaEnabled) void withCode(); else void withPasskey(); }}>
            <label className={`rv-field${shake === 'password' ? ' shake' : ''}`} onAnimationEnd={() => setShake(null)}>
              <span>Account password</span>
              <input className="input" type="password" value={password} autoComplete="current-password" autoFocus aria-label="Account password"
                onChange={(e) => setPassword(e.target.value)} disabled={phase !== 'ask'} />
            </label>
            {mfaEnabled && (
              <label className={`rv-field${shake === 'code' ? ' shake' : ''}`} onAnimationEnd={() => setShake(null)}>
                <span>Two-step code (or a recovery code)</span>
                <input className="input rv-code" value={code} inputMode="numeric" autoComplete="one-time-code" maxLength={20} placeholder="123 456" aria-label="Two-step code"
                  onChange={(e) => setCode(e.target.value)} disabled={phase !== 'ask'} />
              </label>
            )}
            {passkey && mfaEnabled && <p className="rv-or" aria-hidden="true"><span>or</span></p>}
            {passkey && (
              <button type="button" className="btn btn-ghost rv-passkey" disabled={busy !== null || phase !== 'ask'} onClick={() => void withPasskey()} data-testid="reveal-passkey">
                {busy === 'passkey' ? <span className="spinner" /> : <Icon name="key" size={16} />} Use a passkey with your password
              </button>
            )}
            {error && <p className="form-error" role="alert">{error}</p>}
            <div className="rv-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={phase !== 'ask'}>Cancel</button>
              {mfaEnabled && <button className="btn btn-primary" disabled={busy !== null || phase !== 'ask' || !password}>{busy === 'code' && <span className="spinner" />}Reveal</button>}
            </div>
            <p className="rv-note">Shown for a few seconds, then hidden again. Every reveal is recorded.</p>
          </form>
        )}
      </div>
    </div>
  );
}
