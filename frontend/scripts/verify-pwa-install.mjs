import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Installability: the built app (dist) on a real localhost server, so the service worker registers. Checks the manifest and every icon,
// Chrome's own installability verdict (Page.getInstallabilityErrors, what Lighthouse uses), that the worker never answers /api,
// the /download page at phone and desktop width (light and dark), and the phone "Install app" card (iPhone hint).
const dist = path.resolve('dist'), out = path.resolve('test-results/pwa-install');
await fs.mkdir(out, { recursive: true });
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
let apiHits = 0;
const server = http.createServer(async (req, res) => {
  const ep = new URL(req.url, 'http://x').pathname;
  if (ep.startsWith('/api/')) { apiHits++; res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end('{}'); return; }
  let file = path.resolve(dist, '.' + ep);
  if (ep.endsWith('/')) file = path.join(file, 'index.html');
  if (!file.startsWith(dist) || !(await fs.stat(file).catch(() => null))?.isFile()) file = path.join(dist, 'index.html');
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
  res.end(await fs.readFile(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const errors = [];
try {
  // 1. manifest + icons
  const manifest = JSON.parse(await fs.readFile(path.join(dist, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.display, 'standalone'); assert.ok(manifest.start_url && manifest.name && manifest.short_name);
  assert.match(manifest.theme_color, /^#8b6cf6$/i, 'purple theme colour');
  const sizes = manifest.icons.map((i) => `${i.sizes}:${i.purpose}`);
  for (const s of ['192x192:any', '512x512:any', '192x192:maskable', '512x512:maskable']) assert.ok(sizes.includes(s), `icon ${s}`);
  for (const i of manifest.icons) assert.ok((await fs.stat(path.join(dist, i.src))).size > 0, `${i.src} exists`);

  // 2. Chrome's installability verdict + service worker
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(origin + '/login');
  await page.waitForFunction(() => navigator.serviceWorker?.controller || navigator.serviceWorker?.getRegistration().then((r) => !!r?.active), null, { timeout: 15000 });
  const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return r.active?.scriptURL; });
  assert.ok(sw?.endsWith('/sw.js'), 'service worker active');
  const cdp = await ctx.newCDPSession(page);
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
  assert.deepEqual(installabilityErrors, [], `installable: ${JSON.stringify(installabilityErrors)}`);
  const { url: mUrl, errors: mErr } = await cdp.send('Page.getAppManifest');
  assert.ok(mUrl.endsWith('/manifest.webmanifest') && mErr.length === 0, 'manifest parsed');
  // API responses never come from the cache
  await page.reload(); await page.waitForLoadState('networkidle');
  const before = apiHits;
  await page.evaluate(() => fetch('/api/v1/auth/me').catch(() => null));
  await page.evaluate(() => fetch('/api/v1/auth/me').catch(() => null));
  assert.ok(apiHits - before >= 2, 'API requests go to the network');
  const cached = await page.evaluate(async () => { const out = []; for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname); return out; });
  assert.ok(!cached.some((p) => p.startsWith('/api')), `no API in cache: ${cached.filter((p) => p.startsWith('/api'))}`);
  await ctx.close();

  // 3. /download at desktop and phone, light and dark
  for (const [w, h] of [[1440, 1000], [390, 844]]) for (const scheme of ['light', 'dark']) {
    const c = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const p = await c.newPage();
    await p.goto(origin + '/download/'); await p.waitForLoadState('networkidle');
    await p.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 50)); } scrollTo(0, 0); });
    await p.waitForTimeout(400);
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `download scrolls sideways at ${w}`);
    const txt = await p.textContent('body');
    for (const t of ['Android', 'APK', 'TestFlight', 'Add to Home Screen', 'Windows', 'macOS']) assert.ok(txt.includes(t), `download page mentions ${t}`);
    await p.screenshot({ path: path.join(out, `download-${w}-${scheme}.png`), fullPage: true });
    await c.close();
  }

  // 4. the phone install card (iPhone: Share → Add to Home Screen)
  const ios = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  const ip = await ios.newPage();
  await ip.goto(origin + '/login');
  await ip.waitForSelector('.pt-install', { timeout: 10000 });
  const box = await ip.locator('.pt-install').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, 'install card fits the phone');
  for (const b of await ip.locator('.pt-install button').all()) assert.ok((await b.boundingBox()).height >= 32);
  await ip.waitForTimeout(500);
  await ip.screenshot({ path: path.join(out, 'install-card-390.png') });
  await ip.click('.pt-install-x');
  assert.equal(await ip.locator('.pt-install').count(), 0, 'dismissed');
  await ip.reload(); await ip.waitForTimeout(5000);
  assert.equal(await ip.locator('.pt-install').count(), 0, 'stays dismissed');
  await ios.close();

  assert.deepEqual(errors, [], 'no page errors');
  console.log('PWA install checks passed; screenshots in', out);
} finally { await browser.close(); server.close(); }
