import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// v2 Work: My work · Team · Tickets with Projects › as a link; one list on /work-items (kind chip, priority dot, owner, due in red when
// late, group and sort; filters only past 10 items); the side panel deep-linked by ?item= (four tiles saved as you go with the version,
// a 409 reloads and says so, ✦ Copilot with one action, one Activity stream, "log 2h", a ticket's SLA / channel / resolution, adding a
// file); a project's work with List / Board / Timeline; + New making a ticket and opening it; old links landing on /work?item=; Team's
// capacity view still reachable. 1440 light and dark, and a 390 phone. Synthetic API only; every write is checked.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/v2-work-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const g = (n) => `90000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const user = { id: g(1), displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ravi = { id: g(2), name: 'Ravi Kumar' }, priya = { id: g(3), name: 'Priya Shah' }, asha = { id: user.id, name: user.displayName };
const ws = { id: g(9), slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 3 };
const members = [asha, ravi, priya].map((p, i) => ({ userId: p.id, displayName: p.name, email: `${p.name.split(' ')[0].toLowerCase()}@example.test`, role: i ? 'Member' : 'Owner', joinedAt: '2026-01-01T00:00:00Z', jobRole: null }));
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const day = (n) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const pid = g(50);
const project = { id: pid, key: 'PAY', name: 'Payments Core', description: null, status: 'Active', priority: 'High', owner: asha, teamId: null, teamName: null, startDate: day(-30), dueDate: day(30),
  progress: 40, health: 'OnTrack', stats: { total: 6, done: 2, inProgress: 2, cancelled: 0, todo: 2, overdue: 1 }, memberCount: 3, version: 1, position: 0, enforceDependencies: false,
  projectGroupId: null, projectGroupName: null, projectType: 'NewProject', deliveryMethod: 'Phased' };
const statuses = [{ id: g(61), name: 'To Do', order: 0, category: 'Todo', color: '#94a3b8' }, { id: g(62), name: 'In Progress', order: 1, category: 'Active', color: '#38bdf8' }, { id: g(63), name: 'Done', order: 2, category: 'Done', color: '#34d399' }];
const stages = ['Requirements', 'Development', 'UAT'].map((name, i) => ({ id: g(70 + i), name, order: i, durationDays: 5, plannedStart: day(-20 + i * 7), plannedEnd: day(-15 + i * 7), actualStart: i ? null : day(-20),
  actualEnd: i ? null : day(-14), status: i ? (i === 1 ? 'InProgress' : 'Pending') : 'Completed', effectiveStatus: i ? (i === 1 ? 'InProgress' : 'Pending') : 'Completed', locked: false, lockedBy: null, taskTotal: 2, taskDone: i ? 0 : 2, openIssues: 0, totalIssues: 0 }));

// ---------------------------------------------------------------- the work items (the server's state for one run)
const LABEL = { ToDo: 'To Do', InProgress: 'In Progress', OnHold: 'On Hold', Completed: 'Completed', Cancelled: 'Cancelled', Open: 'Open', Observed: 'Observed', Fixed: 'Fixed', Resolved: 'Resolved' };
const CAT = { ToDo: 'Todo', Open: 'Todo', Observed: 'Todo', InProgress: 'Active', OnHold: 'Active', Fixed: 'Active', Completed: 'Done', Resolved: 'Done', Cancelled: 'Cancelled' };
function seed() {
  const items = [];
  const add = (kind, n, title, o = {}) => {
    const key = kind === 'ticket' ? `WT-${n}` : kind === 'issue' ? `PAY-I${n}` : kind === 'action' ? `AI-${n}` : `PAY-${n}`;
    const status = o.status ?? (kind === 'action' ? 'Open' : kind === 'issue' ? 'Observed' : kind === 'task' ? 'To Do' : 'ToDo');
    items.push({ kind, id: g(100 + items.length), key, title, projectId: kind === 'ticket' ? null : pid, priority: o.priority ?? 'Medium', dueDate: o.due ?? null, assignee: o.who === undefined ? asha : o.who,
      status, version: 3, description: o.description ?? null, loggedMinutes: 0, activity: o.activity ?? [], channel: o.channel ?? 'app', sla: o.sla ?? null, updatedAt: ago(items.length) });
  };
  add('ticket', 5, 'MuleSoft production server got disconnected', { priority: 'Critical', due: day(0), status: 'InProgress', channel: 'whatsapp', description: 'Workers stopped at 10:40.',
    sla: { response: null, resolution: { dueAt: new Date(Date.now() + 3 * 3600e3).toISOString(), metAt: null, state: 'AtRisk' }, state: 'AtRisk' },
    activity: [{ type: 'change', id: g(900), at: ago(2), actor: asha, summary: 'set status In Progress' }, { type: 'ai', id: g(901), at: ago(1), actor: ravi, summary: 'linked the chat with Siva', auto: false, action: 'LinkChat' }] });
  add('issue', 4, 'Separate GoCollect INC QR transactions', { priority: 'High', due: day(6) });
  add('task', 2, 'CreditVision score API integration', { priority: 'Medium', due: day(12), status: 'In Progress' });
  add('task', 7, 'Refund webhook retries twice', { priority: 'High', due: day(-3) });
  add('action', 3, "Get the bank's sign-off", { priority: 'Low', due: day(2) });
  for (let i = 0; i < 7; i++) add('task', 20 + i, `Settlement report part ${i + 1}`, { priority: ['Low', 'Medium', 'High'][i % 3], due: i % 2 ? day(20 + i) : null });
  add('task', 40, 'Ravi’s reconciliation job', { who: ravi, priority: 'High', due: day(1) });
  add('ticket', 9, 'Printer on floor 2 jams', { who: priya, priority: 'Low', due: day(4) });
  return items;
}
const row = (w) => ({ kind: w.kind, id: w.id, key: w.key, title: w.title, projectId: w.projectId, projectKey: w.projectId ? 'PAY' : null, projectName: w.projectId ? project.name : null,
  status: w.kind === 'task' ? w.status : LABEL[w.status] ?? w.status, category: w.kind === 'task' ? (statuses.find((s) => s.name === w.status)?.category ?? 'Todo') : CAT[w.status], priority: w.priority,
  dueDate: w.dueDate, isOverdue: !!w.dueDate && w.dueDate < today && !['Done', 'Cancelled'].includes(w.kind === 'task' ? statuses.find((s) => s.name === w.status)?.category : CAT[w.status]),
  assignee: w.assignee, typeName: w.kind === 'ticket' ? 'Bug fix' : null, updatedAt: w.updatedAt });
