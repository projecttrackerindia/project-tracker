// Error tracking and real-user speed, without a third-party script.
//  - Errors: uncaught errors and unhandled promise rejections go to POST /api/v1/telemetry/errors; the API relays them to the
//    Sentry-compatible service (only when the server has a DSN: GET /telemetry/config says so) and scrubs them again.
//  - Speed: LCP, INP, CLS, TTFB and FCP measured with the browser's own PerformanceObserver (the same definitions as Google's
//    web-vitals library) and sent once per page view, when the page is hidden, to POST /api/v1/telemetry/vitals (signed-in only;
//    stored under the current workspace). Page addresses are reduced to a pattern before they leave ("/projects/:id/board").
// Nothing personal is sent: no names, e-mail, query strings or typed text.
import { getAccessToken } from '../api/client';
import { isDesktopApp } from './desktop';
import { isNativeApp } from './native';
import { useAuth } from '../stores/auth';

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '';
export const RELEASE = (import.meta.env.VITE_APP_RELEASE as string | undefined) || 'dev';

export type AppKind = 'web' | 'desktop' | 'android' | 'ios';
export function appKind(): AppKind {
  if (isDesktopApp()) return 'desktop';
  if (isNativeApp()) return 'android';
  const c = (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor;
  return c?.getPlatform?.() === 'ios' ? 'ios' : 'web';
}

export function deviceClass(width = window.innerWidth, touch = navigator.maxTouchPoints > 0): 'mobile' | 'tablet' | 'desktop' {
  if (width < 640) return 'mobile';
  if (width < 1100 && touch) return 'tablet';
  return 'desktop';
}

/** "/projects/1b4e…/board?x=1" → "/projects/:id/board" (same rule as the server). */
export function pagePattern(path: string): string {
  let p = path.split('?')[0].split('#')[0].toLowerCase();
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ':id').replace(/\/[^/]*\d[^/]*/g, '/:id');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p.slice(0, 80);
}

/** Same scrubbing as the server, applied before anything leaves the device. */
export function scrub(text: string): string {
  return text.slice(0, 4000)
    .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, '[token]')
    .replace(/\b(bearer|basic)\s+[\w.~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\bpmk_[\w-]{8,}/g, '[api-key]')
    .replace(/\b(password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization|cookie|otp)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1$2[redacted]')
    .replace(/[\w.%+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]')
    .replace(/(?<![\w-])\+?\d[\d -]{8,}\d(?![\w-])/g, '[number]')
    .replace(/(https?:\/\/[^\s?#)]+)\?[^\s)#]*/g, '$1');
}

/** The address without the workspace's own name ("/acme-corp/projects" → "/projects"): no workspace is identifiable from a page. */
function currentPage(): string {
  const slug = useAuth.getState().ctx?.current?.slug;
  const p = location.pathname;
  const stripped = slug && (p === `/${slug}` || p.startsWith(`/${slug}/`)) ? p.slice(slug.length + 1) || '/' : p;
  return pagePattern(stripped);
}

let errorsOn = false;
let sentErrors = 0;
const seen = new Set<string>();

function post(path: string, body: unknown, auth: boolean) {
  const token = getAccessToken();
  if (auth && !token) return;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  void fetch(`${BASE}/api/v1${path}`, { method: 'POST', headers, body: JSON.stringify(body), keepalive: true, credentials: 'omit' }).catch(() => undefined);
}

export function reportError(error: unknown) {
  if (!errorsOn || sentErrors >= 10) return;
  const e = error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Unhandled rejection');
  const key = `${e.name}:${e.message}`;
  if (seen.has(key)) return;
  seen.add(key); sentErrors++;
  post('/telemetry/errors', {
    type: e.name, message: scrub(e.message), stack: scrub(e.stack ?? ''), page: currentPage(),
    app: appKind(), release: RELEASE, device: deviceClass(),
  }, false);
}

type Vitals = Partial<Record<'LCP' | 'INP' | 'CLS' | 'TTFB' | 'FCP', number>>;

function observe(type: string, cb: (entries: PerformanceEntry[]) => void, opts: Record<string, unknown> = {}) {
  try {
    if (!PerformanceObserver.supportedEntryTypes?.includes(type)) return;
    new PerformanceObserver((l) => cb(l.getEntries())).observe({ type, buffered: true, ...opts } as PerformanceObserverInit);
  } catch { /* old browser */ }
}

function startVitals() {
  const v: Vitals = {};
  const nav = performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
  if (nav && nav.responseStart > 0) v.TTFB = Math.max(0, nav.responseStart - ((nav as PerformanceNavigationTiming & { activationStart?: number }).activationStart ?? 0));
  observe('paint', (es) => { for (const e of es) if (e.name === 'first-contentful-paint') v.FCP = e.startTime; });
  observe('largest-contentful-paint', (es) => { const last = es[es.length - 1]; if (last) v.LCP = last.startTime; });
  // CLS: the largest "session window" of layout shifts (gaps < 1 s, window < 5 s), ignoring shifts right after input.
  let cls = 0, win = 0, first = 0, prev = 0;
  observe('layout-shift', (es) => {
    for (const e of es as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
      if (e.hadRecentInput) continue;
      if (win && e.startTime - prev < 1000 && e.startTime - first < 5000) win += e.value; else { win = e.value; first = e.startTime; }
      prev = e.startTime; cls = Math.max(cls, win); v.CLS = cls;
    }
  });
  // INP: the slowest interaction (≈ the 98th percentile once there are 50+), from Event Timing.
  const durations: number[] = [];
  observe('event', (es) => {
    for (const e of es as (PerformanceEntry & { interactionId?: number })[]) {
      if (!e.interactionId) continue;
      durations.push(e.duration);
      const sorted = [...durations].sort((a, b) => b - a);
      v.INP = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length / 50))];
    }
  }, { durationThreshold: 40 });

  let sent = false;
  const flush = (force = false) => {
    if (sent || (!force && document.visibilityState !== 'hidden')) return;
    const metrics = Object.entries(v).filter(([, n]) => typeof n === 'number' && Number.isFinite(n)).map(([name, value]) => ({ name, value: name === 'CLS' ? value : Math.round(value as number) }));
    if (metrics.length === 0) return;
    sent = true;
    post('/telemetry/vitals', { page: currentPage(), device: deviceClass(), metrics }, true);
  };
  document.addEventListener('visibilitychange', () => flush());
  window.addEventListener('pagehide', () => flush(true));
}

let started = false;
export function startTelemetry() {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener('error', (ev) => reportError(ev.error ?? ev.message));
  window.addEventListener('unhandledrejection', (ev) => reportError(ev.reason));
  void fetch(`${BASE}/api/v1/telemetry/config`, { credentials: 'omit' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { data?: { errors?: boolean; vitals?: boolean } } | null) => {
      errorsOn = !!j?.data?.errors;
      if (j?.data?.vitals !== false) startVitals();
    })
    .catch(() => undefined);
}
