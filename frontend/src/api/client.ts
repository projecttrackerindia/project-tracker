import type { ApiErrorItem, AuthResponse } from './types';
import { saveFile } from '../lib/native';
import { lensHeaders } from '../lib/lensState';
import { mutationCommitted } from '../lib/mutationEffects';
import { writeSucceeded } from '../lib/optimistic';
import { isSessionLocked, markLocked, waitForUnlock } from './lockState';
import { enqueue, isCreate, resolveIds, isNetworkFailure, isQueueable, newTempId, recordId, type OutboxEntry } from '../lib/outbox';

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

/** Full address of an API path, for pages the browser itself goes to (sign-in redirects). */
export const apiUrl = (path: string) => `${BASE}/api/v1${path}`;

export class ApiError extends Error {
  status: number;
  code: string;
  errors: ApiErrorItem[];
  traceId?: string;
  retryAfterSeconds?: number;
  constructor(status: number, message: string, errors: ApiErrorItem[], traceId?: string) {
    super(message);
    this.status = status;
    this.errors = errors;
    this.code = errors[0]?.code ?? `HTTP_${status}`;
    this.traceId = traceId;
  }
  /** First validation message for a field, if the server reported one. */
  fieldError(field: string) {
    return this.errors.find((e) => e.field === field)?.message;
  }
}

// The access token lives in memory only; the refresh token is an HttpOnly cookie the page cannot read.
let accessToken: string | null = null;
let onAuthLost: (() => void) | null = null;
export const setAccessToken = (t: string | null) => { accessToken = t; };
export const getAccessToken = () => accessToken;
export const setAuthLostHandler = (fn: () => void) => { onAuthLost = fn; };

// The workspace this tab is in. Sent with every refresh so a switch made in another tab does not move this one, and compared with the
// workspace of the token that comes back: when the server could not honour it (no longer a member), the app reloads its context.
let tabWorkspaceId: string | null = null;
let onWorkspaceMismatch: ((tokenWorkspace: string | null) => void) | null = null;
export const setTabWorkspace = (id: string | null) => { tabWorkspaceId = id; };
export const getTabWorkspace = () => tabWorkspaceId;
export const setWorkspaceMismatchHandler = (fn: (tokenWorkspace: string | null) => void) => { onWorkspaceMismatch = fn; };

// A 403 PERMISSION_DENIED / MODULE_ACCESS_DENIED means the app offered something the person may no longer do: the server marks it with
// X-Context-Stale and the app re-checks its access context (at most once every few seconds, however many requests were refused).
const STALE_CODES = new Set(['PERMISSION_DENIED', 'MODULE_ACCESS_DENIED']);
const STALE_EVERY_MS = 5_000;
let onContextStale: (() => void) | null = null;
let staleAt = 0;
export const setContextStaleHandler = (fn: (() => void) | null) => { onContextStale = fn; };
/** True for a refusal that means the app's idea of the person's access is out of date. */
export const isContextStale = (status: number, code: string | undefined, header: string | null) =>
  status === 403 && (header === '1' || (code !== undefined && STALE_CODES.has(code)));
function noteStale() {
  const now = Date.now();
  if (!onContextStale || now - staleAt < STALE_EVERY_MS) return;
  staleAt = now;
  try { onContextStale(); } catch { /* the handler never breaks a request */ }
}

/** The workspace claim ("wid") of an access token, or null when it has none or cannot be read. */
export function workspaceOfToken(token: string | null | undefined): string | null {
  const part = token?.split('.')[1];
  if (!part) return null;
  try {
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')));
    return typeof json?.wid === 'string' ? json.wid : null;
  } catch { return null; }
}

const REFRESHED_AT = 'pt-refreshed-at';
const remember = () => { try { localStorage.setItem(REFRESHED_AT, String(Date.now())); } catch { /* storage unavailable */ } };

