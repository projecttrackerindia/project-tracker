import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { Segmented } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import { HEALTH_LABEL, vaultApi, type VaultCollection, type VaultHealth, type VaultHealthFlag } from './api';
import { clearClipboardNow, clipboardSnapshot, clipboardWatch } from './secure';

/** The vault's health at the top of the list: a ring for the share of healthy items, and each problem as a filter. */
export function PostureStrip({ health, active, onFilter }: { health: VaultHealth; active: VaultHealthFlag | 'any' | null; onFilter: (f: VaultHealthFlag | null) => void }) {
  if (health.total === 0) return null;
  const parts: [VaultHealthFlag, number][] = ([['breached', health.breached], ['rotate', health.toRotate], ['reused', health.reused], ['weak', health.weak], ['expired', health.expired], ['old', health.old]] as [VaultHealthFlag, number][])
    .filter(([, n]) => n > 0);
  const r = 15, c = 2 * Math.PI * r;
  const tone = health.score >= 85 ? 'good' : health.score >= 60 ? 'fair' : 'poor';
  return (
    <div className={`vlt-posture ${tone}`} data-testid="posture">
      <svg className="vlt-posture-ring" viewBox="0 0 36 36" aria-hidden="true">
        <circle cx="18" cy="18" r={r} className="track" />
        <circle cx="18" cy="18" r={r} className="value" strokeDasharray={`${(health.score / 100) * c} ${c}`} transform="rotate(-90 18 18)" />
      </svg>
      <div className="vlt-posture-text">
        <b>{health.score}</b>
        <span>{parts.length === 0 ? `All ${health.total} items healthy` : `${Math.round((health.score / 100) * health.total)} of ${health.total} healthy`}</span>
      </div>
      {parts.length > 0 && (
        <div className="vlt-posture-flags" role="group" aria-label="Show items with a problem">
          {parts.map(([f, n]) => (
            <button key={f} type="button" className={`vlt-flag f-${f}${active === f ? ' on' : ''}`} aria-pressed={active === f} onClick={() => onFilter(active === f ? null : f)}>
              <b>{n}</b> {HEALTH_LABEL[f].toLowerCase()}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** While a copied value is on the clipboard: how long until it is cleared, and a way to clear it now. */
export function ClipboardCountdown() {
  const state = useSyncExternalStore(clipboardWatch.subscribe, clipboardSnapshot, clipboardSnapshot);
  const [, tick] = useState(0);
  useEffect(() => { if (!state) return; const t = window.setInterval(() => tick((n) => n + 1), 250); return () => window.clearInterval(t); }, [state]);
  if (!state) return null;
  const left = Math.max(0, Math.ceil((state.until - Date.now()) / 1000));
  const r = 9, c = 2 * Math.PI * r;
  return (
    <div className="vlt-clip" role="status" aria-live="polite" data-testid="clipboard-countdown">
      <svg viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r={r} className="track" /><circle cx="11" cy="11" r={r} className="value" strokeDasharray={`${(left / state.seconds) * c} ${c}`} transform="rotate(-90 11 11)" /></svg>
      <span>Clipboard clears in <b>{left}s</b></span>
      <button type="button" className="btn btn-ghost btn-xs" onClick={() => void clearClipboardNow()}>Clear now</button>
    </div>
  );
}

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
const ACCESS: Record<string, string> = { Manage: 'manages', View: 'can view', UseOnly: 'can use' };

/** Who can open a shared collection, as faces; opens the access list for someone who manages it. */
export function AccessFaces({ collection, onOpen }: { collection: VaultCollection; onOpen?: () => void }) {
  const q = useWsQuery(['vault', 'collection', collection.id], () => vaultApi.collection(collection.id), { staleTime: 60_000, enabled: collection.kind !== 'Personal' && collection.myAccess === 'Manage' });
  const shares = q.data?.shares ?? [];
  if (shares.length === 0) return null;
  const shown = shares.slice(0, 5);
  const label = shares.map((s) => `${s.name} ${ACCESS[s.access] ?? ''}`.trim()).join(', ');
  return (
    <button type="button" className="vlt-faces" onClick={onOpen} title={label} aria-label={`Who has access: ${label}`} data-testid="access-faces">
      {shown.map((s) => (
        <span key={s.id} className={`vlt-face a-${s.access.toLowerCase()}`}>{s.principalType === 'User' ? initials(s.name) : <Icon name={s.principalType === 'Team' ? 'users' : s.principalType === 'Project' ? 'folder' : 'shield'} size={12} />}</span>
      ))}
      {shares.length > shown.length && <span className="vlt-face more">+{shares.length - shown.length}</span>}
    </button>
  );
}

/** How an item is protected, said exactly (mono pill in the item header). */
export function CryptoPill({ sealed }: { sealed: boolean }) {
  return sealed
    ? <span className="ds-pill mono accent vlt-crypto" title="Opened only on members' devices: the collection key reaches each person in an X25519 + ML-KEM-768 envelope; items are AES-256-GCM">x25519+mlkem768 · aes256gcm</span>
    : <span className="ds-pill mono accent vlt-crypto" title="Server-guarded: each item has its own AES-256-GCM key, wrapped by the workspace key">aes256gcm · per-item key</span>;
}

/** The item header: what it is and where it lives (grey), the big name, and the protection pill; its actions below. */
export function ItemHead({ title, context, sealed, tile, actions, onClose }: {
  title: string; context: string; sealed: boolean; tile: ReactNode; actions: ReactNode; onClose: () => void;
}) {
  return (
    <header className="vlt-panel-head">
      <div className="vlt-head-top">
        <button className="btn-icon vlt-back" aria-label="Back to the list" onClick={onClose}><Icon name="arrowLeft" /></button>
        {tile}
        <div className="vlt-panel-title">
          <p className="vlt-context">{context}</p>
          <h2>{title}</h2>
        </div>
        <CryptoPill sealed={sealed} />
      </div>
      <div className="vlt-panel-actions">
        {actions}
        <button className="btn-icon vlt-close" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
      </div>
    </header>
  );
}

const HOUR = 3_600_000;
const leftText = (ms: number) => ms < HOUR ? `${Math.max(1, Math.round(ms / 60_000))} min left` : ms < 48 * HOUR ? `${Math.round(ms / HOUR)} h left` : `${Math.round(ms / (24 * HOUR))} days left`;
const endsText = (iso: string) => `ends ${new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
type Way = 'time' | 'link' | 'jit';

/**
 * How this item is shared, as the design's three ways: time-bound access to its collection (people with an end time, revoked on their own),
 * a one-time link, and just-in-time windows that someone else approves. Below it, who has access now: an end time is a bar of the time left
 * (red in the last hour); standing access is a full grey bar.
 */
export function ItemSharing({ collection, canManage, canSend, onShare, onSend, onAsk, approval }: {
  collection: VaultCollection | null; canManage: boolean; canSend: boolean; onShare?: () => void; onSend: () => void; onAsk: () => void; approval: boolean;
}) {
  const ways: Way[] = [...(canManage && collection && collection.kind !== 'Personal' && onShare ? ['time' as const] : []), ...(canSend ? ['link' as const] : []), 'jit'];
  const [picked, setWay] = useState<Way>(ways[0]);
  const way = ways.includes(picked) ? picked : ways[0];
  const q = useWsQuery(['vault', 'collection', collection?.id ?? ''], () => vaultApi.collection(collection!.id), { staleTime: 60_000, enabled: !!collection && collection.kind !== 'Personal' && collection.myAccess === 'Manage' });
  const shares = q.data?.shares ?? [];
  const now = Date.now();
  if (!collection || collection.kind === 'Personal' && ways.length === 1) return null;
  return (
    <>
      <div className="vlt-card vlt-share" data-testid="share-access">
        <h3>Share access</h3>
        {ways.length > 1 && (
          <Segmented label="How to share" wide value={way} onChange={setWay}
            options={ways.map((w) => ({ id: w, label: w === 'time' ? 'Time-bound' : w === 'link' ? 'One-time link' : 'Just-in-time' }))} />
        )}
        {way === 'time' && (
          <div className="vlt-share-body">
            <p>Give people or a team access to <b>{collection.name}</b> until a time you choose. Access is revoked automatically at the end time.</p>
            <div className="vlt-share-acts"><button type="button" className="btn btn-primary" onClick={onShare}>Grant access</button></div>
          </div>
        )}
        {way === 'link' && (
          <div className="vlt-share-body">
            <p>A link that opens once, then it is destroyed. Its key travels only in the link, so the server cannot open the copy it holds.</p>
            <div className="vlt-share-acts"><button type="button" className="btn btn-primary" onClick={onSend}>Create one-time link</button></div>
          </div>
        )}
        {way === 'jit' && (
          <div className="vlt-share-body">
            <p>{approval ? 'Ask for a window of time; another manager approves it, and access ends on its own.'
              : 'Ask a manager for access for a while. Turn on the two-person rule in collection settings to require approval for every use.'}</p>
            <div className="vlt-share-acts"><button type="button" className="btn btn-ghost" onClick={onAsk}>Ask for access</button></div>
          </div>
        )}
      </div>
      {shares.length > 0 && (
        <div className="vlt-card vlt-who" data-testid="who-has-access">
          <h3>Who has access</h3>
          <ul>
            {shares.map((s) => {
              const left = s.expiresAt ? Date.parse(s.expiresAt) - now : null;
              const pct = left === null ? 100 : Math.max(3, Math.min(100, (left / (7 * 24 * HOUR)) * 100));
              const urgent = left !== null && left < HOUR;
              return (
                <li key={s.id}>
                  <div className="vlt-who-line">
                    <span>{s.name} · {left === null ? (ACCESS[s.access] ?? s.access.toLowerCase()) : 'time-bound'}</span>
                    <span className={urgent ? 'urgent' : ''}>{left === null ? 'standing' : left <= 0 ? 'ended' : urgent ? leftText(left) : endsText(s.expiresAt!)}</span>
                  </div>
                  <div className={`ds-meter ${left === null ? 'standing' : urgent ? 'danger' : ''}`}><i style={{ width: `${pct}%` }} /></div>
                </li>
              );
            })}
          </ul>
          <p className="vlt-audit-line">Every copy, share and change is recorded · {shares.length} with access</p>
        </div>
      )}
    </>
  );
}
