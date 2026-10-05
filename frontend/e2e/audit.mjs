// Walks every screen of the app at phone sizes and reports anything that sticks out past the screen: a page that scrolls sideways, a layout that
// widens the viewport, or an element (outside a deliberate scroller) wider than the screen. Run against a running API and Vite:
//   BASE=http://127.0.0.1:5173 WIDTHS=390,360,320 node e2e/audit.mjs      (SHOTS=dir to save a screenshot per screen)
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173';
// Sizes are WIDTH or WIDTHxHEIGHT (a phone on its side is 844x390).
const SIZES = (process.env.WIDTHS ?? '390,360,320,844x390').split(',').map((t) => { const [w, h] = t.split('x').map(Number); return { w, h: h ?? 800 }; });
const SHOTS = process.env.SHOTS;
const ONLY = process.env.ONLY?.split(',');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--no-sandbox'] });
const SETTINGS = ['general', 'access', 'security', 'sso', 'billing', 'audit', 'data', 'project-groups', 'timeline-templates', 'labels', 'priorities', 'custom-fields', 'work-types', 'automation', 'reminders', 'api-keys', 'webhooks', 'email', 'git'];
const ROUTES = ['', 'my-work', 'ai', 'reminders', 'timesheet', 'timesheet/approvals', 'calendar', 'chat', 'projects', 'portfolio', 'operations', 'reports', 'reports/operations', 'workload', 'workload/capacity',
  'people', 'people/teams', 'people/invitations', 'people/org-chart', 'activity', 'notifications', 'organization', 'account', 'account/notifications', 'account/security', 'account/mobile',
  ...SETTINGS.map((s) => `settings/${s}`)];

const api = async (path, token) => (await fetch(`${BASE}/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } })).json();
const login = await (await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'demo@example.com', password: 'Demo@12345' }) })).json();
const token = login.data.accessToken;

let bad = 0;
for (const { w, h } of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`); await page.waitForTimeout(1000);
  await page.fill('input[type=email], input[name=email]', 'demo@example.com'); await page.fill('input[type=password]', 'Demo@12345'); await page.click('button[type=submit]');
  await page.waitForSelector('.m-tabs', { timeout: 30000 });
  const slug = new URL(page.url()).pathname.split('/')[1];
  const routes = [...ROUTES];
  try { const pr = await api('/projects?pageSize=1', token); const id = pr.data?.items?.[0]?.id ?? pr.data?.[0]?.id; if (id) routes.push(`projects/${id}`); } catch { /* none */ }
  for (const r of routes) {
    if (ONLY && !ONLY.some((o) => r.startsWith(o))) continue;
    await page.goto(`${BASE}/${slug}/${r}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1400);
    const res = await page.evaluate((vw) => {
      const out = { inner: innerWidth, doc: document.documentElement.scrollWidth, wide: [] };
      const inScroller = (el) => { for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) { const o = getComputedStyle(e).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; };
      for (const el of document.querySelectorAll('body *')) {
        if (!(el instanceof HTMLElement) || el.closest('.m-tabs,.toast-root,.island,.sheet-scrim,.auth-blob,.react-flow,table.rt thead') || el.classList.contains('auth-blob')) continue;
        const cs = getComputedStyle(el); if (cs.position === 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue;
        if ((r.right > vw + 1 || r.left < -1) && !inScroller(el)) out.wide.push(`${el.tagName.toLowerCase()}.${(el.className?.toString() ?? '').split(' ').slice(0, 2).join('.')} ${Math.round(r.left)}..${Math.round(r.right)} «${(el.textContent ?? '').trim().slice(0, 24)}»`);
      }
      out.wide = out.wide.slice(0, 4);
      // Deliberate scrollers that really scroll sideways: fine for a board or a timeline, but a plain table should be cards on a phone.
      out.scrollers = [];
      for (const el of document.querySelectorAll('body *')) {
        if (!(el instanceof HTMLElement) || el.closest('.m-tabs,.sheet')) continue;
        const o = getComputedStyle(el).overflowX; if (o !== 'auto' && o !== 'scroll') continue;
        if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) out.scrollers.push(`${el.tagName.toLowerCase()}.${(el.className?.toString() ?? '').split(' ').slice(0, 2).join('.')} ${el.clientWidth}/${el.scrollWidth}`);
      }
      return out;
    }, w);
    if (process.env.DEBUG) console.log(JSON.stringify(res));
    const sideways = res.inner > w + 1 || res.doc > w + 1;
    const ok = !sideways && res.wide.length === 0;
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'BAD '} ${w} /${r}${ok ? '' : `  inner=${res.inner} doc=${res.doc} ${res.wide.join(' | ')}`}${res.scrollers.length ? `  SCROLLS: ${res.scrollers.join(' | ')}` : ''}`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${w}-${r.replace(/\//g, '_') || 'home'}.png` });
  }
  await ctx.close();
}
await browser.close();
console.log(bad ? `${bad} screens stick out` : 'every screen fits');
process.exit(bad ? 1 : 0);
