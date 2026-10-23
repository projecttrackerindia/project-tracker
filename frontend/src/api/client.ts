import type { ApiErrorItem, AuthResponse } from './types';
import { saveFile } from '../lib/native';
import { lensHeaders } from '../lib/lensState';

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
export const setWorkspaceMismatchHandler = (fn: (tokenWorkspace: string | null) => void) => { onWorkspaceMismatch = fn; };

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
  return { data: null, error };
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
        const res = await fetch(`${BASE}/api/v1/auth/refresh`, { method: 'POST', credentials: 'include', headers });
        const { data, error } = await parse(res);
        if (error || !data) return null;
        remember();
        return data as AuthResponse;
      });
      if (!auth) return null;
      accessToken = auth.accessToken;
      const tokenWorkspace = workspaceOfToken(auth.accessToken);
      if (tabWorkspaceId && tokenWorkspace !== tabWorkspaceId) onWorkspaceMismatch?.(tokenWorkspace);
      return auth;
    } catch { return null; }
    finally { setTimeout(() => { refreshing = null; }, 0); }
  })();
  return refreshing;
}

interface Options { auth?: boolean; retry?: boolean; signal?: AbortSignal; idempotent?: boolean }

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
  const { auth = true, retry = true, signal } = opts;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;
  Object.assign(headers, lensHeaders(method, path));
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const res = await fetch(`${BASE}/api/v1${path}`, {
    method, headers, credentials: 'include', signal, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const { data, error } = await parse(res);
  if (!error) return data as T;

  if (error.status === 401 && auth && retry && !path.startsWith('/auth/')) {
    const renewed = await refreshSession();
    if (renewed) return send<T>(method, path, body, { ...opts, retry: false }, idempotencyKey);
    accessToken = null;
    onAuthLost?.();
  }
  throw error;
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
  accessToken = null;
  onAuthLost?.();
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

/** Authenticated file download (CSV). Blob downloads are user-initiated from a click handler. */
export async function download(path: string, filename: string, signal?: AbortSignal) {
  const send = () => fetch(`${BASE}/api/v1${path}`, { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}, credentials: 'include', signal });
  let res = await send();
  if (res.status === 401) {
    if (await refreshSession()) res = await send();
    else { accessToken = null; onAuthLost?.(); }
  }
  if (!res.ok) throw (await parse(res)).error ?? new ApiError(res.status, 'Download failed', []);
  const blob = await res.blob(); signal?.throwIfAborted();
  await saveFile(blob, filename);
}
