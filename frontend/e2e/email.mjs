// Browser check of the e-mail screens: the administrator's delivery panel (Health) and the public "stop emails like this" page.
//   npm i --no-save playwright-core && BASE=http://127.0.0.1:5173 node e2e/email.mjs
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--no-sandbox'] });
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };
const errors = [];

// A sign-up sends a verification e-mail: it must show up in the delivery log.
const email = `mail-e2e-${Date.now()}@example.test`;
const reg = await fetch(`${BASE}/api/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'Mail E2E', email, password: 'Passw0rd!x', acceptedTerms: true }) });
check('a sign-up works', reg.ok, String(reg.status));

const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/login`); await page.waitForTimeout(1000);
await page.fill('input[type=email], input[name=email]', 'admin@example.com'); await page.fill('input[type=password]', 'Admin@12345'); await page.click('button[type=submit]');
await page.waitForURL(/admin/, { timeout: 25000 });
await page.goto(`${BASE}/admin/health`); await page.waitForSelector('.em-stats', { timeout: 15000 });
check('Health shows the e-mail panel with its counts', (await page.locator('.em-stats > div').count()) === 4);
await page.waitForSelector('.table-wrap tbody tr', { timeout: 10000 });
check('the verification message is in the delivery log', (await page.locator('.em-stats ~ .table-wrap').innerText()).includes(email));
await page.click('.em-filter >> text=Failed');
await page.waitForTimeout(600);
check('the log can be filtered', (await page.locator('.em-filter button.on').innerText()) === 'Failed');
await page.fill('.em-domain input', 'not a domain'); await page.click('text=Check domain'); await page.waitForTimeout(800);
check('a bad domain is refused politely', (await page.locator('.em-check').count()) === 0);

// The public page for a bad link
const anon = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const p2 = await anon.newPage();
p2.on('pageerror', (e) => errors.push(e.message));
await p2.goto(`${BASE}/unsubscribe?token=nonsense`); await p2.waitForSelector('text=This link is not valid', { timeout: 10000 });
check('a made-up unsubscribe link says so', true);
check('and it does not scroll sideways', !(await p2.evaluate(() => document.documentElement.scrollWidth > 391 || innerWidth > 391)));

console.log(errors.length ? `page errors:\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
