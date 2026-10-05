/**
 * The public website, built with the app: the search-engine tags and the landing page inside index.html, the static Features, Pricing and
 * Security pages, sitemap.xml and robots.txt. These are plain HTML (no script needed to read them), which is what a search engine,
 * a link preview and a slow phone all want. Their words come from ./content.ts; the signed-in app is untouched.
 */
import type { Plugin } from 'vite';
import { PATHS } from '../src/components/Icon';
import { FEATURES, HOME, NAV, PAGES, PLANS, SECURITY, SITE, type StaticPage } from './content';

const ORIGIN = (process.env.SITE_URL ?? 'https://projecttracker.in').replace(/\/$/, '');
const abs = (path: string) => `${ORIGIN}${path}`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`;

const icon = (name: string, size = 22) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${(PATHS as Record<string, string>)[name] ?? ''}</svg>`;

const VARS = '--bg:#faf9ff;--surface:#fff;--text:#1f1b2e;--muted:#5b5670;--line:#e7e3f5;--brand:#7c3aed;--brand-2:#a855f7;--brand-soft:#f1eaff;--ok:#16a34a;--warn:#d97706;--bad:#dc2626';
const VARS_DARK = '--bg:#120f1d;--surface:#1b1730;--text:#f3f0ff;--muted:#b4adcf;--line:#2d2748;--brand:#a78bfa;--brand-soft:#2a2150';
const FONT = 'Inter,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';

