import type { ApiErrorItem, AuthResponse } from './types';

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

/** Full address of an API path, for pages the browser itself goes to (sign-in redirects). */
export const apiUrl = (path: string) => `${BASE}/api/v1${path}`;

export class ApiError extends Error {
  status: number;
  code: string;
  errors: ApiErrorItem[];
  traceId?: string;
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
  return { data: null, error: new ApiError(res.status, json?.message ?? errors[0].message, errors, json?.traceId) };
}

// One in-flight refresh shared by every caller (page bootstrap, parallel 401s, React StrictMode double-invoke).
let refreshing: Promise<AuthResponse | null> | null = null;
export function refreshSession(): Promise<AuthResponse | null> {
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${BASE}/api/v1/auth/refresh`, {
        method: 'POST', credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' }, // CSRF guard for the cookie-based refresh
      });
      const { data, error } = await parse(res);
      if (error || !data) return null;
      const auth = data as AuthResponse;
      accessToken = auth.accessToken;
      return auth;
    } catch { return null; }
    finally { setTimeout(() => { refreshing = null; }, 0); }
  })();
  return refreshing;
}

interface Options { auth?: boolean; retry?: boolean; signal?: AbortSignal }

export async function api<T = void>(method: string, path: string, body?: unknown, opts: Options = {}): Promise<T> {
  const { auth = true, retry = true, signal } = opts;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetch(`${BASE}/api/v1${path}`, {
    method, headers, credentials: 'include', signal, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const { data, error } = await parse(res);
  if (!error) return data as T;

  if (error.status === 401 && auth && retry && !path.startsWith('/auth/')) {
    const renewed = await refreshSession();
    if (renewed) return api<T>(method, path, body, { ...opts, retry: false });
    accessToken = null;
    onAuthLost?.();
  }
  throw error;
}

export const get = <T>(path: string, query?: Query, opts?: Options) => api<T>('GET', path + qs(query), undefined, opts);
export const post = <T = void>(path: string, body?: unknown, opts?: Options) => api<T>('POST', path, body ?? {}, opts);
export const put = <T = void>(path: string, body: unknown) => api<T>('PUT', path, body);
export const patch = <T = void>(path: string, body: unknown) => api<T>('PATCH', path, body);
export const del = <T = void>(path: string) => api<T>('DELETE', path);

/** Uploads one file as multipart/form-data (the browser sets the boundary itself). */
export async function uploadFile<T>(path: string, file: File, fields?: Record<string, string>): Promise<T> {
  const body = new FormData();
  body.append('file', file);
  for (const [k, v] of Object.entries(fields ?? {})) body.append(k, v);
  const send = async () => fetch(`${BASE}/api/v1${path}`, {
    method: 'POST', body, credentials: 'include', headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
  });
  let res = await send();
  if (res.status === 401 && (await refreshSession())) res = await send();
  const { data, error } = await parse(res);
  if (error) throw error;
  return data as T;
}

/** Fetches a protected file and returns an object URL; the caller revokes it when the element goes away. */
export async function fetchBlobUrl(path: string, signal?: AbortSignal): Promise<string> {
  const send = async () => fetch(`${BASE}/api/v1${path}`, { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}, credentials: 'include', signal });
  let res = await send();
  if (res.status === 401 && (await refreshSession())) res = await send();
  if (!res.ok) throw (await parse(res)).error ?? new ApiError(res.status, 'Could not load the file', []);
  return URL.createObjectURL(await res.blob());
}

/** Authenticated file download (CSV). Blob downloads are user-initiated from a click handler. */
export async function download(path: string, filename: string) {
  const res = await fetch(`${BASE}/api/v1${path}`, { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}, credentials: 'include' });
  if (!res.ok) throw (await parse(res)).error ?? new ApiError(res.status, 'Download failed', []);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
