import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { BrandMark } from '../../components/BrandMark';
import { Icon } from '../../components/Icon';
import { formatDateTime } from '../../lib/format';
import { vaultApi, type SecretLinkInfo } from './api';
import { LinkKeyError, openLink, type LinkPayload } from './e2ee/links';
import { copySecret } from './secure';
import './vault.css';

/**
 * Where a one-time link leads, without signing in. Looking at the page does not use the link (chat apps fetch links to preview them);
 * pressing Open does. The key is the part of the address after #, which the browser never sends: it is read here, removed from the address
 * bar at once, and used only in this page's memory.
 */
export function SecretLinkPage() {
  const { token = '' } = useParams();
  const fragment = useRef<string>(typeof window !== 'undefined' ? window.location.hash.slice(1) : '');
  const [info, setInfo] = useState<SecretLinkInfo | null>(null);
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cipher = useRef<string | null>(null);
  const [secret, setSecret] = useState<LinkPayload | null>(null);
  const [shown, setShown] = useState<number | null>(null);

  useEffect(() => {
    // The key leaves the address bar (and so the history entry) right away.
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
    vaultApi.linkInfo(token).then(setInfo).catch(() => setInfo({ state: 'gone' } as SecretLinkInfo));
    const forget = () => { cipher.current = null; setSecret(null); };
    window.addEventListener('pagehide', forget);
    return () => window.removeEventListener('pagehide', forget);
  }, [token]);
  useEffect(() => { if (shown === null) return; const t = window.setTimeout(() => setShown(null), 20_000); return () => window.clearTimeout(t); }, [shown]);

  const complete = fragment.current.length >= 40;
  const open = async () => {
    setBusy(true); setError(null);
    try {
      if (!cipher.current) cipher.current = (await vaultApi.openSecretLink(token)).cipher;
      setSecret(await openLink(token, fragment.current, cipher.current, info?.hasPassphrase ? pass : null, info?.salt ?? null, info?.params ?? null));
    } catch (e) {
      // A wrong passphrase can be tried again: what was handed out stays in this page's memory (and nowhere else).
      setError(e instanceof LinkKeyError || e instanceof ApiError ? e.message : 'It did not open. Check your connection.');
      if (e instanceof ApiError) setInfo({ state: 'gone' } as SecretLinkInfo);
    } finally { setBusy(false); }
  };

  return (
    <div className="auth-shell"><div className="auth-card ra-page vlt-scope vlt-secret-page" data-testid="secret-page">
      <div className="ra-page-brand"><span className="brand-mark"><BrandMark /></span> Project Tracker{info?.workspace && <span className="muted"> · {info.workspace}</span>}</div>
      {!info ? <div className="ra-page-loading"><span className="spinner" /></div>
        : secret ? (
          <>
            <div className="ra-page-ico done"><Icon name="lock" size={28} /></div>
            <h1 className="auth-title">{secret.title}</h1>
            <p className="auth-sub">Save it where it belongs now. This page cannot show it again{info.viewsLeft > 1 ? '' : ': the link is destroyed'}.</p>
            <ul className="vlt-secret-fields">
              {secret.fields.map((f, i) => (
                <li key={i}>
                  <span className="vlt-field-label">{f.label}</span>
                  <div className="vlt-field-row">
                    <code className={`vlt-field-value vlt-secret${!f.secret || shown === i ? ' open' : ''}`} data-state={!f.secret || shown === i ? 'revealed' : 'masked'}>{!f.secret || shown === i ? f.value : '••••••••••••'}</code>
                    {f.secret && <button type="button" className="btn-icon" aria-label={shown === i ? `Hide ${f.label}` : `Show ${f.label}`} onClick={() => setShown(shown === i ? null : i)}><Icon name={shown === i ? 'eyeOff' : 'eye'} size={15} /></button>}
                    <button type="button" className="btn-icon" aria-label={`Copy ${f.label}`} onClick={() => void copySecret(f.value, 60).then((ok) => setError(ok ? null : 'The browser did not allow copying.'))}><Icon name="copy" size={15} /></button>
                  </div>
                </li>
              ))}
            </ul>
            {error && <div className="form-error" role="alert">{error}</div>}
          </>
        ) : info.state !== 'ready' ? (
          <>
            <div className="ra-page-ico off"><Icon name="lock" size={28} /></div>
            <h1 className="auth-title">This link no longer works</h1>
            <p className="auth-sub">It was already opened, revoked, or it ran out of time — the secret in it has been destroyed. Ask the person who sent it for a new one.</p>
            <p className="vlt-small muted">If you did not open it yourself, tell them: someone else may have.</p>
          </>
        ) : (
          <>
            <div className="ra-page-ico"><Icon name="key" size={28} /></div>
            <h1 className="auth-title">{info.from ? `${info.from} sent you a secret` : 'Someone sent you a secret'}</h1>
            {info.note && <p className="auth-sub">“{info.note}”</p>}
            <p className="ra-page-state">{info.viewsLeft === 1 ? 'It opens once.' : `It opens ${info.viewsLeft} more times.`} {info.expiresAt ? `Destroyed ${formatDateTime(info.expiresAt)} at the latest.` : ''}</p>
            {!complete && <div className="form-error" role="alert">This link is incomplete: copy all of it, including the part after #. Nothing has been used up.</div>}
            {complete && info.hasPassphrase && (
              <label className="field vlt-secret-pass"><span>Passphrase (the sender tells you this separately)</span>
                <input className="input" value={pass} autoFocus autoComplete="off" spellCheck={false} onChange={(e) => setPass(e.target.value)} aria-label="Passphrase" /></label>
            )}
            {error && <div className="form-error" role="alert">{error}</div>}
            {complete && (
              <div className="ra-page-actions">
                <button type="button" className="btn btn-primary" disabled={busy || (info.hasPassphrase && pass.length < 1)} onClick={() => void open()}>{busy ? <span className="spinner" /> : <Icon name="lock" size={15} />} {cipher.current ? 'Try again' : 'Open the secret'}</button>
              </div>
            )}
            <p className="vlt-small muted"><Icon name="shield" size={12} /> Decrypted in this browser. The key is in your link, never on our servers.</p>
          </>
        )}
    </div></div>
  );
}
