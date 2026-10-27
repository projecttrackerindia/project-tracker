import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// v2 Home: "For you" (briefing, one inbox with filters, one action + Later per row, tomorrow, four numbers) and "Calendar" (a week, Me/Team,
// three colours, the ✦ card, Subscribe as a link), light and dark at 1440 and on a 390 phone. Only the built frontend and synthetic API
// fixtures are used; the only writes allowed are the inbox's own (Later, and the row's action).
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/v2-home-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 4 };
const pid = '00000000-0000-0000-0000-000000000003';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const day = (n) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const monday = (() => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();
const wday = (n) => { const d = new Date(`${monday}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const at = (date, hh, mm) => new Date(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`).toISOString();
const g = (n) => `90000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`;

const rows = [
  { id: `work:${g(1).replace(/-/g, '')}`, kind: 'ticket', group: 'assigned', title: 'OPS-5 Payout server disconnected', sub: 'Critical · due today', action: { label: 'Open', verb: 'open', endpoint: null }, href: `/work?item=${g(1)}`, at: ago(1), urgent: true },
  { id: `finding:${g(2).replace(/-/g, '')}`, kind: 'decision', group: 'decisions', title: 'Move PAY due date 2 Nov → 19 Dec?', sub: 'Project agent · Payments Core', action: { label: 'Accept', verb: 'accept', endpoint: `/api/v1/agent/findings/${g(2)}/approve` }, href: `/work/projects/${pid}`, at: ago(2), urgent: false },
  { id: `work:${g(3).replace(/-/g, '')}`, kind: 'task', group: 'assigned', title: 'PAY-1 Bulk payments timeout', sub: 'High · PAY · overdue since 13 Oct', action: { label: 'Open', verb: 'open', endpoint: null }, href: `/work?item=${g(3)}`, at: ago(3), urgent: true },
  { id: `mention:${g(4).replace(/-/g, '')}`, kind: 'mention', group: 'mentions', title: 'Ravi mentioned you in Payments Core', sub: '@Asha can you send it as a mail?', action: { label: 'Reply', verb: 'open', endpoint: null }, href: '/talk', at: ago(4), urgent: false },
  { id: `timesheet:${g(5).replace(/-/g, '')}`, kind: 'approval', group: 'decisions', title: 'Ravi Kumar · timesheet 19 Oct', sub: '38h logged', action: { label: 'Approve', verb: 'approve', endpoint: `/api/v1/time/approvals/${g(5)}/approve` }, href: '/insights?tab=time', at: ago(20), urgent: false },
  { id: `reminder:${g(6).replace(/-/g, '')}`, kind: 'reminder', group: 'assigned', title: 'Submit timesheet', sub: 'every Friday', action: { label: 'Done', verb: 'done', endpoint: `/api/v1/reminders/${g(6)}/done` }, href: null, at: ago(30), urgent: false },
];
const counts = { all: 6, assigned: 3, decisions: 2, mentions: 1 };
const briefing = { count: 6, headline: '6 things need you.', reasons: ['OPS-5 Payout server disconnected — Critical · due today.', 'PAY-1 Bulk payments timeout — overdue since 13 Oct.', '1 proposal waits for your decision.'], sources: `read your work, project agent, approvals, mentions and reminders · ${today}`, stats: { overdue: 1, dueToday: 1, decisions: 1, approvals: 1, mentions: 1, reminders: 1 } };
const calendar = [
  { type: 'work', id: g(1), title: 'OPS-5', date: today, status: 'Open', category: 'Todo', overdue: false, projectId: null, projectName: null, priority: 'Critical', startsAt: null },
  ...[0, 1, 2, 3, 4].map((i) => ({ type: 'meeting', id: g(20 + i), title: 'Status call', date: wday(i), status: null, category: null, overdue: false, projectId: null, projectName: null, priority: null, startsAt: at(wday(i), 10, 30) })),
  { type: 'stage', id: g(30), title: 'UAT', date: wday(2), status: 'InProgress', category: null, overdue: false, projectId: pid, projectName: 'Payments Core', priority: null, startsAt: null },
  { type: 'task', id: g(31), title: 'Timesheet', date: wday(4), status: 'To do', category: 'Todo', overdue: false, projectId: pid, projectName: 'Payments Core', priority: 'Medium', startsAt: null },
  { type: 'meeting', id: g(32), title: 'Daily status call', date: day(1), status: null, category: null, overdue: false, projectId: null, projectName: null, priority: null, startsAt: at(day(1), 10, 30) },
  { type: 'project', id: pid, title: 'Payments Core', date: day(1), status: 'Active', category: null, overdue: false, projectId: pid, projectName: 'Payments Core', priority: null, startsAt: null },
];
const project = (i, health) => ({ id: g(40 + i), key: `P${i}`, name: `Project ${i}`, description: null, status: 'Active', priority: 'Medium', owner: null, teamId: null, teamName: null, startDate: day(-30), dueDate: day(30), progress: 40, health, stats: { total: 10, done: 4, inProgress: 3, cancelled: 0, todo: 3, overdue: 1 }, memberCount: 3, version: 1, position: i, enforceDependencies: false, projectGroupId: null, projectGroupName: null, projectType: 'NewProject', deliveryMethod: 'Hybrid' });
const projects = [project(1, 'Delayed'), project(2, 'Delayed'), project(3, 'OnTrack'), project(4, 'AtRisk')];
const dashboard = { counts: { myDueToday: 1, myCompletedToday: 0, myOpen: 7, myOverdue: 2, activeProjects: 4, completedProjects: 0, totalProjects: 4, openTasks: 20, overdueTasks: 3, members: 4, overallProgress: 40, myLoggedMinutesThisWeek: 0 }, myTasks: [], projects: [], activity: [], myWork: [] };
const workload = { scope: 'Everyone', available: ['Everyone'], members: [], totals: { people: 4, open: 10, overdue: 2 } };

const errors = [], checks = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const make = async (theme, writes, opts = {}) => {
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
    if (method !== 'GET' && !ep.endsWith('/auth/refresh')) {
      assert.ok(/^\/api\/v1\/inbox\/[^/]+\/later$/.test(ep) || ep === `/api/v1/agent/findings/${g(2)}/approve` || ep === `/api/v1/time/approvals/${g(5)}/approve` || ep === `/api/v1/reminders/${g(6)}/done`, `Unexpected write: ${method} ${ep}`);
      writes.push(`${method} ${ep}`);
      await route.fulfill({ status: ep.endsWith('/later') ? 204 : 200, contentType: 'application/json', body: ep.endsWith('/later') ? '' : JSON.stringify({ data: {} }) });
      return;
    }
    let data = [];
    if (ep.endsWith('/auth/refresh')) data = { accessToken: `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`, expiresAt: '2099-01-01T00:00:00Z', user };
    else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['projects.view', 'projects.edit', 'tasks.view', 'tasks.edit', 'org.manage', 'work.view', 'work.create', 'reports.view', 'reports.broad'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 0, activity: 3, documents: 3, people: 3, reports: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: {} } };
    else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: true };
    else if (ep === '/api/v1/timer') data = null;
    else if (ep === '/api/v1/inbox') {
      const f = url.searchParams.get('filter') ?? 'all';
      const list = opts.empty ? [] : f === 'all' ? rows : rows.filter((r) => r.group === f);
      data = { rows: list, counts: opts.empty ? { all: 0, assigned: 0, decisions: 0, mentions: 0 } : counts, later: 0 };
    }
    else if (ep === '/api/v1/inbox/briefing') data = opts.empty ? { count: 0, headline: "You're all caught up.", reasons: [], sources: 'read your work', stats: { overdue: 0, dueToday: 0, decisions: 0, approvals: 0, mentions: 0, reminders: 0 } } : briefing;
    else if (ep === '/api/v1/calendar') { const from = url.searchParams.get('from'), to = url.searchParams.get('to'); data = calendar.filter((e) => e.date >= from && e.date <= to && (url.searchParams.get('mine') === 'true' ? e.type !== 'project' : true)); }
    else if (ep === '/api/v1/calendar/feed') data = { enabled: true, url: 'https://projecttracker-preview.test/api/v1/calendar/feed/abc.ics', createdAt: ago(100), lastUsedAt: null };
    else if (ep === '/api/v1/dashboard') data = dashboard;
    else if (ep === '/api/v1/projects') data = { items: projects, page: 1, pageSize: 100, totalItems: projects.length, totalPages: 1 };
    else if (ep === '/api/v1/workload') data = workload;
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
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => { if (e.type() === 'error' && !e.text().startsWith('Failed to load resource')) errors.push(e.text()); });
};

