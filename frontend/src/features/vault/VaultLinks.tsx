import { useState } from 'react';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { EmptyState, ErrorState, Modal, Spinner } from '../../components/ui';
import { formatDateTime, timeAgo } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { confirmDialog, toast } from '../../stores/ui';
import { LINK_HOURS, vaultApi, type SecretLink, type VaultItem } from './api';
import { sealLink, type LinkField } from './e2ee/links';
import type * as sealed from './e2ee/sealed';
import { copySecret } from './secure';
import { useStepUp } from './stepUpContext';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError || e instanceof Error ? e.message || fallback : fallback);
const HOURS_LABEL: Record<number, string> = { 1: '1 hour', 24: '1 day', 72: '3 days', 168: '1 week' };

export type LinkSource =
  | { kind: 'guarded'; item: VaultItem }
  | { kind: 'sealed'; item: sealed.SealedItem }
  | { kind: 'blank' };

/**
 * Sends a secret once: the browser encrypts it with a key that only the link carries (after the #), so the server — and anyone reading its
 * database or logs — gets nothing readable. The link opens the chosen number of times before the deadline, then the secret is destroyed.
 */
export function SendLinkModal({ source, clipboardSeconds, onClose }: { source: LinkSource; clipboardSeconds: number; onClose: () => void }) {
  const step = useStepUp();
  const fieldsOf = (): { key: string; label: string; secret: boolean; value?: string | null }[] => {
    if (source.kind === 'guarded') return source.item.fields.filter((f) => f.type !== 'totp' && (f.secret || !!f.value)).map((f) => ({ key: f.key, label: f.label, secret: f.secret, value: f.secret ? null : f.value }));
    if (source.kind === 'sealed') return (source.item.payload?.fields ?? []).filter((f) => f.type !== 'totp' && !!f.value).map((f) => ({ key: f.key, label: f.label, secret: f.secret, value: f.value }));
    return [];
  };
  const available = fieldsOf();
  const title = source.kind === 'guarded' ? source.item.item.title : source.kind === 'sealed' ? source.item.payload?.title ?? 'Secret' : '';
  const [picked, setPicked] = useState<string[]>(available.map((f) => f.key));
  const [blankTitle, setBlankTitle] = useState('');
  const [blankUser, setBlankUser] = useState('');
  const [blankSecret, setBlankSecret] = useState('');
  const [views, setViews] = useState(1);
  const [hours, setHours] = useState(24);
  const [usePass, setUsePass] = useState(false);
  const [pass, setPass] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ url: string; expiresAt: string; views: number } | null>(null);

  const ready = source.kind === 'blank' ? !!blankTitle.trim() && !!blankSecret : picked.length > 0;
  const create = async () => {
    setError(null); setBusy(true);
    try {
      let fields: LinkField[];
      let token: string | undefined;
      if (source.kind === 'blank') {
        fields = [...(blankUser.trim() ? [{ label: 'User name', value: blankUser.trim(), secret: false }] : []), { label: 'Secret', value: blankSecret, secret: true }];
      } else if (source.kind === 'sealed') {
        fields = available.filter((f) => picked.includes(f.key)).map((f) => ({ label: f.label, value: f.value ?? '', secret: f.secret }));
      } else {
        // A guarded value comes from the server one field at a time, with the same checks as copying it (and recorded the same way).
        fields = [];
        for (const f of available.filter((x) => picked.includes(x.key))) {
          if (!f.secret) { fields.push({ label: f.label, value: f.value ?? '', secret: false }); continue; }
          const res = await step.run((t) => { token = t; return vaultApi.reveal(source.item.item.id, f.key, true, t); }, source.item.needsStepUp);
          if (!res) { setBusy(false); return; }
          fields.push({ label: f.label, value: res.value, secret: true });
        }
      }
      const sealedLink = await sealLink({ v: 1, title: source.kind === 'blank' ? blankTitle.trim() : title, fields }, usePass ? pass : null);
      fields.forEach((f) => { f.value = ''; });
      const itemId = source.kind === 'guarded' ? source.item.item.id : source.kind === 'sealed' ? source.item.row.id : null;
      const res = await step.run((t) => vaultApi.createLink({ ...sealedLink.body, itemId, note: note.trim() || null, maxViews: views, hours, stepUp: t ?? token }), false);
      if (!res) { setBusy(false); return; }
      setMade({ url: sealedLink.url, expiresAt: res.expiresAt, views });
    } catch (e) { setError(errText(e, 'Could not make the link.')); }
    finally { setBusy(false); }
  };

  if (made) return (
    <Modal title="Your one-time link" subtitle="Send it to one person. It is destroyed after it is opened, or when it runs out." size="sm" onClose={onClose} className="vlt-scope"
      footer={<button type="button" className="btn btn-primary" onClick={onClose}>Done</button>}>
      <div className="vlt-link-made" data-testid="link-made">
        <code className="vlt-link-url">{made.url}</code>
        <button type="button" className="btn btn-primary" onClick={() => void copySecret(made.url, Math.max(clipboardSeconds, 60)).then((ok) => toast(ok ? 'Link copied. The clipboard clears in a minute.' : 'The browser did not allow copying.', ok ? 'success' : 'error'))}>
          <Icon name="copy" size={15} /> Copy the link</button>
        <p className="vlt-small muted">Opens {made.views === 1 ? 'once' : `${made.views} times`} · until {formatDateTime(made.expiresAt)} · you are told when it is opened.</p>
        {usePass && <p className="vlt-small vlt-warn"><b>Tell them the passphrase another way</b> — by phone, or in person. Never in the same message as the link.</p>}
        <p className="vlt-small muted"><Icon name="lock" size={12} /> The key is the part after #. It never reaches our servers: we cannot read this secret.</p>
      </div>
    </Modal>
  );

  return (
    <Modal title={source.kind === 'blank' ? 'Send a secret once' : `Send “${title}” once`} subtitle="Encrypted on this device. The link carries the key; the server keeps only scrambled data." size="sm" onClose={onClose} className="vlt-scope"
      onSubmit={(e) => { e.preventDefault(); void create(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !ready || (usePass && pass.length < 6)}>{busy && <span className="spinner" />}Make the link</button></>}>
      <div className="vlt-req-form">
        {source.kind === 'blank' ? (
          <>
            <label className="field"><span>What it is</span><input className="input" value={blankTitle} maxLength={120} autoFocus onChange={(e) => setBlankTitle(e.target.value)} placeholder="Guest Wi-Fi" /></label>
            <label className="field"><span>User name (optional)</span><input className="input" value={blankUser} maxLength={200} autoComplete="off" onChange={(e) => setBlankUser(e.target.value)} /></label>
            <label className="field"><span>Secret</span><textarea className="textarea vlt-mono" rows={3} value={blankSecret} maxLength={20000} autoComplete="off" spellCheck={false} onChange={(e) => setBlankSecret(e.target.value)} /></label>
          </>
        ) : (
          <div className="field"><span className="vlt-field-label">What to send</span>
            <div className="vlt-link-fields">
              {available.map((f) => (
                <label key={f.key} className="vlt-check-row"><input type="checkbox" checked={picked.includes(f.key)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, f.key] : p.filter((x) => x !== f.key)))} />
                  <span>{f.label}{f.secret && <span className="muted"> · secret</span>}</span></label>
              ))}
              {available.length === 0 && <p className="muted">Nothing on this item can be sent.</p>}
            </div>
          </div>
        )}
        <div className="field"><span className="vlt-field-label">Opens</span>
          <div className="seg" role="radiogroup" aria-label="Opens">
            {[1, 2, 3, 5].map((n) => <button key={n} type="button" role="radio" aria-checked={views === n} onClick={() => setViews(n)}>{n === 1 ? 'Once' : `${n} times`}</button>)}
          </div>
        </div>
        <div className="field"><span className="vlt-field-label">Destroyed after</span>
          <div className="seg" role="radiogroup" aria-label="Destroyed after">
            {LINK_HOURS.map((h) => <button key={h} type="button" role="radio" aria-checked={hours === h} onClick={() => setHours(h)}>{HOURS_LABEL[h]}</button>)}
          </div>
        </div>
        <label className="vlt-check-row"><input type="checkbox" checked={usePass} onChange={(e) => setUsePass(e.target.checked)} /> <span><b>Also ask for a passphrase</b><br /><span className="muted">Someone who only sees the link still cannot open it.</span></span></label>
        {usePass && <label className="field"><span>Passphrase (at least 6 characters; tell it by phone)</span><input className="input" value={pass} type="text" autoComplete="off" spellCheck={false} onChange={(e) => setPass(e.target.value)} placeholder="blue elephant" aria-label="Passphrase" /></label>}
        <label className="field"><span>Note for them (optional, not secret)</span><input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="For the vendor audit on Friday" /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

