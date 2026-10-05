// Browser check per access level: the demo organization gets an Admin, a Manager, a Member and a Guest, each signs in and opens every page
// their sidebar offers. Fails on a crash screen, a "Page not found" for a page the sidebar itself linked, or a script error.
//   BASE=http://127.0.0.1:5173 CHROMIUM=/path/to/chromium node e2e/roles.mjs
import { chromium } from 'playwright-core';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--no-sandbox'] });
const results = []; const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  - ' + d : ''}`); };

const owner = await (await browser.newContext()).newPage();
await owner.goto(`${BASE}/login`);
await owner.fill('input[type=email], input[name=email]', 'demo@example.com'); await owner.fill('input[type=password]', 'Demo@12345'); await owner.click('button[type=submit]');
await owner.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 }); await owner.waitForTimeout(6500);
const token = await owner.evaluate(async () => (await (await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } })).json()).data.accessToken);
const api = (page, p, m = 'GET', b, t = token) => page.evaluate(async ([p, m, b, t]) => { const r = await fetch('/api/v1' + p, { method: m, headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; }, [p, m, b, t]);

const stamp = Date.now();
const people = [];
for (const role of ['Admin', 'Manager', 'Member', 'Guest']) {
  const email = `${role.toLowerCase()}${stamp}@example.com`;
  const made = await api(owner, '/workspace/members', 'POST', { email, displayName: `${role} Person`, role, password: 'Temp@12345pw' });
  if (made.status !== 201) { check(`${role} account created`, false, `${made.status}`); continue; }
  people.push({ role, email, userId: made.json.data.userId ?? made.json.data.id });
}
// A guest sees only projects they are added to: add this one to the first project.
const projects = (await api(owner, '/projects?pageSize=5')).json.data.items;
const guest = people.find((p) => p.role === 'Guest');
if (guest && projects[0]) await api(owner, `/projects/${projects[0].id}/members`, 'POST', { userId: guest.userId });

for (const p of people) {
  const ctx = await browser.newContext({ viewport: { width: 1357, height: 800 } });
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/login`);
  await page.fill('input[type=email], input[name=email]', p.email); await page.fill('input[type=password]', 'Temp@12345pw'); await page.click('button[type=submit]');
  await page.waitForSelector('text=Choose your password', { timeout: 30000 });
  const boxes = page.locator('.password-box input');
  await boxes.nth(0).fill('Temp@12345pw'); await boxes.nth(1).fill('Brand#New2026x'); await boxes.nth(2).fill('Brand#New2026x');
  await page.click('button[type=submit]');
  await page.waitForSelector('.sidebar-nav', { timeout: 30000 }); await page.waitForTimeout(1500);
  const links = await page.locator('.sidebar-nav a').evaluateAll((as) => as.map((a) => a.getAttribute('href')).filter(Boolean));
  const slug = new URL(page.url()).pathname.split('/')[1];
  let bad = [];
  for (const href of [...new Set(links)]) {
    await page.goto(`${BASE}${href.startsWith(`/${slug}`) ? href : `/${slug}${href}`}`); await page.waitForTimeout(1200);
    if ((await page.locator('text=Something went wrong').count()) || (await page.locator('text=Page not found').count())) bad.push(href);
  }
  check(`${p.role}: ${links.length} sidebar pages open`, bad.length === 0, bad.join(', '));
  await page.goto(`${BASE}/${slug}`); await page.waitForTimeout(1500);
  check(`${p.role}: dashboard opens`, (await page.locator('text=Something went wrong').count()) === 0);
  check(`${p.role}: no script errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
  await ctx.close();
}
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