const detailOf = (w) => {
  const r = row(w);
  const own = w.kind === 'task' ? { id: w.id, projectId: pid, statusId: statuses.find((s) => s.name === w.status)?.id, statusName: w.status, canEdit: true }
    : w.kind === 'ticket' ? { id: w.id, status: w.status, workTypeId: g(81), workType: 'Bug fix', relatedProject: null, sla: w.sla, can: { edit: true, delete: true } }
    : { id: w.id, status: w.status, can: { edit: true, delete: true } };
  return { ...r, description: w.description, startDate: null, reporter: asha, version: w.version, createdAt: ago(48), updatedAt: w.updatedAt, completedAt: null, loggedMinutes: w.loggedMinutes,
    detail: own, activity: [...w.activity].sort((a, b) => b.at.localeCompare(a.at)), channel: w.kind === 'ticket' ? w.channel : null };
};

const errors = [], checks = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
/** A browser context over the built app with this run's synthetic server. `state.bump` makes the next PATCH meet someone else's change. */
const make = async (theme, state) => {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
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
    const items = state.items;
    const find = (id) => items.find((w) => w.id === id);
    const m = ep.match(/^\/api\/v1\/work-items\/([0-9a-f-]{36})(\/comments)?$/);
    if (method !== 'GET' && !ep.endsWith('/auth/refresh')) {
      // Writes: only the Work API, and a file on a ticket.
      if (ep === '/api/v1/work-items' && method === 'POST') {
        const b = req.postDataJSON(); state.writes.push({ ep, method, b });
        assert.equal(b.kind, 'ticket'); assert.ok(b.workTypeId && b.title);
        const n = { kind: 'ticket', id: g(300 + state.writes.length), key: `WT-${20 + state.writes.length}`, title: b.title, projectId: null, priority: b.priority, dueDate: b.dueDate ?? null,
          assignee: members.find((x) => x.userId === b.assigneeId) ? { id: b.assigneeId, name: members.find((x) => x.userId === b.assigneeId).displayName } : null,
          status: 'ToDo', version: 1, description: null, loggedMinutes: 0, activity: [{ type: 'change', id: g(950), at: new Date().toISOString(), actor: asha, summary: 'created the ticket' }], channel: 'app', sla: null, updatedAt: new Date().toISOString() };
        items.unshift(n);
        return json(detailOf(n), 201);
      }
      if (m && !m[2] && method === 'PATCH') {
        const w = find(m[1]), b = req.postDataJSON(); state.writes.push({ ep, method, b });
        if (state.bump) { state.bump = false; w.version += 1; w.status = 'OnHold'; w.activity.push({ type: 'change', id: g(960), at: new Date().toISOString(), actor: ravi, summary: 'set status On Hold' }); }
        if (b.version !== w.version) return json({ message: 'Someone else changed this item since you opened it. Reload it to see their change.', errors: [{ code: 'VERSION_CONFLICT', message: 'Someone else changed this item since you opened it.' }] }, 409);
        for (const k of ['priority', 'title', 'description', 'dueDate', 'status']) if (k in b) w[k] = b[k];
        if ('statusId' in b) w.status = statuses.find((s) => s.id === b.statusId).name;
        if ('assigneeId' in b) w.assignee = b.assigneeId ? { id: b.assigneeId, name: members.find((x) => x.userId === b.assigneeId).displayName } : null;
        w.version += 1; w.updatedAt = new Date().toISOString();
        w.activity.push({ type: 'change', id: g(970 + w.version), at: new Date().toISOString(), actor: asha, summary: `changed ${Object.keys(b).filter((k) => k !== 'version').join(', ')}` });
        return json(detailOf(w));
      }
      if (m && m[2] && method === 'POST') {
        const w = find(m[1]), b = req.postDataJSON(); state.writes.push({ ep, method, b });
        const c = { type: 'comment', id: g(980 + w.activity.length), at: new Date().toISOString(), actor: asha, summary: 'commented', body: b.body };
        w.activity.push(c);
        let time = null, timeProblem = null;
        if (/^log\s+2h/i.test(b.body)) {
          if (w.kind === 'task' || w.kind === 'ticket') { time = { type: 'time', id: g(990 + w.activity.length), at: new Date().toISOString(), actor: asha, summary: 'logged 2h', minutes: 120, workDate: today }; w.activity.push(time); w.loggedMinutes += 120; }
          else timeProblem = w.kind === 'issue' ? 'Time is logged on tasks and tickets, not on issues.' : 'Time is logged on tasks and tickets, not on action items.';
        }
        return json({ comment: c, time, timeProblem }, 201);
      }
      const up = ep.match(/^\/api\/v1\/work-tasks\/([0-9a-f-]{36})\/attachments$/);
      if (up && method === 'POST') {
        const w = find(up[1]); state.writes.push({ ep, method });
        w.activity.push({ type: 'file', id: g(995), at: new Date().toISOString(), actor: asha, summary: 'added vpn-log.txt', fileId: g(996), fileName: 'vpn-log.txt' });
        return json({ id: g(996), workTaskId: w.id, fileName: 'vpn-log.txt', contentType: 'text/plain', sizeBytes: 12, uploadedBy: asha, createdAt: new Date().toISOString(), canDelete: true, isImage: false }, 201);
      }
      if (ep === '/api/v1/operations/triage') return json({ workTypeId: null, workTypeName: null, priority: null, suggestedAssignee: null, similar: [] });   // read-only suggestions (POST for the body)
      assert.fail(`Unexpected write: ${method} ${ep}`);
    }
    let data = [];
    if (ep.endsWith('/auth/refresh')) data = { accessToken: `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`, expiresAt: '2099-01-01T00:00:00Z', user };
    else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, reportCount: 2, permissions: ['projects.view', 'projects.edit', 'projects.create', 'tasks.view', 'tasks.edit', 'tasks.create', 'tasks.comment', 'org.manage', 'work.view', 'work.create', 'reports.view', 'reports.broad'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 0, activity: 3, documents: 3, people: 3, reports: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: {} } };
    else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: true };
    else if (ep === '/api/v1/workspace/members') data = members;
    else if (ep === '/api/v1/work-items') {
      state.lists.push(Object.fromEntries(sp));
      const status = sp.get('status') ?? 'open', q = (sp.get('q') ?? '').toLowerCase(), kinds = sp.get('kind')?.split(',');
      let list = items.map(row).filter((r) => (status === 'open' ? ['Todo', 'Active'].includes(r.category) : status === 'closed' ? ['Done', 'Cancelled'].includes(r.category) : true));
      if (sp.get('mine') === 'true') list = list.filter((r) => r.assignee?.id === user.id);
      if (sp.get('team')) list = list.filter((r) => r.assignee && r.assignee.id !== user.id);
      if (sp.get('assigneeId')) list = list.filter((r) => r.assignee?.id === sp.get('assigneeId'));
      if (sp.get('projectId')) list = list.filter((r) => r.projectId === sp.get('projectId'));
      if (kinds) list = list.filter((r) => kinds.includes(r.kind));
      if (sp.get('overdue') === 'true') list = list.filter((r) => r.isOverdue);
      if (q) list = list.filter((r) => r.title.toLowerCase().includes(q) || r.key.toLowerCase().includes(q));
      const offset = Number(sp.get('offset') ?? 0), limit = Number(sp.get('limit') ?? 50);
      data = { items: list.slice(offset, offset + limit), offset, limit, hasMore: list.length > offset + limit };
    }
    else if (m && !m[2]) { const w = find(m[1]); if (!w) return json({ message: 'Work item not found.', errors: [{ code: 'WORK_ITEM_NOT_FOUND', message: 'Work item not found.' }] }, 404); data = detailOf(w); }
    else if (ep === '/api/v1/work-types') data = [{ id: g(81), name: 'Bug fix', description: null, isActive: true, order: 0 }, { id: g(82), name: 'Access request', description: null, isActive: true, order: 1 }];
    else if (ep === '/api/v1/work/sla') data = { entitled: true, canManage: true, defaults: [{ priority: 'Critical', responseMinutes: 30, resolutionMinutes: 240 }, { priority: 'High', responseMinutes: 120, resolutionMinutes: 1440 }, { priority: 'Medium', responseMinutes: 480, resolutionMinutes: 4320 }, { priority: 'Low', responseMinutes: 1440, resolutionMinutes: 10080 }], overrides: [] };
    else if (/^\/api\/v1\/work-tasks\/[0-9a-f-]{36}\/resolution$/.test(ep)) data = { workTaskId: ep.split('/')[4], workVersion: 3, note: null, proposedAt: null, acceptedAt: null, current: true, canPropose: false, canAccept: false, documentId: null, documentVersion: null };
    else if (ep === '/api/v1/projects') data = { items: [project], page: 1, pageSize: 200, totalItems: 1, totalPages: 1 };
    else if (ep === `/api/v1/projects/${pid}`) data = { project, statuses, stages, members: members.map((x) => ({ userId: x.userId, name: x.displayName, email: x.email, role: x.role })) };
    else if (ep === `/api/v1/projects/${pid}/tasks`) data = { items: items.filter((w) => w.kind === 'task').map((w) => ({ id: w.id, projectId: pid, projectKey: 'PAY', projectName: project.name, number: 1, key: w.key, title: w.title, description: null,
      statusId: statuses.find((s) => s.name === w.status).id, statusName: w.status, statusCategory: statuses.find((s) => s.name === w.status).category, statusColor: '#38bdf8', priority: w.priority, assignee: w.assignee, reporter: asha,
      startDate: null, dueDate: w.dueDate, estimatedHours: null, actualHours: null, position: 0, parentTaskId: null, subtaskTotal: 0, subtaskDone: 0, commentCount: 0, labels: [], completedAt: null, createdAt: ago(48), updatedAt: null,
      version: w.version, isOverdue: false, milestoneId: null, milestoneName: null, dependsOnCount: 0, blocksCount: 0, isBlocked: false, sprintId: null, sprintName: null, checklistTotal: 0, checklistDone: 0, canEdit: true, stageId: null, stageName: null })),
      page: 1, pageSize: 500, totalItems: 9, totalPages: 1 };
    else if (ep === '/api/v1/teams') data = [{ id: g(40), name: 'Payments', description: null, memberCount: 3, projectCount: 1, lead: asha }];
    else if (ep === '/api/v1/workload') data = { scope: 'Everyone', available: ['Everyone', 'Me'], members: [{ userId: ravi.id, name: ravi.name, email: 'ravi@example.test', jobRole: null, level: 0, reportsTo: null, open: 4, overdue: 1, dueThisWeek: 2, doneLast30Days: 3, loggedMinutesLast7Days: 600, openByKind: { total: 4, tasks: 3, issues: 0, actionItems: 0, operational: 1 }, nextUp: [] }], totals: { people: 1, open: 4, overdue: 1 } };
    else if (ep === '/api/v1/time/capacity' || ep.startsWith('/api/v1/time/capacity')) data = { from: day(-28), to: day(0), weeks: 4, people: [], totals: { capacityMinutes: 0, loggedMinutes: 0, billableMinutes: 0, cost: 0 }, currency: 'INR' };
    else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
    else if (ep.endsWith('/ai/status')) data = { enabled: false, configured: false, entitled: true, allowedHere: false };
    else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
    else if (ep === '/api/v1/timer') data = null;
    else if (ep === '/api/v1/chat/projects/unread') data = [];
    else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
    else if (ep === '/api/v1/priorities') data = null;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  return ctx;
};
const shot = async (page, name) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(700); await page.screenshot({ path: path.join(out, name), fullPage: false, animations: 'disabled' }); };
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => { if (e.type() === 'error' && !e.text().startsWith('Failed to load resource')) errors.push(e.text()); });
};
const at = (page) => { const u = new URL(page.url()); return `${u.pathname.replace('/preview-org', '')}${u.search}`; };
const waitFor = async (fn, what) => { for (let i = 0; i < 40; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 100)); } assert.fail(`timed out waiting for ${what}`); };

