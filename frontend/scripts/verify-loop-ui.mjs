import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// The owner's loop audit: Today's "Team & portfolio signals" (separate from Needs you, owner + one action, never a bare "Nothing needs you"
// while signals exist, numbers that open filtered lists, glossary definitions), the timesheet review before "Submit week" (target explained,
// fixes, warnings acknowledged), Quality ↔ API docs (an endpoint's Tests, Groot's proposed cases confirmed one by one, coverage on projects and
// named gaps on Library collections) and the Calendar's empty week. Light and dark at 1440, and a 390 phone. Built frontend, synthetic fixtures.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/loop-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 6 };
const pid = '00000000-0000-0000-0000-000000000003';
const g = (n) => `90000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const monday = (() => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();
const wday = (n) => { const d = new Date(`${monday}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();

// ---- Today: signals (the server decides scope; the fixture is what a manager who owns one project sees)
const signals = { total: 7, generatedAt: ago(0), groups: [
  { kind: 'risk', label: 'projects at risk', count: 2, href: '/work/projects?status=AtRisk', items: [
    { id: `risk:${g(41)}`, kind: 'risk', title: 'HRB · Harbor Rollout', reason: 'Set at risk by hand: Vendor slipped the gateway drop', owner: { id: g(11), name: 'Kiran Vale' }, href: `/work/projects/${g(41)}`, tone: 'orange',
      action: { verb: 'ask', label: 'Ask Kiran for a date', href: `/work/projects/${g(41)}`, userId: g(11), message: 'HRB Harbor Rollout shows as at risk. When do you expect it to land?' } },
    { id: `risk:${pid}`, kind: 'risk', title: 'LDG · Ledger Sync', reason: 'Past its due date (20 Oct 2026) with 62% done', owner: { id: user.id, name: user.displayName }, href: `/work/projects/${pid}`, tone: 'red',
      action: { verb: 'open', label: 'Open project', href: `/work/projects/${pid}` } }] },
  { kind: 'team', label: 'team items overdue', count: 3, href: '/work?tab=team&overdue=1', items: [
    { id: `team:${g(12)}`, kind: 'team', title: 'Devan Rao', reason: '3 overdue of 7 open · oldest HRB-12 due 21 Oct', owner: { id: g(12), name: 'Devan Rao' }, href: `/work?tab=team&person=${g(12)}`, tone: 'red',
      action: { verb: 'ask', label: 'Ask Devan for a date', href: `/work?tab=team&person=${g(12)}`, userId: g(12), message: 'HRB-12 was due 21 Oct.' } }] },
  { kind: 'docs', label: 'doc needs review', count: 1, href: '/library', items: [
    { id: `docs:${g(20)}`, kind: 'docs', title: 'DOC-14 · Gateway runbook', reason: 'HRB-12 “Wire the gateway” changed after this page was last edited.', owner: { id: user.id, name: user.displayName }, href: `/documents/${g(20)}`, tone: 'orange',
      action: { verb: 'review', label: 'Review', href: `/documents/${g(20)}` } }] },
  { kind: 'sla', label: 'Desk SLA breached', count: 1, href: '/work?tab=tickets&sla=breached', items: [
    { id: `sla:${g(21)}`, kind: 'sla', title: 'WT-31 · Payments down for a branch', reason: 'Critical · resolution target missed by 5h', owner: null, href: `/work?item=${g(21)}`, tone: 'red',
      action: { verb: 'assign', label: 'Assign', href: `/work?item=${g(21)}` } }] },
] };
const dashboard = { counts: { myDueToday: 0, myCompletedToday: 0, myOpen: 4, myOverdue: 0, activeProjects: 3, completedProjects: 0, totalProjects: 3, openTasks: 20, overdueTasks: 3, members: 6, overallProgress: 40, myLoggedMinutesThisWeek: 600 }, myTasks: [], projects: [], activity: [], myWork: [] };
const project = (i, id, name, health) => ({ id, key: name.slice(0, 3).toUpperCase(), name, description: null, status: 'Active', priority: 'Medium', owner: { id: user.id, name: user.displayName }, teamId: null, teamName: null, startDate: wday(-30), dueDate: wday(30), progress: 40, health, stats: { total: 10, done: 4, inProgress: 3, cancelled: 0, todo: 3, overdue: 1 }, memberCount: 3, version: 1, position: i, enforceDependencies: false, projectGroupId: null, projectGroupName: null, projectType: 'NewProject', deliveryMethod: 'Hybrid', updatedAt: ago(i), stageCount: 0, pendingSignOffs: 0 });
const projects = [project(1, pid, 'Ledger Sync', 'Delayed'), project(2, g(41), 'Harbor Rollout', 'AtRisk'), project(3, g(42), 'Payments Core', 'OnTrack')];

