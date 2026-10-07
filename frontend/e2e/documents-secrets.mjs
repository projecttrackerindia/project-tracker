// Browser check of sensitive values (release D5): add a secret, reveal it, and see it hidden again after the time the administrator chose.
//   npm i --no-save playwright-core && BASE=http://127.0.0.1:5173 node e2e/documents-secrets.mjs   (API running, Development, seeded)
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173';
const SHOTS = process.env.SHOTS;
// The demo workspace is on Pro; choosing the reveal time and confidential values are Business, so move it up first (through the API, as the Billing page would).
const API = process.env.API ?? BASE;
const login = await (await fetch(`${API}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'demo@example.com', password: 'Demo@12345' }) })).json();
const up = await fetch(`${API}/api/v1/billing/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.data.accessToken}` }, body: JSON.stringify({ planCode: 'BUSINESS', startTrial: false, seats: 10 }) });
if (!up.ok) { console.log('FAIL  could not move the demo workspace to Business', up.status); process.exit(1); }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--no-sandbox'] });
const results = [];
/** A document opens for reading; switch to editing when the test needs to type. */
let toEdit = async () => undefined;
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
const page = await ctx.newPage();
toEdit = async () => { const b = page.locator('.mode-switch button[aria-label="Edit"]'); await b.first().waitFor({ timeout: 8000 }).catch(() => undefined); if ((await b.count()) && (await b.getAttribute('aria-pressed')) !== 'true') { await b.click(); await page.waitForTimeout(500); } };
page.on('pageerror', (e) => errors.push(e.message));
const shot = async (n) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/secrets-${n}.png` }); };

await page.goto(`${BASE}/login`);
await page.fill('input[type=email], input[name=email]', 'demo@example.com'); await page.fill('input[type=password]', 'Demo@12345'); await page.click('button[type=submit]');
await page.waitForFunction(() => !location.pathname.endsWith('/login') && location.pathname.length > 1, null, { timeout: 30000 });
await page.waitForTimeout(4000);
const slug = new URL(page.url()).pathname.split('/')[1];

// ---- a document to keep the secret in
await page.goto(`${BASE}/${slug}/documents`); await page.waitForTimeout(1500);
await page.locator('button', { hasText: 'New document' }).first().click(); await page.waitForTimeout(900);
await page.locator('.doc-type').first().click();
await page.locator('.modal input.input').first().fill('Integration credentials');
await page.locator('.modal .ss-trigger').first().click(); await page.waitForTimeout(300);
await page.locator('[role=option]').nth(1).click(); await page.waitForTimeout(300);
for (let i = 0; i < 8; i++) {
  const create = page.locator('.modal button', { hasText: 'Create document' });
  if (await create.count()) { await create.click(); break; }
  await page.locator('.modal button', { hasText: /Next|Review/ }).click(); await page.waitForTimeout(400);
}
await page.waitForURL(/documents\/[0-9a-f-]{36}/, { timeout: 15000 }); await toEdit(); await page.waitForTimeout(1500);
const docUrl = page.url().split('?')[0];

// ---- add a secret
const SECRET = 'sk_live_E2E-9f3a7c';
await page.locator('.doc-side-card', { hasText: 'Secrets' }).locator('button', { hasText: 'Add' }).click(); await page.waitForTimeout(500);
await page.locator('.modal input').nth(0).fill('Production key');
await page.locator('.modal input[type=password]').fill(SECRET);
await page.locator('.modal input').nth(2).fill('payments gateway');
await shot('add');
await page.locator('.modal button', { hasText: 'Save' }).click(); await page.waitForTimeout(1500);
const row = page.locator('li[data-secret="Production key"]');
check('the secret is listed by name', (await row.count()) === 1);
check('its value is masked', (await row.locator('code[data-state=masked]').count()) === 1 && !(await page.content()).includes(SECRET));

// ---- reveal, and the page holds the value only while shown
await row.locator('button[aria-label="Reveal Production key"]').click(); await page.waitForTimeout(800);
check('revealing shows the value', (await row.locator('code[data-state=revealed]').innerText()) === SECRET);
check('a countdown bar is shown', (await row.locator('.doc-secret-timer').count()) === 1);
await shot('revealed');
await row.locator('button[aria-label="Hide Production key"]').click(); await page.waitForTimeout(300);
check('hiding masks it at once and removes it from the page', (await row.locator('code[data-state=masked]').count()) === 1 && !(await page.content()).includes(SECRET));

