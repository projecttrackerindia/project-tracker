import { useEffect, useState, useSyncExternalStore } from 'react';
import { Icon } from '../../components/Icon';
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
