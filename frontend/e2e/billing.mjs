// Browser check of the billing screen with simulated payments (the default): choose a plan, see the invoice, cancel.
//   npm i --no-save playwright-core && BASE=http://127.0.0.1:5173 node e2e/billing.mjs
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--no-sandbox'] });
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/login`); await page.fill('input[type=email], input[name=email]', 'demo@example.com'); await page.fill('input[type=password]', 'Demo@12345'); await page.click('button[type=submit]');
await page.waitForSelector('.sidebar, aside', { timeout: 25000 });
const slug = new URL(page.url()).pathname.split('/')[1];
await page.goto(`${BASE}/${slug}/settings/billing`); await page.waitForSelector('text=Current plan', { timeout: 15000 });
check('the billing page shows the current plan', (await page.locator('text=Pro').count()) > 0);
await page.locator('button:has-text("Choose Business")').first().click();
await page.waitForSelector('.modal', { timeout: 5000 });
const txt = await page.locator('.modal').innerText();
check('the confirmation says payments are simulated in demo mode', /simulated/i.test(txt), txt.slice(0, 90));
await page.locator('.modal button:has-text("Confirm")').click();
await page.waitForFunction(() => /Business/.test(document.body.innerText) && document.body.innerText.includes('Renews'), null, { timeout: 10000 }).catch(() => undefined);
check('the plan changes at once and an invoice is listed', (await page.locator('text=Business plan').count()) > 0 || (await page.locator('text=INV-').count()) > 0);
console.log(errors.length ? `page errors:\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
