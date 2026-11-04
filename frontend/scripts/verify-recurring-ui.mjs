import { chromium, devices } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';
import { openCreate } from './lib/aura.mjs';

// + New › "From template…": the searchable picker of project and task templates, picking one, the start-date form, creating through
// /templates/{id}/create-project and landing on the new project. Light and dark at 1440, and an iPhone at 390 (no sideways scroll, nothing cut off).
// Built frontend with fictional fixtures only (the shell mocks are the ones verify-approvals-phone-ui.mjs uses).
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/recurring-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-0000000000a1', displayName: 'Ravi Menon', email: 'ravi@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Northwind', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 8 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const now = Date.now(), iso = (m) => new Date(now + m * 60000).toISOString();
const T = (id, kind, name, description, taskCount, sectionCount, durationDays) => ({ id, kind, name, description, taskCount, sectionCount, durationDays, createdAt: iso(-9000) });
const projectTemplates = [T('tp1', 'project', 'Client onboarding', 'Kick-off to go-live', 18, 4, 42), T('tp2', 'project', 'Website relaunch', 'Design, build, launch', 26, 5, 60), T('tp3', 'project', 'Quarterly audit', null, 9, 3, 21)];
const taskTemplates = [T('tt1', 'task', 'Month-end close', 'Close the books', 4, 0, null), T('tt2', 'task', 'New joiner setup', null, 6, 0, null)];
const deploy = {}, needs = [], history = [], apList = () => ({ items: [], counts: {} }), chain = () => ({ steps: [] });
const RM = { id: user.id, name: user.displayName };
const members = [RM].map((u) => ({ userId: u.id, displayName: u.name, email: 'ravi@example.test', role: 'Owner', joinedAt: iso(-99999), jobRole: null }));
const grid = {}, draft = {}, tinsights = {}, activity = { items: [], page: 1, pageSize: 25, totalItems: 0, totalPages: 0 }, reminders = { open: [], completed: [], sent: [], counts: {}, limits: {} }, suggestions = [], watches = [], noteList = { items: [] }, noteOne = {};
const monday = '2026-11-02', addD = (d) => d;

