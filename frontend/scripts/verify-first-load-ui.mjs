import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

import { appCsp } from './lib/csp.mjs';

// First load (built app, synthetic API, fictional data):
//  - the launch splash in index.html paints before any script or stylesheet has arrived: the purple check and "ProjectTracker", centred,
//    on the app's light or dark background, at 390 and 1440, and with the app's stylesheets still on the way;
//  - it leaves once the first screen is there (#pt-splash removed) and the page shows with no horizontal scroll, light and dark;
//  - the late stylesheet (styles/late.css) is placed straight after index.html's own stylesheets and ahead of every page stylesheet, so the
//    cascade is as before; Today paints without it (shell pieces that moved stay styled: the timer chip), and any other page opened first
//    waits for it (Messages renders with it already applied);
//  - the build ships pre-compressed .gz copies of its scripts and styles (nginx gzip_static).
const origin = 'https://projecttracker-preview.test', dist = path.resolve(process.env.DIST ?? 'dist'), out = path.resolve('test-results/first-load');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const g = (n) => `90000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const user = { id: g(1), displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: g(9), slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 3 };
const me = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, reportCount: 0, permissions: ['projects.view', 'projects.edit', 'projects.create', 'tasks.view', 'tasks.edit', 'tasks.create', 'work.view', 'work.create', 'reports.view'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 0, activity: 3, documents: 3, people: 3, reports: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: {} } };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const shots = [];
const errors = [];

const type = (f) => ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' })[path.extname(f)] || 'application/octet-stream';
async function open({ url = '/preview-org/', theme = 'light', width = 390, hold = null, block = null }) {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block', viewport: { width, height: width === 390 ? 844 : 900 }, isMobile: width === 390, hasTouch: width === 390, reducedMotion: 'reduce' });
  await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_hint', '1'); localStorage.setItem('pm_theme', t); }, theme);
  await ctx.route('**/*', async (route) => {
    const u = new URL(route.request().url()), ep = u.pathname;
    if (u.origin !== origin || ep.startsWith('/hubs/')) return route.abort();
    if (!ep.startsWith('/api/')) {
      if (hold && hold.test(ep)) return;   // never answers: the moment before it arrives
      if (block && block.test(ep)) return route.abort();
      const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html');
      let body; try { body = await fs.readFile(file); } catch { return route.fulfill({ status: 404, body: '' }); }
      return route.fulfill({ contentType: type(file), body, headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
    }
    let data = [];
    if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
    else if (ep === '/api/v1/me') data = me;
    else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: true };
    else if (ep.endsWith('/approvals')) data = { items: [], counts: { needsMe: 0, mine: 0, all: 0, history: 0 }, week: { approved: 0, rejected: 0, expired: 0, medianMinutes: null }, byType: {}, elsewhere: [] };
    else if (ep.endsWith('/shell/summary')) data = { workspaceId: ws.id, notifications: { unread: 0, needsYou: 0, forInfo: 0, tabs: {} }, approvals: { needsMe: 0 }, chatUnread: { count: 0, conversations: 0 }, reminders: null };
    else if (ep.endsWith('/counts')) data = { unread: 0, needsYou: 0, forInfo: 0, tabs: {}, needsMe: 0, mine: 0, all: 0, history: 0 };
    else if (ep.endsWith('/avatar') || ep.endsWith('/file')) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${url}: ${e.message}`));
  void page.goto(origin + url).catch(() => undefined);
  return { ctx, page };
}
const snap = async (page, name) => { const file = path.join(out, `${name}.png`); await page.screenshot({ path: file }); shots.push(file); };

