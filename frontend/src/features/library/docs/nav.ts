/**
 * Addresses of Library's documentation. One place builds them, and one function turns every old DocTracker / Library address into the new
 * one, so links people saved keep working.
 *
 *   /library                              the documentation hub
 *   /library/security                     Security Center
 *   /library/p/{project}                  a project's documentation (Overview); {project} is the project id, or "general"
 *   /library/p/{project}/api              API reference index
 *   /library/p/{project}/api/{endpoint}   one endpoint's symbol page
 *   /library/p/{project}/architecture     architecture and request flows
 *   /library/p/{project}/d/{document}     a guide (any document) read inside its project
 *   /library/docs/{document}              a document on its own
 */
export const GENERAL = 'general';
export const docsPath = {
  hub: () => '/library',
  security: () => '/library/security',
  project: (p: string | null) => `/library/p/${encodeURIComponent(p ?? GENERAL)}`,
  apiIndex: (p: string | null) => `${docsPath.project(p)}/api`,
  endpoint: (p: string | null, ep: string) => `${docsPath.project(p)}/api/${encodeURIComponent(ep)}`,
  architecture: (p: string | null) => `${docsPath.project(p)}/architecture`,
  guide: (p: string | null, doc: string) => `${docsPath.project(p)}/d/${encodeURIComponent(doc)}`,
  doc: (doc: string) => `/library/docs/${encodeURIComponent(doc)}`,
};

/** The topic a project address points at. */
export type Topic = { kind: 'overview' } | { kind: 'api' } | { kind: 'endpoint'; id: string } | { kind: 'architecture' } | { kind: 'guide'; id: string };
export function topicOf(rest: string): Topic {
  const [a, b] = rest.split('/').filter(Boolean);
  if (a === 'api' && b) return { kind: 'endpoint', id: decodeURIComponent(b) };
  if (a === 'api') return { kind: 'api' };
  if (a === 'architecture') return { kind: 'architecture' };
  if (a === 'd' && b) return { kind: 'guide', id: decodeURIComponent(b) };
  return { kind: 'overview' };
}

/**
 * Where an old address goes: DocTracker's `?view=home|security`, `?p=` project, `?t=overview|apis|architecture|documents`, `?ep=` endpoint
 * (on /library, /library/docs or /doctracker). Returns null when the address is already a new one. Other query values (new=1, title) are kept.
 */
export function legacyTarget(pathname: string, search: string): string | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (!/^\/(library(\/docs)?|doctracker(\/.*)?)$/.test(path)) return null;
  const q = new URLSearchParams(search);
  const legacy = ['view', 'p', 't', 'ep'].some((k) => q.has(k)) || path.startsWith('/doctracker') || path === '/library/docs';
  if (!legacy) return null;
  const view = q.get('view'), p = q.get('p'), t = q.get('t'), ep = q.get('ep');
  for (const k of ['view', 'p', 't', 'ep', 'tab']) q.delete(k);
  const rest = q.toString() ? `?${q}` : '';
  if (view === 'security') return docsPath.security() + rest;
  if (p) {
    if (ep) return docsPath.endpoint(p, ep) + rest;
    if (t === 'architecture') return docsPath.architecture(p) + rest;
    if (t === 'apis') return docsPath.apiIndex(p) + rest;
    return docsPath.project(p) + rest;
  }
  return docsPath.hub() + rest;
}

/** DEV / UAT / PROD names for an API's servers: from the host when it says so, otherwise by order. */
export function envLabels(servers: string[]): { label: string; url: string }[] {
  const named = servers.map((url) => {
    let host = url.toLowerCase();
    try { host = new URL(url).hostname; } catch { /* not a full URL */ }
    const parts = host.split('.'); if (parts.length > 1) parts.pop();   // the TLD (".test", ".dev") says nothing about the environment
    const t = new Set(parts.join('-').split('-'));
    const has = (...w: string[]) => w.some((x) => t.has(x));
    const label = has('uat', 'stg', 'staging', 'stage', 'preprod') ? 'UAT' : has('sit', 'qa', 'test') ? 'SIT' : has('dev', 'sandbox', 'local', 'localhost') ? 'DEV'
      : has('prod', 'production', 'live', 'api', 'www') ? 'PROD' : '';
    return { label, url };
  });
  const order = ['DEV', 'UAT', 'PROD'];
  return named.map((n, i) => ({ url: n.url, label: n.label || (servers.length <= 3 ? order[order.length - servers.length + i] ?? `ENV ${i + 1}` : `ENV ${i + 1}`) }));
}