/**
 * Runs the refresh under a lock shared by every tab of this browser (where the browser has one), so two tabs never present the same
 * refresh cookie at once: the second one waits, then sends the cookie the first one just received. Without the Web Locks API it just runs.
 */
function underRefreshLock<T>(work: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  if (!locks?.request) return work();
  return locks.request('pt-refresh', work) as Promise<T>;
}

type Query = Record<string, string | number | boolean | null | undefined>;
export const qs = (q?: Query) => {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

async function parse(res: Response): Promise<{ data: unknown; error?: ApiError }> {
  if (res.status === 204) return { data: undefined };
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (res.ok) return { data: json && 'data' in json ? json.data : json };
  const errors: ApiErrorItem[] = json?.errors?.length ? json.errors : [{ code: `HTTP_${res.status}`, message: json?.message ?? res.statusText }];
  const error = new ApiError(res.status, json?.message ?? errors[0].message, errors, json?.traceId);
  const retry = Number(res.headers.get('Retry-After'));
  if (Number.isFinite(retry) && retry > 0) error.retryAfterSeconds = retry;
  if (isContextStale(res.status, error.code, res.headers.get('X-Context-Stale'))) noteStale();
  return { data: null, error };
}

/**
 * Whether the last refresh that failed was refused by the server (the session is really over: 400-level) rather than not answered (offline,
 * a release restarting the server, a 5xx, rate limiting). Only a refusal signs the person out; a refresh that could not be made leaves the
 * session as it is, so a blip while moving between pages never sends someone to the sign-in page.
 */
let lastRefreshRefused = false;
export const refreshWasRefused = () => lastRefreshRefused;
/** Server answers that mean "try again shortly", not "signed out". */
export const transientStatus = (status: number) => status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The refresh index.html started for a signed-in visit, handed out once (later refreshes are the app's own). */
function takeEarlyRefresh(): Promise<Response | null> | null {
  const w = typeof window !== 'undefined' ? (window as Window & { __ptRefresh?: Promise<Response | null> }) : null;
  const p = w?.__ptRefresh ?? null;
  if (w) delete w.__ptRefresh;
  return p;
}

type EarlyReads = { token: string } & Record<string, Promise<Response | null> | string>;
/**
 * A read index.html started as soon as its early refresh answered (/me and /shell/summary, see index.html), handed out once to the same
 * request from the app, and only while the access token is still the one it was made with.
 */
async function takeEarlyRead(path: string): Promise<Response | null> {
  const w = typeof window !== 'undefined' ? (window as Window & { __ptEarly?: Promise<EarlyReads | null> }) : null;
  if (!w?.__ptEarly) return null;
  const early = await w.__ptEarly.catch(() => null);
  const res = early && early.token === accessToken && typeof early[path] === 'object' ? early[path] as Promise<Response | null> : null;
  if (early && res) delete early[path];
  if (!early || (!early['/me'] && !early['/shell/summary'])) delete w.__ptEarly;
  return res ? res.catch(() => null) : null;
}

// One in-flight refresh shared by every caller (page bootstrap, parallel 401s, React StrictMode double-invoke).
let refreshing: Promise<AuthResponse | null> | null = null;
export function refreshSession(): Promise<AuthResponse | null> {
  refreshing ??= (async () => {
    try {
      const auth = await underRefreshLock(async () => {
        // Even when another tab refreshed a moment ago, refresh here too: the cookie this request carries is the one that tab just
        // received, and the server tolerates a near-simultaneous second use of the same token in any case.
        const headers: Record<string, string> = { 'X-Requested-With': 'XMLHttpRequest' }; // CSRF guard for the cookie-based refresh
        if (tabWorkspaceId) headers['X-Workspace-Id'] = tabWorkspaceId;
        // A refresh that is not answered is tried again a couple of times before giving up (without signing out).
        for (let attempt = 0; ; attempt++) {
          let res: Response | null = null;
          // The page's first refresh may already be in flight from index.html (started before the scripts loaded): use that answer once.
          const early = attempt === 0 && !BASE ? takeEarlyRefresh() : null;
          try { res = early ? await early : await fetch(`${BASE}/api/v1/auth/refresh`, { method: 'POST', credentials: 'include', headers }); } catch { res = null; }
          if (res && !transientStatus(res.status)) {
            const { data, error } = await parse(res);
            if (error || !data) {
              lastRefreshRefused = true;
              // Signed out because the account signed in on another device ("Single active session"): the sign-in page says so once.
              if (error?.code === 'SESSION_REPLACED') { try { sessionStorage.setItem('pm_signed_out_reason', error.message); } catch { /* storage unavailable */ } }
              // Locked after inactivity: not signed out. The lock screen takes over and waiting requests go out once it is unlocked.
              if (error?.code === 'SESSION_IDLE_LOCKED') { lastRefreshRefused = false; markLocked(); }
              return null;
            }
            lastRefreshRefused = false;
            remember();
            return data as AuthResponse;
          }
          if (attempt >= 2) { lastRefreshRefused = false; return null; }
          await pause(attempt === 0 ? 600 : 1800);
        }
      });
      if (!auth) return null;
      accessToken = auth.accessToken;
      const tokenWorkspace = workspaceOfToken(auth.accessToken);
      if (tabWorkspaceId && tokenWorkspace !== tabWorkspaceId) onWorkspaceMismatch?.(tokenWorkspace);
      return auth;
    } catch { lastRefreshRefused = false; return null; }
    finally { setTimeout(() => { refreshing = null; }, 0); }
  })();
  return refreshing;
}

interface Options { auth?: boolean; retry?: boolean; signal?: AbortSignal; idempotent?: boolean; noQueue?: boolean }

/**
 * Creating things (projects, tasks, tickets, issues) must never happen twice for one intention: a double click, Enter plus a click, a
 * tap while the network is slow, or a retry after a dropped connection. Identical create requests share one call while it runs, and for
 * a short while after, the same Idempotency-Key, so the server replays the first result instead of creating a copy.
 */
const DEDUPE_MS = 10_000;
const inFlight = new Map<string, Promise<unknown>>();
const recentKeys = new Map<string, { key: string; at: number }>();
const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

export async function api<T = void>(method: string, path: string, body?: unknown, opts: Options = {}): Promise<T> {
  if (opts.idempotent) {
    const sig = `${method} ${path} ${body === undefined ? '' : JSON.stringify(body)}`;
    const running = inFlight.get(sig);
    if (running) return running as Promise<T>;
    const now = Date.now();
    for (const [k, v] of recentKeys) if (now - v.at > DEDUPE_MS) recentKeys.delete(k);
    const key = recentKeys.get(sig)?.key ?? newKey();
    recentKeys.set(sig, { key, at: now });
    const p = send<T>(method, path, body, opts, key).finally(() => inFlight.delete(sig));
    inFlight.set(sig, p);
    return p;
  }
  return send<T>(method, path, body, opts);
}

async function send<T>(method: string, path: string, body: unknown, opts: Options, idempotencyKey?: string): Promise<T> {
  // Something created offline and saved since: its temporary id in an address means the server's id.
  if (path.includes('offline-')) path = resolveIds(path);
  const { auth = true, retry = true, signal } = opts;
  // Started before the session was confirmed (a warm start shows the page at once): wait for the refresh that is running instead of
  // being refused and sent again.
  if (auth && !accessToken && refreshing && !path.startsWith('/auth/')) await refreshing.catch(() => null);
  // Locked after inactivity: the request waits for the unlock (the page and what was typed stay as they are) and fails on a sign-out.
  if (auth && isSessionLocked() && !path.startsWith('/auth/') && !(await waitForUnlock())) throw new ApiError(401, 'Signed out.', [{ code: 'SESSION_IDLE_LOCKED', message: 'Signed out.' }]);
  const workspaceAtStart = tabWorkspaceId;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;
  Object.assign(headers, lensHeaders(method, path));
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  // Sign-in requests say which time zone this device is in: a sign-in waiting for approval shows its approximate region (no IP lookups).
  if (path.startsWith('/auth/')) { try { headers['X-Client-Zone'] = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* no Intl */ } }

  let res: Response;
  try {
    const early = method === 'GET' && auth && !BASE && (path === '/me' || path === '/shell/summary') ? await takeEarlyRead(path) : null;
    res = early ?? await fetch(`${BASE}/api/v1${path}`, {
      method, headers, credentials: 'include', signal, body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    // No connection: a small edit to the person's own work waits in the outbox and the page shows it at once (see lib/outbox.ts).
    if (auth && !opts.noQueue && !signal?.aborted && isQueueable(method, path) && isNetworkFailure(e)) {
      const tempId = isCreate(method, path) ? newTempId() : undefined;
      await enqueue({ method, path, body, workspaceId: workspaceAtStart, idempotencyKey: idempotencyKey ?? newKey(), tempId });
      return (onQueued?.(method, path, body, workspaceAtStart, tempId) ?? body) as T;
    }
    throw e;
  }
  const { data, error } = await parse(res);
  if (!error) {
    if (auth) { mutationCommitted(method, path, workspaceAtStart); writeSucceeded(method, path); }
    return data as T;
  }

  // A date moved later without a reason: the shared "Reason for extending" sheet asks for one and the same request is sent again with it.
  // One place for every surface (task and plan sheets, action items, timeline and calendar drags, quick-add, Aura).
  if (error.status === 422 && error.code === 'DATE_EXTENSION_REASON_REQUIRED' && onExtensionReason && (body === undefined || (body !== null && typeof body === 'object' && !Array.isArray(body)))) {
    const b = (body ?? {}) as Record<string, unknown>;
    if (!b.extensionReason) {
      const reason = await onExtensionReason({ message: error.message, method, path, body: b });
      if (reason) return send<T>(method, path, { ...b, extensionReason: reason, ...(b.dueDateReason ? {} : { dueDateReason: reason }) }, opts, idempotencyKey);
      error.message = 'The date was not moved.';
      (error as ApiError & { cancelled?: boolean }).cancelled = true;
    }
  }

  if (error.status === 401 && auth && retry && !path.startsWith('/auth/') && (error.code === 'SESSION_IDLE_LOCKED' || isSessionLocked())) {
    markLocked();
    if (await waitForUnlock()) return send<T>(method, path, body, { ...opts, retry: false }, idempotencyKey);
    throw error;
  }
  if (error.status === 401 && auth && retry && !path.startsWith('/auth/')) {
    const renewed = await refreshSession();
    if (!renewed && isSessionLocked()) { if (await waitForUnlock()) return send<T>(method, path, body, { ...opts, retry: false }, idempotencyKey); throw error; }
    if (renewed) return send<T>(method, path, body, { ...opts, retry: false }, idempotencyKey);
    // Signed out only when the server refused the refresh; when it could not be reached the session stays and this request fails.
    if (lastRefreshRefused) { accessToken = null; onAuthLost?.(); }
  }
  throw error;
}

/** What the reason sheet is told about a refused date change. */
export interface ExtensionAsk { message: string; method: string; path: string; body: Record<string, unknown> }
let onExtensionReason: ((ask: ExtensionAsk) => Promise<string | null>) | null = null;
/** Set by the app shell: shows the "Reason for extending" sheet and resolves with the reason (null when cancelled). */
export const setExtensionReasonHandler = (fn: ((ask: ExtensionAsk) => Promise<string | null>) | null) => { onExtensionReason = fn; };

type QueuedHandler = (method: string, path: string, body: unknown, workspaceId: string | null, tempId?: string) => unknown;
let onQueued: QueuedHandler | null = null;
/** Set by the app: applies a queued offline edit to the cached answers and returns the optimistic copy for the caller. */
export const setQueuedHandler = (fn: QueuedHandler | null) => { onQueued = fn; };

/** Sends one queued offline edit now (on reconnect), with this session's token: sent, refused as a conflict (server wins), or still offline. */
export async function replayQueued(e: OutboxEntry): Promise<'sent' | 'conflict' | 'rejected' | 'offline' | 'reason'> {
  if (tabWorkspaceId && e.workspaceId && e.workspaceId !== tabWorkspaceId) return 'rejected';
  try {
    const data = await send<{ id?: unknown } | undefined>(e.method, e.path, e.body, { retry: true, noQueue: true }, e.idempotencyKey);
    // A create made offline: from now on its temporary id means the server's one (later queued edits, links, the address bar).
    if (e.tempId && data && typeof data === 'object' && typeof data.id === 'string') recordId(e.tempId, data.id);
    return 'sent';
  } catch (err) {
    if (isNetworkFailure(err)) return 'offline';
    const status = (err as { status?: number }).status ?? 0;
    if (status === 0 || status >= 500 || status === 408 || status === 429) return 'offline';
    if (status === 422 && (err as { code?: string }).code === 'DATE_EXTENSION_REASON_REQUIRED') return 'reason';
    return status === 409 || status === 412 ? 'conflict' : 'rejected';
  }
}

export const get = <T>(path: string, query?: Query, opts?: Options) => api<T>('GET', path + qs(query), undefined, opts);
export const post = <T = void>(path: string, body?: unknown, opts?: Options) => api<T>('POST', path, body ?? {}, opts);
/** A POST that creates something: sent once however many times it is triggered (see DEDUPE_MS). */
export const create = <T = void>(path: string, body?: unknown) => api<T>('POST', path, body ?? {}, { idempotent: true });
export const put = <T = void>(path: string, body: unknown) => api<T>('PUT', path, body);
export const patch = <T = void>(path: string, body: unknown) => api<T>('PATCH', path, body);
export const del = <T = void>(path: string) => api<T>('DELETE', path);

/** After a 401: renew the session and send again, or, when it cannot be renewed, end it in the app the same way api() does. */
async function renewOrLose(refused: Response, send: () => Promise<Response>): Promise<Response> {
  if (await refreshSession()) return send();
  if (isSessionLocked()) return (await waitForUnlock()) ? send() : refused;
  if (lastRefreshRefused) { accessToken = null; onAuthLost?.(); }
  return refused;
}

/** Uploads one file as multipart/form-data (the browser sets the boundary itself). */
export async function uploadFile<T>(path: string, file: File, fields?: Record<string, string>): Promise<T> {
  const body = new FormData();
  body.append('file', file);
  for (const [k, v] of Object.entries(fields ?? {})) body.append(k, v);
  const send = async () => fetch(`${BASE}/api/v1${path}`, {
    method: 'POST', body, credentials: 'include', headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
  });
  let res = await send();
  if (res.status === 401) res = await renewOrLose(res, send);
  const { data, error } = await parse(res);
  if (error) throw error;
  return data as T;
}

/** POSTs a whole form (fields and any number of files) as multipart/form-data. */
export async function postForm<T>(path: string, body: FormData): Promise<T> {
  const send = async () => fetch(`${BASE}/api/v1${path}`, {
    method: 'POST', body, credentials: 'include', headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
  });
  let res = await send();
  if (res.status === 401) res = await renewOrLose(res, send);
  const { data, error } = await parse(res);
  if (error) throw error;
  return data as T;
}

/**
 * POST whose answer is read as it arrives (server-sent events). Returns the open response once the server has accepted the request;
 * a refusal (no plan, no credits, a bad file ...) comes back as an ordinary error response and is thrown as an ApiError.
 */
export async function streamPost(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const send = () => fetch(`${BASE}/api/v1${path}`, {
    method: 'POST', credentials: 'include', signal, body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...lensHeaders('POST', path), ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
  });
  let res = await send();
  if (res.status === 401) res = await renewOrLose(res, send);
  if (!res.ok || !res.body) throw (await parse(res)).error ?? new ApiError(res.status, 'The assistant could not be reached.', []);
  return res;
}

/** Fetches a protected file and returns an object URL; the caller revokes it when the element goes away. */
export async function fetchBlobUrl(path: string, signal?: AbortSignal): Promise<string> {
  const send = async () => fetch(`${BASE}/api/v1${path}`, { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}, credentials: 'include', signal });
  let res = await send();
  if (res.status === 401) res = await renewOrLose(res, send);
  if (!res.ok) throw (await parse(res)).error ?? new ApiError(res.status, 'Could not load the file', []);
  return URL.createObjectURL(await res.blob());
}

/** An authenticated file's text (an export read in the app rather than saved). */
export async function fetchText(path: string, signal?: AbortSignal): Promise<string> {
  const send = async () => fetch(`${BASE}/api/v1${path}`, { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}, credentials: 'include', signal });
  let res = await send();
  if (res.status === 401) res = await renewOrLose(res, send);
  if (!res.ok) throw (await parse(res)).error ?? new ApiError(res.status, 'Could not load the file', []);
  return res.text();
}

/** A POST whose answer is raw bytes (an encrypted file the browser decrypts itself). */
export async function postBytes(path: string, body?: unknown): Promise<Uint8Array<ArrayBuffer>> {
  const send = () => fetch(`${BASE}/api/v1${path}`, {
    method: 'POST', credentials: 'include', body: JSON.stringify(body ?? {}),
    headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
  });
  let res = await send();
  if (res.status === 401) res = await renewOrLose(res, send);
  if (!res.ok) throw (await parse(res)).error ?? new ApiError(res.status, 'Download failed', []);
  return new Uint8Array(await res.arrayBuffer());
}

/** A download asked for with a POST (the body can carry a short-lived two-step token, which must never travel in an address). */
export async function downloadPost(path: string, body: unknown, filename: string, signal?: AbortSignal) {
  const send = () => fetch(`${BASE}/api/v1${path}`, {
    method: 'POST', credentials: 'include', signal, body: JSON.stringify(body ?? {}),
    headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
  });
  let res = await send();
  if (res.status === 401) res = await renewOrLose(res, send);
  if (!res.ok) throw (await parse(res)).error ?? new ApiError(res.status, 'Download failed', []);
  const blob = await res.blob(); signal?.throwIfAborted();
  await saveFile(blob, filename);
}

/** Authenticated file download (CSV). Blob downloads are user-initiated from a click handler. */
export async function download(path: string, filename: string, signal?: AbortSignal) {
  const send = () => fetch(`${BASE}/api/v1${path}`, { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}, credentials: 'include', signal });
  let res = await send();
  if (res.status === 401) {
    if (await refreshSession()) res = await send();
    else if (lastRefreshRefused) { accessToken = null; onAuthLost?.(); }
  }
  if (!res.ok) throw (await parse(res)).error ?? new ApiError(res.status, 'Download failed', []);
  const blob = await res.blob(); signal?.throwIfAborted();
  await saveFile(blob, filename);
}

// A project, task or action item was deleted: everything that showed it (Today, My work, Portfolio, the plan sheet, reminders, the bell,
// search, Aura) reads again at once, so no trace lingers. The query cache registers the refresh (stores/auth.ts) to avoid an import cycle.
let workDeletedHandler: (() => void) | null = null;
export function setWorkDeletedHandler(f: (() => void) | null) { workDeletedHandler = f; }
export function workDeleted<T>(value: T): T { workDeletedHandler?.(); return value; }