/** The components. Every class carries the pt- prefix (see `scoped`) so none of it can collide with the app's own styles. */
const COMPONENTS = `
.wrap{max-width:1120px;margin:0 auto;padding:0 20px}
.top{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.top .wrap{display:flex;align-items:center;gap:28px;height:64px}
.brand{display:inline-flex;align-items:center;gap:10px;font-weight:800;font-size:18px;color:var(--text);letter-spacing:-.2px}.brand:hover{text-decoration:none}
.brand img{width:32px;height:32px;border-radius:9px;display:block}
.nav{display:flex;gap:6px;margin-left:8px}.nav a{padding:8px 12px;border-radius:8px;color:var(--muted);font-weight:600;font-size:15px}.nav a:hover,.nav a[aria-current]{color:var(--text);background:var(--brand-soft);text-decoration:none}
.actions{margin-left:auto;display:flex;align-items:center;gap:10px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:11px 20px;border-radius:10px;font-weight:700;font-size:15px;border:1px solid transparent;cursor:pointer;line-height:1.2}
.btn:hover{text-decoration:none}
.btn-primary{background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;box-shadow:0 6px 18px rgba(124,58,237,.28)}.btn-primary:hover{filter:brightness(1.06)}
.btn-ghost{background:var(--surface);color:var(--text);border-color:var(--line)}.btn-ghost:hover{border-color:var(--brand)}
.btn-lg{padding:14px 26px;font-size:16px}
.hero{padding:72px 0 40px}
.hero .wrap{display:grid;grid-template-columns:1.05fr .95fr;gap:48px;align-items:center}
.kicker{display:inline-block;padding:5px 12px;border-radius:99px;background:var(--brand-soft);color:var(--brand);font-weight:700;font-size:13px;letter-spacing:.2px}
h1{font-size:clamp(34px,5vw,56px);line-height:1.08;letter-spacing:-1.2px;margin:18px 0 16px;font-weight:800}
.lead{font-size:clamp(17px,2vw,20px);color:var(--muted);margin:0 0 28px;max-width:34em}
.cta{display:flex;flex-wrap:wrap;gap:12px}.fine{margin:16px 0 0;font-size:14px;color:var(--muted)}
.mock{background:var(--surface);border:1px solid var(--line);border-radius:18px;box-shadow:0 30px 70px rgba(76,29,149,.16);padding:18px;display:grid;gap:12px}
.mock h3{margin:0;font-size:15px;display:flex;justify-content:space-between;align-items:center}.mock h3 small{color:var(--muted);font-weight:600}
.row{display:grid;grid-template-columns:1fr auto;gap:6px 12px;padding:12px;border:1px solid var(--line);border-radius:12px}
.row b{font-size:14.5px}.row span.meta{grid-column:1;font-size:12.5px;color:var(--muted)}
.chip{font-size:12px;font-weight:700;padding:3px 10px;border-radius:99px;align-self:start}
.chip.ok{background:#dcfce7;color:#166534}.chip.warn{background:#fef3c7;color:#92400e}.chip.bad{background:#fee2e2;color:#991b1b}
.bar{grid-column:1/-1;height:7px;background:var(--brand-soft);border-radius:9px;overflow:hidden}.bar i{display:block;height:100%;background:linear-gradient(90deg,#7c3aed,#a855f7);border-radius:9px}
section.block{padding:64px 0}
.eyebrow{color:var(--brand);font-weight:800;font-size:13px;letter-spacing:.8px;text-transform:uppercase;margin:0 0 10px}
h2{font-size:clamp(26px,3.4vw,38px);line-height:1.15;letter-spacing:-.6px;margin:0 0 12px;font-weight:800}
.sub{color:var(--muted);font-size:18px;margin:0 0 36px;max-width:40em}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:22px}
.card .ic{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;background:var(--brand-soft);color:var(--brand);margin-bottom:14px}
.card h3{margin:0 0 6px;font-size:17px;letter-spacing:-.2px}.card p{margin:0;color:var(--muted);font-size:15px}
.card ul{list-style:none;margin:10px 0 0;padding:0;display:grid;gap:9px}.card li{display:flex;gap:9px;color:var(--muted);font-size:15px}.card li svg{flex:none;color:var(--ok);margin-top:3px}
.plans{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;align-items:stretch}
.plan{display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:24px}
.plan.hot{border:2px solid var(--brand);box-shadow:0 18px 44px rgba(124,58,237,.18);position:relative}
.plan .tag{position:absolute;top:-12px;left:20px;background:var(--brand);color:#fff;font-size:12px;font-weight:800;padding:3px 12px;border-radius:99px}
.plan h3{margin:0;font-size:19px}.plan .blurb{color:var(--muted);font-size:14.5px;margin:4px 0 14px;min-height:44px}
.price{font-size:36px;font-weight:800;letter-spacing:-1px}.price small{font-size:14px;color:var(--muted);font-weight:600;letter-spacing:0}
.plan ul{list-style:none;margin:18px 0 22px;padding:0;display:grid;gap:10px;flex:1}.plan li{display:flex;gap:9px;font-size:14.5px}.plan li svg{flex:none;color:var(--ok);margin-top:3px}
.note{color:var(--muted);font-size:14px;margin-top:22px}
.band{margin:24px 0 64px;border-radius:24px;padding:48px 28px;text-align:center;color:#fff;background:radial-gradient(circle at 85% 0,#a855f7 0,rgba(168,85,247,0) 50%),linear-gradient(135deg,#4c1d95,#6d28d9 60%,#7c3aed)}
.band h2{color:#fff}.band p{color:#ede9fe;margin:0 auto 24px;max-width:36em;font-size:18px}.band .btn-primary{background:#fff;color:#5b21b6;box-shadow:none}
.page-head{padding:56px 0 8px}.page-head .lead{margin-bottom:0}
.report{display:flex;gap:24px;align-items:center;justify-content:space-between;flex-wrap:wrap;background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:26px;margin-top:20px}
.report h2{font-size:22px;margin:0 0 6px}.report p{margin:0;color:var(--muted);max-width:44em}
footer{border-top:1px solid var(--line);padding:44px 0 36px;color:var(--muted);font-size:14.5px}
footer .cols{display:grid;grid-template-columns:1.4fr repeat(3,1fr);gap:28px}footer h4{margin:0 0 10px;color:var(--text);font-size:14px}
footer ul{list-style:none;margin:0;padding:0;display:grid;gap:8px}footer a{color:var(--muted)}footer a:hover{color:var(--brand)}
footer .legal{margin-top:30px;padding-top:18px;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
@media (max-width:900px){.hero .wrap{grid-template-columns:1fr}.grid{grid-template-columns:repeat(2,1fr)}.plans{grid-template-columns:repeat(2,1fr)}footer .cols{grid-template-columns:1fr 1fr}.nav{display:none}}
@media (max-width:560px){.grid,.plans{grid-template-columns:1fr}.top .wrap{gap:12px}.actions .btn-ghost{display:none}.hero{padding-top:40px}}
`.replace(/\.([a-z][\w-]*)/g, '.pt-$1');

/** A page of its own (the static pages). */
const PAGE_CSS = `:root{${VARS}}@media (prefers-color-scheme:dark){:root{${VARS_DARK}}}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 ${FONT};-webkit-font-smoothing:antialiased}${COMPONENTS}`;

/** The landing page inside index.html, shown only while the visitor is signed out: nested under #site so it styles nothing else. */
const LANDING_CSS = `#site{${VARS};background:var(--bg);color:var(--text);font:16px/1.6 ${FONT};-webkit-font-smoothing:antialiased;min-height:100vh;
&,& *{box-sizing:border-box}${COMPONENTS}}
@media (prefers-color-scheme:dark){#site{${VARS_DARK}}}`;

/** Gives every class in a piece of markup the pt- prefix. */
const scoped = (html: string) => html.replace(/class="([^"]+)"/g, (_m, c: string) => `class="${c.split(' ').map((x) => `pt-${x}`).join(' ')}"`);

