import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { cspFor } from './lib/csp.mjs';

// Sign-up asks Personal or Organisation and sends only that choice; an invited person is asked nothing.
const dist = path.resolve('dist');
const origin = 'https://projecttracker-preview.test';
const pageCsp = await cspFor(); const csp = pageCsp();
const artifacts = path.resolve(process.env.PM_UI_ARTIFACTS || 'test-results/enterprise-ui', 'signup');
await fs.mkdir(artifacts, { recursive: true });
const sent = [];
const errors = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
try {
  const context = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
  await context.addInitScript(() => { localStorage.setItem('pm_theme', 'light'); });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { await route.abort(); return; }
    if (!url.pathname.startsWith('/api/')) {
      const file = path.resolve(dist, url.pathname.startsWith('/assets/') ? url.pathname.slice(1) : 'index.html');
      assert.ok(file.startsWith(dist + path.sep));
      const type = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' }[path.extname(file)] || 'application/octet-stream';
      const body = await fs.readFile(file).catch(() => null);
      if (!body) { await route.fulfill({ status: 404, body: '' }); return; }
      await route.fulfill({ status: 200, contentType: type, body, headers: path.extname(file) === '.html' ? { 'content-security-policy': pageCsp(file) } : {} }); return;
    }
    const p = url.pathname;
    if (p.endsWith('/auth/register')) { sent.push(route.request().postDataJSON()); await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ data: { userId: 'u1', requiresEmailVerification: true } }) }); return; }
    if (p.endsWith('/auth/refresh')) { await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ message: 'signed out', errors: [] }) }); return; }
    if (p.includes('password-policy')) { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { minLength: 8, requireUpper: false, requireLower: false, requireDigit: false, requireSymbol: false } }) }); return; }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: null }) });
  });

  const fill = async (page, email) => {
    await page.getByLabel('Full name').fill('Asha Rao');
    await page.getByLabel('Email').fill(email);
    const pw = page.locator('input[autocomplete="new-password"]');
    await pw.nth(0).fill('Passw0rd!x-long');
    await pw.nth(1).fill('Passw0rd!x-long');
    await page.locator('.auth-remember input[type=checkbox]').check();
  };

  for (const [w, h, name] of [[1280, 860, 'desktop'], [390, 844, 'phone']]) {
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`${origin}/register`);
    await page.getByRole('radio', { name: /Personal/ }).waitFor();
    assert.equal(await page.getByRole('radio', { name: /Personal/ }).getAttribute('aria-checked'), 'true');
    assert.equal(await page.getByLabel('Organisation name').count(), 0, 'no organisation field for a personal sign-up');
    await page.getByRole('radio', { name: /Organisation/ }).click();
    await page.getByLabel('Organisation name').waitFor();
    await page.waitForTimeout(700);   // the form's entrance animation
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(artifacts, `signup-organisation-${name}.png`), fullPage: true });
    if (name === 'desktop') {
      await fill(page, 'asha@example.test');
      await page.getByRole('button', { name: 'Create account' }).click();
      await page.getByText("Enter your organisation's name.").waitFor();
      assert.equal(sent.length, 0, 'an organisation without a name is not sent');
      await page.getByLabel('Organisation name').fill('Northwind Test Ltd');
      await page.getByRole('button', { name: 'Create account' }).click();
      await page.getByText('Check your email').waitFor();
      assert.equal(sent.at(-1).workspaceType, 'organization');
      assert.equal(sent.at(-1).organizationName, 'Northwind Test Ltd');
    }
    await page.close();
  }

  const invited = await context.newPage();
  await invited.goto(`${origin}/register?email=new%40example.test&redirect=${encodeURIComponent('/invite?token=abc')}`);
  await invited.getByLabel('Full name').waitFor();
  assert.equal(await invited.getByRole('radio').count(), 0, 'an invited person is not asked to choose');
  await fill(invited, 'new@example.test');
  await invited.getByRole('button', { name: 'Create account' }).click();
  await invited.getByText('Check your email').waitFor();
  assert.equal(sent.at(-1).workspaceType, 'invited');
  await invited.screenshot({ path: path.join(artifacts, 'signup-invited.png') });
  assert.deepEqual(errors, []);
  console.log('Sign-up UI OK:', sent.map((s) => s.workspaceType).join(', '));
} finally { await browser.close(); }
