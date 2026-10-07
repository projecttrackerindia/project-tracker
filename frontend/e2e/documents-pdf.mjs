// Browser check of PDF export, full-text search and the overview (release D6).
//   npm i --no-save playwright-core && BASE=http://127.0.0.1:5173 node e2e/documents-pdf.mjs   (API running, Development, seeded)
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173';
const API = process.env.API ?? BASE;
const SHOTS = process.env.SHOTS;
const results = [];
/** A document opens for reading; switch to editing when the test needs to type. */
let toEdit = async () => undefined;
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };

const login = await (await fetch(`${API}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'demo@example.com', password: 'Demo@12345' }) })).json();
const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.data.accessToken}` };
await fetch(`${API}/api/v1/billing/checkout`, { method: 'POST', headers: auth, body: JSON.stringify({ planCode: 'BUSINESS', startTrial: false, seats: 10 }) });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--no-sandbox'] });
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 }, acceptDownloads: true });
const page = await ctx.newPage();
toEdit = async () => { const b = page.locator('.mode-switch button[aria-label="Edit"]'); await b.first().waitFor({ timeout: 8000 }).catch(() => undefined); if ((await b.count()) && (await b.getAttribute('aria-pressed')) !== 'true') { await b.click(); await page.waitForTimeout(500); } };
page.on('pageerror', (e) => errors.push(e.message));
const shot = async (n) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/pdf-${n}.png` }); };

await page.goto(`${BASE}/login`);
await page.fill('input[type=email], input[name=email]', 'demo@example.com'); await page.fill('input[type=password]', 'Demo@12345'); await page.click('button[type=submit]');
await page.waitForFunction(() => !location.pathname.endsWith('/login') && location.pathname.length > 1, null, { timeout: 30000 });
await page.waitForTimeout(4000);
const slug = new URL(page.url()).pathname.split('/')[1];

// ---- a document with some text, made through the wizard and filled through the API
await page.goto(`${BASE}/${slug}/documents`); await page.waitForTimeout(1500);
await page.locator('button', { hasText: 'New document' }).first().click(); await page.waitForTimeout(900);
await page.locator('.doc-type').first().click();
await page.locator('.modal input.input').first().fill('Quokka onboarding flow');
await page.locator('.modal .ss-trigger').first().click(); await page.waitForTimeout(300);
await page.locator('[role=option]').nth(1).click(); await page.waitForTimeout(300);
for (let i = 0; i < 8; i++) {
  const create = page.locator('.modal button', { hasText: 'Create document' });
  if (await create.count()) { await create.click(); break; }
  await page.locator('.modal button', { hasText: /Next|Review/ }).click(); await page.waitForTimeout(400);
}
await page.waitForURL(/documents\/[0-9a-f-]{36}/, { timeout: 15000 }); await toEdit(); await page.waitForTimeout(1500);
const docId = page.url().split('/documents/')[1].split('?')[0];
const detail = await (await fetch(`${API}/api/v1/documents/${docId}`, { headers: auth })).json();
const first = detail.data.sections[0];
const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'New users meet the marsupial mascot during sign-up.' }] },
  { type: 'codeBlock', attrs: { language: 'mermaid' }, content: [{ type: 'text', text: 'flowchart LR\n  A[Sign up] --> B{Email verified?}\n  B -->|yes| C[Welcome tour]\n  B -->|no| D[Send reminder]\n  D --> B' }] }] };
const saved = await fetch(`${API}/api/v1/documents/${docId}/sections`, { method: 'PUT', headers: auth, body: JSON.stringify({ revision: detail.data.revision, sections: [{ key: first.key, content: JSON.stringify(body) }] }) });
check('the text was saved', saved.ok);
await page.reload(); await page.waitForTimeout(2000);

// ---- the diagram on the page
await page.waitForSelector('.doc-diagram svg', { timeout: 15000 }).catch(() => undefined);
check('a diagram written as text is drawn under the section', (await page.locator('.doc-diagram svg').count()) === 1);
check('with its boxes and labels', (await page.locator('.doc-diagram svg text', { hasText: 'Welcome tour' }).count()) === 1 && (await page.locator('.doc-diagram svg text', { hasText: 'yes' }).count()) >= 1);
await page.locator('.doc-diagram').scrollIntoViewIfNeeded();
await shot('diagram');

// ---- PDF
await page.locator('.doc-head-actions .menu > button').click();
check('the page offers a PDF download', (await page.locator('.doc-head-actions .menu-list button', { hasText: 'Download PDF' }).count()) === 1);
await page.locator('.doc-head-actions .menu > button').click();
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), (await page.locator('.doc-head-actions .menu > button').click(), page.locator('.doc-head-actions .menu-list button', { hasText: 'Download PDF' }).click())]);
const file = await dl.path();
const bytes = fs.readFileSync(file);
check('a PDF file is downloaded', bytes.subarray(0, 5).toString() === '%PDF-' && dl.suggestedFilename().endsWith('.pdf'), dl.suggestedFilename());
const raw = bytes.toString('latin1');
check('it holds the title, the text, a contents page and page numbers', raw.includes('(Quokka onboarding flow)') && raw.includes('marsupial mascot') && raw.includes('(CONTENTS)') && /Page \d+ of \d+/.test(raw));
await shot('export');
const pdfRaw = raw;
check('the diagram is drawn in the PDF (its box texts are in the page)', pdfRaw.includes('(Email verified?) Tj') && pdfRaw.includes('(Welcome tour) Tj'));

// ---- search finds words inside the text (not only titles)
await page.goto(`${BASE}/${slug}/documents`); await page.waitForTimeout(1500);
await page.locator('.doc-search input').fill('marsupial'); await page.waitForTimeout(1500);
check('searching a word from the text finds the document', (await page.locator('text=Quokka onboarding flow').count()) >= 1);
await page.locator('.doc-search input').fill('zzzqqq-nothing'); await page.waitForTimeout(1500);
check('a word that is nowhere finds nothing', (await page.locator('text=Quokka onboarding flow').count()) === 0);
await page.locator('.doc-search input').fill('');
await page.waitForTimeout(1200);

// ---- overview
check('the overview shows the number of documents', (await page.locator('.doc-overview .doc-stat', { hasText: 'documents' }).count()) === 1);
const total = Number((await page.locator('.doc-overview .doc-stat', { hasText: 'documents' }).locator('b').innerText()).replace(/\D/g, ''));
const listed = await (await fetch(`${API}/api/v1/documents`, { headers: auth })).json();
check('and it equals what the list holds', total === listed.data.total, `${total} vs ${listed.data.total}`);
await shot('overview');

check('no script errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
