// Browser check of the phone experience: the app shell (tab bar, top bar, sheets), the gestures (drag a sheet away, pull to refresh) and that a
// desktop window still gets the desktop layout. Run against a running API (Development, seeded) and the Vite dev server:
//   npm i --no-save playwright-core && BASE=http://127.0.0.1:5173 node e2e/mobile.mjs
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--no-sandbox'] });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };
const errors = [];

const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/login`); await page.waitForTimeout(1500);
check('sign-in fills the screen on a phone', await page.evaluate(() => { const c = document.querySelector('.auth-card'); return !!c && c.getBoundingClientRect().width >= innerWidth - 1; }));
await page.fill('input[type=email], input[name=email]', 'demo@example.com');
await page.fill('input[type=password]', 'Demo@12345');
await page.click('button[type=submit]');
await page.waitForSelector('.m-tabs', { timeout: 25000 });
await page.waitForTimeout(1500);
const slug = new URL(page.url()).pathname.split('/')[1];

// The shell
check('tab bar replaces the sidebar', (await page.locator('.m-tabs').isVisible()) && (await page.locator('aside.sidebar').count()) === 0);
check('four places in the capsule and a Create button beside it', (await page.locator('.m-pill > *').count()) === 4 && (await page.locator('.m-fab').count()) === 1, String(await page.locator('.m-pill > *').count()));
check('Home is the active tab', await page.locator('.m-tab.on', { hasText: 'Home' }).count() === 1);
check('top bar names the workspace', (await page.locator('.m-org').innerText()).length > 2);
check('no page scrolls sideways', !(await page.evaluate(() => document.documentElement.scrollWidth > 391 || innerWidth > 391)), `inner ${await page.evaluate(() => innerWidth)}`);
const inputs = await page.evaluate(() => [...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]),select,textarea')].filter((e) => e.offsetParent).map((e) => parseFloat(getComputedStyle(e).fontSize)));
check('fields are 16px or larger (no zoom on focus)', inputs.every((n) => n >= 16), inputs.join(','));
check('the stat tiles are compact', await page.evaluate(() => { const c = document.querySelector('.stat-card'); return !!c && c.getBoundingClientRect().height < 110; }));
check('the capsule floats clear of the screen edges', await page.evaluate(() => { const r = document.querySelector('.m-pill').getBoundingClientRect(); return r.left >= 8 && r.bottom <= innerHeight - 6; }));

check('Home leads with the day: greeting, focus card, week strip', (await page.locator('.mh-greet').count()) === 1 && (await page.locator('.mh-focus').count()) === 1 && (await page.locator('.mh-day').count()) === 7);
await page.tap('.mh-day:not(.on)'); await page.waitForTimeout(400);
check('picking another day changes the list heading', !(await page.locator('.mh-h').first().innerText()).startsWith('Today'));
await page.tap('.m-tab:has-text("Projects")'); await page.waitForTimeout(1200);
check('a tab moves to its page', new URL(page.url()).pathname.endsWith('/projects') && await page.locator('.m-tab.on', { hasText: 'Projects' }).count() === 1);
await page.tap('.m-tab:has-text("Home")'); await page.waitForTimeout(800);

// Sheets
await page.tap('.m-tab:has-text("More")'); await page.waitForSelector('.sheet');
check('More opens a sheet with the whole menu', (await page.locator('.sheet .m-tile').count()) >= 6 && (await page.locator('.sheet .m-signout').count()) === 1);
await page.keyboard.press('Escape'); await page.waitForTimeout(300);
check('Escape closes the sheet', (await page.locator('.sheet').count()) === 0);

await page.tap('.m-fab'); await page.waitForSelector('.sheet');
check('the plus opens Create', (await page.locator('.sheet .m-make').count()) >= 2);
await page.tap('.m-make:has-text("Task")'); await page.waitForSelector('.modal');
check('a form is a bottom sheet', await page.evaluate(() => { const m = document.querySelector('.modal'); const r = m.getBoundingClientRect(); return r.bottom >= innerHeight - 1 && r.width >= innerWidth - 1; }));

// Drag the sheet away from its handle
const dragged = await page.evaluate(async () => {
  const grab = document.querySelector('.modal-grab'); const ev = (type, y) => grab.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'touch', pointerId: 7, clientX: 195, clientY: y }));
  ev('pointerdown', 500); ev('pointermove', 560); ev('pointermove', 700); ev('pointerup', 700);
  await new Promise((r) => setTimeout(r, 700));
  return document.querySelectorAll('.modal').length;
});
check('dragging the handle down closes it', dragged === 0, `${dragged} left`);

// Pull to refresh
const calls = [];
page.on('request', (r) => { if (r.url().includes('/api/v1/')) calls.push(r.url()); });
await page.waitForTimeout(500); calls.length = 0;
await page.evaluate(async () => {
  const t = (y) => new Touch({ identifier: 1, target: document.body, clientX: 190, clientY: y });
  const fire = (type, y) => document.body.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [t(y)], changedTouches: [t(y)] }));
  window.scrollTo(0, 0);
  fire('touchstart', 200); for (let y = 220; y <= 420; y += 20) fire('touchmove', y); fire('touchend', 420);
  await new Promise((r) => setTimeout(r, 1500));
});
check('pulling down from the top refreshes the data', calls.length > 0, `${calls.length} request(s)`);

// Other screens keep their shape
for (const [path, name] of [['/projects', 'projects'], ['/my-work', 'my work'], ['/calendar', 'calendar'], ['/portfolio', 'portfolio'], ['/people', 'people']]) {
  await page.goto(`${BASE}/${slug}${path}`); await page.waitForTimeout(2200);
  check(`${name} fits the screen`, !(await page.evaluate(() => document.documentElement.scrollWidth > 391 || innerWidth > 391)), `inner ${await page.evaluate(() => innerWidth)}`);
}
check('no script errors (phone)', errors.length === 0, errors.join(' | '));

// A desktop window keeps the desktop layout, and resizing swaps the layout without a crash
const desk = await browser.newContext({ viewport: { width: 1357, height: 800 } });
const dp = await desk.newPage(); dp.on('pageerror', (e) => errors.push(e.message));
await dp.goto(`${BASE}/login`); await dp.fill('input[type=email], input[name=email]', 'demo@example.com'); await dp.fill('input[type=password]', 'Demo@12345'); await dp.click('button[type=submit]');
await dp.waitForSelector('aside.sidebar', { timeout: 25000 });
check('desktop keeps the sidebar and no tab bar', (await dp.locator('.m-tabs').count()) === 0 && (await dp.locator('.sidebar-nav').isVisible()));
await dp.setViewportSize({ width: 390, height: 844 }); await dp.waitForSelector('.m-tabs', { timeout: 5000 });
check('narrowing the window switches to the phone layout', (await dp.locator('aside.sidebar').count()) === 0);
await dp.setViewportSize({ width: 1357, height: 800 }); await dp.waitForSelector('aside.sidebar', { timeout: 5000 });
check('widening it switches back', (await dp.locator('.m-tabs').count()) === 0);
check('no script errors (resize)', errors.length === 0, errors.join(' | '));

await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