try {
  for (const [theme, width] of [['light', 1440], ['dark', 1440], ['light', 390]]) {
    const tag = `${width}${theme === 'dark' ? '-dark' : ''}`;
    const writes = [];
    let ctx = await make(theme, writes);
    let page = await ctx.newPage();
    watch(page);
    await page.setViewportSize({ width, height: 1000 });

    // For you: eyebrow, greeting, the dark briefing.
    await page.goto(`${origin}/preview-org/`);
    await page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), Asha\.$/ }).waitFor();
    await page.getByText('briefing ready').waitFor();
    const brief = page.getByRole('region', { name: 'Briefing' });
    await brief.getByText('6 things need you.').waitFor();
    assert.match(await brief.innerText(), /OPS-5 Payout server disconnected/);
    assert.equal(await page.getByRole('tab', { name: 'For you' }).getAttribute('aria-selected'), 'true');

    // The inbox: each row one primary action and Later. With 10 rows or fewer there is nothing to sort, so no filter chips (v2 rule).
    const inbox = page.getByRole('region', { name: 'Inbox' });
    await inbox.locator('.hm-row').first().waitFor();
    assert.equal(await inbox.getByRole('button', { name: /^Decisions\s?2$/ }).count(), 0, 'no filter chips at 6 rows');
    const items = inbox.locator('.hm-row');
    assert.equal(await items.count(), 6);
    for (let i = 0; i < 6; i++) {
      assert.equal(await items.nth(i).locator('.btn-primary').count(), 1, 'one primary action per row');
      assert.equal(await items.nth(i).getByRole('button', { name: 'Later' }).count(), 1);
    }
    for (const label of ['Ticket', 'Decision', 'Task', 'Mention', 'Approval', 'Reminder']) await inbox.locator('.hm-tag', { hasText: label }).first().waitFor();
    // Tomorrow and the four numbers.
    const side = page.getByRole('complementary', { name: 'Tomorrow and your numbers' });
    await side.getByText('Daily status call').waitFor();
    for (const label of ['Delayed projects', 'Overdue items', 'Logged this week', 'Team open items']) await side.getByText(label).waitFor();
    assert.equal((await side.locator('.ds-kpi', { hasText: 'Delayed projects' }).locator('.v').innerText()).trim(), '2');
    assert.equal((await side.locator('.ds-kpi', { hasText: 'Team open items' }).locator('.v').innerText()).trim(), '10');
    if (width === 390) await fitsPhone(page, 'Home', assert);
    await shot(page, `home-${tag}.png`);

    // The row's own action runs in place (approve a timesheet), and Later moves a row to tomorrow.
    await inbox.locator('.hm-row', { hasText: 'Ravi Kumar · timesheet' }).getByRole('button', { name: 'Approve' }).click();
    await page.locator('.hm-row.done', { hasText: 'Ravi Kumar · timesheet' }).waitFor();
    await inbox.locator('.hm-row', { hasText: 'Move PAY due date' }).getByRole('button', { name: 'Later' }).click();
    await page.getByText('Moved to tomorrow morning.').waitFor();
    assert.deepEqual(writes.sort(), [`POST /api/v1/inbox/${encodeURIComponent(rows[1].id)}/later`, `POST /api/v1/time/approvals/${g(5)}/approve`].sort());

    // Calendar: a week with Me / Team, three colours only, the ✦ card and Subscribe as a link.
    await page.getByRole('tab', { name: 'Calendar' }).click();
    await page.getByRole('heading', { level: 1, name: 'Calendar' }).waitFor();
    assert.match(page.url(), /tab=calendar/);
    assert.equal(await page.locator('.hm-day').count(), 7);
    await page.locator('.hm-ev.c-meeting').first().waitFor();
    await page.locator('.hm-ev.c-stage', { hasText: 'UAT' }).waitFor();
    await page.locator('.hm-ev.c-deadline').first().waitFor();
    const colours = await page.locator('.hm-ev').evaluateAll((els) => [...new Set(els.map((e) => [...e.classList].find((c) => c.startsWith('c-'))))]);
    assert.ok(colours.every((c) => ['c-meeting', 'c-deadline', 'c-stage'].includes(c)), `three colours only: ${colours}`);
    const ai = page.getByRole('region', { name: 'This week' });
    await ai.getByText('✦ This week').waitFor();
    assert.match(await ai.innerText(), /\d+ deadlines? and \d+ meetings?/);
    assert.equal(await page.getByRole('tab', { name: 'Me' }).getAttribute('aria-selected'), 'true');
    await page.getByRole('tab', { name: 'Team' }).click();
    assert.equal(await page.getByRole('tab', { name: 'Team' }).getAttribute('aria-selected'), 'true');
    await page.getByRole('button', { name: 'Subscribe in Google / Outlook ›' }).waitFor();
    if (width === 390) await fitsPhone(page, 'Calendar', assert);
    await shot(page, `calendar-${tag}.png`);
    await page.getByRole('button', { name: 'Subscribe in Google / Outlook ›' }).click();
    await page.getByRole('dialog').getByText('Subscribe in your calendar').waitFor();
    await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click();
    await ctx.close();

    // Nothing waiting: a calm empty inbox and an all-clear briefing.
    ctx = await make(theme, [], { empty: true });
    page = await ctx.newPage();
    watch(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}/preview-org/`);
    await page.getByText("You're all caught up.").waitFor();
    await page.getByText('Nothing needs you').waitFor();
    if (width === 390) await fitsPhone(page, 'Home empty', assert);
    await shot(page, `home-empty-${tag}.png`);
    await ctx.close();
    checks.push(tag);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors }));
} finally { await browser.close(); }