// ---- Time: one long-named row, the review with warnings and a fix
const days = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ date: wday(i), minutes: i === 0 ? 600 : 0, targetMinutes: i < 5 ? 480 : 0, weekend: i >= 5, leave: false, leaveNote: null, future: wday(i) > today, meetings: 0, meetingMinutes: 0 }));
const longTitle = 'Reconcile the branch ledger against the core banking settlement file and explain every mismatch to finance';
const grid = { weekStart: monday, weekEnd: wday(6), user: { id: user.id, name: user.displayName }, mine: true, editable: true, locked: false, status: 'NotSubmitted', days,
  rows: [{ kind: 'task', targetId: g(50), key: 'LDG-7', title: longTitle, projectId: pid, projectName: 'Ledger Sync', billable: false, totalMinutes: 600, cells: days.map((d) => ({ date: d.date, minutes: d.date === monday ? 600 : 0, entries: 1, running: false, note: null })) }],
  suggestions: [], totalMinutes: 600, billableMinutes: 0, targetMinutes: 2400, overtimeMinutes: 120, missingDays: 0, running: null };
const week = { weekStart: monday, weekEnd: wday(6), userId: user.id, status: 'NotSubmitted', totalMinutes: 600, billableMinutes: 0, note: null, submittedAt: null, reviewer: null, reviewedAt: null, reviewNote: null, locked: false, canSubmit: true, canWithdraw: false, canReview: false, id: null, entitled: true };
const target = { weeklyCapacityMinutes: 2400, isDefault: false, setBy: 'Mira Mehta', setAt: ago(400), dailyMinutes: 480, workingDays: 4, daysOff: [{ date: wday(2), kind: 'holiday', name: 'Harvest Day' }], targetMinutes: 1920,
  explanation: '32h = 40h (your weekly capacity, set by Mira Mehta in People) over 5 working days, less 1 day off (Wed Harvest Day holiday).' };
const reviewOf = (billableFixed) => {
  const issues = [
    { code: 'missing-day', severity: 'warning', message: `Nothing logged on ${wday(1)}, a working day.`, date: wday(1), entryId: null, fix: 'log', fixLabel: 'Log time', minutes: 480 },
    ...(billableFixed ? [] : [{ code: 'not-billable', severity: 'warning', message: '“Reconcile the branch ledger…” is on billable project Ledger Sync but not marked billable.', date: monday, entryId: g(70), fix: 'billable', fixLabel: 'Mark billable', minutes: 600, note: null }]),
    { code: 'note-missing', severity: 'warning', message: 'Billable time on “Reconcile the branch ledger…” has no comment; billable time needs one for the invoice.', date: monday, entryId: g(70), fix: 'note', fixLabel: 'Add comment', minutes: 600 },
  ];
  return { weekStart: monday, weekEnd: wday(6), totalMinutes: 600, target, issues, errors: 0, warnings: issues.length, canSubmit: true };
};

