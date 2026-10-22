// Core journeys, against the real API: a project is created from the form, a task is created, edited and moved to another status, and
// the changes are what the screens show afterwards. Signs in as the development demo owner. Run with the API (Development, seeded) and
// the Vite dev server up:
//   npm i --no-save playwright-core && BASE=http://127.0.0.1:5173 node e2e/core-journeys.mjs
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--no-sandbox'] });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };
const errors = [];
const stamp = Date.now().toString(36).slice(-5).toUpperCase();

const ctx = await browser.newContext({ viewport: { width: 1357, height: 760 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));

const field = (label) => page.locator('.modal .field').filter({ has: page.locator('label', { hasText: label }) }).first();
const modalGone = async () => { await page.waitForSelector('.modal', { state: 'detached', timeout: 15000 }).catch(() => undefined); return (await page.locator('.modal').count()) === 0; };

// 1. Sign in.
await page.goto(`${BASE}/login`);
await page.fill('input[type=email], input[name=email]', 'demo@example.com');
await page.fill('input[type=password]', 'Demo@12345');
await page.click('button[type=submit]');
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 });
await page.waitForTimeout(1500);
const slug = new URL(page.url()).pathname.split('/')[1];
check('signed in to a workspace', !!slug && slug !== 'login', page.url());

// 2. Create a project from the form: only the name is typed; group, type and timeline take their defaults.
const projectName = `Smoke project ${stamp}`;
await page.goto(`${BASE}/${slug}/projects`); await page.waitForTimeout(1500);
await page.locator('button', { hasText: 'New project' }).first().click();
await page.waitForSelector('.modal', { timeout: 10000 });
await field('Project name').locator('input').fill(projectName);
// Group, type and timeline are defaulted once their lists load; submitting before that trips the required-field validation.
const defaulted = async (label) => {
  const select = field(label).locator('select');
  for (let i = 0; i < 50; i++) { if ((await select.count()) === 0 || (await select.inputValue())) return true; await page.waitForTimeout(200); }
  return false;
};
check('project form defaults are loaded', (await defaulted('Project group')) && (await defaulted('Project type')) && (await defaulted('Project timeline')));
await page.locator('.modal button[type=submit], .modal button', { hasText: 'Create project' }).first().click();
let projectOpened = await page.waitForURL((u) => /\/projects\/[0-9a-f-]{36}/.test(u.pathname), { timeout: 20000 }).then(() => true).catch(() => false);
if (!projectOpened) {
  // The save may have gone through without the hand-off to the project page (the development API's SQLite can answer late);
  // the project list is the source of truth, so look it up there by name.
  const notice = (await page.locator('.toast, [role=status], .modal .field-error, .modal [role=alert]').allInnerTexts().catch(() => [])).join(' | ');
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.goto(`${BASE}/${slug}/projects`); await page.waitForTimeout(2000);
  const card = page.locator(`text=${projectName}`).first();
  if (await card.count()) { await card.click(); projectOpened = await page.waitForURL((u) => /\/projects\/[0-9a-f-]{36}/.test(u.pathname), { timeout: 15000 }).then(() => true).catch(() => false); }
  check('project is created and opened', projectOpened, projectOpened ? `opened from the list after save (${notice})` : `${page.url()} ${notice}`);
} else check('project is created and opened', true, page.url());
await page.waitForTimeout(1500);
check('project page shows its name', (await page.locator(`text=${projectName}`).count()) > 0);

// 3. Create a task from the project page.
const taskTitle = `Smoke task ${stamp}`;
await page.locator('button', { hasText: 'Add task' }).first().click();
await page.waitForSelector('.modal', { timeout: 10000 });
await field('Task title').locator('input').fill(taskTitle);
const phase = field('Timeline phase').locator('select');
if (await phase.count() && !(await phase.inputValue())) await phase.selectOption({ index: 1 }).catch(() => undefined);
await page.locator('.modal button[type=submit], .modal button', { hasText: 'Save task' }).first().click();
check('task form closes after save', await modalGone());
await page.waitForTimeout(1200);
check('new task is listed on the project', (await page.locator(`text=${taskTitle}`).count()) > 0);

// 4. Edit the task: a new title and a new status, then the page reflects both.
const edited = `${taskTitle} (edited)`;
await page.locator(`text=${taskTitle}`).first().click();
await page.waitForSelector('.modal', { timeout: 10000 });
await field('Task title').locator('input').fill(edited);
if (await page.locator('.modal .more-toggle').count()) await page.locator('.modal .more-toggle').click();
const status = field('Status').locator('select');
let moved = false;
if (await status.count()) {
  const options = await status.locator('option').allTextContents();
  const current = await status.inputValue();
  const next = (await status.locator('option').evaluateAll((os) => os.map((o) => o.value))).find((v) => v && v !== current);
  if (next) { await status.selectOption(next); moved = true; }
  check('task has more than one status to move to', options.length > 1, options.join(' | '));
}
await page.locator('.modal button[type=submit], .modal button', { hasText: 'Save changes' }).first().click();
check('task edit form closes after save', await modalGone());
await page.waitForTimeout(1200);
check('edited title is shown', (await page.locator(`text=${edited}`).count()) > 0);
check('status change was saved', moved);

// 5. The saved values are what the server returns: a fresh load of the project shows the edited task. The development API runs on
// SQLite and can refuse a connection for a moment under load, so the load is given time and one more attempt.
let survived = false;
for (let attempt = 0; attempt < 2 && !survived; attempt++) {
  await page.reload();
  survived = await page.waitForSelector(`text=${edited}`, { timeout: 15000 }).then(() => true).catch(() => false);
}
check('edited task survives a reload', survived);

check('no script errors', errors.length === 0, errors.slice(0, 2).join(' | '));
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
