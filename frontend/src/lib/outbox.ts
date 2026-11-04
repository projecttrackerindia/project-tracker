/**
 * Offline outbox: an edit made while the phone has no connection is kept on this device (IndexedDB, never the service worker's cache, and
 * never with the access token - the token is added when it is sent) and sent, in order, as soon as the connection is back. The page shows
 * the change at once (optimistic: the cached copy of the edited item takes the new fields), and when the server has a newer copy (a
 * version conflict, 409/412) the server wins and the person is told the item "changed elsewhere".
 *
 * Only small, replayable edits to the person's own key data are queued (tasks, work tasks, notes, reminders, checklists, comments); anything
 * else still needs a connection. Cleared on sign-out with the rest of the device data (clearOutbox).
 */
const DB = 'pm-outbox', STORE = 'q';

export interface OutboxEntry { id: string; method: string; path: string; body?: unknown; at: number; workspaceId: string | null; idempotencyKey: string; needsReason?: boolean }
export type OutboxEvent = { pending: number; online: boolean };

/** An item id (GUIDs in the API; any plain id segment that is not a settings word). */
const ID = '(?!settings|policy|time-zone|suggestions|order)[0-9a-z-]{2,64}';
const QUEUEABLE: RegExp[] = [
  new RegExp(`^/tasks/${ID}(/(move|sprint|checklist(/${ID})?|comments))?$`, 'i'),
  new RegExp(`^/work-tasks/${ID}(/(status|comments))?$`, 'i'),
  new RegExp(`^/projects/${ID}/tasks$`, 'i'),
  new RegExp(`^/notes(/${ID})?$`, 'i'),
  new RegExp(`^/reminders(/${ID}(/(done|reopen|meta|snooze))?)?$`, 'i'),
];

export function isQueueable(method: string, path: string) {
  if (method === 'GET' || method === 'HEAD') return false;
  const p = path.split('?')[0];
  return QUEUEABLE.some((r) => r.test(p));
}

/** True when the request did not reach the server at all (no connection), rather than the server saying no. */
export function isNetworkFailure(e: unknown) {
  return (typeof navigator !== 'undefined' && navigator.onLine === false) || e instanceof TypeError;
}

let memory: OutboxEntry[] = [];
function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'id' }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}
async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | null> {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, mode);
      const r = fn(t.objectStore(STORE));
      t.oncomplete = () => { resolve(r ? (r.result as T) : null); db.close(); };
      t.onerror = t.onabort = () => { resolve(null); db.close(); };
    } catch { resolve(null); db.close(); }
  });
}

export async function listOutbox(): Promise<OutboxEntry[]> {
  const all = await run<OutboxEntry[]>('readonly', (s) => s.getAll() as IDBRequest<OutboxEntry[]>);
  return (all ?? memory).slice().sort((a, b) => a.at - b.at);
}

const listeners = new Set<(e: OutboxEvent) => void>();
let pendingCount = 0;
export function onOutbox(fn: (e: OutboxEvent) => void) { listeners.add(fn); fn({ pending: pendingCount, online: navigator.onLine }); return () => { listeners.delete(fn); }; }
async function emit() {
  pendingCount = (await listOutbox()).length;
  for (const l of listeners) l({ pending: pendingCount, online: navigator.onLine });
}

const uid = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

export async function enqueue(e: Omit<OutboxEntry, 'id' | 'at'>): Promise<OutboxEntry> {
  const entry: OutboxEntry = { ...e, id: uid(), at: Date.now() };
  // Several edits to the same item while offline: only the latest full-body save is kept (PUT/PATCH replace the earlier one).
  const prior = (await listOutbox()).filter((x) => (x.method === 'PUT' || x.method === 'PATCH') && x.method === entry.method && x.path === entry.path);
  if (prior.length && (entry.method === 'PUT' || entry.method === 'PATCH')) {
    entry.at = prior[0].at;
    // Keep the version the first offline edit was based on: the server compares against what this device last saw.
    const base = (prior[0].body as { version?: number } | undefined)?.version;
    if (base !== undefined && entry.body && typeof entry.body === 'object') entry.body = { ...(entry.body as object), version: base };
    for (const p of prior) await remove(p.id);
  }
  const ok = await run('readwrite', (s) => { s.put(entry); });
  if (ok === null && !(await open())) memory.push(entry);
  await emit();
  return entry;
}

async function remove(id: string) {
  memory = memory.filter((m) => m.id !== id);
  await run('readwrite', (s) => { s.delete(id); });
}

export type Sender = (e: OutboxEntry) => Promise<'sent' | 'conflict' | 'rejected' | 'offline' | 'reason'>;

let flushing: Promise<{ sent: number; conflicts: number; rejected: number; needReason: OutboxEntry[] }> | null = null;
/** Sends what is waiting, oldest first; stops at the first one that still cannot reach the server (tried again on the next reconnect). */
export function flushOutbox(send: Sender) {
  flushing ??= (async () => {
    let sent = 0, conflicts = 0, rejected = 0; const needReason: OutboxEntry[] = [];
    try {
      for (const e of await listOutbox()) {
        // A date pushed later needs a reason (422 DATE_EXTENSION_REASON_REQUIRED): it waits, marked, until the person gives one.
        if (e.needsReason) { needReason.push(e); continue; }
        const r = await send(e);
        if (r === 'offline') break;
        if (r === 'reason') { const m = { ...e, needsReason: true }; await run('readwrite', (st) => { st.put(m); }); needReason.push(m); continue; }
        await remove(e.id);
        if (r === 'sent') sent++; else if (r === 'conflict') conflicts++; else rejected++;
      }
    } finally { flushing = null; await emit(); }
    return { sent, conflicts, rejected, needReason };
  })();
  return flushing;
}

/** The person gave the reason for a queued date extension: it is added to the edit (extensionReason) and the edit is sent again. */
export async function giveReason(id: string, reason: string) {
  const e = (await listOutbox()).find((x) => x.id === id);
  if (!e) return;
  const body = e.body && typeof e.body === 'object' ? { ...(e.body as object), extensionReason: reason } : { extensionReason: reason };
  await run('readwrite', (s) => { s.put({ ...e, body, needsReason: false }); });
  await emit();
}
export const dropQueued = async (id: string) => { await remove(id); await emit(); };

export async function clearOutbox() {
  memory = [];
  await run('readwrite', (s) => { s.clear(); });
  await emit();
}

/**
 * The optimistic copy: every cached answer that holds an object with this id takes the edited fields (shallow), so lists and detail
 * views agree. Returns the first patched object (what the caller would have got from the server), or the body itself.
 */
export function patchById<T>(data: T, id: string, fields: Record<string, unknown>): { data: T; hit: unknown } {
  let hit: unknown = null;
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 6 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) { let changed = false; const out = v.map((x) => { const y = walk(x, depth + 1); if (y !== x) changed = true; return y; }); return changed ? out : v; }
    const o = v as Record<string, unknown>;
    if (o.id === id) { const next = { ...o, ...fields, id }; hit ??= next; return next; }
    let changed = false; const out: Record<string, unknown> = {};
    for (const k of Object.keys(o)) { const y = walk(o[k], depth + 1); if (y !== o[k]) changed = true; out[k] = y; }
    return changed ? out : v;
  };
  const next = walk(data, 0) as T;
  return { data: next, hit };
}

export function idOfPath(path: string) {
  const parts = path.split('?')[0].split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  return /^(move|sprint|status|done|reopen|meta|snooze|comments|checklist)$/.test(last) ? parts[parts.length - 2] : last;
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { void emit(); });
  window.addEventListener('offline', () => { void emit(); });
}