// ---- Library: an API endpoint with its Tests, Groot's proposals, coverage
const now = Date.now(), iso = (m) => new Date(now + m * 60000).toISOString();
const E = (id, method, p, summary, score, gaps) => ({ id, documentId: 'd1', definitionId: 'def1', definition: 'Lending API', method, path: p, summary, tag: 'Loans', deprecated: false, score, gaps, stage: 'Uat', updatedAt: iso(-30) });
const eps = [E('e1', 'POST', '/loans/dispatch', 'Dispatch a loan', 90, ['No error cases']), E('e2', 'GET', '/loans/{id}', 'Get a loan', 55, ['No description', 'No success response example'])];
const catalog = { projects: [{ id: pid, key: 'LDG', name: 'Ledger Sync', endpoints: eps, definitions: [{ id: 'def1', documentId: 'd1', name: 'Lending API', version: 'v1', stage: 'Uat', auth: 'Bearer', servers: ['https://lending-uat.example.test'] }],
  documents: [{ id: 'd1', key: 'DOC-1', title: 'Lending API', typeCode: 'API', typeName: 'API documentation', typeColor: '#35c491', status: 'Published', classification: 'Internal', updatedAt: iso(-60), isApi: true },
    { id: 'd2', key: 'DOC-2', title: 'Ledger requirements', typeCode: 'BRD', typeName: 'Business requirements', typeColor: '#5c7cfa', status: 'Published', classification: 'Internal', updatedAt: iso(-90), isApi: false }], diagrams: 0 }],
  canCreate: true, isAdmin: true, truncated: 0 };
const def = { id: 'def1', name: 'Lending API', description: null, basePath: '/v1', version: 'v1', auth: 'Bearer', authNote: null, servers: ['https://lending-uat.example.test'], endpoints: 2, sortOrder: 0, stage: 'Uat' };
const item = (e) => ({ id: e.id, definitionId: 'def1', definition: 'Lending API', method: e.method, path: e.path, summary: e.summary, tag: e.tag, deprecated: false, owner: { id: user.id, name: user.displayName } });
const endpoint = { item: item(eps[0]), readOnly: false, maskedCount: 0, revealed: false, revealSeconds: 0, canReveal: false,
  details: { description: 'Creates a loan dispatch.', auth: 'inherit', parameters: [{ name: 'branch', in: 'query', required: true, type: 'string', description: 'Branch code', example: 'HYD01', schema: null }],
    requestBody: { contentType: 'application/json', required: true, description: null, schema: null, example: '{"pan":"ABCDE1234F","amount":500}' }, responses: [{ status: '201', description: 'Created', contentType: 'application/json', schema: null, example: '{"id":"ld_1"}' }], errors: [], samples: [], dependencies: [{ name: 'Core banking', note: null }] } };
const caseOf = { id: g(80), key: 'TC-118', title: 'POST /loans/dispatch returns 201 for a valid request', steps: 'Send it', expected: '201', priority: 'High', tags: 'API', projectId: pid, projectName: 'Ledger Sync', createdAt: ago(48), updatedAt: null, links: [{ kind: 'endpoint', id: 'e1', documentId: 'd1' }] };
const draft = (kind, title, expected, priority, why) => ({ kind, title, steps: `Send ${title}`, expected, priority, tags: 'API, POST', why });
const proposals = [draft('required', 'POST /loans/dispatch rejects a missing required field (branch) with 400', '400 · error names the missing field', 'High', 'branch, pan, amount are required.'),
  draft('auth', 'POST /loans/dispatch refuses a missing or expired token with 401', '401 · no data in the body', 'Critical', 'The API requires authentication.'),
  draft('idempotency', 'POST /loans/dispatch is safe to retry (same idempotency key twice)', 'Same response twice · one record created', 'High', 'Clients retry writes after a timeout.')];