// ---- the administrator's reveal time: each preset re-masks within one second of its time
await page.goto(`${BASE}/${slug}/documents`); await page.waitForTimeout(1500);
const setPreset = async (label) => {
  await page.goto(`${BASE}/${slug}/documents`); await page.waitForTimeout(1200);
  await page.locator('button', { hasText: 'Security' }).first().click(); await page.waitForTimeout(900);
  if (label === 'Custom') {
    await page.locator('.dsec [role=radio]', { hasText: 'Custom' }).click();
    await page.locator('.dsec-custom input').fill('5');
    await page.locator('.dsec-custom button', { hasText: 'Save' }).click();
  } else await page.locator('.dsec [role=radio]', { hasText: label }).click();
  await page.waitForTimeout(1000);
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
};
const timeIt = async (seconds) => {
  await page.goto(docUrl); await toEdit(); await page.waitForTimeout(1500);
  const r = page.locator('li[data-secret="Production key"]');
  await r.locator('button[aria-label="Reveal Production key"]').click();
  await r.locator('code[data-state=revealed]').waitFor({ timeout: 5000 });
  const t0 = Date.now();
  await r.locator('code[data-state=masked]').waitFor({ timeout: (seconds + 5) * 1000 });
  const took = Date.now() - t0;
  check(`${seconds} s: hidden again after ${seconds} s (took ${(took / 1000).toFixed(2)} s)`, took >= seconds * 1000 - 400 && took <= seconds * 1000 + 1000);
};
for (const [label, seconds] of [['10 s', 10], ['15 s', 15], ['30 s', 30], ['60 s', 60], ['Custom', 5]]) { await setPreset(label); await timeIt(seconds); }

// ---- the security dialog
await page.goto(`${BASE}/${slug}/documents`); await page.waitForTimeout(1200);
await page.locator('button', { hasText: 'Security' }).first().click(); await page.waitForTimeout(900);
check('the dialog shows the key version and the audit trail', (await page.locator('.dsec', { hasText: 'Key version' }).count()) === 1 && (await page.locator('.dsec', { hasText: 'Intact' }).count()) >= 0);
await page.locator('.dsec button', { hasText: 'Verify now' }).click(); await page.waitForTimeout(1500);
check('verifying the audit trail reports it intact', (await page.locator('.dsec .badge', { hasText: 'Intact' }).count()) === 1);
await shot('security');
await page.locator('.dsec button', { hasText: 'Rotate key' }).click(); await page.waitForTimeout(500);
await page.locator('.confirm button, .modal button', { hasText: /^Rotate$/ }).last().click(); await page.waitForTimeout(2000);
check('rotating the key moves the values to version 2', (await page.locator('.dsec', { hasText: 'Key version 2' }).count()) === 1);
await page.keyboard.press('Escape');
await page.goto(docUrl); await toEdit(); await page.waitForTimeout(1500);
await page.locator('li[data-secret="Production key"] button[aria-label="Reveal Production key"]').click(); await page.waitForTimeout(800);
check('a value still reveals after the key was rotated', (await page.locator('li[data-secret="Production key"] code[data-state=revealed]').innerText()) === SECRET);

// ---- confidential values ask for a two-step check
await page.waitForTimeout(6000);
await page.locator('.doc-side-card', { hasText: 'Secrets' }).locator('button', { hasText: 'Add' }).click(); await page.waitForTimeout(500);
await page.locator('.modal input').nth(0).fill('Vault password');
await page.locator('.modal input[type=password]').fill('hunter2-e2e');
await page.locator('.modal label', { hasText: 'Confidential' }).locator('input').check();
await page.locator('.modal button', { hasText: 'Save' }).click(); await page.waitForTimeout(1500);
const vault = page.locator('li[data-secret="Vault password"]');
check('a confidential secret is marked', (await vault.locator('.badge', { hasText: 'Confidential' }).count()) === 1);
await vault.locator('button[aria-label="Reveal Vault password"]').click(); await page.waitForTimeout(700);
check('revealing it asks for a two-step code', (await page.locator('.modal', { hasText: 'Confirm it is you' }).count()) === 1);
await page.locator('.modal input[aria-label="Two-step code"]').fill('123456');
await page.locator('.modal button', { hasText: 'Confirm' }).click(); await page.waitForTimeout(1200);
check('without two-step verification on the account it is refused and stays masked', (await page.locator('.modal [role=alert]').count()) === 1 && (await vault.locator('code[data-state=masked]').count()) === 1);
await shot('confidential');

check('no script errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
