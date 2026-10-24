import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Workload, Capacity & cost, Reports, My work and a project's Issues and Files, in the design-system language, light and dark, desktop
// and phone. Only the built frontend and synthetic API fixtures are used.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/insights-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 4 };
const pid = '00000000-0000-0000-0000-000000000003';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const day = (n) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const people = [['Asha Rao', 'asha'], ['Ravi Kumar', 'ravi'], ['Meera Iyer', 'meera'], ['Jordan Lee', 'jordan']].map(([name, e], i) => ({ id: `30000000-0000-0000-0000-00000000000${i + 1}`, name, email: `${e}@example.test` }));
const item = (i, kind, title, due, overdue, status = 'In progress', category = 'InProgress', priority = 'Medium') => ({
  id: `40000000-0000-0000-0000-0000000000${String(i).padStart(2, '0')}`, kind, key: kind === 'Operational' ? `OPS-${i}` : `PAY-${i}`, title, projectId: kind === 'Operational' ? null : pid,
  projectKey: kind === 'Operational' ? null : 'PAY', projectName: kind === 'Operational' ? null : 'Payments Core', status, statusName: status, category, priority, dueDate: due, isOverdue: overdue,
  assignee: { id: user.id, name: user.displayName }, typeName: kind === 'Operational' ? 'Support' : null, updatedAt: ago(3),
});
const mine = [
  item(1, 'Task', 'Settlement file format', day(-2), true, 'In progress', 'InProgress', 'High'),
  item(2, 'Issue', 'Refund webhook retries twice', day(-1), true, 'Observed / Failed', 'Todo', 'Critical'),
  item(3, 'Task', 'API validation with the bank', today, false, 'To do', 'Todo', 'Medium'),
  item(4, 'ActionItem', 'Share the cut-off times with support', day(3), false, 'Open', 'Todo', 'Low'),
  item(5, 'Operational', 'Reconcile yesterday’s failed payouts', day(5), false, 'In progress', 'InProgress', 'High'),
  item(6, 'Task', 'Write the release notes', null, false, 'To do', 'Todo', 'Low'),
];
const workload = {
  scope: 'Everyone', available: ['Everyone', 'Reports', 'Me'],
  members: people.map((p, i) => ({
    userId: p.id, name: p.name, email: p.email, jobRole: ['Product lead', 'Backend engineer', 'QA engineer', 'Designer'][i], level: 0, reportsTo: null,
    open: [6, 9, 4, 2][i], overdue: [2, 3, 0, 0][i], doneLast30Days: [11, 7, 9, 5][i], loggedMinutesLast7Days: [1860, 2280, 1500, 600][i], dueThisWeek: [3, 4, 1, 1][i],
    openByKind: { tasks: [3, 5, 1, 2][i], issues: [1, 3, 3, 0][i], actionItems: [1, 0, 0, 0][i], operational: [1, 1, 0, 0][i], total: [6, 9, 4, 2][i] },
    nextUp: i < 2 ? mine.slice(i * 2, i * 2 + 2).map((w) => ({ ...w, statusName: w.status })) : [],
  })),
  totals: { people: 4, open: 21, overdue: 5 },
};
const util = (p, i) => ({ userId: p.id, name: p.name, capacityMinutes: 9600, loggedMinutes: [8700, 10400, 6100, 3000][i], billableMinutes: [6200, 7900, 2400, 900][i], projectMinutes: [7000, 9100, 4800, 2500][i], operationalMinutes: [1700, 1300, 1300, 500][i], utilisation: [0.91, 1.08, 0.64, 0.31][i], billableShare: [0.65, 0.82, 0.25, 0.09][i], cost: [72500, 86600, 50800, 25000][i], billableValue: [103300, 131600, 40000, 15000][i] });
const utilisation = { from: day(-27), to: today, scope: 'Everyone', available: ['Everyone', 'Reports', 'Me'], currency: 'INR', showMoney: true, entitled: true, workingDays: 20, people: people.map(util), totals: { userId: '', name: 'All', capacityMinutes: 38400, loggedMinutes: 28200, billableMinutes: 17400, projectMinutes: 23400, operationalMinutes: 4800, utilisation: 0.73, billableShare: 0.45, cost: 234900, billableValue: 289900 } };
const rates = { currency: 'INR', entitled: true, canEdit: true, currencies: [{ code: 'INR', name: 'Indian rupee' }, { code: 'USD', name: 'US dollar' }], members: people.map((p, i) => ({ userId: p.id, name: p.name, email: p.email, role: i ? 'Member' : 'Owner', weeklyCapacityHours: 40, standardCapacity: i !== 1, costRate: [500, 500, 500, 500][i], billRate: [1200, 1000, 1000, 1000][i] })) };
const exportsList = [
  { id: 'e1', kind: 'Project', format: 'Xlsx', status: 'Ready', projectId: null, targetUserId: null, days: 30, fileName: 'project-report.xlsx', sizeBytes: 48211, error: null, createdAt: ago(1), completedAt: ago(1), expiresAt: null },
  { id: 'e2', kind: 'Timesheet', format: 'Csv', status: 'Running', projectId: null, targetUserId: null, days: 7, fileName: null, sizeBytes: 0, error: null, createdAt: ago(0.05), completedAt: null, expiresAt: null },
  { id: 'e3', kind: 'Workload', format: 'Pdf', status: 'Failed', projectId: null, targetUserId: null, days: 30, fileName: null, sizeBytes: 0, error: 'The report was too large', createdAt: ago(26), completedAt: null, expiresAt: null },
];
const stages = ['Created', 'Build', 'Testing / QA', 'Launch'].map((name, i) => ({ id: `10000000-0000-0000-0000-00000000000${i + 1}`, name, order: i, durationDays: [0, 6, 4, 0][i], plannedStart: day(-20 + i * 5), plannedEnd: day(-15 + i * 5), actualStart: i < 2 ? day(-20 + i * 5) : null, actualEnd: i < 1 ? day(-20) : null, status: i < 1 ? 'Completed' : i === 2 ? 'InProgress' : 'Pending', effectiveStatus: i < 1 ? 'Completed' : i === 2 ? 'InProgress' : 'Pending', openIssues: i === 2 ? 3 : 0 }));
const project = { id: pid, key: 'PAY', name: 'Payments Core', description: 'Refunds, settlements and payouts for every bank partner.', status: 'Active', priority: 'High', health: 'AtRisk', progress: 46, active: 20, startDate: day(-20), dueDate: day(20), version: 3, stageScheduleMode: 'FollowSchedule', projectType: 'NewProject', deliveryMethod: 'Hybrid', owner: { id: user.id, name: user.displayName }, stats: { total: 13, done: 6, inProgress: 4, cancelled: 0, todo: 3, overdue: 2 } };
const detail = { project, stages, statuses: [{ id: pid, name: 'To Do', order: 0, category: 'Todo', color: '#4f46e5' }], members: people.map((p, i) => ({ userId: p.id, name: p.name, email: p.email, role: i ? 'Member' : 'Owner' })) };
const can = { edit: true, assign: true, delete: true, attach: true, moveTo: ['InProgress', 'Fixed', 'Resolved'] };
const issues = [
  ['Refund webhook retries twice', 'Critical', 'Observed', 2], ['Settlement file has the wrong date format', 'High', 'InProgress', 0],
  ['Bank code missing on the receipt', 'Medium', 'Fixed', 1], ['Typo on the refund screen', 'Low', 'Resolved', 0],
].map(([title, severity, status, files], i) => ({ id: `50000000-0000-0000-0000-00000000000${i + 1}`, key: `PAY-I${i + 1}`, number: i + 1, projectId: pid, stageId: stages[2].id, stageName: stages[2].name, title, details: null, severity, status, reporter: { id: people[2].id, name: people[2].name }, assignee: i === 3 ? null : { id: people[1].id, name: people[1].name }, createdAt: ago(5 + i * 20), resolvedAt: status === 'Resolved' ? ago(2) : null, fileCount: files, can }));
const files = [
  { id: 'f1', projectId: pid, taskId: null, taskKey: null, taskTitle: null, fileName: 'settlement-spec-v3.pdf', contentType: 'application/pdf', sizeBytes: 812000, uploadedBy: { id: people[1].id, name: people[1].name }, createdAt: ago(30), canDelete: true, isImage: false, issueId: null },
  { id: 'f2', projectId: pid, taskId: 'x', taskKey: 'PAY-12', taskTitle: 'Refund screen', fileName: 'refund-flow.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sizeBytes: 64200, uploadedBy: { id: user.id, name: user.displayName }, createdAt: ago(4), canDelete: true, isImage: false, issueId: null },
];

const errors = [], checks = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const make = async (theme, modules) => {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
  await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); }, theme);
  await ctx.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
    if (url.origin !== origin) { await route.abort(); return; }
    if (ep.endsWith('/avatar') || ep.endsWith('/thumbnail')) { await route.fulfill({ status: 404, body: '' }); return; }
    if (!ep.startsWith('/api/')) {
      const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
      await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
      return;
    }
    assert.ok(method === 'GET' || ep.endsWith('/auth/refresh'), `Unexpected write: ${method} ${ep}`);
    let data = [];
    if (ep.endsWith('/auth/refresh')) data = { accessToken: `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`, expiresAt: '2099-01-01T00:00:00Z', user };
    else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['projects.view', 'projects.edit', 'tasks.view', 'tasks.edit', 'org.manage', 'work.view', 'work.create', 'reports.view', 'reports.broad'], modules, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { ADVANCED_REPORTS: 1, RESOURCE_MANAGEMENT: 1 } } };
    else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: true };
    else if (ep === '/api/v1/timer') data = null;
    else if (ep === '/api/v1/workload') data = workload;
    else if (ep.startsWith('/api/v1/workload/')) data = { person: workload.members[1], openTasks: mine.map((w) => ({ ...w, statusName: w.status })) };
    else if (ep === '/api/v1/resources/utilisation') data = utilisation;
    else if (ep === '/api/v1/resources/rates') data = rates;
    else if (ep === '/api/v1/reports/exports') data = exportsList;
    else if (ep === '/api/v1/my-work') data = mine;
    else if (ep === `/api/v1/projects/${pid}`) data = detail;
    else if (ep === `/api/v1/projects/${pid}/issues`) data = issues;
    else if (ep === `/api/v1/projects/${pid}/attachments`) data = files;
    else if (ep.endsWith('/attachments/limits')) data = { maxFileBytes: 20e6, storageLimitBytes: 5e9, storageUsedBytes: 1.2e9, allowedExtensions: ['.pdf', '.xlsx'] };
    else if (ep.endsWith('/workspace/members')) data = people.map((p, i) => ({ userId: p.id, displayName: p.name, email: p.email, role: i ? 'Member' : 'Owner' }));
    else if (ep.endsWith('/projects') || ep.endsWith('/tasks') || ep.endsWith('/work-tasks')) data = { items: ep.endsWith('/projects') ? [project] : [], page: 1, totalPages: 1, totalItems: ep.endsWith('/projects') ? 1 : 0 };
    else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
    else if (ep.endsWith('/ai/status')) data = { enabled: false, configured: false, entitled: true, allowedHere: false };
    else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
    else if (ep === '/api/v1/chat/projects/unread') data = [];
    else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  return ctx;
};
const shot = async (page, name, full = true) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(1500); await page.screenshot({ path: path.join(out, name), fullPage: full, animations: 'disabled' }); };
const all = { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 0, activity: 3, documents: 3, people: 3, reports: 3, billing: 3 };
const noProjects = { ...all, projects: 0 };
try {
  for (const [theme, width] of [['light', 1440], ['dark', 1440], ['light', 820], ['light', 390]]) {
    const tag = `${width}${theme === 'dark' ? '-dark' : ''}`;
    let ctx = await make(theme, all);
    let page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (e) => { if (e.type() === 'error' && !e.text().startsWith('Failed to load resource')) errors.push(e.text()); });
    await page.setViewportSize({ width, height: 1000 });

    // Workload: the people, their open work and the chart.
    await page.goto(`${origin}/preview-org/workload`);
    await page.getByRole('heading', { name: 'Workload', level: 1 }).waitFor();
    await page.locator('.team-card', { hasText: 'Ravi Kumar' }).waitFor();
    await page.waitForTimeout(1500); await page.locator(".wl-chart").screenshot({ path: path.join(out, `workload-chart-${tag}.png`) });
    if (width === 390) await fitsPhone(page, 'Workload', assert);
    await shot(page, `workload-${tag}.png`);
    // Capacity & cost.
    await page.goto(`${origin}/preview-org/workload/capacity`);
    await page.locator('.util-row', { hasText: 'Meera Iyer' }).waitFor();
    if (width === 390) await fitsPhone(page, 'Capacity', assert);
    await shot(page, `capacity-${tag}.png`);
    // Reports: pick a kind, the files below.
    await page.goto(`${origin}/preview-org/reports`);
    await page.getByRole('button', { name: /Download/ }).first().waitFor();
    await page.getByRole('button', { name: /Team workload/ }).first().click();
    await page.getByRole('heading', { name: 'Team workload' }).waitFor();
    if (width === 390) await fitsPhone(page, 'Reports', assert);
    await shot(page, `reports-${tag}.png`);
    // A project's issues and files.
    await page.goto(`${origin}/preview-org/projects/${pid}?tab=issues`);
    await page.getByText('Refund webhook retries twice').first().waitFor();
    if (width === 390) await fitsPhone(page, 'Issues', assert);
    await shot(page, `issues-${tag}.png`);
    await page.goto(`${origin}/preview-org/projects/${pid}?tab=files`);
    await page.getByText('settlement-spec-v3.pdf').first().waitFor();
    if (width === 390) await fitsPhone(page, 'Files', assert);
    await shot(page, `files-${tag}.png`);
    await ctx.close();

    // My work (a workspace without projects keeps its own page).
    ctx = await make(theme, noProjects);
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${origin}/preview-org/my-work`);
    await page.getByText('Reconcile yesterday’s failed payouts').waitFor();
    if (width === 390) await fitsPhone(page, 'My work', assert);
    await shot(page, `my-work-${tag}.png`);
    await ctx.close();
    checks.push(tag);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors }));
} finally { await browser.close(); }