// 1. The splash, before anything else has arrived: scripts held back, and the app's stylesheets still downloading.
for (const [theme, width] of [['light', 390], ['dark', 390], ['light', 1440], ['dark', 1440]]) {
  const { ctx, page } = await open({ theme, width, hold: /^\/assets\// });
  await page.waitForSelector('#pt-splash svg', { state: 'visible', timeout: 15000 });
  await page.waitForTimeout(300);
  const s = await page.evaluate(() => {
    const el = document.getElementById('pt-splash'), svg = el.querySelector('svg').getBoundingClientRect(), r = el.getBoundingClientRect();
    return { text: el.textContent.trim(), bg: getComputedStyle(el).backgroundColor, cover: r.width === innerWidth && r.height === innerHeight,
      dx: Math.abs(svg.left + svg.width / 2 - innerWidth / 2), above: svg.top + svg.height / 2 < innerHeight / 2 + 30, sx: document.documentElement.scrollWidth - innerWidth };
  });
  assert.equal(s.text, 'ProjectTracker');
  assert.ok(s.cover, 'the splash covers the screen');
  assert.ok(s.dx < 2 && s.above, `the mark is centred (${s.dx})`);
  assert.equal(s.bg, theme === 'dark' ? 'rgb(11, 14, 21)' : 'rgb(243, 246, 251)', `${theme} background`);
  assert.ok(s.sx <= 0);
  await snap(page, `splash-${theme}-${width}`);
  await ctx.close();
}

// 2. Today opens: the splash leaves, the page has no horizontal scroll; the late styles are placed right after index.html's stylesheets.
for (const [theme, width] of [['light', 390], ['dark', 390], ['light', 1440], ['dark', 1440]]) {
  const { ctx, page } = await open({ theme, width });
  await page.waitForSelector('main', { timeout: 30000 });
  await page.waitForFunction(() => !document.getElementById('pt-splash'), null, { timeout: 15000 });
  await page.mouse.click(2, 2).catch(() => undefined);   // first interaction: whatever was put off until the first screen settled loads now
  await page.waitForFunction(() => !!document.querySelector('link[data-late]')?.sheet, null, { timeout: 15000 });
  const order = await page.evaluate(() => {
    const links = [...document.querySelectorAll('link[rel="stylesheet"]')];
    const late = links.findIndex((l) => l.hasAttribute('data-late'));
    const main = links.findIndex((l) => /\/assets\/frontend-/.test(l.href));
    return { late, main, before: links.slice(0, late).every((l) => l.parentElement === document.body), sx: document.documentElement.scrollWidth - innerWidth };
  });
  assert.equal(order.late, order.main + 1, 'late.css sits straight after the app stylesheet');
  assert.ok(order.before, 'only index.html\'s own stylesheets come before it');
  assert.ok(order.sx <= 0, `no horizontal scroll (${theme} ${width})`);
  await page.waitForTimeout(400);
  await snap(page, `today-${theme}-${width}`);
  await ctx.close();
}

// 3. Today without the late styles at all still has its shell styled (rules that moved to first-screen files).
{
  const { ctx, page } = await open({ width: 1440, block: /\/assets\/late-/ });
  await page.waitForSelector('main', { timeout: 30000 });
  await page.waitForFunction(() => !document.getElementById('pt-splash'), null, { timeout: 15000 });
  const chip = await page.evaluate(() => { const c = document.querySelector('.timer-chip'); return c ? getComputedStyle(c).borderRadius : 'none'; });
  if (chip !== 'none') assert.equal(chip, '999px', 'the timer chip keeps its pill shape without late.css');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0);
  await snap(page, 'today-without-late-1440');
  await ctx.close();
}

// 4. Another page opened first waits for the late styles: when Messages shows, late.css is applied.
{
  const { ctx, page } = await open({ url: '/preview-org/messages', width: 390 });
  await page.waitForSelector('main', { timeout: 30000 });
  await page.waitForFunction(() => !document.getElementById('pt-splash'), null, { timeout: 20000 });
  assert.ok(await page.evaluate(() => !!document.querySelector('link[data-late]')?.sheet), 'late.css is in before Messages renders');
  await snap(page, 'messages-390');
  await ctx.close();
}

// 5. Pre-compressed copies ship with the build.
const assets = await fs.readdir(path.join(dist, 'assets'));
const main = assets.find((f) => /^frontend-.*\.js$/.test(f));
assert.ok(main && assets.includes(`${main}.gz`), 'scripts ship with a .gz copy');

await browser.close();
assert.deepEqual(errors, []);
console.log(JSON.stringify({ ok: true, shots }, null, 1));
