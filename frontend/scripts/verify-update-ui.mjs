// The "new version available" banner, against the real production build: no banner on the first load, the banner once the server's
// /version.json names a different build (found on returning to the tab), "Later" until the next release, and "Reload" loading the new one.
// Service workers are blocked, as in the Android app's WebView: the check must work without one. Synthetic API answers only.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { appCsp } from './lib/csp.mjs';

const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/update-banner');
await fs.mkdir(out, { recursive: true });
const nginx = await fs.readFile('nginx.conf', 'utf8');
assert.match(nginx, /location = \/version\.json \{\s*add_header Cache-Control "no-store";/, 'nginx serves /version.json with no-store');
const csp = await appCsp();
const indexHtml = await fs.readFile(path.join(dist, 'index.html'), 'utf8');
const running = indexHtml.match(/<meta name="app-build" content="([^"]+)"/)?.[1];
assert.ok(running, 'index.html names its build');
assert.deepEqual(JSON.parse(await fs.readFile(path.join(dist, 'version.json'), 'utf8')), { build: running }, 'version.json names the same build');

const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Preview User', email: 'preview@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 2 };
const me = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['work.view'], modules: { projects: 3, tasks: 3, work: 3, reports: 3, calendar: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: {} } };

let server = running;          // the build the server "has now"
let deployedHtml = indexHtml;  // index.html after a release (its meta names the new build)
let signedIn = false;
let versionReads = 0;
const errors = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
try {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
  await ctx.addInitScript(() => { localStorage.setItem('pm_alerts_prompt', '1'); });
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url()), ep = url.pathname;
    if (url.origin !== origin) { await route.abort(); return; }
    if (ep === '/version.json') {
      versionReads++;
      assert.equal(route.request().headers()['cache-control'] ?? 'no-store', 'no-store');
      await route.fulfill({ contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify({ build: server }) });
      return;
    }
    if (ep.startsWith('/api/')) {
      if (ep.endsWith('/avatar')) { await route.fulfill({ status: 404, body: '' }); return; }
      if (ep.endsWith('/auth/refresh')) {
        if (!signedIn) { await route.fulfill({ status: 401, contentType: 'application/json', body: '{"message":"Not signed in"}' }); return; }
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { accessToken: `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`, expiresAt: '2099-01-01T00:00:00Z', user } }) });
        return;
      }
      assert.equal(route.request().method(), 'GET', `Unexpected write ${ep}`);
      let data = [];
      if (ep === '/api/v1/me') data = me;
      else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
      else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
      else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
      return;
    }
    const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html');
    assert.ok(file.startsWith(dist + path.sep));
    const ext = path.extname(file);
    const type = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[ext] || 'application/octet-stream';
    const body = ext === '.html' ? deployedHtml : await fs.readFile(file);
    await route.fulfill({ contentType: type, body, headers: ext === '.html' ? { 'content-security-policy': csp } : {} });
  });

  const banner = (page) => page.locator('.upd-banner');
  const returnToTab = (page) => page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
  const settle = (page) => page.waitForTimeout(400);
  async function open(url, selector, width, height = 900) {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width, height });
    await page.goto(origin + url);
    await page.locator(selector).first().waitFor({ timeout: 15000 });
    await page.evaluate(() => document.fonts.ready);
    return page;
  }

  // 1. First load, and returning to the tab while the server still has this build: nothing to say.
  let page = await open('/login', 'form', 1280);
  await settle(page);
  assert.equal(await banner(page).count(), 0, 'No banner on the first load');
  await returnToTab(page);
  await settle(page);
  assert.equal(versionReads, 1, 'Returning to the tab asks the server once (focus and visibilitychange together)');
  assert.equal(await banner(page).count(), 0, 'No banner while the server has the running build');
  await page.close();

  // 2. A release goes out while a tab is open: the next return to the tab shows the banner.
  page = await open('/login', 'form', 1280);
  server = 'release-2';
  await returnToTab(page);
  await banner(page).waitFor({ timeout: 5000 });
  assert.match(await banner(page).innerText(), /A new version of Project Tracker is available\./);
  assert.equal(await page.evaluate(() => document.activeElement?.closest('.upd-banner') ?? null), null, 'The banner never takes focus');
  await page.waitForTimeout(400);   // the entrance animation
  await banner(page).screenshot({ path: path.join(out, 'banner-light.png') });
  await page.screenshot({ path: path.join(out, 'page-light.png') });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForTimeout(150);
  await banner(page).screenshot({ path: path.join(out, 'banner-dark.png') });
  await page.screenshot({ path: path.join(out, 'page-dark.png') });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  const bannerBox = await banner(page).boundingBox();
  assert.ok(bannerBox.y + bannerBox.height <= 900 - 12, 'The banner sits at the bottom, inside the screen');

  // 3. "Later" hides it for this release; the next release shows it again (coming back online checks straight away).
  await page.getByRole('button', { name: 'Later', exact: true }).click();
  assert.equal(await banner(page).count(), 0, '"Later" hides the banner');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await settle(page);
  assert.equal(await banner(page).count(), 0, 'The same release stays dismissed');
  server = 'release-3';
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await banner(page).waitFor({ timeout: 5000 });

  // 4. "Reload" loads the release (no service worker here: a plain reload), and the new page has nothing more to say.
  deployedHtml = indexHtml.replace(`content="${running}"`, `content="${server}"`);
  await page.evaluate(() => { window.__oldPage = true; });
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Reload', exact: true }).click()]);
  await page.locator('form').first().waitFor({ timeout: 15000 });
  assert.equal(await page.evaluate(() => window.__oldPage ?? false), false, 'Reload reloaded the page');
  assert.equal(await page.locator('meta[name="app-build"]').getAttribute('content'), 'release-3', 'The reloaded page runs the new build');
  await returnToTab(page);
  await settle(page);
  assert.equal(await banner(page).count(), 0, 'No banner once the new build is running');
  await page.close();

  // 5. On a phone, signed in: above the tab bar.
  signedIn = true; server = 'release-3'; deployedHtml = indexHtml;
  page = await open('/preview-org/calendar', '.v2-phone-bar', 390, 844);
  server = 'release-4';
  await returnToTab(page);
  await banner(page).waitFor({ timeout: 5000 });
  await page.waitForTimeout(400);
  const b = await banner(page).boundingBox(), tabs = await page.locator('.v2-phone-bar').boundingBox();
  assert.ok(b.y + b.height <= tabs.y - 4, 'The banner sits above the tab bar');
  assert.ok(b.x >= 15 && b.x + b.width <= 390 - 15, 'The banner keeps the 16px side gutters');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'No sideways scroll');
  await page.screenshot({ path: path.join(out, 'phone-light.png') });
  await page.close();

  assert.deepEqual(errors, [], 'No page errors');
  console.log(JSON.stringify({ running, versionReads, screenshots: (await fs.readdir(out)).filter((f) => f.endsWith('.png')).map((f) => path.join(out, f)), pageErrors: errors }, null, 2));
} finally {
  await browser.close();
}