/** Prices are read from the live price list when the page opens (the printed ones are only what shows before that or without scripts). */
const PRICE_SCRIPT = `<script>
(function(){try{fetch('/api/v1/public/plans',{headers:{Accept:'application/json'}}).then(function(r){return r.ok?r.json():null}).then(function(list){
if(!list)return;var d=list.data||list;(Array.isArray(d)?d:[]).forEach(function(p){
var el=document.querySelectorAll('[data-price="'+p.code+'"]');if(!el.length)return;
var t=p.priceMonthly==null?'Custom':new Intl.NumberFormat('en-IN',{style:'currency',currency:p.currency||'INR',maximumFractionDigits:0}).format(p.priceMonthly);
el.forEach(function(e){e.textContent=t});
document.querySelectorAll('[data-per="'+p.code+'"]').forEach(function(e){e.style.display=p.priceMonthly==null||p.priceMonthly===0?'none':''})})}).catch(function(){})}catch(e){}})();
</script>`;

const header = (active = '') => `<header class="top"><div class="wrap">
<a class="brand" href="/" aria-label="${SITE.name} home"><img src="/favicon-48x48.png" width="32" height="32" alt="" />${SITE.name}</a>
<nav class="nav" aria-label="Main">${NAV.map((n) => `<a href="${n.href}"${n.href === active ? ' aria-current="page"' : ''}>${n.label}</a>`).join('')}</nav>
<div class="actions"><a class="btn btn-ghost" href="/login">Sign in</a><a class="btn btn-primary" href="/register">Get started</a></div></div></header>`;

const footer = () => `<footer><div class="wrap"><div class="cols">
<div><a class="brand" href="/"><img src="/favicon-48x48.png" width="32" height="32" alt="" />${SITE.name}</a><p style="margin:12px 0 0;max-width:22em">${esc(SITE.tagline)}.</p></div>
<div><h4>Product</h4><ul>${NAV.map((n) => `<li><a href="${n.href}">${n.label}</a></li>`).join('')}</ul></div>
<div><h4>Account</h4><ul><li><a href="/login">Sign in</a></li><li><a href="/register">Create account</a></li></ul></div>
<div><h4>Legal</h4><ul><li><a href="/terms">Terms of Service</a></li><li><a href="/privacy">Privacy Policy</a></li><li><a href="/security/#report">Report a vulnerability</a></li><li><a href="mailto:${SITE.securityEmail}">${SITE.securityEmail}</a></li></ul></div>
</div><div class="legal"><span>© ${new Date().getFullYear()} ${SITE.name}</span><span>Made for teams that deliver.</span></div></div></footer>`;

const tick = icon('tick', 16);
const featureCard = (f: { icon: string; title: string; text: string }) => `<article class="card"><div class="ic">${icon(f.icon)}</div><h3>${esc(f.title)}</h3><p>${esc(f.text)}</p></article>`;
const planCard = (p: (typeof PLANS)[number]) => `<article class="plan${p.featured ? ' hot' : ''}">${p.featured ? '<span class="tag">Most popular</span>' : ''}
<h3>${p.name}</h3><div class="blurb">${esc(p.blurb)}</div>
<div class="price"><span data-price="${p.name.toUpperCase()}">${p.price}</span>${p.price === 'Custom' || p.price === '₹0' ? '' : ` <small data-per="${p.name.toUpperCase()}">/ month</small>`}</div>
<ul>${p.points.map((x) => `<li>${tick}<span>${esc(x)}</span></li>`).join('')}</ul>
<a class="btn ${p.featured ? 'btn-primary' : 'btn-ghost'}" href="/register">${esc(p.cta)}</a></article>`;
const pricingNote = '<p class="note">Prices are per organization per month, in Indian rupees, and the price shown at checkout is the one that applies. Every plan starts from a free account, so you can look around first.</p>';

const mock = `<div class="mock" aria-hidden="true"><h3>Portfolio today <small>3 projects need attention</small></h3>
<div class="row"><b>Customer portal relaunch</b><span class="chip bad">At risk</span><span class="meta">Forecast 9 days after the planned date · 2 blocked tasks</span><div class="bar"><i style="width:58%"></i></div></div>
<div class="row"><b>Mobile app v2</b><span class="chip warn">Watch</span><span class="meta">Forecast 2 days late · 1 overdue task</span><div class="bar"><i style="width:74%"></i></div></div>
<div class="row"><b>Data migration</b><span class="chip ok">On track</span><span class="meta">Forecast on the planned date</span><div class="bar"><i style="width:91%"></i></div></div></div>`;

