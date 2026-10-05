// Browser smoke test: signs in as the development demo owner and walks the pages people use most, failing on a crash screen, a broken
// layout or a missing control. Run against a running API (Development, seeded) and the Vite dev server:
//   npm i --no-save playwright-core && BASE=http://127.0.0.1:5173 node e2e/smoke.mjs
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--no-sandbox'] });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };
const errors = [];

const ctx = await browser.newContext({ viewport: { width: 1357, height: 676 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));

// 1. Sign in: the welcome moment plays exactly once.
await page.goto(`${BASE}/login`);
await page.fill('input[type=email], input[name=email]', 'demo@example.com');
await page.fill('input[type=password]', 'Demo@12345');
await page.click('button[type=submit]');
let shown = 0, prev = false;
for (let i = 0; i < 90; i++) { const on = (await page.locator('.sc').count()) > 0; if (on && !prev) shown++; prev = on; await page.waitForTimeout(100); }
check('welcome screen plays once', shown === 1, `${shown} time(s)`);
const slug = new URL(page.url()).pathname.split('/')[1];
check('organization is in the address', !!slug && slug !== 'login', page.url());

const crashed = async () => (await page.locator('text=Something went wrong').count()) > 0 || (await page.locator('text=Page not found').count()) > 0;
for (const [name, path] of [['dashboard', ''], ['projects', '/projects'], ['portfolio', '/portfolio'], ['my work', '/my-work'], ['reports', '/reports'], ['people', '/people'], ['teams', '/people/teams'], ['settings', '/settings/general']]) {
  await page.goto(`${BASE}/${slug}${path}`); await page.waitForTimeout(1800);
  check(`${name} opens`, !(await crashed()));
}

// 2. Dashboard layout: the trend and the status card sit side by side, the range buttons show which one is chosen.
await page.goto(`${BASE}/${slug}`); await page.waitForTimeout(2500);
const cols = await page.locator('.dash-charts').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length).catch(() => 0);
check('dashboard charts side by side', cols === 2, `${cols} column(s)`);
const bg = await page.locator('.seg button.on').first().evaluate((el) => { const c = getComputedStyle(el); return c.backgroundImage !== 'none' ? 'gradient' : c.backgroundColor; }).catch(() => 'none');
check('selected range is highlighted', bg !== 'rgba(0, 0, 0, 0)' && bg !== 'none', bg);

// 3. Team picker in the top bar.
check('team picker present', (await page.locator('.lens-btn').count()) === 1);

// 4. Forms start short.
await page.goto(`${BASE}/${slug}/projects`); await page.waitForTimeout(1500);
await page.locator('button', { hasText: 'New project' }).first().click(); await page.waitForTimeout(800);
check('new project form is short', (await page.locator('.modal .field').count()) <= 4, `${await page.locator('.modal .field').count()} fields`);
check('new project form has More options', (await page.locator('.more-toggle').count()) === 1);
await page.keyboard.press('Escape');

// 5. Portfolio: overview, a project, and the way back.
await page.goto(`${BASE}/${slug}/portfolio`); await page.waitForTimeout(2000);
check('portfolio overview shows', (await page.locator('.pi').count()) === 1);
await page.locator('.ps-group-head').first().click(); await page.locator('.ps-proj').first().click(); await page.waitForTimeout(1500);
check('project panel shows tabs', (await page.locator('.ps-seg button').count()) === 3);
if (await page.locator('.pi-whatif-btn').count()) {
  await page.locator('.pi-whatif-btn').click(); await page.waitForTimeout(1000);
  await page.locator('.pi-whatif-inputs input').first().fill('10'); await page.waitForTimeout(1200);
  const cards = await page.locator('.pi-whatif-card b').allInnerTexts();
  check('what-if shows today and the changed plan', cards.length === 2 && cards[0] !== cards[1], cards.join(' vs '));
  await page.keyboard.press('Escape'); await page.waitForTimeout(400);
  if (await page.locator('.pi-whatif-inputs').count()) await page.locator('.modal button:has-text("Close")').click();
}
await page.locator('.ps-home').click(); await page.waitForTimeout(1000);
check('back to Portfolio today', (await page.locator('.pi').count()) === 1);

check('no script errors', errors.length === 0, errors.slice(0, 2).join(' | '));
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