/** The person's one-time links: still open, used, expired or revoked — and when each was opened. */
export function LinksView({ clipboardSeconds }: { clipboardSeconds: number }) {
  const q = useWsQuery(['vault', 'links'], vaultApi.links, { staleTime: 15_000, refetchInterval: 60_000 });
  const [making, setMaking] = useState(false);
  if (q.isLoading) return <div className="vlt-pad"><Spinner /></div>;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const rows = q.data ?? [];
  return (
    <div className="vlt-requests" data-testid="links">
      <section className="card">
        <div className="card-head">
          <div><h3>One-time links</h3><p>Send a password or key to one person without it sitting in their email or chat. Each link opens the number of times you chose, then the secret is destroyed.</p></div>
          <button className="btn btn-primary btn-sm" onClick={() => setMaking(true)}><Icon name="send" size={14} /> Send a secret</button>
        </div>
        <div className="card-body">
          {rows.length === 0 ? <EmptyState icon="send" title="No links yet" text="From an item, choose “Send once”; or send something that is not in the vault." /> : (
            <ul className="vlt-req-list">{rows.map((l: SecretLink) => (
              <li key={l.id} data-link={l.id}>
                <span className="vlt-req-main">
                  <b>{l.itemTitle ?? l.note ?? 'A secret'}</b>
                  {l.itemTitle && l.note && <span className="vlt-req-reason">“{l.note}”</span>}
                  <span className="muted vlt-small">
                    <span className={`vlt-req-status s-${l.state === 'open' ? 'pending' : l.state === 'used' ? 'approved' : 'denied'}`}>{l.state === 'open' ? `Open · ${l.views} of ${l.maxViews} opened` : l.state === 'used' ? 'Opened and destroyed' : l.state === 'expired' ? 'Expired, destroyed' : 'Revoked'}</span>
                    {' · '}made {timeAgo(l.createdAt)}{l.state === 'open' ? ` · until ${formatDateTime(l.expiresAt)}` : ''}{l.lastOpenedAt ? ` · last opened ${timeAgo(l.lastOpenedAt)}` : ''}{l.hasPassphrase ? ' · passphrase' : ''}
                  </span>
                </span>
                {l.state === 'open' && <div className="vlt-req-actions"><button className="btn btn-ghost btn-sm danger" onClick={async () => {
                  if (!(await confirmDialog({ title: 'Revoke this link?', message: 'The secret is destroyed now; the link stops working.', confirmText: 'Revoke' }))) return;
                  try { await vaultApi.revokeLink(l.id); toast('Revoked.'); void q.refetch(); } catch (e) { toast(errText(e, 'Could not revoke it.'), 'error'); }
                }}>Revoke</button></div>}
              </li>
            ))}</ul>
          )}
        </div>
      </section>
      {making && <SendLinkModal source={{ kind: 'blank' }} clipboardSeconds={clipboardSeconds} onClose={() => { setMaking(false); void q.refetch(); }} />}
    </div>
  );
}
