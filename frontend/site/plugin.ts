/**
 * The public website, built with the app: the search-engine tags and the landing page inside index.html, the static Features, Pricing and
 * Security pages, sitemap.xml and robots.txt. These are plain HTML (no script needed to read them), which is what a search engine,
 * a link preview and a slow phone all want. Their words come from ./content.ts, their look from ./css.ts and their markup from ./sections.ts;
 * the signed-in app is untouched.
 */
import type { Plugin } from 'vite';
import { DETAILS, HOME, PAGES, SITE, type StaticPage } from './content';
import { CLIENT_SCRIPT } from './client';
import { landingCss, pageCss, scoped } from './css';
import { esc, landing, staticMain } from './sections';

const ORIGIN = (process.env.SITE_URL || 'https://projecttracker.in').replace(/\/$/, '');
/** Proof of ownership for the search engines' webmaster tools, and the IndexNow key: set at build time, empty means not used. */
const GOOGLE_VERIFY = process.env.GOOGLE_SITE_VERIFICATION || '';
const BING_VERIFY = process.env.BING_SITE_VERIFICATION || '';
const INDEXNOW_KEY = /^[A-Za-z0-9-]{8,128}$/.test(process.env.INDEXNOW_KEY || '') ? process.env.INDEXNOW_KEY! : '';
const abs = (path: string) => `${ORIGIN}${path}`;
const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`;

/** Prices are read from the live price list when the page opens (the printed ones are only what shows before that or without scripts). */
const PRICE_SCRIPT = `<script>
(function(){try{fetch('/api/v1/public/plans',{headers:{Accept:'application/json'}}).then(function(r){return r.ok?r.json():null}).then(function(list){
if(!list)return;var d=list.data||list;(Array.isArray(d)?d:[]).forEach(function(p){
var el=document.querySelectorAll('[data-price="'+p.code+'"]');if(!el.length)return;
var t=p.priceMonthly==null?'Custom':new Intl.NumberFormat('en-IN',{style:'currency',currency:p.currency||'INR',maximumFractionDigits:0}).format(p.priceMonthly);
el.forEach(function(e){e.textContent=t});
document.querySelectorAll('[data-per="'+p.code+'"]').forEach(function(e){e.style.display=p.priceMonthly==null||p.priceMonthly===0?'none':''})})}).catch(function(){})}catch(e){}})();
</script>`;

const orgLd = {
  '@context': 'https://schema.org', '@type': 'Organization', '@id': abs('/#organization'), name: SITE.name, url: abs('/'),
  logo: { '@type': 'ImageObject', url: abs('/icons/icon-512.png'), width: 512, height: 512 },
};
const siteLd = { '@context': 'https://schema.org', '@type': 'WebSite', '@id': abs('/#website'), url: abs('/'), name: SITE.name, alternateName: SITE.alternateNames, description: SITE.description, publisher: { '@id': abs('/#organization') }, inLanguage: 'en' };
const appLd = {
  '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: SITE.name, url: abs('/'), applicationCategory: 'BusinessApplication', operatingSystem: 'Web',
  description: SITE.description, image: abs('/og-image.png'), offers: { '@type': 'Offer', price: '0', priceCurrency: 'INR', description: 'Free plan' },
};

function meta(page: { path: string; title: string; description: string }, extra: unknown[] = []): string {
  const url = abs(page.path);
  return [
    `<title>${esc(page.title)}</title>`,
    `<meta name="description" content="${esc(page.description)}" />`,
    `<link rel="canonical" href="${url}" />`,
    '<meta name="robots" content="index, follow, max-image-preview:large" />',
    `<meta name="theme-color" content="${SITE.themeColor}" />`,
    ...(GOOGLE_VERIFY ? [`<meta name="google-site-verification" content="${esc(GOOGLE_VERIFY)}" />`] : []),
    ...(BING_VERIFY ? [`<meta name="msvalidate.01" content="${esc(BING_VERIFY)}" />`] : []),
    '<link rel="icon" href="/favicon.ico" sizes="48x48" />',
    '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />',
    '<link rel="icon" type="image/png" sizes="48x48" href="/favicon-48x48.png" />',
    '<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />',
    '<link rel="manifest" href="/manifest.webmanifest" />',
    `<meta property="og:site_name" content="${SITE.name}" />`, '<meta property="og:type" content="website" />', '<meta property="og:locale" content="en_IN" />',
    `<meta property="og:title" content="${esc(page.title)}" />`, `<meta property="og:description" content="${esc(page.description)}" />`,
    `<meta property="og:url" content="${url}" />`, `<meta property="og:image" content="${abs('/og-image.png')}" />`,
    '<meta property="og:image:width" content="1200" />', '<meta property="og:image:height" content="630" />', `<meta property="og:image:alt" content="${SITE.name}: ${esc(SITE.tagline)}" />`,
    '<meta name="twitter:card" content="summary_large_image" />', `<meta name="twitter:title" content="${esc(page.title)}" />`,
    `<meta name="twitter:description" content="${esc(page.description)}" />`, `<meta name="twitter:image" content="${abs('/og-image.png')}" />`,
    ...extra.map(ld),
  ].join('\n    ');
}

function staticPage(p: StaticPage): string {
  const trail: { name: string; path: string }[] = [{ name: SITE.name, path: '/' }];
  if (p.path.startsWith('/features/') && p.path !== '/features/') trail.push({ name: 'Features', path: '/features/' });
  trail.push({ name: p.title.split(' | ')[0], path: p.path });
  const crumbs = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: trail.map((t, i) => ({ '@type': 'ListItem', position: i + 1, name: t.name, item: abs(t.path) })) };
  const page = { '@context': 'https://schema.org', '@type': 'WebPage', '@id': abs(p.path), url: abs(p.path), name: p.title, description: p.description, isPartOf: { '@id': abs('/#website') }, inLanguage: 'en' };
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="preload" href="/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin />
    ${meta(p, [crumbs, page, orgLd])}
    <style>${pageCss()}</style>
  </head>
  <body>
${scoped(staticMain(p))}
${CLIENT_SCRIPT}
${p.path === '/pricing/' ? PRICE_SCRIPT : ''}
  </body>
</html>
`;
}

