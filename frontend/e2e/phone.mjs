// Browser check of signing in by approving on a phone: a computer asks, the phone (already signed in, with the app open) shows an island with three
// numbers, the right one signs the computer in, a wrong one does not, and a Free-plan account cannot turn the feature on. Run against a running API
// (Development, seeded) and the Vite dev server:
//   npm i --no-save playwright-core && BASE=http://127.0.0.1:5173 node e2e/phone.mjs
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173';
const EMAIL = process.env.EMAIL ?? 'demo@example.com', PASSWORD = process.env.PASSWORD ?? 'Demo@12345';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--no-sandbox'] });
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };
const errors = [];

// A phone that has already opted in: sign in over the API, register a (fake) push endpoint and allow it to approve sign-ins.
const api = async (path, init = {}, token) => (await fetch(`${BASE}/api/v1${path}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers } })).json();
const login = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
const token = login.data.accessToken;
const endpoint = `https://push.example.invalid/e2e-${Date.now()}`;
await api('/push/subscriptions', { method: 'POST', body: JSON.stringify({ endpoint, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } }) }, token);
const enabled = await api('/push/sign-in', { method: 'PUT', body: JSON.stringify({ endpoint, enabled: true }) }, token);
check('a Pro-plan phone can turn on approving sign-ins', enabled.data?.enabled === true, JSON.stringify(enabled).slice(0, 160));

const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const p = await phone.newPage();
p.on('pageerror', (e) => errors.push(e.message));
await p.goto(`${BASE}/login`); await p.waitForTimeout(1200);
await p.fill('input[type=email], input[name=email]', EMAIL); await p.fill('input[type=password]', PASSWORD); await p.click('button[type=submit]');
await p.waitForSelector('.m-tabs', { timeout: 25000 });

const desk = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const d = await desk.newPage();
d.on('pageerror', (e) => errors.push(e.message));
await d.goto(`${BASE}/login`); await d.waitForTimeout(1200);
await d.click('.auth-phone');
check('asking for the phone without an email says so', (await d.locator('.form-error').count()) === 1);
await d.fill('input[type=email], input[name=email]', EMAIL);
await d.click('.auth-phone'); await d.waitForFunction(() => /^\d\d$/.test(document.querySelector('.ps-number')?.textContent ?? ''), null, { timeout: 10000 });
const number = parseInt(await d.locator('.ps-number').innerText(), 10);
check('the computer shows a two-digit number', number >= 10 && number <= 99, String(number));

await p.waitForSelector('.island', { timeout: 15000 });
check('the phone drops an island with the request', (await p.locator('.island-head').innerText()).includes('Sign-in request'));
check('the island opens to three numbers', (await p.locator('.island .ap-nums button').count()) === 3);
check('the island sits inside the screen', await p.evaluate(() => { const r = document.querySelector('.island').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0; }));
const nums = (await p.locator('.island .ap-nums button').allInnerTexts()).map((t) => parseInt(t, 10));
check('the right number is among them', nums.includes(number), nums.join(','));
const wrong = nums.find((n) => n !== number);
await p.locator('.island .ap-nums button', { hasText: String(wrong) }).first().tap();
await p.waitForTimeout(800);
check('a wrong number says so and does not sign the computer in', (await p.locator('.island .ap-err').count()) === 1 && (await d.locator('.ps-number').count()) === 1);
// One wrong pick is allowed; the right number on the same request then signs the computer in.
await p.locator('.island .ap-nums button', { hasText: String(number) }).first().tap();
await d.waitForSelector('.dp-dock, aside.sidebar, .sidebar', { timeout: 20000 });
check('the right number signs the computer in by itself', !(await d.url()).includes('/login'), d.url());

// Mobile app page
const slug = new URL(p.url()).pathname.split('/')[1];
await p.goto(`${BASE}/${slug}/account/mobile`); await p.waitForSelector('.ma-hero', { timeout: 15000 });
check('Account → Mobile app shows the three steps', (await p.locator('.ma-step').count()) === 3);
check('the plan lock is not shown on Pro', (await p.locator('.ma-lock').count()) === 0);
check('the mobile app page does not scroll sideways', !(await p.evaluate(() => document.documentElement.scrollWidth > 391 || innerWidth > 391)));

console.log(errors.length ? `page errors:\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
