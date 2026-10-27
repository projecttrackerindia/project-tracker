import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { appCsp } from './lib/csp.mjs';

// Quality → Releases (design s-release): the header with the previous shipped version and "N days to go", the go/no-go card ("Ready once
// N blockers close and M people sign off", tests passed / blocking bugs / sign-offs pending, the forecast line), Sign-offs with Remind
// pending and signing your own, Test runs by environment (suites × environments) and linked work items with Blocker/Done tags.
// 1440 light and dark, 390 phone (no horizontal scroll). Synthetic API only; every write is checked.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/release-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const g = (n) => `92000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const user = { id: g(1), displayName: 'Prasanna K', email: 'prasanna@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: g(9), slug: 'preview-org', name: 'FiveStar Finance', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 4 };
const P = (n, name) => ({ id: g(n), name });
const me = P(1, 'Prasanna K'), clara = P(2, 'Clara Novak'), lena = P(3, 'Lena Fischer'), tomas = P(4, 'Tomás Rivera');
const members = [me, clara, lena, tomas].map((x, i) => ({ userId: x.id, displayName: x.name, email: `u${i}@example.test`, role: i ? 'Member' : 'Owner', joinedAt: '2026-01-01T00:00:00Z', jobRole: null }));
const iso = (d) => d.toISOString().slice(0, 10);
const plus = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return iso(d); };
const pid = g(50);
const rel = { id: g(60), name: 'v2.4', projectId: pid, projectName: 'Loan Origination', targetDate: plus(18), status: 'Planned', notes: null, items: 4, runs: 2, approvedBy: null, approvedAt: null, shippedAt: null, createdAt: '2026-10-01T00:00:00Z' };
const prev = { ...rel, id: g(61), name: 'v2.3', status: 'Shipped', targetDate: '2026-10-17', shippedAt: '2026-10-17T10:00:00Z' };
const item = (n, key, title, category, bug) => ({ id: g(n), kind: bug ? 'issue' : 'task', key, title, status: category === 'Done' ? 'Done' : 'In Progress', category, assignee: null, dueDate: null, bug });
function state() {
  return {
    release: rel, done: 2, open: 2, openBugs: 2, go: false, canApprove: true,
    items: [item(70, 'LO-412', 'Duplicate EMI row after restructure', 'Active', true), item(71, 'LO-418', 'Sanction letter PDF times out > 40 pages', 'Active', true),
      item(72, 'LO-401', 'Co-applicant income step', 'Done', false), item(73, 'LO-397', 'Pre-approved offer banner', 'Done', false)],
    runs: [{ id: g(80), name: 'UAT 2.4', environment: 'UAT', build: '214', status: 'Done', projectId: pid, createdAt: '2026-10-20T00:00:00Z', startedAt: null, completedAt: null },
      { id: g(81), name: 'Pre-prod', environment: 'Pre-prod', build: '215', status: 'Running', projectId: pid, createdAt: '2026-10-25T00:00:00Z', startedAt: null, completedAt: null }],
    tests: { run: null, cases: 190, ran: 186, passed: 182, failed: 4, blocked: 0, notRun: 4, passPercent: 96, blockers: [], ready: false },
    checks: [{ key: 'work', label: 'Work done', ok: true, detail: 'All 2 items are done.' }, { key: 'bugs', label: 'No open bugs', ok: false, detail: '2 bugs are still open.' },
      { key: 'tests', label: 'Tests ready', ok: false, detail: 'UAT 2.4: 96% passed.' }, { key: 'signoffs', label: 'Signed off', ok: false, detail: '3 of 4 sign-offs pending.' }],
    signOffs: [[clara, 'QA', 'Pending'], [lena, 'Risk & compliance', 'Pending'], [me, 'Product', 'Pending'], [tomas, 'Engineering', 'Signed']].map(([u, role, status], i) =>
      ({ id: g(90 + i), user: u, role, status, note: null, signedAt: status === 'Signed' ? '2026-10-24T09:00:00Z' : null, remindedAt: null })),
    grid: { environments: ['DEV', 'QA', 'UAT', 'Pre-prod'], rows: [['Loan application flow', 48, 48, 47, 0], ['EMI & repayment', 36, 33, 34, 0], ['Documents & e-sign', 30, 30, 28, 0]].map(([suite, t, q, u]) =>
      ({ suite, cells: [{ environment: 'DEV', passed: t, total: t, running: false }, { environment: 'QA', passed: q, total: t, running: false }, { environment: 'UAT', passed: u, total: t, running: false }, { environment: 'Pre-prod', passed: 0, total: 0, running: true }] })) },
    previous: prev, forecast: { openBlockers: 2, closedPerDay: 0.5, blockersClearBy: plus(4) },
  };
}
const errors = [], checks = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const make = async (theme, st) => {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
  await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); }, theme);
  await ctx.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
    if (url.origin !== origin || ep.startsWith('/hubs/')) { await route.abort(); return; }
    if (ep.endsWith('/avatar') || ep.endsWith('/logo/file') || ep.endsWith('/thumbnail')) { await route.fulfill({ status: 404, body: '' }); return; }
    if (!ep.startsWith('/api/')) {
      const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
      await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
      return;
    }
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ data }) });
    if (method !== 'GET' && !ep.endsWith('/auth/refresh')) {
      const b = method === 'DELETE' ? null : req.postDataJSON();
      st.writes.push({ ep, method, b });
      if (ep === `/api/v1/releases/${rel.id}/signoffs/remind`) { st.s.signOffs.forEach((x) => { if (x.status === 'Pending') x.remindedAt = new Date().toISOString(); }); return json(st.s); }
      if (ep === `/api/v1/releases/${rel.id}/signoffs/sign`) { assert.equal(b.signed, true); const x = st.s.signOffs.find((y) => y.user.id === me.id); x.status = 'Signed'; x.signedAt = new Date().toISOString(); return json(st.s); }
      assert.fail(`Unexpected write: ${method} ${ep}`);
    }
    let data = [];
    if (ep.endsWith('/auth/refresh')) data = { accessToken: `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`, expiresAt: '2099-01-01T00:00:00Z', user };
    else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, reportCount: 2, permissions: ['projects.view', 'projects.edit', 'tasks.view', 'tasks.edit', 'work.view', 'work.create', 'work.edit', 'org.manage'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 0, activity: 3, documents: 3, people: 3, reports: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: {} } };
    else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: true };
    else if (ep === '/api/v1/workspace/members') data = members;
    else if (ep === '/api/v1/quality/matrix') data = { runs: [], cases: [], results: [] };
    else if (ep === '/api/v1/quality/runs') data = st.s.runs;
    else if (ep === '/api/v1/releases') data = [rel, prev];
    else if (ep === `/api/v1/releases/${rel.id}`) data = st.s;
    else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
    else if (ep.endsWith('/ai/status')) data = { enabled: false, configured: false, entitled: true, allowedHere: false };
    else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
    else if (ep === '/api/v1/timer') data = null;
    else if (ep === '/api/v1/chat/projects/unread') data = [];
    else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
    else if (ep === '/api/v1/priorities') data = null;
    else if (ep === '/api/v1/projects') data = { items: [], page: 1, pageSize: 100, totalItems: 0, totalPages: 0 };
    await json(data);
  });
  return ctx;
};
const shot = async (page, name) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(700); await page.screenshot({ path: path.join(out, name), fullPage: true, animations: 'disabled' }); };
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => { if (e.type() === 'error' && !e.text().startsWith('Failed to load resource')) errors.push(e.text()); });
};
const open = async (page) => {
  await page.goto(`${origin}/preview-org/quality`);
  await page.getByRole('tab', { name: 'Releases' }).click();
  await page.getByText('Ready once 2 blockers close').waitFor();
};
try {
  for (const [theme, w, h] of [['light', 1440, 1000], ['dark', 1440, 1000], ['light', 390, 844], ['dark', 390, 844]]) {
    const st = { s: state(), writes: [] };
    const ctx = await make(theme, st);
    const page = await ctx.newPage();
    watch(page);
    await page.setViewportSize({ width: w, height: h });
    await open(page);
    const main = page.getByRole('region', { name: 'Release' });
    await main.getByText('v2.3 shipped 17 Oct').waitFor();
    await main.getByText('18 days to go').waitFor();
    await main.getByText(/Ready once 2 blockers close, 3 people sign off and tests pass/).waitFor();
    await main.getByText('Blocking bugs open').waitFor();
    await main.getByText(/At the recent fix rate .* on track/).waitFor();
    assert.equal(await main.locator('.rl-tr:not(.hd)').count(), 3);
    assert.equal(await main.locator('.rl-tr.hd > span').count(), 5);
    assert.equal(await main.locator('.rl-tag', { hasText: 'Blocker' }).count(), 2);
    if (w < 500) assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scroll on phone');
    await shot(page, `release-${w}${theme === 'dark' ? '-dark' : ''}.png`);
    if (theme === 'light' && w === 1440) {
      await main.getByRole('button', { name: 'Remind pending' }).click();
      await page.waitForTimeout(300);
      assert.ok(st.writes.some((x) => x.ep.endsWith('/signoffs/remind')));
      await main.getByRole('button', { name: 'Sign off as Product' }).click();
      await main.getByText(/2 people sign off/).waitFor().catch(() => undefined);
      assert.ok(st.writes.some((x) => x.ep.endsWith('/signoffs/sign')));
      checks.push('remind+sign');
    }
    checks.push(`${theme}-${w}`);
    await ctx.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors }));
} finally { await browser.close(); }