try {
  for (const [theme, width] of [['light', 1440], ['dark', 1440], ['light', 390]]) {
    const tag = `${width}${theme === 'dark' ? '-dark' : ''}`;
    const state = { items: seed(), writes: [], lists: [], bump: false };
    const ctx = await make(theme, state);
    const page = await ctx.newPage();
    watch(page);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    if (theme === 'dark') { await page.goto(`${origin}/preview-org/work`); assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark'); }

    // ---------------------------------------------------------------- My work: one list of every kind, on /work-items
    await page.goto(`${origin}/preview-org/work`);
    await page.getByRole('heading', { level: 1, name: 'Work' }).waitFor();
    await page.getByText('Tasks, issues, actions and tickets — one list').waitFor();
    const tabs = page.getByRole('tablist', { name: 'Work' });
    assert.deepEqual((await tabs.getByRole('tab').allInnerTexts()).map((t) => t.trim()), ['My work', 'Team', 'Tickets', 'Automations']);
    assert.equal(await tabs.getByRole('tab', { name: 'My work' }).getAttribute('aria-selected'), 'true');
    // Projects › is a link that leaves Work, not a tab.
    const projectsLink = page.getByRole('link', { name: /^Projects/ });
    assert.equal(await projectsLink.getAttribute('href'), '/preview-org/work/projects');
    const list = page.getByRole('region', { name: 'Work list' });
    const rows = list.locator('.wk-row');
    await rows.first().waitFor();
    assert.equal(await rows.count(), 12, 'every open item assigned to me');
    await waitFor(() => state.lists.some((l) => l.mine === 'true' && (l.status ?? 'open') === 'open'), 'My work asks /work-items for mine');
    // Each row: priority dot, key, title, kind chip, owner, due (red when late).
    const wt5 = rows.filter({ hasText: 'MuleSoft production server' });
    assert.equal(await wt5.locator('.wk-kind').innerText(), 'Ticket');
    assert.equal(await wt5.locator('.wk-dot.p-Critical').count(), 1);
    assert.equal(await wt5.locator('.wk-key').innerText(), 'WT-5');
    assert.equal(await wt5.locator('.wk-due').innerText(), 'Today');
    assert.equal(await wt5.locator('.wk-owner .avatar').count(), 1);
    const late = rows.filter({ hasText: 'Refund webhook retries twice' });
    assert.match(await late.locator('.wk-due').getAttribute('class'), /late/);
    assert.equal(await late.locator('.wk-due').innerText(), '3d late');
    const red = await late.locator('.wk-due').evaluate((e) => getComputedStyle(e).color);
    const [r0, g0, b0] = red.match(/\d+/g).map(Number); assert.ok(r0 > 180 && g0 < 130 && b0 < 130, `late due is red (${red})`);
    for (const k of ['Task', 'Issue', 'Action', 'Ticket']) await list.locator('.wk-kind', { hasText: new RegExp(`^${k}$`) }).first().waitFor();
    // Grouped by due date (Overdue first), sorted by priority.
    assert.deepEqual((await list.locator('.wk-group-head span').allInnerTexts()).slice(0, 2), ['Overdue', 'Today']);
    // More than 10 items: the filters show. The kind chips narrow the list.
    await list.getByRole('searchbox', { name: 'Search work' }).waitFor();
    await list.getByRole('button', { name: /^Issue/ }).click();
    assert.equal(await rows.count(), 1);
    await list.getByRole('button', { name: /^All$/ }).click();
    assert.equal(await rows.count(), 12);
    // Group and sort.
    await list.getByLabel('Group by').selectOption('kind');
    await list.locator('.wk-group-head', { hasText: 'Tickets' }).waitFor();
    await list.getByLabel('Group by').selectOption('due');
    if (width === 390) await fitsPhone(page, 'Work list', assert);
    await shot(page, `work-${tag}.png`);
    checks.push(`list-${tag}`);

    // ---------------------------------------------------------------- the side panel, deep-linked
    await wt5.click();
    await page.waitForURL(/[?&]item=/);
    assert.equal(new URL(page.url()).searchParams.get('item'), state.items[0].id);
    const panel = page.locator('aside.v2-panel');
    await panel.getByText('WT-5 · Ticket').waitFor();
    assert.equal(await panel.getByLabel('Title').inputValue(), 'MuleSoft production server got disconnected');
    // Four tiles; no Save / Cancel footer.
    for (const l of ['Status', 'Priority', 'Owner', 'Due']) await panel.locator('.wkp-tile-l', { hasText: new RegExp(`^${l}$`) }).waitFor();
    assert.equal(await panel.locator('.wkp-tile').count(), 4);
    assert.equal(await panel.getByRole('button', { name: /^(Save|Cancel)/ }).count(), 0, 'no Save / Cancel');
    assert.match(await panel.locator('.wkp-tile', { hasText: 'Status' }).innerText(), /In Progress/);
    // A ticket's SLA, channel and resolution are fields.
    const fields = panel.locator('.wkp-fields');
    await fields.locator('.sla-chip').waitFor();
    assert.match(await fields.innerText(), /Channel\s*WhatsApp/);
    await fields.getByText('Resolution').waitFor();
    // ✦ Copilot: violet, one suggested action and Not now.
    const ai = panel.locator('.v2-ai-card');
    await ai.getByText('Copilot').waitFor();
    assert.equal(await ai.locator('.btn-ai').count(), 1, 'one suggested action');
    await ai.getByRole('button', { name: 'Not now' }).waitFor();
    const violet = await ai.locator('.btn-ai').evaluate((e) => getComputedStyle(e).backgroundColor);
    assert.equal(violet, 'rgb(94, 92, 230)', 'violet only for the AI');
    // One Activity stream: field changes and the AI's action.
    const stream = panel.getByRole('region', { name: 'Activity' });
    await stream.getByText('set status In Progress').waitFor();
    await stream.locator('.wkp-act.t-ai', { hasText: 'linked the chat with Siva' }).waitFor();
    // The page beside stays readable: the list is not covered on a wide screen.
    if (width === 1440) {
      // (the page makes room with a short transition)
      await page.waitForFunction(() => { const l = document.querySelector('[aria-label="Work list"]')?.getBoundingClientRect(), p = document.querySelector('aside.v2-panel')?.getBoundingClientRect(); return !!l && !!p && l.right <= p.left + 1; }, null, { timeout: 5000 })
        .catch(() => assert.fail('the panel sits beside the list, not over it'));
    }
    await shot(page, `panel-${tag}.png`);

    // Saves as you go: priority, with the version read.
    const before = state.writes.length;
    await panel.getByLabel('Priority', { exact: true }).selectOption('High');
    await waitFor(() => state.writes.length > before, 'the PATCH');
    const patch = state.writes.at(-1);
    assert.equal(patch.method, 'PATCH'); assert.deepEqual(patch.b, { version: 3, priority: 'High' });
    await panel.locator('.wkp-tile', { hasText: 'Priority' }).locator('.wkp-tile-v', { hasText: 'High' }).waitFor();
    await panel.getByRole('status').filter({ hasText: /Saved|Saving/ }).first().waitFor();
    // Owner and due, each its own save with the version it read.
    await panel.getByLabel('Owner', { exact: true }).selectOption(ravi.id);
    await waitFor(() => state.writes.at(-1)?.b?.assigneeId === ravi.id, 'the owner change');
    assert.equal(state.writes.at(-1).b.version, 4);
    await panel.locator('.wkp-tile', { hasText: 'Owner' }).locator('.wkp-tile-v', { hasText: 'Ravi Kumar' }).waitFor();
    checks.push(`patch-${tag}`);

    // Someone else saved in between: 409, the item is read again, and the panel says so.
    state.bump = true;
    await panel.getByLabel('Status', { exact: true }).selectOption('Completed');
    await panel.getByRole('alert').filter({ hasText: 'Someone else changed this' }).waitFor();
    assert.equal(state.writes.at(-1).b.status, 'Completed');
    await panel.locator('.wkp-tile', { hasText: 'Status' }).locator('.wkp-tile-v', { hasText: 'On Hold' }).waitFor();   // their change is shown
    await stream.getByText('set status On Hold').waitFor();
    // Making the change again works on the new version.
    await panel.getByLabel('Status', { exact: true }).selectOption('InProgress');
    await waitFor(() => state.writes.at(-1)?.b?.status === 'InProgress', 'the second try');
    assert.equal(state.writes.at(-1).b.version, 6);
    await panel.locator('.wkp-tile', { hasText: 'Status' }).locator('.wkp-tile-v', { hasText: 'In Progress' }).waitFor();
    checks.push(`conflict-${tag}`);

    // "log 2h" logs time on a ticket, and shows in the one stream.
    const box = panel.getByLabel('Comment, or log time');
    await box.fill('log 2h restarted the workers');
    await panel.getByText('Logs this time on it, as you, and posts the comment.').waitFor();
    await box.press('Enter');
    await waitFor(() => state.writes.some((w) => w.ep.endsWith('/comments')), 'the comment');
    assert.equal(state.writes.find((w) => w.ep.endsWith('/comments')).b.body, 'log 2h restarted the workers');
    await stream.locator('.wkp-act.t-time', { hasText: 'logged 2h' }).waitFor();
    await stream.locator('.wkp-bubble', { hasText: 'log 2h restarted the workers' }).waitFor();
    await page.getByText('Logged 2h on WT-5.').waitFor();
    checks.push(`log-2h-${tag}`);

    // A file, added from the panel.
    await panel.getByTestId('wkp-file-input').setInputFiles({ name: 'vpn-log.txt', mimeType: 'text/plain', buffer: Buffer.from('VPN dropped.') });
    await panel.locator('.wkp-file', { hasText: 'vpn-log.txt' }).waitFor();
    await waitFor(() => state.writes.some((w) => w.ep.endsWith('/attachments')), 'the upload');
    if (width === 390) { await fitsPhone(page, 'Work panel', assert); const pb = await panel.boundingBox(); assert.ok(pb.width >= 389, 'the panel fills a phone'); }
    await shot(page, `panel-after-${tag}.png`);
    // An issue cannot take time: the comment posts and says why.
    await page.goto(`${origin}/preview-org/work?item=${state.items[1].id}`);
    await panel.getByText('PAY-I4 · Issue').waitFor();
    await panel.getByLabel('Comment, or log time').fill('log 2h');
    await panel.getByLabel('Comment, or log time').press('Enter');
    await panel.getByText('Time is logged on tasks and tickets, not on issues.').waitFor();
    // Esc closes; the address drops ?item=.
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'detached' });
    assert.equal(new URL(page.url()).searchParams.get('item'), null);
    checks.push(`panel-${tag}`);

    // ---------------------------------------------------------------- Team and Tickets; Team's capacity view stays reachable
    await tabs.getByRole('tab', { name: 'Team' }).click();
    await page.waitForURL(/tab=team/);
    await list.locator('.wk-row', { hasText: 'Ravi’s reconciliation job' }).waitFor();
    await waitFor(() => state.lists.some((l) => l.team === 'mine'), 'Team asks for my teams');
    await page.getByRole('button', { name: 'More in Team' }).click();
    await page.getByRole('menuitem', { name: /Capacity & cost/ }).click();
    await page.waitForURL(/tab=team&s=capacity/);
    await page.getByRole('heading', { name: 'Workload', level: 1 }).waitFor();
    await page.goto(`${origin}/preview-org/workload/capacity`);
    await page.waitForURL(/\/work\?tab=team&s=capacity/);
    await page.getByRole('link', { name: /Capacity & cost/ }).waitFor();
    await page.getByRole('button', { name: 'Work · Team' }).click();
    await page.waitForURL((u) => u.searchParams.get('tab') === 'team' && !u.searchParams.has('s'));
    await tabs.getByRole('tab', { name: 'Tickets' }).click();
    await page.waitForURL(/tab=tickets/);
    await list.locator('.wk-row', { hasText: 'Printer on floor 2 jams' }).waitFor();
    await waitFor(() => state.lists.some((l) => l.kind === 'ticket'), 'Tickets asks for tickets');
    assert.equal(await list.locator('.wk-kchip').count(), 0, 'one kind: no kind chips');
    // The ticket desk's own views are one ··· away.
    await page.getByRole('button', { name: 'More in Tickets' }).click();
    for (const name of [/Queue/, /Board/, /Insights/, /WhatsApp desk/, /Voice agent/, /Desk settings/, /Export CSV/]) await page.getByRole('menuitem', { name }).waitFor();
    await page.keyboard.press('Escape');
    checks.push(`tabs-${tag}`);

    // ---------------------------------------------------------------- old links land on /work?item=<id>
    for (const [from, to] of [
      [`/operations?task=${state.items[0].id}`, `/work?tab=tickets&item=${state.items[0].id}`],
      [`/projects/${pid}?task=${state.items[2].id}`, `/work?item=${state.items[2].id}`],
      [`/projects/${pid}?tab=issues&issue=${state.items[1].id}`, `/work?item=${state.items[1].id}`],
      [`/projects/${pid}?tab=actions&action=${state.items[4].id}`, `/work?item=${state.items[4].id}`],
      [`/tasks/${state.items[3].id}`, `/work?item=${state.items[3].id}`],
    ]) {
      await page.goto(`${origin}/preview-org${from}`);
      await page.waitForURL((u) => u.pathname === '/preview-org/work' && u.searchParams.get('item') === new URLSearchParams(to.split('?')[1]).get('item'));
      assert.equal(at(page), to, `${from} lands on ${to}`);
      await panel.locator('.wkp-tiles').waitFor();
    }
    checks.push(`redirects-${tag}`);

    // ---------------------------------------------------------------- a project's work: List / Board / Timeline, the same panel
    await page.goto(`${origin}/preview-org/work?project=${pid}`);
    await page.getByRole('heading', { level: 1, name: 'Payments Core' }).waitFor();
    const show = page.getByRole('tablist', { name: 'Show work as' });
    assert.deepEqual((await show.getByRole('tab').allInnerTexts()).map((t) => t.trim()), ['List', 'Board', 'Timeline']);
    await list.locator('.wk-row').first().waitFor();
    await waitFor(() => state.lists.some((l) => l.projectId === pid), 'the list is narrowed to the project');
    assert.equal(await list.locator('.wk-row', { hasText: 'Printer on floor 2 jams' }).count(), 0);
    await show.getByRole('tab', { name: 'Board' }).click();
    await page.waitForURL(/view=board/);
    await page.locator('.wk-board').getByText('CreditVision score API integration').waitFor();
    await shot(page, `project-board-${tag}.png`);
    await show.getByRole('tab', { name: 'Timeline' }).click();
    await page.waitForURL(/view=timeline/);
    await page.locator('.wk-timeline').getByText('Development').first().waitFor();
    await shot(page, `project-timeline-${tag}.png`);
    await show.getByRole('tab', { name: 'List' }).click();
    await list.locator('.wk-row', { hasText: 'CreditVision score API integration' }).click();
    await panel.getByText(/PAY-2 · Task/).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('project'), pid, 'the panel opens on the project view');
    // Quick add stays over the list; the old Issues tab (?kind=issue) and Plan (?view=plan) land on the list's kind and on Timeline.
    await page.getByLabel('Add a task in plain words').waitFor();
    await page.goto(`${origin}/preview-org/work?project=${pid}&kind=issue`);
    await list.locator('.wk-row').first().waitFor();
    assert.equal(await list.getByRole('button', { name: /^Issue/ }).getAttribute('aria-pressed'), 'true');
    assert.deepEqual([...new Set(await list.locator('.wk-kind').allInnerTexts())], ['Issue']);
    await page.goto(`${origin}/preview-org/work?project=${pid}&view=plan`);
    assert.equal(await show.getByRole('tab', { name: 'Timeline' }).getAttribute('aria-selected'), 'true');
    await page.locator('.wk-timeline').getByText('Development').first().waitFor();
    await page.goto(`${origin}/preview-org/work?project=${pid}`);
    if (width === 390) await fitsPhone(page, 'Project work', assert);
    await page.keyboard.press('Escape');
    checks.push(`project-${tag}`);

    // ---------------------------------------------------------------- + New: a ticket from words, with chips, opened in the panel
    await page.goto(`${origin}/preview-org/work`);
    await rows.first().waitFor();
    await page.evaluate(() => document.querySelector(window.innerWidth < 769 ? '.v2-phone-new' : '.v2-new')?.click());
    const sheet = page.getByRole('dialog', { name: 'New' });
    await sheet.getByLabel('What to create').fill('VPN down for collections team, critical, give to Ravi');
    await sheet.getByText('✦ I understood this as a ticket').waitFor();
    await sheet.locator('.v2-new-chip', { hasText: 'Type' }).locator('b', { hasText: 'Bug fix' }).waitFor();
    await sheet.locator('.v2-new-chip', { hasText: 'Priority' }).locator('b', { hasText: 'Critical' }).waitFor();
    await sheet.locator('.v2-new-chip', { hasText: 'Owner' }).locator('b', { hasText: 'Ravi Kumar' }).waitFor();
    await sheet.locator('.v2-new-chip', { hasText: 'SLA' }).locator('b', { hasText: '4 hours' }).waitFor();
    // Tap a chip to change it: the type.
    await sheet.getByLabel('Change type').selectOption({ label: 'Access request' });
    await sheet.locator('.v2-new-chip', { hasText: 'Type' }).locator('b', { hasText: 'Access request' }).waitFor();
    if (width === 390) await fitsPhone(page, 'New sheet', assert);
    await shot(page, `new-${tag}.png`);
    await sheet.getByRole('button', { name: 'Create ticket' }).click();
    await waitFor(() => state.writes.some((w) => w.ep === '/api/v1/work-items'), 'the create');
    const made = state.writes.find((w) => w.ep === '/api/v1/work-items').b;
    assert.equal(made.kind, 'ticket'); assert.equal(made.title, 'VPN down for collections team'); assert.equal(made.priority, 'Critical');
    assert.equal(made.assigneeId, ravi.id); assert.equal(made.workTypeId, g(82));
    await sheet.waitFor({ state: 'detached' });
    await panel.getByText(/WT-2\d · Ticket/).waitFor();
    assert.equal(await panel.getByLabel('Title').inputValue(), 'VPN down for collections team');
    assert.ok(new URL(page.url()).searchParams.get('item'), 'the new ticket is open in the panel');
    checks.push(`new-ticket-${tag}`);

    // The other six types keep their own places: each opens where it is made, with the words carried over (their pages have their own
    // checks; only the hand-over is checked here, so what those unmocked pages log is set aside).
    if (tag === '1440') {
      const kept = errors.length;
      const newSheet = async (words, tile) => {
        await page.goto(`${origin}/preview-org/work`); await rows.first().waitFor();
        await page.locator('.v2-new').click();
        await sheet.getByLabel('What to create').fill(words);
        if (tile) await sheet.getByRole('radio', { name: tile }).click();
        await sheet.getByRole('button', { name: /^Create / }).click();
        await sheet.waitFor({ state: 'detached' });
      };
      await newSheet('Payout runbook for the bank', 'Doc');
      await page.waitForURL((u) => u.pathname === '/preview-org/library/docs');
      await newSheet('Meeting with the bank on Friday', 'Meeting');
      await page.waitForURL((u) => u.pathname === '/preview-org/talk' && u.searchParams.get('f') === 'meetings');
      await newSheet('2h on WT-5 today', 'Time');
      await page.waitForURL((u) => u.pathname === '/preview-org/insights' && u.searchParams.get('tab') === 'time' && u.searchParams.get('log') === '2h on WT-5 today');
      await newSheet('Remind me to call Ravi tomorrow at 10', 'Reminder');
      await page.locator('.rm-composer, [role="dialog"]').first().waitFor();
      await page.keyboard.press('Escape');
      await newSheet('Collections revamp', 'Project');
      await page.getByRole('dialog', { name: /New project/ }).waitFor();
      await page.keyboard.press('Escape');
      // A task needs its project: the Project chip asks for one, then it is made through /work-items too.
      await page.goto(`${origin}/preview-org/work`); await rows.first().waitFor();
      await page.locator('.v2-new').click();
      await sheet.getByLabel('What to create').fill('Write the settlement runbook');
      await sheet.getByRole('radio', { name: 'Task' }).click();
      await sheet.getByLabel('Change project').selectOption(pid);
      await sheet.getByLabel('Change type').selectOption('issue');
      await sheet.getByText('✦ I understood this as an issue').waitFor();
      await page.keyboard.press('Escape');
      errors.splice(kept);
      checks.push('new-every-type');
    }

    // Dark mode: the panel and list read on dark surfaces.
    if (theme === 'dark') {
      const bg = await panel.evaluate((e) => getComputedStyle(e).backgroundColor);
      const [r, gg, b] = bg.match(/\d+/g).map(Number); assert.ok(r < 40 && gg < 40 && b < 40, `dark panel (${bg})`);
      checks.push('dark');
    }
    await shot(page, `new-opened-${tag}.png`);
    await ctx.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors }));
} finally { await browser.close(); }
