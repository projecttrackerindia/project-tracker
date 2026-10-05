// Browser check of passkeys with a virtual authenticator (the browser's own test device): add a passkey in Settings → Security, sign out, sign in with
// it (no password), and see it listed as the way the session was opened. Passkeys need a secure origin, and http://localhost counts as one:
//   npm i --no-save playwright-core && BASE=http://localhost:5173 node e2e/passkey.mjs
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--no-sandbox'] });
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };
const errors = [];

const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
const cdp = await ctx.newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });

await page.goto(`${BASE}/login`); await page.waitForTimeout(1200);
check('the sign-in page offers a passkey', (await page.locator('.auth-passkey').count()) === 1);
await page.fill('input[type=email], input[name=email]', 'demo@example.com'); await page.fill('input[type=password]', 'Demo@12345'); await page.click('button[type=submit]');
await page.waitForSelector('.sidebar, aside', { timeout: 25000 });
const slug = new URL(page.url()).pathname.split('/')[1];

await page.goto(`${BASE}/${slug}/account/security`); await page.waitForSelector('.pk-list', { timeout: 15000 });
check('Security lists no passkeys to begin with', (await page.locator('.pk-item').count()) === 0);
await page.click('text=Add a passkey'); await page.waitForSelector('.pk-item', { timeout: 15000 });
check('a passkey is added with a device name', (await page.locator('.pk-item').count()) === 1, await page.locator('.pk-main b').first().innerText());
check('it says it has not been used yet', (await page.locator('.pk-main small').first().innerText()).includes('Not used yet'));

// Rename
await page.click('.pk-item >> text=Rename'); await page.fill('.pk-edit input', 'Work laptop'); await page.click('.pk-edit >> text=Save');
await page.waitForFunction(() => document.querySelector('.pk-main b')?.textContent === 'Work laptop');
check('it can be renamed', true);

// Sign out completely, then sign in with the passkey alone (no email typed: the device offers the one it holds).
await ctx.clearCookies();
await page.goto(`${BASE}/login`); await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* none */ } });
await page.reload(); await page.waitForSelector('.auth-passkey');
await page.click('.auth-passkey');
await page.waitForSelector('.sidebar, aside', { timeout: 25000 });
check('the passkey alone signs in', !page.url().includes('/login'), page.url());

await page.goto(`${BASE}/${slug}/account/security`); await page.waitForSelector('.pk-list', { timeout: 15000 });
check('the passkey now shows when it was used', !(await page.locator('.pk-main small').first().innerText()).includes('Not used yet'));
check('the session list says it was opened with a passkey', (await page.locator('text=with a passkey').count()) >= 1);

// Remove
page.once('dialog', (d) => d.accept());
await page.click('.pk-item button[aria-label^="Remove"]');
await page.click('.modal button.btn-danger, .modal button:has-text("Remove")').catch(() => undefined);
await page.waitForFunction(() => document.querySelectorAll('.pk-item').length === 0, null, { timeout: 8000 }).catch(() => undefined);
check('it can be removed', (await page.locator('.pk-item').count()) === 0);

console.log(errors.length ? `page errors:\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
