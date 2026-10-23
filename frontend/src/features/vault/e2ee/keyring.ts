import { useSyncExternalStore } from 'react';
import { forget, wipe, type Identity } from './crypto';

/**
 * What the sealed vault holds while it is unlocked: the identity (derived from the secret) and the collection keys opened so far. Only in
 * this tab's memory — never in storage, never in the query cache — and wiped (bytes overwritten) when the vault locks: after idle minutes,
 * on demand, on a workspace switch, or when the page goes away.
 */
interface State { identity: Identity | null; tenant: string | null; user: string | null; generation: number; via: string | null; version: number }
let state: State = { identity: null, tenant: null, user: null, generation: 0, via: null, version: 0 };
const keys = new Map<string, Map<number, Uint8Array>>();
const listeners = new Set<() => void>();
const emit = () => { state = { ...state, version: state.version + 1 }; listeners.forEach((l) => l()); };

export const keyring = {
  get: () => state,
  subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  unlock(tenant: string, user: string, identity: Identity, generation: number, via: string) {
    if (state.identity && state.identity !== identity) forget(state.identity);
    state = { ...state, identity, tenant, user, generation, via };
    emit();
  },
  lock() {
    forget(state.identity);
    for (const m of keys.values()) for (const k of m.values()) wipe(k);
    keys.clear();
    state = { ...state, identity: null, via: null };
    emit();
  },
  isOpenFor: (tenant: string | null | undefined, user: string | null | undefined) => !!state.identity && state.tenant === tenant && state.user === user,
  collectionKey: (collection: string, version: number) => keys.get(collection)?.get(version) ?? null,
  setCollectionKey(collection: string, version: number, key: Uint8Array) {
    let m = keys.get(collection);
    if (!m) keys.set(collection, (m = new Map()));
    const old = m.get(version);
    if (old && old !== key) wipe(old);
    m.set(version, key);
    emit();
  },
  dropCollection(collection: string) { const m = keys.get(collection); if (m) { for (const k of m.values()) wipe(k); keys.delete(collection); emit(); } },
};
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => keyring.lock());

export function useKeyring() { return useSyncExternalStore(keyring.subscribe, keyring.get, keyring.get); }

// ------------------------------------------------------------------ pinned keys (trust on first use, like Signal)

/**
 * The safety code and signing key seen for each person the first time their key was used here. If the server ever hands out a different
 * key for them, the vault says so before anything is shared with it. Kept per workspace on this device; public data only.
 */
interface Pin { fp: string; ed: string; verified?: boolean }
const pinKey = (tenant: string) => `pt-vault-pins:${tenant}`;
function readPins(tenant: string): Record<string, Pin> {
  try { return JSON.parse(localStorage.getItem(pinKey(tenant)) ?? '{}') as Record<string, Pin>; } catch { return {}; }
}
function writePins(tenant: string, pins: Record<string, Pin>) { try { localStorage.setItem(pinKey(tenant), JSON.stringify(pins)); } catch { /* private mode: pins live for this page only */ } }

export type PinState = 'new' | 'same' | 'verified' | 'changed';
export const pins = {
  check(tenant: string, user: string, fp: string, ed: string): PinState {
    const p = readPins(tenant)[user];
    if (!p) return 'new';
    if (p.fp !== fp || p.ed !== ed) return 'changed';
    return p.verified ? 'verified' : 'same';
  },
  /** Remembers the key (first use), or accepts a changed one the person has checked. */
  accept(tenant: string, user: string, fp: string, ed: string, verified = false) {
    const all = readPins(tenant);
    all[user] = { fp, ed, verified: verified || (all[user]?.fp === fp && all[user]?.verified) || false };
    writePins(tenant, all);
  },
  verified: (tenant: string, user: string) => !!readPins(tenant)[user]?.verified,
};
