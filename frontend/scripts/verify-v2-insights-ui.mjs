import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// v2 Insights: Overview (4 numbers, workload bars open/overdue, ✦ What stands out with Suggest a rebalance), Time (one input with voice,
// one ✦ draft card, a clean week grid, total vs target, Submit week) and Reports (describe a report, 4 types, the Monday summary and the
// background reviews), light and dark at 1440 and on a 390 phone. Built frontend and synthetic API fixtures only.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/v2-insights-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 4, reportCount: 3 };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const monday = (() => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();
const wday = (n) => { const d = new Date(`${monday}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const g = (n) => `90000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`;

const project = (i, health, name) => ({ id: g(40 + i), key: `P${i}`, name, description: null, status: 'Active', priority: 'Medium', owner: null, teamId: null, teamName: null, startDate: wday(-30), dueDate: wday(30), progress: 40, health, stats: { total: 10, done: 4, inProgress: 3, cancelled: 0, todo: 3, overdue: 1 }, memberCount: 3, version: 1, position: i, enforceDependencies: false, projectGroupId: null, projectGroupName: null, projectType: 'NewProject', deliveryMethod: 'Hybrid' });
const projects = [project(1, 'Delayed', 'MuleSoft Gateway'), project(2, 'Delayed', 'MuleSoft Payouts'), ...[3, 4, 5, 6, 7].map((i) => project(i, 'OnTrack', `Project ${i}`)), project(8, 'AtRisk', 'Credit Vision')];
const people = [['Siva Reddy', 5, 1], ['Chalumuri Devaraju', 2, 0], ['Rakshit D', 2, 0], ['Shiva Kumar', 1, 1]];
const workload = {
  scope: 'Everyone', available: ['Everyone'],
  members: people.map(([name, open, overdue], i) => ({ userId: g(10 + i), name, email: `p${i}@example.test`, jobRole: null, level: 0, reportsTo: null, open, overdue, doneLast30Days: 3, loggedMinutesLast7Days: 0, nextUp: [], dueThisWeek: 1, openByKind: null })),
  totals: { people: 4, open: 10, overdue: 2 },
};
const ops = { days: 30, open: 4, unassigned: 0, breached: 0, atRisk: 1, compliance: 1, medianResolutionHours: 6, medianResponseMinutes: 20, createdInPeriod: 8, completedInPeriod: 6, weeks: [], aging: [], byTeam: [], byType: [], byPerson: [] };
const workRows = [['CIBIL-2', 'CreditVision API'], ['AA-5', 'UAT validation'], ['IQCA-1', 'Routing for 1rupee'], ['SIA-4', 'GoCollect QR split'], ['WT-5', 'MuleSoft server outage']];
const days = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ date: wday(i), minutes: 0, targetMinutes: i < 5 ? 480 : 0, weekend: i >= 5, leave: false, leaveNote: null, future: wday(i) > today, meetings: 0, meetingMinutes: 0 }));
const gridOf = (logged) => ({
  weekStart: monday, weekEnd: wday(6), user: { id: user.id, name: user.displayName }, mine: true, editable: true, locked: false, status: 'NotSubmitted', days,
  rows: workRows.map(([key, title], i) => ({ kind: i === 4 ? 'work' : 'task', targetId: g(50 + i), key, title, projectId: null, projectName: null, billable: true, totalMinutes: i === 0 ? logged : 0,
    cells: days.map((d) => ({ date: d.date, minutes: i === 0 && d.date === monday ? logged : 0, entries: 0, running: false, note: null })) })),
  suggestions: [], totalMinutes: logged, billableMinutes: logged, targetMinutes: 2400, overtimeMinutes: 0, missingDays: 0, running: null,
});
const week = { weekStart: monday, weekEnd: wday(6), userId: user.id, status: 'NotSubmitted', totalMinutes: 0, billableMinutes: 0, note: null, submittedAt: null, reviewer: null, reviewedAt: null, reviewNote: null, locked: false, canSubmit: true, canWithdraw: false, canReview: false, id: null, entitled: true };
const draft = { weekStart: monday, days: days.map((d) => ({ date: d.date, availableMinutes: 480, meetingMinutes: 0, skipped: d.weekend ? 'Weekend' : null })), cells: [{ kind: 'task', targetId: g(50), key: 'CIBIL-2', title: 'CreditVision API', projectName: null, date: monday, minutes: 240, why: 'You moved it to In progress' }, { kind: 'task', targetId: g(51), key: 'AA-5', title: 'UAT validation', projectName: null, date: monday, minutes: 120, why: 'You commented on it' }] };
const parsed = { text: '3h on CIBIL-2 today', entries: [{ text: '3h on CIBIL-2 today', minutes: 180, date: today, target: { kind: 'task', targetId: g(50), key: 'CIBIL-2', title: 'CreditVision API', projectName: null }, note: null, match: 'key', options: [], problem: null }], dayMinutes: 180, usedAi: false, model: null, transcript: null, language: null };
const jobs = [{ id: g(60), kind: 'portfolio', title: 'Portfolio risks & delivery forecast', status: 'succeeded', progress: 100, attempts: 1, createdAt: ago(20), errorCode: null, result: { summary: '**Two MuleSoft projects will slip** by about two weeks.', evidenceAt: ago(20), methodology: '', sources: [] } }];
const exportsList = [{ id: 'e1', kind: 'Project', format: 'Xlsx', status: 'Ready', projectId: null, targetUserId: null, days: 30, fileName: 'project-report.xlsx', sizeBytes: 48211, error: null, createdAt: ago(1), completedAt: ago(1), expiresAt: null }];

const errors = [], checks = [];
const allowed = [/^PUT \/api\/v1\/time\/grid$/, /^POST \/api\/v1\/time\/words$/, /^POST \/api\/v1\/time\/week\/submit$/, /^POST \/api\/v1\/ai\/operations\/(jobs|schedules)$/];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const make = async (theme, writes) => {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
  await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); }, theme);
  let logged = 0, schedules = [];
  await ctx.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
    if (url.origin !== origin) { await route.abort(); return; }
    if (ep.endsWith('/avatar') || ep.endsWith('/thumbnail')) { await route.fulfill({ status: 404, body: '' }); return; }
    if (!ep.startsWith('/api/')) {
      const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
      await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
      return;
    }
    let data = [];
    if (method !== 'GET' && !ep.endsWith('/auth/refresh')) {
      const sig = `${method} ${ep}`;
      assert.ok(allowed.some((r) => r.test(sig)), `Unexpected write: ${sig}`);
      writes.push(sig);
      const body = req.postDataJSON();
      if (ep === '/api/v1/time/grid') { logged = body.cells.reduce((a, c) => a + c.minutes, 0); data = { grid: gridOf(logged), saved: body.cells.length, errors: [] }; }
      else if (ep === '/api/v1/time/words') data = parsed;
      else if (ep === '/api/v1/time/week/submit') data = { ...week, status: 'Submitted', canSubmit: false };
      else if (ep === '/api/v1/ai/operations/schedules') { assert.equal(body.intervalMinutes, 10080); assert.equal(new Date(body.firstRunAt).getDay(), 1, 'the Monday summary starts on a Monday'); schedules = [{ id: g(70), title: body.title, kind: body.kind, intervalMinutes: 10080, nextRunAt: body.firstRunAt, enabled: true }]; data = schedules[0]; }
      else data = { id: g(61) };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
      return;
    }
    if (ep.endsWith('/auth/refresh')) data = { accessToken: `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`, expiresAt: '2099-01-01T00:00:00Z', user };
    else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['projects.view', 'projects.edit', 'tasks.view', 'tasks.edit', 'org.manage', 'work.view', 'work.create', 'reports.view', 'reports.broad'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 0, activity: 3, documents: 3, people: 3, reports: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { ADVANCED_REPORTS: 1 } } };
    else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: true };
    else if (ep === '/api/v1/timer') data = null;
    else if (ep === '/api/v1/projects') data = { items: projects, page: 1, pageSize: 100, totalItems: projects.length, totalPages: 1 };
    else if (ep === '/api/v1/workload') data = workload;
    else if (ep === '/api/v1/operations/insights') data = ops;
    else if (ep === '/api/v1/time/grid') data = gridOf(logged);
    else if (ep === '/api/v1/time/grid/draft') data = logged ? { ...draft, cells: [] } : draft;
    else if (ep === '/api/v1/time/week') data = week;
    else if (ep === '/api/v1/reports/exports') data = exportsList;
    else if (ep === '/api/v1/ai/operations/jobs') data = jobs;
    else if (ep === `/api/v1/ai/operations/jobs/${g(60)}`) data = jobs[0];
    else if (ep === '/api/v1/ai/operations/schedules') data = schedules;
    else if (ep.endsWith('/workspace/members')) data = people.map(([name], i) => ({ userId: g(10 + i), displayName: name, email: `p${i}@example.test`, role: 'Member' }));
    else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
    else if (ep.endsWith('/ai/status')) data = { enabled: false, configured: false, entitled: true, allowedHere: false };
    else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
    else if (ep === '/api/v1/chat/projects/unread') data = [];
    else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  return ctx;
};
const shot = async (page, name) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(900); await page.screenshot({ path: path.join(out, name), fullPage: true, animations: 'disabled' }); };

try {
  for (const [theme, width] of [['light', 1440], ['dark', 1440], ['light', 390]]) {
    const tag = `${width}${theme === 'dark' ? '-dark' : ''}`;
    const writes = [];
    const ctx = await make(theme, writes);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (e) => { if (e.type() === 'error' && !e.text().startsWith('Failed to load resource')) errors.push(e.text()); });
    await page.setViewportSize({ width, height: 1000 });

    // Overview: four numbers, the workload bars and what stands out.
    await page.goto(`${origin}/preview-org/insights`);
    await page.getByRole('heading', { level: 1, name: 'Insights' }).waitFor();
    for (const t of ['Overview', 'Time', 'Reports']) await page.getByRole('tab', { name: t }).waitFor();
    // Three rings: Delivery on time, Load balance, Time logged.
    for (const label of ['Delivery on time', 'Load balance', 'Time logged']) await page.locator('.ins-ring', { hasText: label }).first().waitFor();
    assert.equal(await page.locator('.ins-ring').count(), 3);
    const deliveryRing = page.locator('.ins-ring', { hasText: 'Delivery on time' });
    assert.match(await deliveryRing.innerText(), /5 of 8 projects on track/);
    assert.match(await deliveryRing.innerText(), /2 delayed/);
    await deliveryRing.getByText(/^63\s*%$/).waitFor();
    assert.match(await page.locator('.ins-ring', { hasText: 'Time logged' }).innerText(), /0h of 160h expected this week/);
    await page.getByRole('region', { name: 'Done vs planned' }).waitFor();
    const load = page.getByRole('region', { name: 'Workload' });
    assert.equal(await load.locator('.ins-bars li').count(), 4);
    assert.equal(await load.locator('.ins-bars li').first().locator('.ins-name').innerText(), 'Siva Reddy');
    assert.ok((await load.locator('.ins-bar i.late').first().evaluate((e) => e.getBoundingClientRect().width)) > 0, 'overdue shows in red');
    const stand = page.getByRole('region', { name: 'What stands out' });
    await stand.getByText('Siva Reddy holds 50% of the team\'s open work, 1 of it overdue.').waitFor();
    await stand.getByText(/2 projects are delayed: MuleSoft Gateway, MuleSoft Payouts\./).waitFor();
    await stand.getByText('Nobody has logged time in the last 7 days.').waitFor();
    await stand.getByRole('button', { name: 'Suggest a rebalance' }).waitFor();
    if (width === 390) await fitsPhone(page, 'Insights overview', assert);
    await shot(page, `overview-${tag}.png`);

    // Time: one input (with voice when the browser has it), one draft card, the clean grid, total vs target, Submit week.
    await page.getByRole('tab', { name: 'Time' }).click();
    await page.getByRole('heading', { level: 1, name: 'Time' }).waitFor();
    await page.getByText(/Week of .* · not submitted/).waitFor();
    const say = page.getByRole('textbox', { name: 'Log time in words' });
    assert.match(await say.getAttribute('placeholder'), /3h on CIBIL-2 today/);
    await page.locator('.ins-draft').first().waitFor(); assert.equal(await page.locator('.ins-draft').count(), 1, 'one draft card');
    await page.locator('.ins-draft').getByText(/6h across 2 items/).waitFor();
    assert.equal(await page.locator('.ins-table tbody tr').count(), 5);
    assert.equal(await page.locator('.ins-table thead th').count(), 7, 'Work, Monday to Friday, Total');
    await page.getByText(/0h of 40h · billable 0h/).waitFor();
    await page.getByRole('button', { name: 'Submit week' }).waitFor();
    if (width === 390) await fitsPhone(page, 'Time', assert);
    await shot(page, `time-${tag}.png`);
    // Typing words reads them for checking before anything is logged.
    await say.fill('3h on CIBIL-2 today');
    await page.getByRole('button', { name: 'Log', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    // Use draft fills the grid, then the week is submitted.
    await page.locator('.ins-draft').getByRole('button', { name: 'Use draft' }).click();
    await page.getByText(/6h of 40h/).waitFor();
    await page.getByRole('button', { name: 'Submit week' }).click();
    await page.getByText('Week submitted for approval.').waitFor();
    await page.getByRole('link', { name: 'Home inbox ›' }).waitFor();

    // Reports: describe a report, four types, the Monday summary and the reviews.
    await page.getByRole('tab', { name: 'Reports' }).click();
    await page.getByRole('heading', { level: 1, name: 'Reports' }).waitFor();
    const types = page.getByRole('group', { name: 'Report type' });
    assert.equal(await types.locator('.ds-choice').count(), 4);
    await page.getByRole('textbox', { name: 'Describe a report' }).fill('hours by person this month as Excel');
    await page.getByRole('button', { name: 'Set up' }).click();
    assert.equal(await types.locator('.ds-choice[aria-pressed="true"]').innerText().then((t) => /Timesheet/i.test(t)), true, 'the words picked the timesheet report');
    const mondaySummary = page.getByRole('region', { name: 'Monday summary' });
    await mondaySummary.getByRole('button', { name: 'Schedule it' }).click();
    await mondaySummary.getByText(/Every Monday/).waitFor();
    const reviews = page.getByRole('region', { name: 'Reviews' });
    await reviews.getByRole('button', { name: /Portfolio risks & delivery forecast/ }).nth(1).click();
    await reviews.getByText('Two MuleSoft projects will slip').waitFor();
    if (width === 390) await fitsPhone(page, 'Reports', assert);
    await shot(page, `reports-${tag}.png`);
    assert.deepEqual([...new Set(writes)].sort(), ['POST /api/v1/ai/operations/schedules', 'POST /api/v1/time/week/submit', 'POST /api/v1/time/words', 'PUT /api/v1/time/grid'].sort());
    await ctx.close();
    checks.push(tag);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors }));
} finally { await browser.close(); }
