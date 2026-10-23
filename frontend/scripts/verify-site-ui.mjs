import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { cspFor } from './lib/csp.mjs';

// The public website: the landing page, Features, the new feature pages and Pricing at desktop and phone width. Prices come from the
// live price list (mocked here with the current catalog), the AI employee scene and the suite tiles render, nothing scrolls sideways.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/site-ui');
await fs.mkdir(out, { recursive: true });
const pageCsp = await cspFor(); const csp = pageCsp();
const pricing = { policy: { annualDiscountPercent: 20, maxTotalDiscountPercent: 30, volumeTiers: [{ minSeats: 10, percent: 10 }, { minSeats: 25, percent: 15 }, { minSeats: 100, percent: 20 }] },
  plans: [{ code: 'FREE', priceMonthly: 0, currency: 'INR', perSeat: false }, { code: 'PRO', priceMonthly: 449, currency: 'INR', perSeat: true }, { code: 'BUSINESS', priceMonthly: 999, currency: 'INR', perSeat: true }, { code: 'ENTERPRISE', priceMonthly: null, currency: 'INR', perSeat: false }] };
const errors = [], checks = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
try {
  for (const [w, h] of [[1440, 1000], [390, 844]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' });
    await ctx.route('**/*', async (route) => {
      const url = new URL(route.request().url()), ep = url.pathname;
      if (url.origin !== origin) { await route.abort(); return; }
      if (ep === '/api/v1/public/pricing') { await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: pricing }) }); return; }
      if (ep.startsWith('/api/')) { await route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }); return; }
      let file = path.resolve(dist, ep.slice(1));
      if (ep.endsWith('/')) file = path.join(file, 'index.html');
      if (!file.startsWith(dist) || !(await fs.stat(file).catch(() => null))?.isFile()) file = path.join(dist, 'index.html');
      await route.fulfill({ contentType: types[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file), headers: file.endsWith('.html') ? { 'content-security-policy': pageCsp(file) } : {} });
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${w}: ${e.message}`));
    const visit = async (p, name) => {
      await page.goto(origin + p); await page.waitForLoadState('networkidle');
      // scroll through so every section is revealed, then back to the top
      await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); } window.scrollTo(0, 0); });
      await page.waitForTimeout(500);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${p} scrolls sideways at ${w}`);
      await page.screenshot({ path: path.join(out, `${name}-${w}.png`), fullPage: true });
    };
    await visit('/', 'landing');
    await page.locator('.pt-emp-stage').waitFor();
    await page.locator('.pt-ast-stage').waitFor();
    assert.ok(await page.locator('.pt-suite .pt-tile').count() === 3);
    await page.locator('.pt-emp').scrollIntoViewIfNeeded(); await page.waitForTimeout(3200);
    await page.locator('.pt-emp').screenshot({ path: path.join(out, `employee-${w}.png`) });
    await page.locator('.pt-ast').scrollIntoViewIfNeeded(); await page.waitForTimeout(2600);
    await page.locator('.pt-ast').screenshot({ path: path.join(out, `assist-${w}.png`) });
    await page.locator('.pt-suite').scrollIntoViewIfNeeded(); await page.waitForTimeout(2000);
    await page.locator('.pt-suite').screenshot({ path: path.join(out, `suite-${w}.png`) });
    await page.locator('.pt-hero').screenshot({ path: path.join(out, `hero-${w}.png`) });
    await page.locator('[data-price="PRO"]', { hasText: '449' }).first().waitFor();
    await page.locator('[data-price="BUSINESS"]', { hasText: '999' }).first().waitFor();
    checks.push(`landing-${w}`);
    await visit('/pricing/', 'pricing');
    await page.locator('.pt-matrix', { hasText: 'AI employee for calls and WhatsApp' }).waitFor();
    await page.locator('.pt-matrix', { hasText: '300 per person' }).waitFor();
    checks.push(`pricing-${w}`);
    await visit('/features/', 'features');
    await page.locator('.pt-emp-stage').waitFor();
    for (const p of ['/features/connect-ai/', '/features/ai-employee/', '/features/operations/', '/features/doctracker/', '/features/meeting-notetaker/']) {
      await visit(p, p.split('/')[2]);
      await page.locator('h1').first().waitFor();
    }
    checks.push(`features-${w}`);
    await ctx.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors }));
} finally { await browser.close(); }