function landing(): string {
  return `${header()}
<main>
<section class="hero"><div class="wrap"><div>
<span class="kicker">Project management for every team</span>
<h1>${esc(HOME.h1)}</h1>
<p class="lead">${esc(HOME.lead)}</p>
<div class="cta"><a class="btn btn-primary btn-lg" href="/register">Start free</a><a class="btn btn-ghost btn-lg" href="/features/">See what it does</a></div>
<p class="fine">Start on the free plan and move up when your team grows.</p></div>${mock}</div></section>
<section class="block"><div class="wrap"><p class="eyebrow">Everything in one place</p><h2>From the first task to the portfolio review</h2>
<p class="sub">One workspace for planning, doing and reporting, so leaders see the truth without chasing updates.</p>
<div class="grid">${FEATURES.slice(0, 6).map(featureCard).join('')}</div>
<p style="margin-top:22px"><a href="/features/"><strong>See all features →</strong></a></p></div></section>
<section class="block" style="padding-top:8px"><div class="wrap"><p class="eyebrow">Plans</p><h2>Simple plans that grow with you</h2>
<p class="sub">Free for one person. Pro, Business and Enterprise add people, teams, reports and governance.</p>
<div class="plans">${PLANS.map(planCard).join('')}</div>${pricingNote}</div></section>
<section class="block" style="padding-top:8px"><div class="wrap"><p class="eyebrow">Security</p><h2>Each organization's work stays its own</h2>
<p class="sub">Separation in the data layer, role and team based access, single sign-on, an audit log and encrypted traffic.</p>
<a class="btn btn-ghost" href="/security/">How we protect your data</a></div></section>
<div class="wrap"><div class="band"><h2>Bring your projects into one clear view</h2><p>Create your workspace in a minute. Invite your team when you are ready.</p><a class="btn btn-primary btn-lg" href="/register">Create your free account</a></div></div>
</main>${footer()}`;
}

const pageBody: Record<string, () => string> = {
  '/features/': () => `<div class="wrap"><div class="grid">${FEATURES.map(featureCard).join('')}</div>
<div class="band" style="margin-top:56px"><h2>See it with your own projects</h2><p>The free plan has no time limit.</p><a class="btn btn-primary btn-lg" href="/register">Start free</a></div></div>`,
  '/pricing/': () => `<div class="wrap"><div class="plans">${PLANS.map(planCard).join('')}</div>${pricingNote}</div>`,
  '/security/': () => `<div class="wrap"><div class="grid">${SECURITY.map((p) => `<article class="card"><div class="ic">${icon(p.icon)}</div><h3>${esc(p.title)}</h3><ul>${p.points.map((x) => `<li>${tick}<span>${esc(x)}</span></li>`).join('')}</ul></article>`).join('')}</div>
<section class="report" id="report"><div><h2>Report a vulnerability</h2><p>If you believe you have found a security problem, e-mail <a href="mailto:${SITE.securityEmail}">${SITE.securityEmail}</a> with the steps to reproduce it. We reply within two working days, keep you informed while we fix it, and credit you if you wish. Please do not access other customers' data, degrade the service or run automated scans against it while investigating.</p></div>
<a class="btn btn-primary" href="mailto:${SITE.securityEmail}?subject=Security%20report">Report a problem</a></section>
<p class="note">Machine-readable contact: <a href="/.well-known/security.txt">/.well-known/security.txt</a></p></div>`,
};

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
  const crumbs = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: SITE.name, item: abs('/') }, { '@type': 'ListItem', position: 2, name: p.title.split(' | ')[0], item: abs(p.path) }] };
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    ${meta(p, [crumbs, orgLd])}
    <style>${PAGE_CSS}</style>
  </head>
  <body>
${scoped(`${header(p.path)}
<main><div class="wrap page-head"><p class="eyebrow">${esc(p.title.split(' | ')[0])}</p><h1 style="margin-top:0">${esc(p.h1)}</h1><p class="lead">${esc(p.lead)}</p></div>
<section class="block" style="padding-top:28px">${pageBody[p.path]()}</section></main>
${footer()}`)}
${p.path === '/pricing/' ? PRICE_SCRIPT : ''}
  </body>
</html>
`;
}

const sitemap = () => {
  const day = new Date().toISOString().slice(0, 10);
  const urls = ['/', ...PAGES.map((p) => p.path), '/login', '/register', '/terms', '/privacy'];
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
  for (const p of PAGES) out[p.path] = { type: 'text/html', body: staticPage(p), emit: `${p.path.slice(1)}index.html` };
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
        .replace('<!--site:css-->', LANDING_CSS)
        .replace('<!--site:body-->', scoped(landing()))
        .replace('<!--site:scripts-->', PRICE_SCRIPT),
    },
    configureServer: serve,
    configurePreviewServer: serve,
    generateBundle() {
      for (const f of Object.values(files())) this.emitFile({ type: 'asset', fileName: f.emit, source: f.body });
    },
  };
}
