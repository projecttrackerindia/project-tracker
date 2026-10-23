import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import type { VaultCollection, VaultHealthFlag, VaultItemSummary } from './api';
import { useKeyring } from './e2ee/keyring';
import * as sealed from './e2ee/sealed';
import { strength } from './secure';

export interface Me { id: string; email: string; name: string }
const errText = (e: unknown, fallback: string) => (e instanceof ApiError || e instanceof Error ? e.message || fallback : fallback);

// ------------------------------------------------------------------ the decrypted view of sealed collections (memory only)

export interface SealedView { status: 'loading' | 'open' | 'waiting' | 'unreadable' | 'error'; items: sealed.SealedItem[]; bin: sealed.SealedItem[] | null; warning: string | null; error: string | null }

/** Opens every sealed collection once the vault is unlocked and keeps the decrypted items in this page's memory (gone on lock). */
export function useSealedData(collections: VaultCollection[], tenant: string | null, me: string | null) {
  const ring = useKeyring();
  const unlocked = !!ring.identity && ring.tenant === tenant && ring.user === me;
  const [data, setData] = useState<Record<string, SealedView>>({});
  const sealedCols = useMemo(() => collections.filter((c) => c.sealed), [collections]);
  const load = useCallback(async (c: VaultCollection, withBin = false) => {
    setData((d) => ({ ...d, [c.id]: { ...(d[c.id] ?? { items: [], bin: null, warning: null, error: null }), status: d[c.id]?.status === 'open' ? 'open' : 'loading' } }));
    try {
      const r = await sealed.openCollection(c);
      const items = r.state === 'open' ? await sealed.listSealed(c) : [];
      const bin = r.state === 'open' && withBin && r.keys.myAccess === 'Manage' ? await sealed.listSealed(c, true) : null;
      setData((d) => ({ ...d, [c.id]: { status: r.state, items, bin: bin ?? d[c.id]?.bin ?? null, warning: r.warning, error: null } }));
    } catch (e) { setData((d) => ({ ...d, [c.id]: { status: 'error', items: [], bin: null, warning: null, error: errText(e, 'Could not open it.') } })); }
  }, []);
  useEffect(() => {
    if (!unlocked) { setData({}); return; }
    for (const c of sealedCols) if (!data[c.id]) void load(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked, sealedCols]);
  return { unlocked, data, load, sealedCols };
}

/** A sealed item shown in lists like any other (everything here was computed in the browser). */
export function sealedSummary(c: VaultCollection, s: sealed.SealedItem, reusedPasswords: Set<string>, breached: Map<string, number>): VaultItemSummary & { sealed: true } {
  const p = s.payload;
  const field = (k: string) => p?.fields.find((f) => f.key === k)?.value ?? null;
  const password = field('password') ?? field('key') ?? field('pin');
  const user = field('username') ?? field('holder');
  const hint = user ? (user.includes('@') ? `${user[0]}***${user.slice(user.indexOf('@'))}` : user.length <= 2 ? `${user[0]}*` : `${user[0]}***${user[user.length - 1]}`) : null;
  const health: VaultHealthFlag[] = [];
  const str = password ? strength(password) : null;
  if (str !== null && str < 2) health.push('weak');
  if (password && reusedPasswords.has(password)) health.push('reused');
  if (password && (breached.get(s.row.id) ?? 0) > 0) health.push('breached');
  const expired = !!s.row.expiresAt && Date.parse(s.row.expiresAt) <= Date.now();
  if (expired) health.push('expired');
  if (s.row.valueChangedAt && Date.parse(s.row.valueChangedAt) < Date.now() - 365 * 86_400_000 && ['Login', 'ApiKey', 'Database', 'Server'].includes(s.row.kind)) health.push('old');
  if (s.row.rotationReason) health.push('rotate');
  return {
    id: s.row.id, collectionId: c.id, collectionName: c.name, kind: s.row.kind, title: p?.title ?? 'Sealed item (cannot be read here)', url: p?.url ?? null, usernameHint: hint, tags: p?.tags ?? [],
    class: p?.class ?? 'Secret', useOnly: false, owner: null, hasTotp: !!p?.fields.some((f) => f.type === 'totp' && f.value), strength: str, breached: (breached.get(s.row.id) ?? 0) > 0, reused: health.includes('reused'),
    expiresAt: s.row.expiresAt, expired, rotationReason: s.row.rotationReason, valueChangedAt: s.row.valueChangedAt, lastUsedAt: null, myAccess: s.row.myAccess, health, sealed: true,
  };
}

