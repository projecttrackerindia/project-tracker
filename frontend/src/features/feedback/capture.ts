/**
 * What "Report a problem" sends besides the person's words: the last console errors and failed requests the app saw (kept in memory only,
 * a short ring each), the route and the app version. Installed once at start-up; nothing leaves the device unless the person sends a report.
 * Only a request's method, path and status are kept (never its query, body or headers), and the server masks secrets again on arrival.
 */
const MAX = 30;
const consoleTail: string[] = [];
const networkTail: string[] = [];
let installed = false;

const push = (ring: string[], line: string) => { ring.push(line.slice(0, 500)); if (ring.length > MAX) ring.shift(); };
const stamp = () => new Date().toISOString().slice(11, 19);
const text = (v: unknown): string => {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
};
const pathOf = (url: string) => { try { return new URL(url, window.location.origin).pathname; } catch { return url.split('?')[0]; } };

export function installCapture() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => { push(consoleTail, `${stamp()} ${args.map(text).join(' ')}`); original(...args); };
  window.addEventListener('error', (e) => push(consoleTail, `${stamp()} ${e.message || 'Script error'}${e.filename ? ` (${pathOf(e.filename)}:${e.lineno})` : ''}`));
  window.addEventListener('unhandledrejection', (e) => push(consoleTail, `${stamp()} Unhandled: ${text(e.reason)}`));
  const fetcher = window.fetch?.bind(window);
  if (!fetcher) return;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    try {
      const res = await fetcher(input, init);
      if (res.status >= 400) push(networkTail, `${stamp()} ${method} ${pathOf(url)} ${res.status}`);
      return res;
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) push(networkTail, `${stamp()} ${method} ${pathOf(url)} failed`);
      throw err;
    }
  };
}

export const recentConsole = () => [...consoleTail];
export const recentNetwork = () => [...networkTail];
/** The build this page runs (index.html's app-build meta), else "dev". */
export const appVersion = () => (typeof document !== 'undefined' && document.querySelector('meta[name="app-build"]')?.getAttribute('content')) || 'dev';

/** Opens "Report a problem" from anywhere (the ⋯ menu, Settings, the command palette, a shake). */
export const REPORT_PROBLEM = 'pt:report-problem';
export const openProblemReport = () => window.dispatchEvent(new Event(REPORT_PROBLEM));
/** Opens "What's new" from anywhere. */
export const OPEN_WHATS_NEW = 'pt:whats-new';
export const openWhatsNew = () => window.dispatchEvent(new Event(OPEN_WHATS_NEW));

/** For tests. */
export const _rings = { consoleTail, networkTail, push };
