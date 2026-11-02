/** Load likely destinations on navigation intent, never download every feature while idle. */
type Loader = () => Promise<unknown>;
const pages: { path: string; load: Loader }[] = [];
const loaded = new Set<Loader>();
let started = false;
let attempts = 0;
export function registerPage(load: Loader, paths: readonly string[] = []) {
  for (const path of paths) pages.push({ path, load });
}
export function prefetchPages() {
  if (started || typeof window === 'undefined') return;
  started = true;
  const intent = (event: Event) => {
    const c = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (document.hidden || c?.saveData || /^(slow-)?2g$/.test(c?.effectiveType ?? '') || attempts >= 4) return;
    const target = event.target as Element | null;
    const link = target?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!link || link.hasAttribute('download')) return;
    const url = new URL(link.href, window.location.href);
    if (url.origin !== window.location.origin) return;
    const match = pages.filter((p) => url.pathname === p.path || url.pathname.endsWith(p.path) || url.pathname.includes(p.path + '/'))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!match || loaded.has(match.load)) return;
    loaded.add(match.load); attempts++;
    void match.load().catch(() => loaded.delete(match.load));
  };
  document.addEventListener('pointerover', intent, { passive: true });
  document.addEventListener('focusin', intent);
}
