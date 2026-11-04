import { dehydrate, hydrate, type QueryClient } from '@tanstack/react-query';
import type { AppContext } from '../api/types';

/**
 * Warm start (stale-while-revalidate across visits): the last-known context and the shell's and pages' answers are kept on this device
 * in IndexedDB, and the next time the app opens they are shown at once while the session check and fresh reads run behind them. A
 * phone on a slow network paints the real page from what it knew, instead of a splash for several seconds.
 *
 * Only what the person could already see is kept (the same rule as the offline snapshot), only for their current workspace, at most
 * MAX_BYTES, and for MAX_AGE_MS. Sign-out, a refused session or another person signing in clears it (clearWarmStart).
 */
const DB = 'pm-warm', STORE = 'kv', KEY = 'last';
const MAX_BYTES = 1_500_000;
const MAX_AGE_MS = 7 * 24 * 3600_000;

export interface WarmSnapshot { v: 1; savedAt: number; userId: string; workspaceId: string; ctx: AppContext; queries: unknown }

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | null> {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, mode);
      const r = run(t.objectStore(STORE));
      t.oncomplete = () => { resolve(r ? (r.result as T) : null); db.close(); };
      t.onerror = t.onabort = () => { resolve(null); db.close(); };
    } catch { resolve(null); db.close(); }
  });
}

/** Started as early as possible (module load): the read takes a few milliseconds and runs while the scripts are still evaluating. */
let pending: Promise<WarmSnapshot | null> | null = null;
export function readWarmStart(): Promise<WarmSnapshot | null> {
  pending ??= tx<WarmSnapshot>('readonly', (s) => s.get(KEY)).then((w) =>
    w && w.v === 1 && Date.now() - w.savedAt < MAX_AGE_MS && w.ctx?.current?.id === w.workspaceId ? w : null).catch(() => null);
  return pending;
}

/** Puts the saved answers into the query cache as already stale: they show at once and every mounted query refetches behind them. */
export function hydrateWarm(client: QueryClient, w: WarmSnapshot) {
  try {
    const state = w.queries as { queries?: { state: { dataUpdatedAt: number } }[] };
    // Marked as never fetched-at, so they count as stale: shown at once, and every query refetches as soon as it mounts.
    for (const q of state.queries ?? []) q.state.dataUpdatedAt = 0;
    hydrate(client, w.queries as Parameters<typeof hydrate>[1]);
  } catch { /* an older shape: ignore it */ }
}

let timer: number | undefined;
/** Saves the current context and this workspace's successful reads (debounced; also called when the tab is hidden). */
export function saveWarmStart(client: QueryClient, ctx: AppContext | null, now = false) {
  if (!ctx?.current || !ctx.user) return;
  const run = () => {
    timer = undefined;
    const wid = ctx.current!.id;
    const queries = dehydrate(client, {
      shouldDehydrateQuery: (q) => q.state.status === 'success' && q.queryKey[0] === wid && q.state.data !== undefined && !q.meta?.noPersist,
    });
    const snap: WarmSnapshot = { v: 1, savedAt: Date.now(), userId: ctx.user.id, workspaceId: wid, ctx, queries };
    let size = 0;
    try { size = JSON.stringify(snap).length; } catch { return; }
    if (size > MAX_BYTES) {
      // Too much: keep the context and the smallest answers (badges, lists of the shell), drop the biggest.
      const qs = (queries as { queries: { state: { data: unknown } }[] }).queries
        .map((q) => ({ q, n: JSON.stringify(q.state.data)?.length ?? 0 })).sort((a, b) => a.n - b.n);
      let total = 0; const kept = [];
      for (const { q, n } of qs) { if (total + n > MAX_BYTES * 0.8) break; total += n; kept.push(q); }
      snap.queries = { ...(queries as object), queries: kept };
    }
    void tx('readwrite', (s) => { s.put(snap, KEY); });
  };
  if (now) { if (timer) window.clearTimeout(timer); run(); return; }
  if (timer) return;
  timer = window.setTimeout(run, 4000);
}

export function clearWarmStart() {
  pending = Promise.resolve(null);
  if (timer) { window.clearTimeout(timer); timer = undefined; }
  void tx('readwrite', (s) => { s.delete(KEY); });
}
