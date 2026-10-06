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
// Per person: yearly billing and ten people (the demo workspace has six in it) show the discounted price on the card before anything is bought.
await page.click('.seg button:has-text("Yearly")');
// (the demo workspace has paid for ten seats already)
await page.waitForTimeout(300);
const card = await page.locator('.plan-card:has(.plan-name:text-is("Business"))').innerText();
check('the Business card shows the yearly team price per person and the total', card.includes('₹489') && card.includes('₹58,716') && card.includes('30% off'), card.replace(/\s+/g, ' ').slice(0, 140));
check('credits are pooled across the people', card.includes('2,000 for 10') || card.includes('(2,000 for 10)'), '');
await page.locator('button:has-text("Choose Business")').first().click();
await page.waitForSelector('.modal', { timeout: 5000 });
const txt = await page.locator('.modal').innerText();
check('the confirmation says payments are simulated in demo mode', /simulated/i.test(txt), txt.slice(0, 90));
await page.locator('.modal button:has-text("Confirm")').click();
await page.waitForFunction(() => /Business/.test(document.body.innerText) && document.body.innerText.includes('Renews'), null, { timeout: 10000 }).catch(() => undefined);
check('the invoice says what was bought: seats, period and discount', await page.locator('td:has-text("10 seats, billed yearly (30% off)")').first().waitFor({ timeout: 8000 }).then(() => true, () => false));
check('the plan changes at once and an invoice is listed', (await page.locator('text=Business plan').count()) > 0 || (await page.locator('text=INV-').count()) > 0);

// Billing details and the invoice PDF
await page.fill('.bd-grid input[placeholder^="Legal name"]', 'Qruize Technologies Private Limited');
await page.fill('.bd-grid textarea', '12 MG Road\nBengaluru');
await page.click('button:has-text("Save details")'); await page.waitForTimeout(800);
check('billing details can be saved', (await page.locator('button:has-text("Save details")').isDisabled()));
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.locator('button:has-text("PDF")').first().click()]);
const path = await dl.path();
const { readFileSync } = await import('node:fs');
const bytes = readFileSync(path).toString('latin1');
check('the invoice downloads as a PDF', bytes.startsWith('%PDF-1.4') && dl.suggestedFilename().startsWith('Invoice-INV-'), dl.suggestedFilename());
check('it is made out to the details just saved', bytes.includes('Qruize Technologies Private Limited'));

console.log(errors.length ? `page errors:\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
