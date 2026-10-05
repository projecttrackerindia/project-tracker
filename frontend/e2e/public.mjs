// Browser check of the public website: the landing page for someone signed out, the static pages, live prices, and the hand-over to the app.
//   npm i --no-save playwright-core && BASE=http://127.0.0.1:5173 node e2e/public.mjs   (API running, Development)
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--no-sandbox'] });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };
const errors = [];

const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));

// Signed out: the home address is the public page, not the sign-in form.
await page.goto(`${BASE}/`);
await page.waitForTimeout(1500);
check('signed-out home shows the landing page', new URL(page.url()).pathname === '/' && await page.locator('#site h1').isVisible());
check('landing page title is the search title', (await page.title()).startsWith('Project Tracker | '), await page.title());
check('the app is not shown behind it', !(await page.locator('#root').isVisible()));
const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
check('structured data names the site', ld.some((t) => t.includes('"WebSite"') && t.includes('"alternateName"')));
check('social image and canonical are set', (await page.locator('meta[property="og:image"]').getAttribute('content')).endsWith('/og-image.png') && !!(await page.locator('link[rel=canonical]').getAttribute('href')));

// The public pages are real pages with their own title, and prices come from the live price list.
for (const [path, title] of [['/features/', 'Features | Project Tracker'], ['/pricing/', 'Pricing | Project Tracker'], ['/security/', 'Security | Project Tracker']]) {
  await page.goto(`${BASE}${path}`);
  check(`${path} is its own page`, (await page.title()) === title && (await page.locator('h1').count()) === 1, await page.title());
}
await page.goto(`${BASE}/pricing/`);
await page.waitForTimeout(800);
check('pricing shows the live Pro price', /₹\s?999/.test(await page.locator('[data-price=PRO]').first().innerText()));
for (const f of ['/sitemap.xml', '/robots.txt', '/favicon.ico', '/favicon.svg', '/og-image.png']) {
  const r = await page.request.get(`${BASE}${f}`);
  check(`${f} is served`, r.ok(), String(r.status()));
}
for (const d of ['portfolio', 'ai-assistant', 'teams-and-access', 'timesheets-and-workload']) {
  await page.goto(`${BASE}/features/${d}/`);
  const crumbs = (await page.locator('script[type="application/ld+json"]').allTextContents()).join('');
  check(`/features/${d}/ is its own page`, (await page.locator('h1').count()) === 1 && (await page.title()).includes('| Project Tracker') && crumbs.includes('BreadcrumbList') && crumbs.includes('"Features"'));
}
check('sitemap lists the public pages', (await (await page.request.get(`${BASE}/sitemap.xml`)).text()).includes('/features/portfolio/'));

// The sign-in page and the legal pages are part of the app but have their own titles.
await page.goto(`${BASE}/login`);
await page.waitForSelector('input[type=password]');
check('sign-in has its own title', (await page.title()).startsWith('Sign in'), await page.title());
await page.goto(`${BASE}/terms`);
await page.waitForTimeout(1200);
check('terms page is public', (await page.locator('.sec-hero h1').innerText()).length > 0 && (await page.title()).startsWith('Terms of Service'));

// Only public screens are indexable; any other address says so, and the sign-in page names itself as canonical.
await page.goto(`${BASE}/login`);
check('sign-in is its own canonical page', (await page.locator('link[rel=canonical]').getAttribute('href')).endsWith('/login') && (await page.locator('meta[name=robots]').getAttribute('content')).startsWith('index'));
await page.goto(`${BASE}/some-org/projects`);
check('app addresses are noindex', (await page.locator('meta[name=robots]').getAttribute('content')).startsWith('noindex'));

// Signing in: the home address is now the app.
await page.goto(`${BASE}/login`);
await page.fill('input[type=email], input[name=email]', 'demo@example.com');
await page.fill('input[type=password]', 'Demo@12345');
await page.click('button[type=submit]');
await page.waitForFunction(() => !!document.querySelector('.sidebar, nav.sidebar, [class*=sidebar]'), null, { timeout: 20000 }).catch(() => undefined);
await page.waitForTimeout(3000);
await page.goto(`${BASE}/`);
await page.waitForTimeout(2000);
check('signed-in home is the app', await page.locator('#root').isVisible() && !(await page.locator('#site').isVisible()), page.url());

// A device with no memory of a sign-in but a live session still ends in the app (the session settles it).
await page.evaluate(() => localStorage.removeItem('pm_hint'));
await page.goto(`${BASE}/`);
await page.waitForTimeout(2500);
check('live session without the hint still opens the app', await page.locator('#root').isVisible() && !(await page.locator('#site').isVisible()));

check('no script errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
