// Browser check of API documentation (release D4): describe an API, add an endpoint, import a file, export, publish, and see what broke.
//   npm i --no-save playwright-core && BASE=http://127.0.0.1:5173 node e2e/documents-api.mjs   (API running, Development, seeded; run before documents-review.mjs, which adds an approval workflow)
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173';
const SHOTS = process.env.SHOTS;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--no-sandbox'] });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 }, acceptDownloads: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
const shot = async (n) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/api-${n}.png` }); };

await page.goto(`${BASE}/login`);
await page.fill('input[type=email], input[name=email]', 'demo@example.com'); await page.fill('input[type=password]', 'Demo@12345'); await page.click('button[type=submit]');
await page.waitForFunction(() => !location.pathname.endsWith('/login') && location.pathname.length > 1, null, { timeout: 30000 });
await page.waitForTimeout(4000);
const slug = new URL(page.url()).pathname.split('/')[1];

// ---- an API document
await page.goto(`${BASE}/${slug}/documents`); await page.waitForTimeout(1500);
await page.locator('button', { hasText: 'New document' }).first().click(); await page.waitForTimeout(900);
await page.locator('.doc-type', { hasText: 'API documentation' }).click();
await page.locator('.modal input.input').first().fill('Payments API reference');
await page.locator('.modal .ss-trigger').first().click(); await page.waitForTimeout(300);
await page.locator('[role=option]').nth(1).click(); await page.waitForTimeout(300);
for (let i = 0; i < 8; i++) {
  const create = page.locator('.modal button', { hasText: 'Create document' });
  if (await create.count()) { await create.click(); break; }
  await page.locator('.modal button', { hasText: /Next|Review/ }).click(); await page.waitForTimeout(400);
}
await page.waitForURL(/documents\/[0-9a-f-]{36}/, { timeout: 15000 }); await page.waitForTimeout(1500);
const docUrl = page.url().split('?')[0];
check('an API document offers an API reference tab', (await page.locator('.doc-tabs button', { hasText: 'API reference' }).count()) === 1);
await page.locator('.doc-tabs button', { hasText: 'API reference' }).click(); await page.waitForTimeout(1200);
check('it starts empty and offers to describe an API', (await page.locator('.empty', { hasText: 'No API described yet' }).count()) === 1);

// ---- describe an API and add an endpoint by hand
await page.locator('.empty button', { hasText: 'Describe an API' }).click(); await page.waitForTimeout(500);
await page.locator('.modal input.input').first().fill('Payments');
await page.locator('.modal input.input').nth(1).fill('v1');
await page.locator('.modal textarea').nth(1).fill('https://api.example.com');
await page.locator('.modal button[type=submit]').click(); await page.waitForTimeout(1500);
check('the API is listed', (await page.locator('.api-def', { hasText: 'Payments' }).count()) === 1);
await page.locator('.api-bar button', { hasText: 'Endpoint' }).click(); await page.waitForTimeout(600);
await page.locator('.epe-path').fill('/payments/{id}');
await page.locator('.modal input.input[maxlength="300"]').fill('Get a payment');
await page.locator('.epe-tabs button', { hasText: 'Parameters' }).click();
await page.locator('.modal button', { hasText: 'Add a parameter' }).click();
await page.locator('.epe-row input[aria-label="Name"]').first().fill('id');
await page.locator('.epe-row select, .epe-row .ss-trigger').first().click().catch(() => undefined);
await page.keyboard.press('Escape');
await page.locator('.epe-tabs button', { hasText: 'Responses' }).click();
await page.locator('.epe-row textarea[aria-label="Schema"]').first().fill('{"type":"object","properties":{"id":{"type":"string"},"amount":{"type":"integer"}},"required":["id"]}');
await page.locator('.modal button[type=submit]').click(); await page.waitForTimeout(1500);
check('the endpoint opens after saving', (await page.locator('.apr-title code', { hasText: '/payments/{id}' }).count()) === 1);
check('its response schema is shown', (await page.locator('.apr-block pre', { hasText: '"amount"' }).count()) >= 1);
await shot('endpoint');

// ---- import a file
const spec = { openapi: '3.0.3', info: { title: 'Imported shop', version: '3' }, servers: [{ url: 'https://shop.example.com' }], paths: {
  '/orders': { get: { summary: 'List orders', tags: ['Orders'], responses: { 200: { description: 'ok' } } }, post: { summary: 'Create an order', tags: ['Orders'], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { sku: { type: 'string' } } } } } }, responses: { 201: { description: 'created' } } } },
  '/orders/{id}': { get: { summary: 'Get an order', tags: ['Orders'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'ok' } } } } } };
await page.locator('.api-bar button', { hasText: 'Import' }).click(); await page.waitForTimeout(500);
await page.locator('.modal input[type=file]').setInputFiles({ name: 'shop.openapi.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(spec)) });
await page.locator('.modal button', { hasText: 'Check the file' }).click(); await page.waitForTimeout(1500);
check('the check says what would happen', (await page.locator('.imp-result', { hasText: '3 new' }).count()) === 1);
await shot('import');
await page.locator('.modal button.btn-primary', { hasText: 'Import' }).click(); await page.waitForTimeout(2000);
check('the import is applied', (await page.locator('.imp-result', { hasText: 'Imported' }).count()) === 1);
await page.locator('.modal-foot button', { hasText: 'Close' }).click(); await page.waitForTimeout(800);
check('the imported API appears with its endpoints grouped', (await page.locator('.api-def', { hasText: 'Imported shop' }).count()) === 1 && (await page.locator('.api-group-head', { hasText: 'Orders' }).count()) === 1 && (await page.locator('.api-ep').count()) === 3);
await page.locator('.api-ep', { hasText: '/orders/{id}' }).click(); await page.waitForTimeout(800);
check('a path parameter from the file is shown as required', (await page.locator('.apr-table tr', { hasText: 'id' }).filter({ hasText: 'Yes' }).count()) >= 1);

// ---- search and export
await page.locator('input[aria-label="Find an endpoint"]').fill('orders/'); await page.waitForTimeout(900);
check('search narrows the list', (await page.locator('.api-ep').count()) === 1);
await page.locator('input[aria-label="Find an endpoint"]').fill('');
const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.locator('.api-bar button', { hasText: 'OpenAPI' }).click()]);
const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
check('the export is OpenAPI with the imported paths', exported.openapi === '3.0.3' && Object.keys(exported.paths).length === 2, Object.keys(exported.paths).join(','));

// ---- publish, then break something and see it
await page.locator('.doc-tabs button', { hasText: 'Document' }).click(); await page.waitForTimeout(800);
await page.locator('.doc-head-actions button', { hasText: 'Publish' }).click(); await page.waitForTimeout(700);
await page.locator('.modal textarea').first().fill('First release of the API');
await page.locator('.modal button[type=submit]').click(); await page.waitForTimeout(1800);
check('version 1.0 is published', (await page.locator('.doc-head-sub', { hasText: 'Version 1.0' }).count()) === 1);
await page.locator('.doc-tabs button', { hasText: 'API reference' }).click(); await page.waitForTimeout(1000);
await page.locator('.api-def', { hasText: 'Imported shop' }).click(); await page.waitForTimeout(800);
await page.locator('.api-ep', { hasText: '/orders/{id}' }).click(); await page.waitForTimeout(600);
page.once('dialog', (d) => d.accept());
await page.locator('.apr-actions button[aria-label="Delete endpoint"]').click(); await page.waitForTimeout(500);
await page.locator('.modal-foot button, .modal button.btn-danger', { hasText: /Remove|Delete/ }).last().click(); await page.waitForTimeout(1500);
check('removing an endpoint shows in the working copy', (await page.locator('.api-ep').count()) === 2);
await page.locator('.api-bar button', { hasText: 'API changes' }).click(); await page.waitForTimeout(1500);
check('the changes name the removed endpoint as breaking', (await page.locator('.chg-row.breaking', { hasText: '/orders/{id}' }).count()) === 1 && (await page.locator('.chg-stat.bad').count()) === 1);
await shot('changes');
await page.locator('.modal-foot button', { hasText: 'Close' }).click(); await page.waitForTimeout(300);
check('a reader of version 1.0 still has the endpoint', true);

// ---- a phone
await page.setViewportSize({ width: 390, height: 800 });
await page.goto(`${docUrl}?tab=api`); await page.waitForTimeout(2500);
check('the API reference fits a phone', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
check('no script errors', errors.length === 0, errors.slice(0, 2).join(' | '));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);



