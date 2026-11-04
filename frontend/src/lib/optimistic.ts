/**
 * Instant saves, by architecture rather than per button.
 *
 * Every write in the app goes through one of two doors, and both are covered here:
 *  1. React Query mutations: the shared MutationCache (see `optimisticMutationCache`) reads `meta.optimistic` from ANY mutation, writes the new
 *     value into the cache before the request leaves (so the screen changes at once), rolls the cache back if the server refuses, and shows the
 *     one shared "✓ Saved" tick when it lands. A mutation opts out with `meta: { saved: false }`.
 *  2. Plain API writes (`api.put/patch`): the transport reports each successful save (`reportSaved`), which shows the same tick.
 *
 * Nothing here knows about any page. Pages describe *what* changes (`optimistic: [{ key, apply }]`); this file does the *how*.
 */
import { MutationCache, type Mutation, type QueryClient, type QueryKey } from '@tanstack/react-query';

export interface OptimisticPatch<V = unknown> {
  /** The cached query to change, or a function of the mutation's variables. Every query starting with this key is changed. */
  key: QueryKey | ((vars: V) => QueryKey);
  /** The new cached value. Return `old` unchanged when the patch does not apply. Must not mutate `old`. */
  apply: (old: unknown, vars: V) => unknown;
}

export interface OptimisticMeta<V = unknown> extends Record<string, unknown> {
  optimistic?: OptimisticPatch<V>[];
  /** false: no "✓ Saved" tick (sends, deletes with their own undo, background writes). */
  saved?: boolean;
  /** Text for the error toast when the server refuses (the cache is rolled back either way). */
  errorText?: string;
}

export const SAVED_EVENT = 'pm:saved';
export const SAVE_FAILED_EVENT = 'pm:save-failed';

let lastSaved = 0;
/** Shows the shared "✓ Saved" tick. Bursts (one save per field) show it once. */
export function reportSaved(now = Date.now()) {
  if (now - lastSaved < 250) return;
  lastSaved = now;
  if (typeof window === 'undefined') return;
  try { window.dispatchEvent(new CustomEvent(SAVED_EVENT)); } catch { /* never let a tick break a save */ }
}

export function reportSaveFailed(message: string) {
  if (typeof window === 'undefined') return;
  try { window.dispatchEvent(new CustomEvent(SAVE_FAILED_EVENT, { detail: { message } })); } catch { /* ignore */ }
}

/** Writes that are not something the person "saved": reading, presence, sign-in, typing, search. They never flash the tick. */
const QUIET = /\/(read|seen|presence|heartbeat|typing|search|preview|parse|options|events|unfurl|refresh|login|logout|token|join|decline|lookup|ping|telemetry)(\/|$)|^\/auth\//;

/** Called by the transport after every successful write. PUT and PATCH are saves; POST and DELETE are actions with their own feedback. */
export function writeSucceeded(method: string, path: string) {
  const m = method.toUpperCase();
  if (m !== 'PUT' && m !== 'PATCH') return;
  if (QUIET.test(path.split('?')[0])) return;
  reportSaved();
}

type Snapshot = Array<[QueryKey, unknown]>;
const snapshots = new WeakMap<object, Snapshot>();

function keyOf<V>(p: OptimisticPatch<V>, vars: V): QueryKey { return typeof p.key === 'function' ? p.key(vars) : p.key; }

/** Applies the patches at once and remembers what was there, so `rollback` can put it back. Exported for tests. */
export async function applyOptimistic<V>(client: QueryClient, patches: OptimisticPatch<V>[], vars: V): Promise<Snapshot> {
  const snap: Snapshot = [];
  for (const p of patches) {
    const key = keyOf(p, vars);
    await client.cancelQueries({ queryKey: key });   // an older read landing now would undo the optimistic value
    for (const [k, old] of client.getQueriesData({ queryKey: key })) {
      snap.push([k, old]);
      if (old !== undefined) client.setQueryData(k, p.apply(old, vars));
    }
  }
  return snap;
}

export function rollback(client: QueryClient, snap: Snapshot | undefined) {
  for (const [k, old] of snap ?? []) client.setQueryData(k, old);
}

function metaOf(m: Mutation<unknown, unknown, unknown, unknown>): OptimisticMeta { return (m.options.meta ?? {}) as OptimisticMeta; }

function errorMessage(e: unknown, fallback: string) {
  const msg = (e as { message?: unknown } | null)?.message;
  return typeof msg === 'string' && msg ? msg : fallback;
}

/**
 * The MutationCache every QueryClient in the app uses. `getClient` is lazy because the cache is made before the client that owns it.
 */
export function optimisticMutationCache(getClient: () => QueryClient) {
  return new MutationCache({
    onMutate: async (vars, mutation) => {
      const patches = metaOf(mutation).optimistic;
      if (patches?.length) snapshots.set(mutation, await applyOptimistic(getClient(), patches, vars));
    },
    onError: (error, _vars, _ctx, mutation) => {
      const meta = metaOf(mutation);
      const snap = snapshots.get(mutation);
      if (snap) {
        rollback(getClient(), snap);
        snapshots.delete(mutation);
        // Only mutations that changed the screen ahead of the server say so here; others keep their own error handling.
        reportSaveFailed(errorMessage(error, meta.errorText ?? 'Could not save. Your change was undone.'));
      }
    },
    onSuccess: (_data, _vars, _ctx, mutation) => {
      snapshots.delete(mutation);
      if (metaOf(mutation).saved !== false) reportSaved();
    },
    onSettled: (_d, _e, _v, _c, mutation) => {
      // Re-read what was patched so the cache ends on the server's truth (ids, timestamps, computed fields).
      const meta = metaOf(mutation);
      const vars = mutation.state.variables;
      for (const p of meta.optimistic ?? []) void getClient().invalidateQueries({ queryKey: keyOf(p, vars) });
    },
  });
}

// ------------------------------------------------------------------ small helpers for common shapes

/** Merges `patch` into the item with this id, in a list or in a single cached object (or a `{ items: [] }` page). */
export function mergeById(old: unknown, id: string, patch: object): unknown {
  if (Array.isArray(old)) return old.map((x) => (x && (x as { id?: string }).id === id ? { ...x, ...patch } : x));
  if (old && typeof old === 'object') {
    const o = old as { id?: string; items?: unknown };
    if (o.id === id) return { ...o, ...patch };
    if (Array.isArray(o.items)) return { ...o, items: mergeById(o.items, id, patch) };
  }
  return old;
}

/** Removes the item with this id from a list or a `{ items: [] }` page. */
export function removeById(old: unknown, id: string): unknown {
  if (Array.isArray(old)) return old.filter((x) => !(x && (x as { id?: string }).id === id));
  if (old && typeof old === 'object' && Array.isArray((old as { items?: unknown }).items)) {
    const o = old as { items: unknown[] };
    return { ...o, items: removeById(o.items, id) };
  }
  return old;
}