const tests = { endpointId: 'e1', documentId: 'd1', method: 'POST', path: '/loans/dispatch', projectId: pid, covered: true, lastPassAt: ago(26), days: 30, canEdit: true,
  draft: draft('happy', 'POST /loans/dispatch returns 201 for a valid request', '201 · response matches the documented schema', 'High', 'The documented success response.'),
  cases: [{ case: caseOf, latest: [{ environment: 'SIT', status: 'Pass', at: ago(26), runId: g(81), runName: 'SIT 2.1', passed: 0, failed: 0, blocked: 0 }, { environment: 'UAT', status: 'Fail', at: ago(3), runId: g(82), runName: 'UAT 2.1', passed: 0, failed: 0, blocked: 0 }] }],
  environments: [{ environment: 'SIT', status: 'Pass', at: ago(26), runId: g(81), runName: 'SIT 2.1', passed: 1, failed: 0, blocked: 0 }, { environment: 'UAT', status: 'Fail', at: ago(3), runId: g(82), runName: 'UAT 2.1', passed: 0, failed: 1, blocked: 0 }] };
const coverage = { days: 30, projects: [{ projectId: pid, endpoints: 2, covered: 1, linked: 1, untested: 1, percent: 50, untestedIds: ['e2'] }] };

const errors = [], checks = [];
const allowed = [/^POST \/api\/v1\/chat\/conversations\/direct$/, new RegExp(`^PUT /api/v1/time/${g(70)}$`), /^POST \/api\/v1\/time\/week\/submit$/, /^POST \/api\/v1\/quality\/cases$/];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const make = async (theme, writes) => {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
  await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); }, theme);
  let billableFixed = false;
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
    if (method !== 'GET' && !ep.endsWith('/auth/refresh') && !ep.endsWith('/views')) {
      const line = `${method} ${ep}`;
      assert.ok(allowed.some((r) => r.test(line)), `Unexpected write: ${line}`);
      const body = req.postDataJSON?.() ?? null;
      writes.push({ line, body });
      if (ep === '/api/v1/chat/conversations/direct') data = { id: g(90), type: 'Direct', name: 'Kiran Vale', members: [] };
      else if (ep === `/api/v1/time/${g(70)}`) { billableFixed = billableFixed || body?.billable === true; data = { id: g(70) }; }
      else if (ep === '/api/v1/time/week/submit') data = { ...week, status: 'Submitted', canSubmit: false, locked: true };
      else if (ep === '/api/v1/quality/cases') data = { ...caseOf, id: g(83), key: 'TC-119', title: body.title };
      await route.fulfill({ status: ep === '/api/v1/quality/cases' ? 201 : 200, contentType: 'application/json', body: JSON.stringify({ data }) });
      return;
    }
    if (ep.endsWith('/auth/refresh')) data = { accessToken: `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`, expiresAt: '2099-01-01T00:00:00Z', user };
    else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, reportCount: 2, permissions: ['projects.view', 'projects.edit', 'tasks.view', 'tasks.edit', 'org.manage', 'work.view', 'work.create', 'reports.view', 'reports.broad', 'docs.create', 'docs.edit'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 3, activity: 3, documents: 3, people: 3, reports: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: {} } };
    else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
    else if (ep === '/api/v1/timer') data = null;
    else if (ep === '/api/v1/today/signals') data = signals;
    else if (ep === '/api/v1/inbox') data = { rows: [], counts: { all: 0, assigned: 0, decisions: 0, mentions: 0 }, later: 0 };
    else if (ep === '/api/v1/inbox/briefing') data = { count: 0, headline: "You're all caught up.", reasons: [], sources: 'read your work', stats: { overdue: 0, dueToday: 0, decisions: 0, approvals: 0, mentions: 0, reminders: 0 } };
    else if (ep === '/api/v1/timeline') data = { from: url.searchParams.get('from'), to: url.searchParams.get('to'), timeZone: 'Asia/Kolkata', scope: 'me', generatedAt: ago(0), events: [] };
    else if (ep === '/api/v1/meet') data = { items: [], from: '', to: '', truncated: false };
    else if (ep === '/api/v1/dashboard') data = dashboard;
    else if (ep === '/api/v1/projects') data = { items: projects, page: 1, pageSize: 100, totalItems: projects.length, totalPages: 1 };
    else if (ep === '/api/v1/workload') data = { scope: 'Everyone', available: ['Everyone'], members: [], totals: { people: 6, open: 12, overdue: 3 } };
    else if (ep === '/api/v1/time/grid') data = grid;
    else if (ep === '/api/v1/time/grid/draft') data = { weekStart: monday, days: [], cells: [] };
    else if (ep === '/api/v1/time/week') data = week;
    else if (ep === '/api/v1/time/review') data = reviewOf(billableFixed);
    else if (ep === '/api/v1/doctracker/catalog') data = catalog;
    else if (ep === '/api/v1/documents/d1/api') data = { definitions: [def], endpoints: 2, live: true, reading: 'Working copy', versionId: null, canEdit: true, limit: -1, used: 2 };
    else if (ep === '/api/v1/documents/d1/api/endpoints/e1') data = endpoint;
    else if (ep === '/api/v1/quality/endpoints/e1/tests') data = tests;
    else if (ep === '/api/v1/quality/endpoints/e1/suggestions') data = proposals;
    else if (ep === '/api/v1/quality/coverage') data = coverage;
    else if (ep === '/api/v1/documents/d1/links') data = { items: [], total: 0, done: 0, overdue: 0, open: 0, restricted: 0 };
    else if (ep === '/api/v1/documents/inbox') data = { toReview: [], submitted: [], accessToDecide: [], myAccessRequests: [], waiting: 0 };
    else if (ep === '/api/v1/documents/dashboard') data = { total: 2, byStatus: [], byType: [], mine: 2, waitingForMe: 0, updatedThisWeek: 1, notUpdatedIn90Days: 0, unpublished: 0, recent: [], projectsMissingRequired: 0, requiredTypes: 0 };
    else if (ep === '/api/v1/documents') data = { items: [], total: 0 };
    else if (ep === '/api/v1/workspace/members') data = [{ userId: user.id, displayName: user.displayName, role: 'Owner' }];
    else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
    else if (ep.endsWith('/ai/status')) data = { enabled: true, configured: true, entitled: true, allowedHere: true };
    else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
    else if (ep === '/api/v1/chat/projects/unread') data = [];
    else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  return ctx;
};
const shot = async (page, name) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(700); await page.screenshot({ path: path.join(out, name), fullPage: true, animations: 'disabled' }); };
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => { if (e.type() === 'error' && !e.text().startsWith('Failed to load resource')) errors.push(e.text()); });
};

