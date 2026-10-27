import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { ApiError } from '../../api/client';
import { Spinner } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { useAuth } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { ACTION_LABEL, vaultApi, type VaultCollection, type VaultField } from './api';
import { useStepUp } from './stepUpContext';

/** Twenty dots whatever the value: the mask never tells how long a secret is. */
const DOTS = 20;

/** Face ID / passkey glyph (the reveal always asks for the passkey or a two-step code). */
export const FaceIdGlyph = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M9 9.5v1M15 9.5v1M12 9.5V13h-1M9.5 16c1.4 1 3.6 1 5 0" />
  </svg>
);

/** A countdown ring: how much of `total` is left, drawn as an arc that empties (a gauge that moves once a second, never spins). */
export function CountRing({ left, total, size = 16, stroke = 2, tone = 'grey' }: { left: number; total: number; size?: number; stroke?: number; tone?: 'grey' | 'green' }) {
  const r = (size - stroke) / 2 - 0.5, c = 2 * Math.PI * r, f = total > 0 ? Math.max(0, Math.min(1, left / total)) : 0;
  return (
    <svg className={`pw-cring ${tone}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} className="pw-cring-track" />
      <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} className="pw-cring-left" strokeDasharray={`${f * c} ${c}`} strokeLinecap={tone === 'green' ? 'round' : 'butt'} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
    </svg>
  );
}

/**
 * A secret shown on purpose: Reveal always needs a passed passkey or two-step check (one from the last few minutes counts, as everywhere in
 * the vault) and the same reveal call and server checks as the edit screen; it is offered only to people who can manage the item (who could
 * already see it there), and every reveal is recorded. The dots turn into characters
 * left to right, and the value hides itself after the workspace's reveal time, when the vault locks, or when the tab is hidden.
 */
export function RevealSecret({ itemId, field, canReveal, lockEpoch, busy, onApproval, onCopy }: {
  itemId: string; field: VaultField; canReveal: boolean; lockEpoch: number; busy: boolean; onApproval: () => void; onCopy: (() => void) | null;
}) {
  const step = useStepUp();
  const [shown, setShown] = useState<{ value: string; total: number; at: number } | null>(null);
  const [left, setLeft] = useState(0);
  const [asking, setAsking] = useState(false);
  const hide = useCallback(() => setShown(null), []);
  useEffect(() => { setShown(null); }, [itemId, lockEpoch]);
  useEffect(() => {
    if (!shown) return;
    const tick = () => {
      const l = Math.max(0, shown.total - Math.floor((Date.now() - shown.at) / 1000));
      setLeft(l);
      if (l <= 0) hide();
    };
    tick();
    const t = window.setInterval(tick, 250);
    const vis = () => { if (document.hidden) hide(); };
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('blur', hide);
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', vis); window.removeEventListener('blur', hide); };
  }, [shown, hide]);
  const reveal = async () => {
    setAsking(true);
    try {
      const res = await step.run((t) => vaultApi.reveal(itemId, field.key, false, t), true);
      if (res) setShown({ value: res.value, total: Math.max(1, res.revealSeconds), at: Date.now() });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VAULT_APPROVAL_REQUIRED') onApproval();
      else toast(e instanceof ApiError ? e.message : 'Could not show it.', 'error');
    } finally { setAsking(false); }
  };
  const chars = shown ? [...shown.value] : [];
  const n = Math.max(DOTS, chars.length);
  return (
    <>
      <code className={`pw-v pw-pw vlt-secret${shown ? ' on' : ''}`} data-state={shown ? 'revealed' : 'masked'} aria-label={shown ? `${field.label}, shown` : `${field.label}, hidden`} aria-live="polite">
        {shown
          ? Array.from({ length: n }, (_, i) => <span key={i} className="pw-ch" style={{ '--i': i } as CSSProperties}>{i < chars.length && <b>{chars[i]}</b>}<i aria-hidden="true">•</i></span>)
          : <span className="pw-dots" aria-hidden="true">{'•'.repeat(DOTS)}</span>}
      </code>
      {shown && <span className="pw-hide" aria-label={`Hides in ${left} seconds`}><CountRing left={left} total={shown.total} />Hides in {left}s</span>}
      {onCopy && <button type="button" className="pw-link" aria-label={`Copy ${field.label}`} title="Asks for your passkey; the clipboard clears itself" disabled={busy} onClick={onCopy}>{busy ? <Spinner /> : 'Copy'}</button>}
      {canReveal && (shown
        ? <button type="button" className="pw-btn" onClick={hide} aria-label={`Hide ${field.label}`}>Hide</button>
        : <button type="button" className="pw-btn fid" onClick={() => void reveal()} disabled={asking} aria-label={`Reveal ${field.label}`} title="Asks for your passkey or a two-step code; recorded">{asking ? <Spinner /> : <FaceIdGlyph />}Reveal</button>)}
    </>
  );
}

const firstName = (n: string) => n.split(' ')[0];

/** Who opened, copied or changed it, newest first (people who manage the item; the full log is under ··· › Activity). */
export function AccessLog({ id }: { id: string }) {
  const me = useAuth((s) => s.ctx?.user.id);
  const q = useWsQuery(['vault', 'activity', id], () => vaultApi.activity(id), { staleTime: 0 });
  const rows = (q.data ?? []).slice(0, 3);
  return (
    <div className="pw-log">
      <h3>Access log</h3>
      {q.isLoading ? <Spinner /> : rows.length === 0 ? <p className="pw-log-none">Nothing recorded yet.</p> : (
        <ul>
          {rows.map((r, i) => (
            <li key={i}><b>{r.by?.id === me ? 'You' : r.by ? firstName(r.by.name) : 'Someone'}</b> {(ACTION_LABEL[r.action] ?? r.action.replace('vault.', '').replace(/_/g, ' ')).toLowerCase()}{r.field ? ` ${r.field.toLowerCase()}` : ''} · {timeAgo(r.at)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const hue = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

/** The people this item's collection is shared with right now, and Stop sharing (people who manage the collection). */
export function SharedPeople({ collection, canManage, onChanged }: { collection: VaultCollection | null; canManage: boolean; onChanged: () => void }) {
  const me = useAuth((s) => s.ctx?.user.id);
  const [busy, setBusy] = useState<string | null>(null);
  const now = useRef(Date.now()).current;
  if (!collection || collection.kind === 'Personal') return null;
  const people = (collection.shares ?? []).filter((s) => s.principalType === 'User' && s.principalId !== me && (!s.expiresAt || new Date(s.expiresAt).getTime() > now)).slice(0, 3);
  if (!people.length) return null;
  const stop = async (id: string, name: string) => {
    if (!(await confirmDialog({ title: `Stop sharing with ${name}?`, message: `${name} loses access to everything in “${collection.name}” at once.`, confirmText: 'Stop sharing' }))) return;
    setBusy(id);
    try {
      const rest = (collection.shares ?? []).filter((s) => s.id !== id).map((s) => ({ principalType: s.principalType, principalId: s.principalId, role: s.role, access: s.access, expiresAt: s.expiresAt }));
      await vaultApi.saveShares(collection.id, rest);
      toast(`No longer shared with ${name}.`); onChanged();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not change the access.', 'error'); }
    finally { setBusy(null); }
  };
  return (
    <ul className="pw-people">
      {people.map((s) => {
        const days = s.expiresAt ? Math.max(1, Math.ceil((new Date(s.expiresAt).getTime() - now) / 86_400_000)) : null;
        return (
          <li key={s.id}>
            <span className="pw-av" style={{ '--h': hue(s.name) } as CSSProperties} aria-hidden="true">{initials(s.name)}</span>
            <span className="pw-people-t">{s.name} · <span>{days ? `${days} day${days === 1 ? '' : 's'} left` : s.access === 'Manage' ? 'manages it' : s.access === 'UseOnly' ? 'can use it' : 'can view'}</span></span>
            {canManage && <button type="button" className="pw-btn sm" disabled={busy === s.id} onClick={() => void stop(s.id, s.name)}>{busy === s.id ? <Spinner /> : 'Stop sharing'}</button>}
          </li>
        );
      })}
    </ul>
  );
}
