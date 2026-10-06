// Browser check of the desktop app's look, with a pretend window bridge (the real one only exists inside the installed app): the app opens at sign-in
// (not the public website), the top bar is the title bar with room for the window buttons, the bar's buttons stay clickable, and the title bar
// follows the theme. Needs the API (Development, seeded) and the Vite dev server:
//   npm i --no-save playwright-core && BASE=http://127.0.0.1:5173 node e2e/desktop.mjs
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173';
const EMAIL = process.env.EMAIL ?? 'demo@example.com', PASSWORD = process.env.PASSWORD ?? 'Demo@12345';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--no-sandbox'] });
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };
const errors = [];

const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36 ProjectTrackerDesktop/1.1.0' });
await ctx.addInitScript(() => { window.__bars = []; window.ptDesktop = { platform: 'win32', setTitleBar: (bg, fg) => window.__bars.push({ bg, fg }) }; });
const p = await ctx.newPage();
p.on('pageerror', (e) => errors.push(e.message));

await p.goto(`${BASE}/`); await p.waitForTimeout(1500);
check('the public home page sends the desktop app to sign-in', new URL(p.url()).pathname === '/login', p.url());
check('the page knows it is the desktop app', await p.evaluate(() => document.documentElement.classList.contains('desktop-app') && document.documentElement.classList.contains('desktop-win')));
await p.fill('input[type=email], input[name=email]', EMAIL); await p.fill('input[type=password]', PASSWORD); await p.click('button[type=submit]');
await p.waitForSelector('.topbar', { timeout: 25000 }); await p.waitForTimeout(1500);

const geo = await p.evaluate(() => {
  const bar = document.querySelector('.topbar'), actions = document.querySelector('.topbar-actions');
  const right = Math.max(...[...bar.querySelectorAll('*')].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0).map((r) => r.right));
  return { barH: bar.getBoundingClientRect().height, lastRight: right, width: innerWidth, drag: getComputedStyle(bar).webkitAppRegion, btnDrag: getComputedStyle(actions.querySelector('button, a')).webkitAppRegion };
});
check('the top bar is 56px tall and draggable', Math.round(geo.barH) === 56 && geo.drag === 'drag', JSON.stringify(geo));
check('the bar leaves room for the window buttons on the right', geo.width - geo.lastRight >= 150, `${Math.round(geo.width - geo.lastRight)}px free`);
check('buttons in the bar are not part of the drag area', geo.btnDrag === 'no-drag');
check('the phone tab bar is never shown', await p.evaluate(() => !document.querySelector('.m-tabs') || getComputedStyle(document.querySelector('.m-tabs')).display === 'none'));
check('the window title bar takes the top bar color', await p.evaluate(() => window.__bars.length > 0 && /^#[0-9a-f]{6}$/.test(window.__bars.at(-1).bg)), await p.evaluate(() => JSON.stringify(window.__bars.at(-1))));
await p.screenshot({ path: process.env.SHOT ?? '/tmp/desktop-light.png' });

const before = await p.evaluate(() => window.__bars.length);
await p.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); }); await p.waitForTimeout(600);
const dark = await p.evaluate(() => ({ n: window.__bars.length, last: window.__bars.at(-1) }));
check('switching to dark updates the title bar', dark.n > before && dark.last.bg !== (await p.evaluate(() => window.__bars[0].bg)), JSON.stringify(dark.last));
await p.screenshot({ path: (process.env.SHOT ?? '/tmp/desktop-light.png').replace('light', 'dark') });

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