const writes = [], errors = [], checks = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
try {
  const make = async (theme, dev = {}) => {
    const ctx = await browser.newContext({ ...dev, timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
    await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); localStorage.setItem('pm_home_mode', 'classic'); }, theme);
    await ctx.route('**/*', async (route) => {
      const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
      if (url.origin !== origin) { await route.abort(); return; }
      if (ep.endsWith('/avatar') || ep.endsWith('/download')) { await route.fulfill({ status: 404, body: '' }); return; }
      if (!ep.startsWith('/api/')) { const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep)); await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } }); return; }
      let data = [];
      const p = ep.replace('/api/v1', '');
      if (method !== 'GET' && !ep.endsWith('/auth/refresh')) {
        writes.push({ method, p, body: req.postData() });
        if (p.endsWith('/create-project')) data = { projectId: 'p9', taskIds: ['t1', 't2'] };
        else if (p.startsWith('/approvals/') && p.endsWith('/decide')) data = { ...deploy, status: 'Approved', needsMe: false };
        else if (p === '/approvals') data = { ...deploy, id: 'ap9' };
        else if (p.startsWith('/notes')) data = noteOne;
        else if (p.startsWith('/reminders')) data = reminders.open[0];
        else data = {};
      }
      else if (p === '/templates') data = (url.searchParams.get('kind') ?? 'project') === 'project' ? projectTemplates : taskTemplates;
      else if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
      else if (p === '/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['projects.view', 'tasks.view', 'org.manage', 'reports.view', 'work.view'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 3, activity: 3, documents: 3, people: 3, reports: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3 } } };
      else if (p === '/workspace') data = { ...ws, aiDisabled: false };
      else if (p === '/me/ui/sidebar') data = { key: 'sidebar', value: null, updatedAt: null };
      else if (p === '/approvals') data = (() => { const l = apList(url.searchParams.get('view') ?? 'needs'); return { items: l.items.map((a, i) => i === 0 ? { ...a, steps: a.steps.map((st, k) => k === 0 ? { ...st, approver: null } : st), links: undefined } : a), counts: l.counts }; })();
      else if (p === '/me/device-login/dl1') data = { id: 'dl1', choices: [12, 47, 83], device: 'Chrome on Windows', ip: '49.37.12.9', createdAt: iso(-1), expiresAt: iso(4) };
      else if (p === '/approvals/counts') data = { needsMe: 3 };
      else if (p === '/approvals/chain') data = chain(url.searchParams.get('type'));
      else if (p.startsWith('/approvals/')) data = [...needs, ...history].find((x) => x.id === p.split('/')[2]) ?? deploy;
      else if (p === '/workspace/members') data = members;
      else if (p === '/time/grid') data = grid;
      else if (p === '/time/week') data = { weekStart: monday, weekEnd: addD(monday, 6), userId: user.id, status: 'NotSubmitted', totalMinutes: grid.totalMinutes, billableMinutes: 1540, note: null, submittedAt: null, reviewer: null, reviewedAt: null, reviewNote: null, locked: false, canSubmit: true, canWithdraw: false, canReview: false, id: null, entitled: true };
      else if (p === '/time/insights') data = tinsights;
      else if (p === '/time/grid/draft') data = draft;
      else if (p === '/activity') data = activity;
      else if (p === '/reminders') data = reminders;
      else if (p === '/reminders/settings') data = { defaultTime: '09:00', timeZone: 'Asia/Kolkata', dueLeads: [1, 0], quietStart: '21:00', quietEnd: '08:00', autoEnabled: true };
      else if (p === '/reminders/suggestions') data = suggestions;
      else if (p === '/ai/watches') data = watches;
      else if (p === '/reminders/insights') data = { doneThisWeek: 23, firedThisWeek: 27, onTimePercent: 86, usualTime: '10:00', snoozedOften: [R('r8', 'Expense report', { snoozeCount: 4 })] };
      else if (p === '/reminders/counts') data = reminders.counts;
      else if (p === '/notes') data = noteList;
      else if (p.startsWith('/notes/')) data = noteOne;
      else if (p === '/search') data = { hits: [{ type: 'task', id: 't1', title: 'ATL-482 Refund webhook retries', subtitle: 'Atlas', projectId: 'p1', taskId: 't1' }] };
      else if (ep.endsWith('/projects') || ep.endsWith('/tasks') || ep.endsWith('/work-tasks')) data = { items: [{ id: 'p1', name: 'Atlas Payments', key: 'ATL' }], page: 1, pageSize: 100, totalPages: 1, totalItems: 1 };
      else if (p === '/timer') data = null;
      else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
      else if (ep.endsWith('/ai/status')) data = { enabled: true, configured: true, entitled: true, allowedHere: true };
      else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
      else if (p === '/chat/projects/unread') data = [];
      else if (p === '/notifications') data = { items: [], page: 1, pageSize: 20, totalPages: 0, totalItems: 0 };
      else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
    });
    return ctx;
  };
  const shot = async (page, name) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(450); await page.screenshot({ path: path.join(out, name) }); };
  for (const theme of ['light', 'dark']) for (const [w, h, dev] of [[1440, 900, {}], [390, 844, devices['iPhone 13']]]) {
    const c = await make(theme, dev); const page = await c.newPage(); if (w > 500) await page.setViewportSize({ width: w, height: h });
    page.on('pageerror', (e) => errors.push(`${w} ${theme}: ${e.message}`));
    await page.goto(`${origin}/preview-org/approvals`); await page.locator('.ap-hero-title').first().waitFor({ timeout: 15000 });
    await openCreate(page);
    await page.getByTestId('new-from-template').click();
    await page.getByTestId('template-picker').waitFor();
    await page.locator('.tp-item', { hasText: 'Client onboarding' }).waitFor();
    assert.equal(await page.locator('.tp-item').count(), 3);
    await page.locator('.tp-search').fill('web'); await page.waitForTimeout(150);
    assert.equal(await page.locator('.tp-item').count(), 1, 'search narrows the list');
    await page.locator('.tp-search').fill('');
    await fitsPhone(page, `picker ${w} ${theme}`, assert);
    await shot(page, `template-picker-${theme}-${w}.png`);
    await page.getByRole('tab', { name: 'Tasks' }).click(); await page.locator('.tp-item', { hasText: 'Month-end close' }).waitFor();
    await page.getByRole('tab', { name: 'Projects' }).click();
    await page.locator('.tp-item', { hasText: 'Client onboarding' }).click();
    await page.locator('.tp-form').waitFor();
    await page.locator('.tp-field input[type="date"]').fill('2027-01-04');
    await fitsPhone(page, `picker form ${w} ${theme}`, assert);
    await shot(page, `template-form-${theme}-${w}.png`);
    await page.getByTestId('template-picker').getByRole('button', { name: 'Create', exact: true }).click(); await page.waitForTimeout(600);
    const made = writes.find((x) => x.p === '/templates/tp1/create-project');
    assert.ok(made, 'created through the template endpoint');
    assert.deepEqual(JSON.parse(made.body), { name: 'Client onboarding', startDate: '2027-01-04' });
    assert.ok(page.url().includes('/work/projects/p9'), `lands on the new project: ${page.url()}`);
    writes.length = 0;
    checks.push(`template-picker ${w} ${theme}`);
    await c.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors }));
} finally { await browser.close(); }