let current = null;
try {
  for (const [theme, width] of [['light', 1440], ['dark', 1440], ['light', 390]]) {
    const tag = `${width}${theme === 'dark' ? '-dark' : ''}`;
    const phone = width === 390;
    const writes = [];
    const ctx = await make(theme, writes);
    const page = await ctx.newPage();
    current = page;
    watch(page);
    await page.setViewportSize({ width, height: phone ? 844 : 1000 });

    // ---- Today: Needs you is personal only; the signals are their own section; never a bare "Nothing needs you".
    await page.goto(`${origin}/preview-org/`);
    const sig = page.getByTestId('signals');
    await sig.waitFor();
    await sig.getByRole('heading', { name: 'Team & portfolio signals' }).waitFor();
    assert.equal(await sig.getByTestId('signal-card').count(), 5);
    const empty = page.getByTestId('needs-you-empty');
    assert.match(await empty.innerText(), /Nothing needs you.*2 projects at risk · 3 team items overdue · 1 doc needs review · 1 Desk SLA breached.* below/);
    // Every card: owner (when there is one) and exactly one action.
    for (const c of await sig.getByTestId('signal-card').all()) assert.equal(await c.locator('button').count(), 1, 'one action per card');
    await sig.getByText('Set at risk by hand: Vendor slipped the gateway drop').waitFor();
    await sig.getByRole('button', { name: 'Assign' }).waitFor();
    await sig.getByRole('button', { name: 'Review' }).waitFor();
    assert.equal(await sig.getByTestId('signal-count-risk').getAttribute('href'), '/preview-org/work/projects?status=AtRisk');
    // The glossary on hover: "at risk" carries the one definition.
    const def = await sig.locator('[data-term="at risk"]').first().getAttribute('data-tip');
    assert.match(def, /more than 15 points behind/);
    if (!phone) {
      // Headline numbers open filtered views.
      assert.equal(await page.getByTestId('number-risk').getAttribute('href'), '/preview-org/work/projects?status=AtRisk');
      assert.equal(await page.getByTestId('number-overdue').getAttribute('href'), '/preview-org/work?overdue=1');
      assert.equal(await page.getByTestId('number-team').getAttribute('href'), '/preview-org/work?tab=team');
      await page.getByTestId('number-overdue').locator('.term').hover();
      assert.equal(await page.getByTestId('number-overdue').locator('.term').evaluate((e) => getComputedStyle(e, '::after').display), 'block', 'the definition shows on hover');
    } else await fitsPhone(page, 'Today with signals', assert);
    await shot(page, `today-${tag}.png`);
    // "Ask Kiran for a date" opens the chat with Kiran.
    await sig.getByRole('button', { name: 'Ask Kiran for a date' }).click();
    await page.waitForURL(new RegExp(`/messages/${g(90)}$`));
    assert.ok(writes.some((w) => w.line === 'POST /api/v1/chat/conversations/direct' && w.body.userId === g(11)));

    // ---- Calendar: an empty week offers Plan focus, Schedule meeting, Open riskiest project.
    await page.goto(`${origin}/preview-org/?tab=calendar`);
    const ce = page.getByTestId('calendar-empty');
    await ce.waitFor();
    assert.match(await ce.innerText(), new RegExp(`No meetings this ${phone ? 'day' : 'week'}`));
    await ce.getByRole('button', { name: 'Schedule meeting' }).waitFor();
    await ce.getByTestId('plan-focus').click();
    await page.locator('.toast, [role="status"]').filter({ hasText: /focus|open work/i }).first().waitFor();
    if (phone) await fitsPhone(page, 'Calendar empty', assert);
    await shot(page, `calendar-empty-${tag}.png`);
    await ce.getByRole('button', { name: 'Open riskiest project' }).click();
    await page.waitForURL(new RegExp(`/work/projects/${g(41)}$`));

    // ---- Time: the target explained; long names compact with the full name on hover; Submit week opens the review.
    await page.goto(`${origin}/preview-org/insights?tab=time`);
    await page.getByRole('heading', { level: 1, name: 'Time' }).waitFor();
    const rowHead = page.locator('.ins-table tbody th').first();
    assert.match(await rowHead.getAttribute('title'), /Reconcile the branch ledger .* finance · Ledger Sync$/);
    const titleBox = await rowHead.locator('.ins-title').boundingBox();
    assert.ok(titleBox.height < 44, 'a long name is clamped to two lines');
    await page.getByTestId('target-explain').click();
    await page.getByText(/set by Mira Mehta in People/).first().waitFor();
    await page.getByRole('link', { name: 'Capacity in People ›' }).waitFor();
    await page.getByTestId('target-explain').click();
    await page.getByTestId('submit-week').click();
    const drawer = page.getByTestId('review-drawer');
    await drawer.waitFor();
    assert.match(await drawer.innerText(), /32h = 40h/);
    for (const code of ['missing-day', 'not-billable', 'note-missing']) await drawer.getByTestId(`issue-${code}`).waitFor();
    assert.equal(await page.getByTestId('review-submit').isDisabled(), true, 'warnings need an acknowledgement');
    await drawer.getByRole('button', { name: 'Mark billable' }).click();
    await page.getByText('Marked billable.', { exact: true }).waitFor();
    await drawer.getByTestId('issue-not-billable').waitFor({ state: 'detached' });
    assert.ok(writes.some((w) => w.line === `PUT /api/v1/time/${g(70)}` && w.body.billable === true && w.body.workDate === monday && w.body.minutes === 600));
    if (phone) await fitsPhone(page, 'Review sheet', assert);
    await shot(page, `time-review-${tag}.png`);
    await page.getByTestId('review-ack').check();
    await page.getByTestId('review-submit').click();
    await page.getByText('Week submitted for approval.').waitFor();

    // ---- Library: the endpoint's Tests, latest run per environment, Groot's proposals confirmed one by one.
    await page.goto(`${origin}/preview-org/library/p/${pid}/api/e1`);
    const et = page.getByTestId('endpoint-tests');
    await et.waitFor();
    assert.match(await page.getByTestId('endpoint-coverage').innerText(), /Covered/);
    assert.match(await et.locator('.et-env.s-uat, .et-env.s-fail').first().innerText(), /UAT\s*Fail/);
    await et.getByText('TC-118').waitFor();
    await et.getByTestId('generate-test-cases').click();
    await et.getByTestId('proposal').first().waitFor();
    assert.equal(await et.getByTestId('proposal').count(), 3);
    await et.getByTestId('proposal').first().getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByText('Test case added and linked to this endpoint.').waitFor();
    const made = writes.find((w) => w.line === 'POST /api/v1/quality/cases');
    assert.deepEqual(made.body.links, [{ kind: 'endpoint', id: 'e1', documentId: 'd1' }]);
    assert.match(made.body.title, /400/);
    await et.getByTestId('proposal').nth(2).waitFor({ state: 'detached' });
    assert.equal(await et.getByTestId('proposal').count(), 2, 'the confirmed proposal leaves the list');
    // "Add test case" opens prefilled from the endpoint.
    await et.getByTestId('add-test-case').click();
    assert.match(await page.getByLabel('Expected').inputValue(), /^201/);
    await page.keyboard.press('Escape');
    await et.scrollIntoViewIfNeeded();
    if (phone) await fitsPhone(page, 'Endpoint tests', assert);
    await shot(page, `endpoint-tests-${tag}.png`);

    // ---- Library hub: named gaps instead of a bare percentage, each a link to fix.
    await page.goto(`${origin}/preview-org/library`);
    const miss = page.getByTestId('collection-missing').first();
    await miss.waitFor();
    await miss.getByRole('link', { name: '1 endpoint without tests' }).waitFor();
    assert.match(await miss.innerText(), /^Missing: test plan, runbook, architecture diagram; 1 endpoint needs docs, 1 endpoint without tests$/);
    assert.match(await miss.getByRole('link', { name: '1 endpoint without tests' }).getAttribute('href'), /\/api\/e2$/);
    if (phone) await fitsPhone(page, 'Library hub', assert);
    await shot(page, `library-${tag}.png`);

    // ---- Projects: test coverage on the passes and in the list.
    await page.goto(`${origin}/preview-org/work/projects`);
    const cov = page.getByTestId('pass-coverage').first();
    await cov.waitFor();
    assert.equal(await cov.innerText(), 'Tests 50%');
    assert.match(await cov.getAttribute('title'), /1 of 2 endpoints passed a test in the last 30 days · 1 without any test case/);
    if (phone) await fitsPhone(page, 'Projects', assert);

    assert.deepEqual(errors, [], `console errors: ${errors.join('\n')}`);
    await ctx.close();
    checks.push(tag);
  }
  console.log(`loop UI verified: ${checks.join(', ')} → ${out}`);
} catch (e) {
  if (current) await current.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
  console.error('errors so far:', errors);
  throw e;
} finally {
  await browser.close();
}
