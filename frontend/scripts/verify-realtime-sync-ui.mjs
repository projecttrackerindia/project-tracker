// Realtime sync, end to end in two browsers: user A edits a work item (title, status, due date) and comments on it; user B, with the list and
// the item's panel open, sees each change within 1 s without reloading. Then B's connection drops (the laptop sleeps, the phone goes to the
// background) while A keeps editing; when it comes back, B catches up through /realtime/changes and nothing is missed. The live connection is
// a synthetic SignalR hub (JSON protocol over a routed WebSocket) in front of the same synthetic API as verify-v2-work-ui. Latencies are
// printed (commit at the synthetic server -> visible on B's screen). Fictional people and data only.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { appCsp } from './lib/csp.mjs';

// v2 Work: My work · Team · Tickets with Projects › as a link; one list on /work-items (kind chip, priority dot, owner, due in red when
// late, group and sort; filters only past 10 items); the side panel deep-linked by ?item= (four tiles saved as you go with the version,
// a 409 reloads and says so, ✦ Copilot with one action, one Activity stream, "log 2h", a ticket's SLA / channel / resolution, adding a
// file); a project's work with List / Board / Timeline; + New making a ticket and opening it; old links landing on /work?item=; Team's
// capacity view still reachable. 1440 light and dark, and a 390 phone. Synthetic API only; every write is checked.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/realtime-sync');
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
  await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pt_classic_pages', '1'); localStorage.setItem('pm_theme', t); }, theme);
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
    else if (ep === '/api/v1/dev-links/status') {
      // Pull request + checks chips: the overdue task has an open pull request with failing checks, CreditVision a merged one.
      const ids = (sp.get('ids') ?? '').split(','); state.prAsks = (state.prAsks ?? 0) + 1;
      const pr = (key, number, st, checks) => { const w = items.find((x) => x.key === key); return w && ids.includes(w.id) ? [{ itemId: w.id, pulls: [{ number, state: st, checks, url: `https://github.com/fictive/payments/pull/${number}`, title: w.title, repository: 'fictive/payments' }] }] : []; };
      data = [...pr('PAY-7', '412', 'open', 'failure'), ...pr('PAY-2', '398', 'merged', 'success')];
    }
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

// ---------------------------------------------------------------- the synthetic hub and change log
const RS = '\x1e';
const hub = { sockets: new Set(), version: 5000, log: [], offline: new Set(), connections: 0 };
const publish = (ev) => {
  const e = { tenantId: ws.id, projectId: pid, actorId: ravi.id, changedFields: null, op: 'updated', ...ev, version: ++hub.version, at: new Date().toISOString() };
  hub.log.push(e);
  if (process.env.RT_DEBUG) console.log('publish', Date.now() % 100000, e.version, [...hub.sockets].map((s) => s.who + ':' + s.invoked.join('/')).join(' '));
  for (const s of hub.sockets) if (!hub.offline.has(s.who)) s.ws.send(JSON.stringify({ type: 1, target: 'sync', arguments: [[e]] }) + RS);
  return e;
};
const live = async (ctx, who) => {
  await ctx.route('**/hubs/chat/negotiate**', async (route) => {
    if (hub.offline.has(who)) { await route.fulfill({ status: 503, body: '' }); return; }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ connectionId: `c-${who}`, connectionToken: `t-${who}-${++hub.connections}`, negotiateVersion: 1,
      availableTransports: [{ transport: 'WebSockets', transferFormats: ['Text', 'Binary'] }] }) });
  });
  await ctx.routeWebSocket(/\/hubs\/chat/, (socket) => {
    const entry = { ws: socket, who, invoked: [] };
    hub.sockets.add(entry);
    const ping = setInterval(() => { try { socket.send(JSON.stringify({ type: 6 }) + RS); } catch { /* closed */ } }, 5000);
    socket.onMessage((raw) => {
      for (const frame of String(raw).split(RS).filter(Boolean)) {
        const m = JSON.parse(frame);
        if (m.protocol) { socket.send('{}' + RS); continue; }
        if (m.type === 1) { entry.invoked.push(m.target); if (m.invocationId) socket.send(JSON.stringify({ type: 3, invocationId: m.invocationId, result: m.target === 'Ping' ? new Date().toISOString() : null }) + RS); }
      }
    });
    socket.onClose(() => { clearInterval(ping); hub.sockets.delete(entry); });
  });
  if (process.env.RT_DEBUG) await ctx.route('**/api/v1/**', async (route) => { const u = new URL(route.request().url()); if (!u.pathname.includes('realtime')) console.log(who, Date.now() % 100000, route.request().method(), u.pathname + u.search); await route.fallback(); });
  await ctx.route('**/api/v1/realtime/changes**', async (route) => {
    const since = Number(new URL(route.request().url()).searchParams.get('since') ?? 0);
    hub.catchUps = (hub.catchUps ?? []).concat({ who, since });
    const changes = since > 0 ? hub.log.filter((e) => e.version > since) : [];
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { version: hub.version, reset: false, changes } }) });
  });
};

