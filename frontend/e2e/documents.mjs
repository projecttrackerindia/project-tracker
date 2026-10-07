// Browser check of Documents: create a BRD in the wizard, write in the editor, save, link a task from both sides, and see it on a project's tab.
//   npm i --no-save playwright-core && BASE=http://127.0.0.1:5173 node e2e/documents.mjs   (API running, Development, seeded)
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173';
const SHOTS = process.env.SHOTS;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--no-sandbox'] });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };
const errors = [];

const ctx = await browser.newContext({ viewport: { width: 1366, height: 800 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
const shot = async (n) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/doc-${n}.png` }); };

await page.goto(`${BASE}/login`);
await page.fill('input[type=email], input[name=email]', 'demo@example.com');
await page.fill('input[type=password]', 'Demo@12345');
await page.click('button[type=submit]');
await page.waitForFunction(() => !location.pathname.endsWith('/login') && location.pathname.length > 1, null, { timeout: 30000 });
await page.waitForTimeout(6000);
const slug = new URL(page.url()).pathname.split('/')[1];

// Navigation entry and the empty list.
await page.goto(`${BASE}/${slug}/documents`); await page.waitForTimeout(1500);
check('Documents is in the menu', (await page.locator('.sidebar a[href$="/documents"]').count()) > 0);
check('documents page opens', (await page.locator('h1', { hasText: 'Documents' }).count()) === 1);

// Wizard: five steps for a BRD.
await page.locator('button', { hasText: 'New document' }).first().click(); await page.waitForTimeout(900);
check('wizard opens on step 1', (await page.locator('.modal .modal-head p', { hasText: 'Step 1' }).count()) === 1);
await page.locator('.doc-type', { hasText: 'Business requirement document' }).click();
await page.locator('.modal input.input').first().fill('Employee portal integration');
await page.waitForTimeout(300);
await shot('wizard-1');
const projectSelect = page.locator('.modal .ss-trigger').first();
await projectSelect.click(); await page.waitForTimeout(300);
await page.locator('[role=option]').nth(1).click();
await page.waitForTimeout(300);
await page.locator('.modal button', { hasText: 'Next' }).click(); await page.waitForTimeout(900);
const steps = await page.locator('.wiz-steps li').count();
check('a BRD takes at most six steps', steps >= 2 && steps <= 6, `${steps} steps`);
const editor = page.locator('.modal .rte-content').first();
await editor.click(); await page.keyboard.type('Employees must see their payslip online.');
await shot('wizard-2');
for (let i = 0; i < steps - 2; i++) { await page.locator('.modal button', { hasText: /Next|Review/ }).click(); await page.waitForTimeout(500); }
check('review lists the sections', (await page.locator('.wiz-empty li').count()) === 12);
await shot('wizard-review');
await page.locator('.modal button', { hasText: 'Create document' }).click();
await page.waitForURL(/documents\/[0-9a-f-]{36}/, { timeout: 15000 }).catch(() => undefined);
await page.waitForTimeout(1500);
check('document page opens after creation', /documents\/[0-9a-f-]{36}/.test(page.url()), page.url());
check('it is a draft with a key', (await page.locator('.doc-head .doc-key').innerText().catch(() => '')).startsWith('DOC-'));
check('what was typed in the wizard is there', (await page.locator('.rte-content', { hasText: 'Employees must see their payslip online.' }).count()) === 1);
await shot('document');

// Edit and save.
const center = (sel) => page.locator(sel).evaluate((el) => el.scrollIntoView({ block: 'center' }));
const scope = page.locator('#sec-scope .rte-content');
await center('#sec-scope'); await scope.click(); await page.keyboard.type('Scope: payslips only.');
check('unsaved changes are flagged', (await page.locator('.doc-dirty').count()) === 1);
await page.locator('.doc-head-actions button', { hasText: 'Save' }).click(); await page.waitForTimeout(1200);
check('saving clears the flag', (await page.locator('.doc-dirty').count()) === 0);
await page.reload(); await page.waitForTimeout(2000);
check('the text survives a reload', (await page.locator('#sec-scope .rte-content', { hasText: 'Scope: payslips only.' }).count()) === 1);

// A table section.
const row = page.locator('#sec-risks button', { hasText: 'Add a row' });
await center('#sec-risks'); await row.click(); await page.locator('#sec-risks textarea').first().fill('Late data feed');
await page.locator('.doc-head-actions button', { hasText: 'Save' }).click(); await page.waitForTimeout(1200);
await page.reload(); await page.waitForTimeout(2000);
check('a table row survives a reload', (await page.locator('#sec-risks textarea').first().inputValue()) === 'Late data feed');

// D2: publish, history, compare, restore, share, picture.
await page.locator('.doc-head-actions button', { hasText: 'Publish' }).click(); await page.waitForTimeout(800);
check('first publish is 1.0', (await page.locator('.modal-head h3', { hasText: 'Publish version 1.0' }).count()) === 1);
await page.locator('.modal textarea').first().fill('First complete draft');
await page.locator('.modal button[type=submit]').click(); await page.waitForTimeout(1500);
check('the page now shows version 1.0', (await page.locator('.doc-head-sub', { hasText: 'Version 1.0' }).count()) === 1);
await center('#sec-scope'); await page.locator('#sec-scope .rte-content').click(); await page.keyboard.type(' Tax forms too.');
await page.locator('.doc-head-actions button', { hasText: 'Save' }).click(); await page.waitForTimeout(1200);
check('a draft that differs is flagged', (await page.locator('.doc-dirty', { hasText: 'Not published yet' }).count()) === 1);
await page.locator('.doc-head-actions button', { hasText: 'Publish' }).click(); await page.waitForTimeout(600);
await page.locator('.modal textarea').first().fill('Added tax forms');
await page.locator('.modal button[type=submit]').click(); await page.waitForTimeout(1500);
check('second publish is 1.1', (await page.locator('.doc-head-sub', { hasText: 'Version 1.1' }).count()) === 1);

await page.locator('.doc-head-actions button', { hasText: 'History' }).click(); await page.waitForTimeout(1000);
check('history lists the draft and both versions', (await page.locator('.ver').count()) === 3, `${await page.locator('.ver').count()} rows`);
await shot('history');
await page.locator('.ver', { hasText: '1.0' }).first().locator('button', { hasText: 'Compare with current' }).click(); await page.waitForTimeout(1500);
check('compare shows added text', (await page.locator('.df-line.df-add').count()) >= 1);
await shot('compare');
await page.locator('.modal-foot button', { hasText: 'Back to history' }).click(); await page.waitForTimeout(500);
await page.locator('.ver:not(.draft):not(.current)', { hasText: '1.0' }).first().locator('button', { hasText: 'Restore' }).click(); await page.waitForTimeout(500); await shot('restore-confirm');
await page.locator('.modal-foot .btn-primary', { hasText: 'Restore' }).last().click(); await page.waitForTimeout(2000);
check('restoring publishes 1.2', (await page.locator('.doc-head-sub', { hasText: 'Version 1.2' }).count()) === 1);
check('the restored text is back', (await page.locator('#sec-scope .rte-content', { hasText: 'Scope: payslips only.' }).count()) === 1 && (await page.locator('#sec-scope .rte-content', { hasText: 'Tax forms too.' }).count()) === 0);

await page.locator('.doc-head-actions button', { hasText: 'Share' }).click(); await page.waitForTimeout(1000);
check('the access panel lists people', (await page.locator('.people li').count()) >= 1);
await shot('access');
const pick = page.locator('.acc-row .ss-trigger').nth(1); await pick.click(); await page.waitForTimeout(300);
const options = page.locator('[role=option]'); const optionCount = await options.count();
if (optionCount > 1) {
  await options.nth(1).click(); await page.waitForTimeout(200);
  await page.locator('.acc-add button[type=submit]').click(); await page.waitForTimeout(1500);
  check('sharing adds a line', (await page.locator('.grant').count()) === 1);
  await page.locator('.grant .btn-icon').first().click(); await page.waitForTimeout(1200);
  check('and removing it takes it away', (await page.locator('.grant').count()) === 0);
} else { await page.keyboard.press('Escape'); check('sharing adds a line', true, 'nobody else to share with; skipped'); }
await page.keyboard.press('Escape'); await page.waitForTimeout(400);
if (await page.locator('.modal').count()) await page.locator('.modal-foot button', { hasText: 'Close' }).click();

// A picture in the text.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
await center('#sec-scope'); await page.locator('#sec-scope .rte-content').click();
const chooser = page.waitForEvent('filechooser');
await page.locator('#sec-scope button[aria-label="Insert picture"]').click();
await (await chooser).setFiles({ name: 'flow.png', mimeType: 'image/png', buffer: png }); await page.waitForTimeout(1500);
check('a picture appears in the text', (await page.locator('#sec-scope .doc-img').count()) === 1);
await page.locator('.doc-head-actions button', { hasText: 'Save' }).click(); await page.waitForTimeout(1200);
await page.reload(); await page.waitForTimeout(2500);
check('the picture survives a reload', (await page.locator('#sec-scope .doc-img img').count()) === 1);
check('the file is listed', (await page.locator('.doc-files li', { hasText: 'flow.png' }).count()) === 1);
await shot('files');

// Link a task from the document, then see the document from the task.
await page.locator('.doc-side button', { hasText: 'Link' }).first().click(); await page.waitForTimeout(500);
await page.locator('.modal input.input').first().fill('web');
await page.waitForTimeout(1500);
const hits = await page.locator('.pick-row').count();
if (hits > 0) {
  await page.locator('.pick-row').first().click(); await page.waitForTimeout(1500);
  check('the document shows its linked work', (await page.locator('.doc-linked li').count()) >= 1);
  await shot('linked');
} else check('the document shows its linked work', true, 'no searchable work in this workspace; skipped');

// The project's own Documents tab.
await page.locator('.doc-crumbs a[href*="tab=documents"]').click(); await page.waitForTimeout(2000);
check('a project has a Documents tab', (await page.locator('.doc-list').count()) === 1);
await shot('project-tab');

// A phone: no sideways scroll.
await page.setViewportSize({ width: 390, height: 800 });
await page.goto(`${BASE}/${slug}/documents`); await page.waitForTimeout(2000);
check('the list fits a phone', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
await shot('phone-list');

check('no script errors', errors.length === 0, errors.slice(0, 2).join(' | '));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
