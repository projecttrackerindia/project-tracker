import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Due times and SLA countdowns, on a fixed clock (10:37 in India): the ticket panel's SLA row reads "Resolve by 14:29 · 3h 52m left" and the
// critical incident banner counts DOWN to 14:29 (keeping the time open beside it); a ticket held only to its SLA shows the resolve-by as its
// due; a task due at a time shows "Today · 16:00" and offers a time picker; Needs you keeps the server's soonest-breach-first order and says
// "breaches in 3h 52m"; Your day and the Calendar mark the SLA breach (red) and the timed deadline at their hours. 1440 light and dark, and a
// 390 phone. Synthetic API only; no writes. The fixed clock freezes animations, so the checks read the DOM, never animated opacity.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/sla-due-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const g = (n) => `91000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const user = { id: g(1), displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const asha = { id: user.id, name: user.displayName }, ravi = { id: g(2), name: 'Ravi Kumar' };
const ws = { id: g(9), slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 2 };
const members = [asha, ravi].map((p, i) => ({ userId: p.id, displayName: p.name, email: `${p.name.split(' ')[0].toLowerCase()}@example.test`, role: i ? 'Member' : 'Owner', joinedAt: '2026-01-01T00:00:00Z', jobRole: null }));
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const monday = (() => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();
const at = (date, hh, mm) => new Date(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`).toISOString();
const NOW = at(today, 10, 37);
const pid = g(50);
const project = { id: pid, key: 'PAY', name: 'Payments Core', description: null, status: 'Active', priority: 'High', owner: asha, teamId: null, teamName: null, startDate: monday, dueDate: today,
  progress: 40, health: 'OnTrack', stats: { total: 2, done: 0, inProgress: 1, cancelled: 0, todo: 1, overdue: 0 }, memberCount: 2, version: 1, position: 0, enforceDependencies: false,
  projectGroupId: null, projectGroupName: null, projectType: 'NewProject', deliveryMethod: 'Phased', updatedAt: NOW };
const statuses = [{ id: g(61), name: 'To Do', order: 0, category: 'Todo', color: '#94a3b8' }, { id: g(62), name: 'In Progress', order: 1, category: 'Active', color: '#38bdf8' }, { id: g(63), name: 'Done', order: 2, category: 'Done', color: '#34d399' }];

// ---------------------------------------------------------------- the work: a critical ticket held to its SLA, a High ticket, a task due at 16:00
const RESOLVE_BY = at(today, 14, 29);
const sla = (dueAt, state) => ({ response: { dueAt: at(today, 8, 15), metAt: at(today, 8, 9), state: 'Met' }, resolution: { dueAt, metAt: null, state }, state });
const ticket = { kind: 'ticket', id: g(101), key: 'WT-11', title: 'Payout server disconnected', projectId: null, projectKey: null, projectName: null, status: 'In Progress', category: 'Active', priority: 'Critical',
  dueDate: null, dueTime: null, dueAt: RESOLVE_BY, dueFromSla: true, isOverdue: false, assignee: asha, typeName: 'Production Support', updatedAt: NOW, slaStartAt: at(today, 8, 0), slaDueAt: RESOLVE_BY, slaState: 'OnTrack' };
const high = { kind: 'ticket', id: g(102), key: 'WT-12', title: 'Refund webhook failing', projectId: null, projectKey: null, projectName: null, status: 'To Do', category: 'Todo', priority: 'High',
  dueDate: null, dueTime: null, dueAt: at(today, 17, 50), dueFromSla: true, isOverdue: false, assignee: asha, typeName: 'Bug Fix', updatedAt: NOW, slaStartAt: at(today, 9, 0), slaDueAt: at(today, 17, 50), slaState: 'OnTrack' };
const task = { kind: 'task', id: g(103), key: 'PAY-7', title: 'Settlement file for the bank', projectId: pid, projectKey: 'PAY', projectName: project.name, status: 'In Progress', category: 'Active', priority: 'Medium',
  dueDate: today, dueTime: '16:00:00', dueAt: at(today, 16, 0), dueFromSla: false, isOverdue: false, assignee: asha, typeName: null, updatedAt: NOW };
const items = [ticket, high, task];
const detailOf = (w) => ({ ...w, description: w.kind === 'ticket' ? 'Workers stopped at 08:00.' : null, startDate: null, reporter: ravi, version: 3, createdAt: w.slaStartAt ?? at(today, 8, 0), completedAt: null, loggedMinutes: 0,
  detail: w.kind === 'ticket' ? { id: w.id, status: w.category === 'Active' ? 'InProgress' : 'ToDo', workTypeId: g(81), workType: w.typeName, relatedProject: null, createdAt: w.slaStartAt, sla: sla(w.slaDueAt, w.slaState), can: { edit: true, delete: true } }
    : { id: w.id, projectId: pid, statusId: g(62), statusName: 'In Progress', canEdit: true, dueTime: w.dueTime },
  activity: [{ type: 'change', id: g(900), at: at(today, 8, 9), actor: ravi, summary: 'raised it' }], channel: w.kind === 'ticket' ? 'app' : null });

// Needs you, in the server's order (soonest breach first, then urgent, then the due instant, then priority).
const inboxRows = [
  { id: `work:${g(101).replace(/-/g, '')}`, kind: 'ticket', group: 'assigned', title: 'WT-11 Payout server disconnected', sub: 'Critical · resolve by 14:29', action: { label: 'Open', verb: 'open', endpoint: null }, href: `/work?item=${g(101)}`, at: NOW, urgent: true, dueAt: RESOLVE_BY, breachAt: RESOLVE_BY, priority: 'Critical' },
  { id: `work:${g(102).replace(/-/g, '')}`, kind: 'ticket', group: 'assigned', title: 'WT-12 Refund webhook failing', sub: 'High · resolve by 17:50', action: { label: 'Open', verb: 'open', endpoint: null }, href: `/work?item=${g(102)}`, at: NOW, urgent: false, dueAt: at(today, 17, 50), breachAt: at(today, 17, 50), priority: 'High' },
  { id: `work:${g(103).replace(/-/g, '')}`, kind: 'task', group: 'assigned', title: 'PAY-7 Settlement file for the bank', sub: 'PAY · due today 16:00', action: { label: 'Open', verb: 'open', endpoint: null }, href: `/work?item=${g(103)}`, at: NOW, urgent: false, dueAt: at(today, 16, 0), priority: 'Medium', dueToday: true },
  { id: `mention:${g(104).replace(/-/g, '')}`, kind: 'mention', group: 'mentions', title: 'Ravi: "is the CRIF token rotated?"', sub: 'Mention in #crif', action: { label: 'Reply', verb: 'open', endpoint: null }, href: '/talk', at: at(today, 9, 30), urgent: false },
];

// The one timeline: a meeting, the critical ticket's SLA breach at 14:29 and the task due at 16:00.
const tev = (o) => ({ end: null, allDay: false, link: null, projectId: null, projectName: null, people: [], status: null, colour: '', key: null, approximated: false, overdue: false, priority: null,
  minutes: null, note: null, joinUrl: null, notes: false, userId: user.id, mode: null, running: false, dueAt: null, slaBreachAt: null, slaState: null, ...o });
const timeline = (from, to) => ({ from, to, timeZone: 'Asia/Kolkata', scope: 'me', generatedAt: NOW, events: [
  tev({ id: `meeting:${g(201)}:${at(today, 11, 0)}`, type: 'meeting', title: 'Bank sync', start: at(today, 11, 0), end: at(today, 11, 30), date: today, sourceType: 'workspaceMeeting', sourceId: g(201), status: 'Scheduled' }),
  tev({ id: `due:work:${g(101)}`, type: 'due', title: ticket.title, key: 'WT-11', allDay: true, start: at(today, 0, 0), date: today, sourceType: 'work', sourceId: g(101), link: `/work?item=${g(101)}`, status: 'In Progress',
    priority: 'Critical', colour: 'due', dueAt: RESOLVE_BY, slaBreachAt: RESOLVE_BY, slaState: 'OnTrack' }),
  tev({ id: `due:task:${g(103)}`, type: 'due', title: task.title, key: 'PAY-7', allDay: true, start: at(today, 0, 0), date: today, sourceType: 'task', sourceId: g(103), link: `/work?item=${g(103)}`, projectId: pid,
    projectName: project.name, status: 'In Progress', priority: 'Medium', colour: 'due', dueAt: at(today, 16, 0) }),
].filter((t) => t.date >= from && t.date <= to) });

const errors = [], checks = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const make = async (theme) => {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
  await ctx.clock.setFixedTime(new Date(NOW));
  await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); }, theme);
  await ctx.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method(), sp = url.searchParams;
    if (url.origin !== origin || ep.startsWith('/hubs/')) { await route.abort(); return; }
    if (ep.endsWith('/avatar') || ep.endsWith('/logo/file') || ep.endsWith('/thumbnail')) { await route.fulfill({ status: 404, body: '' }); return; }
    if (!ep.startsWith('/api/')) {
      const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
      await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
      return;
    }
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status < 400 ? { data } : data) });
    if (method !== 'GET' && !ep.endsWith('/auth/refresh')) {
      if (ep === '/api/v1/operations/triage') return json({ workTypeId: null, workTypeName: null, priority: null, suggestedAssignee: null, similar: [] });   // read-only suggestions
      assert.fail(`Unexpected write: ${method} ${ep}`);
    }
    const m = ep.match(/^\/api\/v1\/work-items\/([0-9a-f-]{36})$/);
    let data = [];
    if (ep.endsWith('/auth/refresh')) data = { accessToken: `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`, expiresAt: '2099-01-01T00:00:00Z', user };
    else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['projects.view', 'projects.edit', 'tasks.view', 'tasks.edit', 'tasks.comment', 'org.manage', 'work.view', 'work.create', 'reports.view'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 0, activity: 3, documents: 3, people: 3, reports: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: {} } };
    else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: true };
    else if (ep === '/api/v1/workspace/members') data = members;
    else if (ep === '/api/v1/work-items') { const kinds = sp.get('kind')?.split(','); const list = items.filter((r) => !kinds || kinds.includes(r.kind)); data = { items: list, offset: 0, limit: 50, hasMore: false }; }
    else if (m) data = detailOf(items.find((w) => w.id === m[1]));
    else if (ep === '/api/v1/inbox') data = { rows: inboxRows, counts: { all: 4, assigned: 3, decisions: 0, mentions: 1 }, later: 0 };
    else if (ep === '/api/v1/inbox/briefing') data = { count: 4, headline: '4 things need you.', reasons: ['WT-11 Payout server disconnected — Critical · resolve by 14:29.'], sources: 'read your work', stats: { overdue: 0, dueToday: 1, decisions: 0, approvals: 0, mentions: 1, reminders: 0 } };
    else if (ep === '/api/v1/timeline') data = timeline(sp.get('from'), sp.get('to'));
    else if (ep === '/api/v1/calendar') data = [];
    else if (ep === '/api/v1/meet') data = { items: [], from: '', to: '', truncated: false };
    else if (ep === '/api/v1/reminders') data = { open: [], completed: [], sent: [], counts: { now: 0, today: 0, upcoming: 0, completed: 0 }, limits: { open: 100, recurring: 10, openUsed: 0, recurringUsed: 0 } };
    else if (ep === '/api/v1/calendar/feed') data = { enabled: false, url: null, createdAt: null, lastUsedAt: null };
    else if (ep === '/api/v1/dashboard') data = { counts: { myDueToday: 1, myCompletedToday: 0, myOpen: 3, myOverdue: 0, activeProjects: 1, completedProjects: 0, totalProjects: 1, openTasks: 1, overdueTasks: 0, members: 2, overallProgress: 40, myLoggedMinutesThisWeek: 0 }, myTasks: [], projects: [], activity: [], myWork: [] };
    else if (ep === '/api/v1/projects') data = { items: [project], page: 1, pageSize: 200, totalItems: 1, totalPages: 1 };
    else if (ep === `/api/v1/projects/${pid}`) data = { project, statuses, stages: [], members: members.map((x) => ({ userId: x.userId, name: x.displayName, email: x.email, role: x.role })) };
    else if (ep === '/api/v1/workload') data = { scope: 'Everyone', available: ['Everyone'], members: [], totals: { people: 2, open: 3, overdue: 0 } };
    else if (ep === '/api/v1/work-types') data = [{ id: g(81), name: 'Production Support', description: null, isActive: true, order: 0 }, { id: g(82), name: 'Bug Fix', description: null, isActive: true, order: 1 }];
    else if (ep === '/api/v1/work/sla') data = { entitled: true, canManage: true, defaults: [], overrides: [], suggested: [], hours: { dayStartMinutes: 570, dayEndMinutes: 1110, workDays: [1, 2, 3, 4, 5], timeZone: 'Asia/Kolkata', isDefault: true } };
    else if (/^\/api\/v1\/work-tasks\/[0-9a-f-]{36}\/resolution$/.test(ep)) data = { workTaskId: ep.split('/')[4], workVersion: 3, note: null, proposedAt: null, acceptedAt: null, current: true, canPropose: false, canAccept: false, documentId: null, documentVersion: null };
    else if (ep === '/api/v1/dev-links/status') data = [];
    else if (ep === '/api/v1/priorities') data = null;
    else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
    else if (ep.endsWith('/ai/status')) data = { enabled: false, configured: false, entitled: true, allowedHere: false };
    else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
    else if (ep === '/api/v1/timer') data = null;
    else if (ep === '/api/v1/chat/projects/unread') data = [];
    else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
    await json(data);
  });
  return ctx;
};
const shot = async (page, name) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(700); await page.screenshot({ path: path.join(out, name), fullPage: true, animations: 'disabled' }); };
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => { if (e.type() === 'error' && !e.text().startsWith('Failed to load resource')) errors.push(e.text()); });
};

try {
  for (const [theme, width] of [['light', 1440], ['dark', 1440], ['light', 390]]) {
    const tag = `${width}${theme === 'dark' ? '-dark' : ''}`;
    const phone = width < 700;
    const ctx = await make(theme);
    const page = await ctx.newPage();
    watch(page);
    await page.setViewportSize({ width, height: phone ? 844 : 1000 });

    // ---------------------------------------------------------------- the ticket panel: SLA countdown and the incident banner counting down
    await page.goto(`${origin}/preview-org/work?item=${ticket.id}`);
    const panel = page.locator('aside.v2-panel');
    await panel.getByTestId('sla-countdown').waitFor();
    assert.equal((await panel.getByTestId('sla-countdown').innerText()).trim(), 'Resolve by 14:29 · 3h 52m left');
    assert.ok(!(await panel.getByTestId('sla-countdown').getAttribute('class')).includes('t-late'), 'more than an hour left: not red');
    const inc = panel.locator('.dk-incident');
    assert.match((await inc.getByTestId('incident-countdown').innerText()).replace(/\s+/g, ' '), /^Resolve in 03:52:00 · by 14:29$/);
    assert.match(await inc.getByTestId('incident-elapsed').innerText(), /^Open 02:37:00$/, 'the time open stays beside the countdown');
    // No due date of its own: the SLA resolve-by is its due.
    assert.equal((await panel.getByTestId('wkp-due').innerText()).trim(), 'SLA · 14:29');
    if (phone) await fitsPhone(page, 'Ticket panel', assert);
    await shot(page, `panel-ticket-${tag}.png`);

    // A task due at a time: "Today · 16:00", and the time picker under the tiles.
    await page.goto(`${origin}/preview-org/work?item=${task.id}`);
    await panel.getByTestId('wkp-due').waitFor();
    assert.equal((await panel.getByTestId('wkp-due').innerText()).trim(), 'Today · 16:00');
    assert.equal(await panel.getByLabel('Due time').inputValue(), '16:00');
    if (phone) await fitsPhone(page, 'Task panel', assert);
    await shot(page, `panel-task-${tag}.png`);

    // ---------------------------------------------------------------- Home: Needs you in breach order, and the SLA marker on Your day
    await page.goto(`${origin}/preview-org/`);
    if (!phone) {
      const inbox = page.getByRole('region', { name: 'Needs you' });
      await inbox.locator('.hm-row').first().waitFor();
      assert.match(await inbox.locator('.hm-lh').innerText(), /4 · soonest breach first/);
      const titles = (await inbox.locator('.hm-row-title').allInnerTexts()).map((t) => t.trim());
      assert.deepEqual(titles.slice(0, 3), ['WT-11 Payout server disconnected', 'WT-12 Refund webhook failing', 'PAY-7 Settlement file for the bank']);
      const breaches = (await inbox.getByTestId('needs-you-breach').allInnerTexts()).map((t) => t.replace(/^\s*·\s*/, '').trim());
      assert.deepEqual(breaches, ['breaches in 3h 52m', 'breaches in 7h 13m']);
      assert.ok((await inbox.getByTestId('needs-you-breach').first().getAttribute('class')).includes('hm-breach'));

      const yday = page.getByRole('region', { name: 'Your day' });
      const mark = yday.getByTestId('your-day-sla');
      await mark.waitFor();
      assert.equal(await mark.getAttribute('data-at'), '14:29');
      assert.match(await mark.innerText(), /SLA 14:29 · WT-11/);
      assert.equal(await yday.locator('.hm-slaline').count(), 1, 'a red line across the lanes at the breach');
      assert.equal(await yday.getByTestId('your-day-due').getAttribute('data-at'), '16:00');
      // At its hour on the ruler: 14:29 sits between the 2 and 3 PM marks (the ruler runs 9 AM to 8 PM here: 11 columns).
      const track = await yday.locator('.hm-day-track').boundingBox(), mb = await mark.boundingBox();
      const hour = 9 + ((mb.x + 9 - track.x) / track.width) * 11;
      assert.ok(Math.abs(hour - (14 + 29 / 60)) < 0.15, `SLA marker at ${hour.toFixed(2)}h`);
      // The lanes are untouched: the meeting is still a capsule on the top lane.
      await yday.locator('.hm-cap', { hasText: 'Bank sync' }).waitFor();
      await shot(page, `home-${tag}.png`);

      // The Calendar's week: the same breach as a red chip "SLA 14:29" in today's due strip (never on top of the day's blocks), a thin dashed
      // line on today's column at 14:29 and its time in the margin; the task due at 16:00 likewise.
      await page.getByRole('link', { name: 'Calendar' }).first().click();
      await page.getByRole('heading', { level: 1, name: 'Calendar' }).waitFor();
      const strip = page.locator(`.wp-allday-d[data-day="${today}"]`);
      const wsla = strip.getByTestId('wp-sla');
      await wsla.waitFor();
      assert.match(await wsla.innerText(), /SLA 14:29/);
      assert.match(await strip.getByTestId('wp-due').innerText(), /16:00/);
      const line = page.locator(`.wp-col[data-day="${today}"] [data-testid="wp-dl-line"][data-kind="sla"]`);
      assert.equal(await line.getAttribute('data-at'), '14:29');
      const lb = await line.boundingBox(), hr = await page.locator('.wp-hrs span[data-hour="14"]').boundingBox();
      assert.ok(Math.abs(lb.y - (hr.y + 6 + (29 / 60) * 73)) < 4, `the line is at 14:29 (${lb.y} vs ${hr.y})`);
      assert.ok(await page.locator('[data-testid="wp-dl-tag"]', { hasText: '14:29' }).count() === 1, 'its time in the margin');
      assert.equal(await page.locator(`.wp-col[data-day="${today}"] [data-testid="wp-sla"], .wp-col[data-day="${today}"] [data-testid="wp-due"]`).count(), 0, 'no deadline chip on the grid itself');
      await shot(page, `calendar-${tag}.png`);
    } else {
      // The phone's Today: the critical ticket is the outage pill; the next rows say when they breach, and Your day lists the breach at 14:29.
      await page.getByRole('region', { name: 'Needs you' }).waitFor();
      const rows = page.getByRole('region', { name: 'Needs you' }).locator('.pt-li');
      assert.match(await rows.first().innerText(), /WT-12 Refund webhook failing[\s\S]*breaches in 7h 13m/);
      const day = page.getByRole('region', { name: 'Your day' });
      const sla = day.locator('.pt-day-row[data-type="sla"]');
      await sla.waitFor();
      assert.match(await sla.innerText(), /WT-11[\s\S]*SLA breach at 14:29/);
      await fitsPhone(page, 'Today', assert);
      await shot(page, `home-${tag}.png`);
    }
    await ctx.close();
    checks.push(tag);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors }));
} finally { await browser.close(); }