const latency = {};
const timed = async (label, page, test, act, arg = null) => {
  const t0 = Date.now();
  await act();
  try { await page.waitForFunction(test, arg, { polling: 16, timeout: 5000 }); }
  catch (e) { console.log('FAILED', label, JSON.stringify(await page.evaluate(() => ({ lat: window.__pmLiveLatency, text: document.body.innerText.slice(0, 1500) })))); await page.screenshot({ path: path.join(out, `fail-${label}.png`) }); throw e; }
  const ms = Date.now() - t0;
  (latency[label] ??= []).push(ms);
  return ms;
};

try {
  const state = { items: seed(), writes: [], lists: [], bump: false };
  const ctxA = await make('light', state), ctxB = await make('light', state);
  await live(ctxA, 'A'); await live(ctxB, 'B');
  const a = await ctxA.newPage(), b = await ctxB.newPage();
  watch(a); watch(b);
  for (const p of [a, b]) await p.setViewportSize({ width: 1440, height: 1000 });
  const item = state.items.find((w) => w.key === 'PAY-2');
  await a.goto(`${origin}/preview-org/work?project=${pid}`);
  await b.goto(`${origin}/preview-org/work?project=${pid}`);
  await b.getByText(item.title).first().waitFor();
  await waitFor(() => [...hub.sockets].some((s) => s.who === 'B'), "B's live connection");
  await waitFor(() => (hub.catchUps ?? []).some((c) => c.who === 'B'), "B's starting version");
  await b.waitForTimeout(500);
  const listsBefore = state.lists.length;

  // A edits (through the API the app uses); the server commits and publishes; B's list shows it.
  const edit = (patch, fields) => async () => {
    Object.assign(item, patch); item.version += 1; item.updatedAt = new Date().toISOString();
    publish({ type: 'task', id: item.id, changedFields: fields });
  };
  for (let i = 1; i <= 5; i++) {
    const title = `CreditVision score API integration v${i}`;
    await timed('title', b, (t) => document.body.innerText.includes(t), edit({ title }, ['title']), title);
  }
  checks.push('title edits appear on B');
  await b.waitForTimeout(300);
  // Targeted, not a storm: a title edit re-reads only the open lists that hold that item (the open lists on this screen that show it), once per edit.
  const perEdit = (state.lists.length - listsBefore) / 5;
  console.log('list reads per title edit', perEdit);
  assert.ok(perEdit <= 4, `a title edit re-reads only the open lists holding it (${perEdit} per edit)`);
  // A completes it: it leaves B's open list.
  await timed('status', b, () => !document.body.innerText.includes('CreditVision score API integration v5'), edit({ status: 'Done' }, ['statusId']));
  item.status = 'In Progress'; item.version += 1; publish({ type: 'task', id: item.id, changedFields: ['statusId'] });
  await b.getByText('CreditVision score API integration v5').first().waitFor();
  checks.push('status change moves the row on B');
  const due = day(9);
  const dueLabel = new Date(`${due}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const rowText = () => b.evaluate(() => { const t = document.body.innerText; const i = t.indexOf('CreditVision score API integration v5'); return t.slice(i, i + 80); });
  assert.ok(!(await rowText()).includes(dueLabel), 'the new due date is not there before');
  await timed('dueDate', b, (v) => { const t = document.body.innerText; const i = t.indexOf('CreditVision score API integration v5'); return i >= 0 && t.slice(i, i + 80).includes(v); }, edit({ dueDate: due }, ['dueDate']), dueLabel);
  checks.push('due date change reaches B');

  // B opens the item; A comments; the comment appears in B's panel.
  await b.goto(`${origin}/preview-org/work?item=${item.id}`);
  await b.getByText('CreditVision score API integration v5').first().waitFor();
  await waitFor(() => [...hub.sockets].some((s) => s.who === 'B'), "B's live connection again");
  await waitFor(() => (hub.catchUps ?? []).filter((c) => c.who === 'B').length >= 2, 'B caught up after opening');
  await b.waitForTimeout(400);
  for (let i = 1; i <= 3; i++) {
    const body = `Ravi: checked the sandbox logs, run ${i}`;
    await timed('comment', b, (t) => document.body.innerText.includes(t), async () => {
      item.activity.push({ type: 'comment', id: g(700 + i), at: new Date().toISOString(), actor: ravi, summary: 'commented', body });
      publish({ type: 'comment', id: g(700 + i), parentId: item.id, op: 'created' });
    }, body);
  }
  checks.push('comments appear in B’s open panel');

  // ---------------------------------------------------------------- offline, then back: the catch-up
  hub.offline.add('B');
  for (const s of [...hub.sockets]) if (s.who === 'B') await s.ws.close();
  await b.waitForTimeout(300);
  item.title = 'CreditVision score API integration (renamed while B slept)'; item.version += 1; publish({ type: 'task', id: item.id, changedFields: ['title'] });
  item.activity.push({ type: 'comment', id: g(799), at: new Date().toISOString(), actor: ravi, summary: 'commented', body: 'Missed while offline' });
  publish({ type: 'comment', id: g(799), parentId: item.id, op: 'created' });
  await b.waitForTimeout(800);
  assert.ok(!(await b.evaluate(() => document.body.innerText.includes('Missed while offline'))), 'B is really offline');
  const before = (hub.catchUps ?? []).filter((c) => c.who === 'B').length;
  const t0 = Date.now();
  hub.offline.delete('B');
  await b.evaluate(() => window.dispatchEvent(new Event('online')));
  await b.waitForFunction(() => document.body.innerText.includes('Missed while offline') && document.body.innerText.includes('renamed while B slept'), null, { polling: 16, timeout: 15000 });
  latency.catchUp = [Date.now() - t0];
  const asked = (hub.catchUps ?? []).filter((c) => c.who === 'B').slice(before);
  assert.ok(asked.some((c) => c.since > 0 && c.since < hub.version), `B asked for the changes it missed: ${JSON.stringify(asked)}`);
  checks.push('offline -> reconnect catch-up');
  await b.screenshot({ path: path.join(out, 'realtime-b-1440.png') });

  const stats = Object.fromEntries(Object.entries(latency).map(([k, v]) => [k, { n: v.length, median: v.slice().sort((x, y) => x - y)[Math.floor(v.length / 2)], max: Math.max(...v) }]));
  console.log('latency (ms)', JSON.stringify(stats));
  for (const [k, v] of Object.entries(latency)) if (k !== 'catchUp') assert.ok(Math.max(...v) < 1000, `${k} reached B within 1 s (max ${Math.max(...v)} ms)`);
  await fs.writeFile(path.join(out, 'latency.json'), JSON.stringify(stats, null, 2));
  assert.deepEqual(errors.filter((e) => !/WebSocket|signalr|hubs\/chat|503/i.test(e)), []);
  console.log('OK', checks);
} finally {
  await browser.close();
}