const sitemap = () => {
  const day = new Date().toISOString().slice(0, 10);
  const urls = ['/', ...PAGES.map((p) => p.path), ...DETAILS.map((d) => d.path), '/login', '/register', '/terms', '/privacy'];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${abs(u)}</loc><lastmod>${day}</lastmod></url>`).join('\n')}\n</urlset>\n`;
};

const robots = () => `User-agent: *
Allow: /
Disallow: /api/
Disallow: /hubs/
Disallow: /scim/
Disallow: /r/
Disallow: /invite
Disallow: /auth/
Disallow: /reset-password
Disallow: /verify-email
Disallow: /dev/

Sitemap: ${abs('/sitemap.xml')}
`;

/** Everything this plugin serves or emits, by URL path. */
function files(): Record<string, { type: string; body: string; emit: string }> {
  const out: Record<string, { type: string; body: string; emit: string }> = {
    '/sitemap.xml': { type: 'application/xml', body: sitemap(), emit: 'sitemap.xml' },
    '/robots.txt': { type: 'text/plain', body: robots(), emit: 'robots.txt' },
  };
  for (const p of [...PAGES, ...DETAILS]) out[p.path] = { type: 'text/html', body: staticPage(p), emit: `${p.path.slice(1)}index.html` };
  if (INDEXNOW_KEY) out[`/${INDEXNOW_KEY}.txt`] = { type: 'text/plain', body: INDEXNOW_KEY, emit: `${INDEXNOW_KEY}.txt` };
  return out;
}

export function publicSite(): Plugin {
  const serve = (server: { middlewares: { use: (fn: (req: { url?: string }, res: { setHeader: (k: string, v: string) => void; end: (b: string) => void }, next: () => void) => void) => void } }) => {
    server.middlewares.use((req, res, next) => {
      const path = (req.url ?? '').split('?')[0];
      const hit = files()[path] ?? files()[`${path}/`];
      if (!hit) return next();
      res.setHeader('Content-Type', `${hit.type}; charset=utf-8`);
      res.end(hit.body);
    });
  };
  return {
    name: 'public-site',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => html
        .replace('<!--site:head-->', meta(HOME, [siteLd, orgLd, appLd]))
        .replace('<!--site:css-->', landingCss())
        .replace('<!--site:body-->', scoped(landing()))
        .replace('<!--site:scripts-->', CLIENT_SCRIPT + PRICE_SCRIPT),
    },
    configureServer: serve,
    configurePreviewServer: serve,
    generateBundle() {
      for (const f of Object.values(files())) this.emitFile({ type: 'asset', fileName: f.emit, source: f.body });
    },
  };
}
