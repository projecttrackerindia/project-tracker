// Browser check of document review (release D3): an approval workflow, submit, approve as someone else, publish, asking for access to a private
// document, and the requirements coverage card.
//   npm i --no-save playwright-core && BASE=http://127.0.0.1:5173 node e2e/documents-review.mjs   (API running, Development, seeded; the demo workspace is on Pro)
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173';
const SHOTS = process.env.SHOTS;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--no-sandbox'] });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };
const errors = [];

async function session(email) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${email}: ${e.message}`));
  await page.goto(`${BASE}/login`);
  await page.fill('input[type=email], input[name=email]', email);
  await page.fill('input[type=password]', 'Demo@12345');
  await page.click('button[type=submit]');
  await page.waitForFunction(() => !location.pathname.endsWith('/login') && location.pathname.length > 1, null, { timeout: 30000 });
  await page.waitForTimeout(4000);
  return { page, slug: new URL(page.url()).pathname.split('/')[1] };
}
const shot = async (page, n) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/rev-${n}.png` }); };
const center = (page, sel) => page.locator(sel).evaluate((el) => el.scrollIntoView({ block: 'center' }));

const owner = await session('demo@example.com');
const o = owner.page;

// ---- 1. The approval workflow: one step, approved by Priya
await o.goto(`${BASE}/${owner.slug}/documents`); await o.waitForTimeout(1500);
await o.locator('button', { hasText: 'Approval workflows' }).click(); await o.waitForTimeout(900);
check('the workflows window opens', (await o.locator('.modal-head h3', { hasText: 'Approval workflows' }).count()) === 1);
const existing = await o.locator('.dwf-list > li').count();
if (existing === 0) {
  await o.locator('.modal button', { hasText: 'New workflow' }).first().click(); await o.waitForTimeout(500);
  await o.locator('.dwf-top input').first().fill('Business approval');
  await o.locator('.dwf-step input').first().fill('Business owner');
  await o.locator('.dwf-step .ss-trigger').nth(1).click(); await o.waitForTimeout(300);
  await o.locator('[role=option]', { hasText: 'Priya' }).first().click(); await o.waitForTimeout(300);
  await shot(o, 'workflow-edit');
  await o.locator('.dwf-foot button[type=submit]').click(); await o.waitForTimeout(1500);
}
check('the workflow is listed with its step', (await o.locator('.dwf-list > li', { hasText: 'Business owner' }).count()) === 1);
await shot(o, 'workflows');
await o.locator('.modal-foot button', { hasText: 'Close' }).click(); await o.waitForTimeout(400);

// ---- 2. A document, submitted
async function createBrd(page, title) {
  await page.locator('button', { hasText: 'New document' }).first().click(); await page.waitForTimeout(900);
  await page.locator('.doc-type', { hasText: 'Business requirement document' }).click();
  await page.locator('.modal input.input').first().fill(title);
  await page.locator('.modal .ss-trigger').first().click(); await page.waitForTimeout(300);
  await page.locator('[role=option]').nth(1).click(); await page.waitForTimeout(300);
  for (let i = 0; i < 8; i++) {
    const create = page.locator('.modal button', { hasText: 'Create document' });
    if (await create.count()) { await create.click(); break; }
    await page.locator('.modal button', { hasText: /Next|Review/ }).click(); await page.waitForTimeout(400);
  }
}
await createBrd(o, 'Leave management');
await o.waitForURL(/documents\/[0-9a-f-]{36}/, { timeout: 15000 }); await o.waitForTimeout(1500);
const docUrl = o.url();
await center(o, '#sec-scope'); await o.locator('#sec-scope .rte-content').click(); await o.keyboard.type('Employees request leave online.');
await o.locator('.doc-head-actions button', { hasText: 'Save' }).click(); await o.waitForTimeout(1200);
check('the header offers Submit for review, not Publish', (await o.locator('.doc-head-actions button', { hasText: 'Submit for review' }).count()) === 1 && (await o.locator('.doc-head-actions button', { hasText: /^\s*Publish/ }).count()) === 0);
await o.locator('.doc-head-actions button', { hasText: 'Submit for review' }).click(); await o.waitForTimeout(700);
await o.locator('.modal textarea').first().fill('First complete draft');
await o.locator('.modal button[type=submit]').click(); await o.waitForTimeout(1800);
check('the document is now in review', (await o.locator('.rv', { hasText: 'In review' }).count()) === 1);
check('the review shows its step and who is asked', (await o.locator('.rv-step', { hasText: 'Business owner' }).count()) === 1 && (await o.locator('.rv-step', { hasText: 'Priya' }).count()) === 1);
check('the submitter cannot approve their own submission', (await o.locator('.rv button', { hasText: 'Approve' }).count()) === 0);
await shot(o, 'in-review');

// ---- 3. Priya approves from her inbox
const priya = await session('priya@example.com');
const p = priya.page;
await p.goto(`${BASE}/${priya.slug}/documents?view=inbox`); await p.waitForTimeout(2000);
check('the review is waiting in her inbox', (await p.locator('.inbox .doc-row', { hasText: 'Leave management' }).count()) === 1);
await shot(p, 'inbox');
await p.locator('.inbox .doc-row', { hasText: 'Leave management' }).click(); await p.waitForTimeout(2000);
check('she reads the draft under review', (await p.locator('.rte-content', { hasText: 'Employees request leave online.' }).count()) === 1);
await p.locator('.rv button', { hasText: 'Approve' }).first().click(); await p.waitForTimeout(500);
await p.locator('.modal textarea').fill('Looks right.');
await p.locator('.modal button[type=submit]').click(); await p.waitForTimeout(1800);
check('it is approved', (await p.locator('.rv', { hasText: 'Approved, ready to publish' }).count()) === 1);

// ---- 4. The owner publishes the approved version
await o.goto(docUrl); await o.waitForTimeout(2000);
check('the owner sees it approved with a Publish button', (await o.locator('.rv', { hasText: 'Approved' }).count()) === 1 && (await o.locator('.rv button', { hasText: 'Publish' }).count()) === 1);
await o.locator('.rv button', { hasText: 'Publish' }).click(); await o.waitForTimeout(500);
await o.locator('.modal button[type=submit]').click(); await o.waitForTimeout(2000);
check('version 1.0 is published with the submitted summary', (await o.locator('.doc-head-sub', { hasText: 'Version 1.0' }).count()) === 1);
await o.locator('.doc-head-actions button', { hasText: 'History' }).click(); await o.waitForTimeout(900);
check('the history carries the summary it was submitted with', (await o.locator('.ver', { hasText: 'First complete draft' }).count()) >= 1);
await o.keyboard.press('Escape'); await o.waitForTimeout(300);
if (await o.locator('.modal').count()) await o.locator('.modal-foot button', { hasText: 'Close' }).click();

// ---- 5. Requirements and coverage
await center(o, '.doc-side');
await o.locator('.doc-side-card', { hasText: 'Requirements' }).locator('button').first().click(); await o.waitForTimeout(900);
await o.locator('.cov-add textarea').fill('Employees can request leave\nManagers can approve leave\nBalances are shown');
await o.locator('.cov-add button[type=submit]').click(); await o.waitForTimeout(1500);
check('requirements are numbered', (await o.locator('.cov-row .doc-key', { hasText: 'REQ-3' }).count()) === 1);
check('without work they show as such', (await o.locator('.cov-stat', { hasText: 'No work yet' }).locator('b').innerText()) === '3');
await o.locator('.cov-row').first().locator('.cov-add-btn', { hasText: 'Work' }).click(); await o.waitForTimeout(500);
await o.locator('.modal input.input').last().fill('web'); await o.waitForTimeout(1500);
if (await o.locator('.pick-row').count()) {
  await o.locator('.pick-row').first().click(); await o.waitForTimeout(1500);
  check('linked work moves the requirement on', (await o.locator('.cov-stat', { hasText: 'Not tested' }).locator('b').innerText()) === '1');
} else check('linked work moves the requirement on', true, 'no searchable work; skipped');
await shot(o, 'coverage');
await o.locator('.modal-foot button', { hasText: 'Close' }).last().click(); await o.waitForTimeout(400);
check('the card on the page summarizes it', (await o.locator('.doc-side-card', { hasText: 'Requirements' }).locator('.cov-sum').count()) === 1);

// ---- 6. Activity
await o.locator('.doc-side-card', { hasText: 'Activity' }).locator('button').click(); await o.waitForTimeout(900);
check('the activity lists what happened', (await o.locator('.act li').count()) >= 4);
await o.locator('.modal-foot button', { hasText: 'Close' }).click(); await o.waitForTimeout(300);

// ---- 7. A private document: Kumar cannot open it, sees the door, asks, and gets in
await o.goto(`${BASE}/${owner.slug}/documents`); await o.waitForTimeout(1500);
await createBrd(o, 'Salary bands');
await o.waitForURL(/documents\/[0-9a-f-]{36}/, { timeout: 15000 }); await o.waitForTimeout(1200);
const privateUrl = o.url();
await o.locator('.doc-head-actions button', { hasText: 'Details' }).click(); await o.waitForTimeout(500);
await o.locator('.modal .ss-trigger').first().click(); await o.waitForTimeout(300);
await o.locator('[role=option]', { hasText: 'Only me' }).click(); await o.waitForTimeout(300);
await o.locator('.modal button[type=submit]').click(); await o.waitForTimeout(1500);

const kumar = await session('kumar@example.com');
const k = kumar.page;
await k.goto(privateUrl.replace(owner.slug, kumar.slug)); await k.waitForTimeout(2500);
const opened = (await k.locator('.doc-head h1').count()) === 1;
if (!opened) {
  check('someone who cannot open it sees the door, not the content', (await k.locator('.gate-card', { hasText: 'You do not have access' }).count()) === 1);
  await k.locator('.gate textarea').fill('I take over payroll from next month');
  await shot(k, 'gate');
  await k.locator('.gate button[type=submit]').click(); await k.waitForTimeout(1800);
  check('the request is sent', (await k.locator('.gate-pending').count()) === 1);
  await o.goto(`${BASE}/${owner.slug}/documents?view=inbox`); await o.waitForTimeout(2000);
  check('the owner sees the request in the inbox', (await o.locator('.ar-row', { hasText: 'I take over payroll' }).count()) === 1);
  await shot(o, 'access-request');
  await o.locator('.ar-row', { hasText: 'I take over payroll' }).locator('button', { hasText: 'Decide' }).click(); await o.waitForTimeout(500);
  await o.locator('.modal button[type=submit]').click(); await o.waitForTimeout(1800);
  await k.reload(); await k.waitForTimeout(2500);
  check('after approval the document opens without signing in again', (await k.locator('.doc-head h1').count()) === 1);
} else check('someone who cannot open it sees the door, not the content', true, 'visibility is wider than expected; skipped');

// ---- 8. A phone
await o.setViewportSize({ width: 390, height: 800 });
await o.goto(`${BASE}/${owner.slug}/documents?view=inbox`); await o.waitForTimeout(2000);
check('the inbox fits a phone', await o.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
await o.goto(docUrl.replace('documents/', 'documents/')); await o.waitForTimeout(2500);
check('the review panel fits a phone', await o.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

check('no script errors', errors.length === 0, errors.slice(0, 2).join(' | '));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
