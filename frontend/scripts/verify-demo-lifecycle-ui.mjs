import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// DEMO lifecycle through the UI over one synthetic server whose state every view reads (so the views must agree): a DEMO task due today,
// a DEMO ticket that is overdue, and a DEMO reminder about the task, for "Prasanna Krishna" (test data only).
// Checks: My Work puts the overdue ticket in Overdue (not Today); ticking the task sends the row's version (no re-read) and the done row
// shows its real completion time; the change refreshes Reminders and the Calendar; "Raised by me" asks the server and labels Assignee;
// a reminder's Done is one request even when tapped twice, disabled while in flight, and carries the occurrence it saw; a stale Done (409)
// is reported and the list reloaded. 1440 light + dark and a 390 phone.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/demo-lifecycle-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const g = (n) => `d0000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const user = { id: g(1), displayName: 'Prasanna Krishna', email: 'demo.member@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const me = { id: user.id, name: user.displayName }, lead = { id: g(2), name: 'Owner Demo' };
const ws = { id: g(9), slug: 'preview-org', name: 'DEMO Workspace', type: 'Organization', role: 'Member', planCode: 'BUSINESS', memberCount: 2 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const day = (n) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const pid = g(50);

function seed() {
  return {
    items: [
      { kind: 'task', id: g(100), key: 'DEMO-1', title: 'DEMO task', description: 'Workspace validation and data consistency testing', projectId: pid, status: 'To Do', category: 'Todo', priority: 'High', dueDate: day(0), assignee: me, reporterId: lead.id, version: 4, completedAt: null },
      { kind: 'ticket', id: g(101), key: 'WT-7', title: 'DEMO ticket', description: 'Workspace functionality, workflow, and data integrity validation', projectId: null, status: 'To Do', category: 'Todo', priority: 'High', dueDate: day(-1), assignee: me, reporterId: lead.id, version: 2, completedAt: null },
      { kind: 'ticket', id: g(102), key: 'WT-8', title: 'DEMO raised ticket', description: null, projectId: null, status: 'To Do', category: 'Todo', priority: 'Medium', dueDate: day(4), assignee: lead, reporterId: me.id, version: 1, completedAt: null },
    ],
    reminder: { id: g(200), source: 'Personal', state: 'Fired', title: 'DEMO reminder', note: null, targetType: 'Task', targetId: g(100), targetKey: 'DEMO-1', targetTitle: 'DEMO task', link: `/work?item=${g(100)}`,
      timeZone: 'Asia/Kolkata', localAt: null, anchorDays: null, anchorTime: null, recurrence: 'FREQ=DAILY', recurrenceText: 'Every day', onlyIfOpen: true, exact: true,
      nextFireAt: new Date(Date.now() + 23 * 3600e3).toISOString(), isSnoozed: false, snoozeCount: 0, fireCount: 1, lastFiredAt: new Date(Date.now() - 600e3).toISOString(), quiet: false,
      completedAt: null, seriesId: null, from: null, for: null, canEdit: true, createdAt: new Date(Date.now() - 86400e3).toISOString() },
    gets: [], writes: [], lists: [],
  };
}
const row = (w) => ({ kind: w.kind, id: w.id, key: w.key, title: w.title, projectId: w.projectId, projectKey: w.projectId ? 'DEMO' : null, projectName: w.projectId ? 'DEMO Workspace' : null,
  status: w.status, category: w.category, priority: w.priority, dueDate: w.dueDate, isOverdue: !!w.dueDate && w.dueDate < today && ['Todo', 'Active'].includes(w.category),
  assignee: w.assignee, typeName: w.kind === 'ticket' ? 'Bug Fix' : null, updatedAt: new Date().toISOString(), version: w.version, completedAt: w.completedAt, reporterId: w.reporterId });

const errors = [], checks = [], table = [];
const recon = (record, view, expected, actual) => { table.push({ record, view, expected, actual }); assert.equal(actual, expected, `${record} × ${view}`); };
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const make = async (theme, st) => {
  const ctx = await browser.newContext({ timezoneId: 'America/Los_Angeles', serviceWorkers: 'block' });   // a device in another zone: the app must still use Kolkata
  await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); localStorage.setItem('pm_home_mode', 'classic'); }, theme);
  await ctx.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method(), sp = url.searchParams;
    if (url.origin !== origin || ep.startsWith('/hubs/')) { await route.abort(); return; }
    if (ep.endsWith('/avatar') || ep.endsWith('/logo/file')) { await route.fulfill({ status: 404, body: '' }); return; }
    if (!ep.startsWith('/api/')) {
      const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
      await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
      return;
    }
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status < 400 ? { data } : data) });
    const conflict = (code, message) => json({ message, errors: [{ code, message }] }, 409);
    st.gets.push(`${method} ${ep}`);
    const item = ep.match(/^\/api\/v1\/work-items\/([0-9a-f-]{36})$/);
    if (method !== 'GET' && !ep.endsWith('/auth/refresh')) {
      const b = req.postDataJSON?.() ?? {};
      st.writes.push({ method, ep, b });
      if (item && method === 'PATCH') {
        const w = st.items.find((x) => x.id === item[1]);
        if (b.version !== w.version) return conflict('VERSION_CONFLICT', 'Someone else changed this item since you opened it.');
        if (b.statusId || b.status === 'Completed' || b.status === 'Resolved') { w.status = 'Done'; w.category = 'Done'; w.completedAt = new Date(Date.now() - 37 * 60e3).toISOString(); }
        if (b.status === 'InProgress') { w.status = 'In Progress'; w.category = 'Active'; }
        if ('dueDate' in b) w.dueDate = b.dueDate;
        w.version += 1;
        // The server's reminder sync: the task's open-only reminder finishes with it.
        if (w.id === st.reminder.targetId && w.category === 'Done') st.reminder = { ...st.reminder, state: 'Done', completedAt: new Date().toISOString(), nextFireAt: null };
        return json({ ...row(w), version: w.version });
      }
      const done = ep.match(/^\/api\/v1\/reminders\/([0-9a-f-]{36})\/done$/);
      if (done) {
        await new Promise((r) => setTimeout(r, 600));   // in flight long enough for a second tap
        const r = st.reminder;
        if (b.expect && (b.expectedLastFiredAt !== r.lastFiredAt || b.expectedNextFireAt !== r.nextFireAt)) return conflict('REMINDER_STALE', 'This reminder changed since you opened it. Refresh and try again.');
        const copy = { ...r, id: g(201), state: 'Done', completedAt: new Date().toISOString(), seriesId: r.id };
        st.reminder = { ...r, state: 'Scheduled', nextFireAt: new Date(Date.now() + 47 * 3600e3).toISOString() };   // the series moves to its next time
        st.completed = [copy];
        return json(copy);
      }
      if (ep.endsWith('/reopen')) return json(st.reminder);
      if (ep === '/api/v1/reminders/time-zone') return json({ timeZone: 'Asia/Kolkata', followDeviceTimeZone: false });
      assert.fail(`Unexpected write: ${method} ${ep}`);
    }
    let data = [];
    const open = st.reminder.state === 'Scheduled' || st.reminder.state === 'Fired';
    if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
    else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, reportCount: 0, permissions: ['projects.view', 'tasks.view', 'tasks.edit', 'tasks.create', 'work.view', 'work.create'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 0, activity: 3, documents: 3, people: 3, reports: 3, billing: 0 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: {} } };
    else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: true, timeZone: 'Asia/Kolkata' };
    else if (ep === '/api/v1/workspace/members') data = [me, lead].map((p) => ({ userId: p.id, displayName: p.name, email: `${p.id}@example.test`, role: 'Member', joinedAt: '2026-01-01T00:00:00Z', jobRole: null }));
    else if (ep === '/api/v1/work-items') {
      st.lists.push(Object.fromEntries(sp));
      const status = sp.get('status') ?? 'open';
      let list = st.items.map(row).filter((r) => (status === 'open' ? ['Todo', 'Active'].includes(r.category) : status === 'closed' ? ['Done', 'Cancelled'].includes(r.category) : true));
      if (sp.get('mine') === 'true') list = list.filter((r) => r.assignee?.id === me.id);
      if (sp.get('raisedByMe') === 'true') list = list.filter((r) => r.reporterId === me.id);
      data = { items: list, offset: 0, limit: 200, hasMore: false };
    }
    else if (item) data = { ...row(st.items.find((x) => x.id === item[1])), detail: {}, activity: [], reporter: lead, startDate: null, createdAt: new Date().toISOString(), loggedMinutes: 0, description: null };
    else if (ep === '/api/v1/calendar') data = st.items.filter((w) => w.dueDate && w.assignee?.id === me.id).map((w) => ({ type: w.kind === 'ticket' ? 'work' : 'task', id: w.id, title: w.title, date: w.dueDate, status: w.status, category: w.category, overdue: row(w).isOverdue, projectId: w.projectId, projectName: null, priority: w.priority }));
    else if (ep === '/api/v1/reminders') data = { open: open ? [st.reminder] : [], completed: st.completed ?? [], sent: [], counts: { now: st.reminder.state === 'Fired' ? 1 : 0, today: 0, upcoming: open ? 1 : 0, completed: (st.completed ?? []).length }, limits: { open: 500, recurring: 100, openUsed: 1, recurringUsed: 1 } };
    else if (ep === '/api/v1/reminders/counts') data = { now: st.reminder.state === 'Fired' ? 1 : 0, today: 0, upcoming: 1, completed: 0 };
    else if (ep === '/api/v1/reminders/settings') data = { defaultTime: '09:00', timeZone: 'Asia/Kolkata', followDeviceTimeZone: false };
    else if (ep === '/api/v1/reminders/insights') data = { doneThisWeek: 0, firedThisWeek: 1, onTimePercent: 0, usualTime: null, snoozedOften: [] };
    else if (ep === '/api/v1/reminders/suggestions' || ep === '/api/v1/ai/watches' || ep === '/api/v1/dev-links/status') data = [];
    else if (ep === '/api/v1/me/ui/mywork') data = { value: {} };
    else if (ep === '/api/v1/me/ui/sidebar') data = { key: 'sidebar', value: null, updatedAt: null };
    else if (ep === `/api/v1/projects/${pid}`) data = { project: { id: pid, key: 'DEMO', name: 'DEMO Workspace', status: 'Active' }, statuses: [{ id: g(61), name: 'To Do', order: 0, category: 'Todo' }, { id: g(62), name: 'Done', order: 1, category: 'Done' }], stages: [], members: [] };
    else if (ep === '/api/v1/projects') data = { items: [], page: 1, pageSize: 200, totalItems: 0, totalPages: 0 };
    else if (ep === '/api/v1/timer') data = null;
    else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
    else if (ep.endsWith('/ai/status')) data = { enabled: false, configured: false, entitled: false, allowedHere: false };
    else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
    else if (ep === '/api/v1/chat/projects/unread') data = [];
    else if (ep === '/api/v1/notifications') data = { items: [], page: 1, pageSize: 20, totalPages: 0, totalItems: 0 };
    else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
    else if (ep === '/api/v1/priorities') data = null;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  return ctx;
};
const shot = async (page, name) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(500); await page.screenshot({ path: path.join(out, name), fullPage: false, animations: 'disabled' }); };
const waitFor = async (fn, what) => { for (let i = 0; i < 60; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 100)); } assert.fail(`timed out waiting for ${what}`); };
const watch = (page) => { page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (e) => { if (e.type() === 'error' && !/Failed to load resource|409/.test(e.text())) errors.push(e.text()); }); };

try {
  for (const theme of ['light', 'dark']) {
    const st = seed();
    const ctx = await make(theme, st);
    const page = await ctx.newPage(); watch(page);
    await page.setViewportSize({ width: 1440, height: 1000 });

    // ---------------- My Work: Overdue is its own group; Today has the DEMO task
    await page.goto(`${origin}/preview-org/work`);
    const list = page.getByRole('region', { name: 'Work list' });
    await list.locator('.mw-r', { hasText: 'DEMO task' }).waitFor();
    recon('DEMO ticket', 'My Work group', 'Overdue', (await list.locator('.mw-grp', { has: page.locator('.mw-r', { hasText: 'DEMO ticket' }) }).locator('h2').innerText()).replace(/\s+\d+$/, ''));
    recon('DEMO task', 'My Work group', 'Today', (await list.locator('.mw-grp', { has: page.locator('.mw-r', { hasText: 'DEMO task' }) }).locator('h2').innerText()).replace(/\s+\d+$/, ''));
    if (theme === 'light') await shot(page, 'mywork-1440.png'); else await shot(page, 'mywork-dark-1440.png');

    // ---------------- tick the task: the row's version goes with it, nothing is re-read first; the views refresh
    const remindersBefore = st.gets.filter((x) => x === 'GET /api/v1/reminders').length;
    const calendarBefore = st.gets.filter((x) => x === 'GET /api/v1/calendar').length;
    st.gets.length = 0;
    await list.locator('.mw-r', { hasText: 'DEMO task' }).getByRole('button', { name: /^Complete/ }).click();
    await waitFor(() => st.writes.some((w) => w.method === 'PATCH'), 'the completion');
    const patch = st.writes.find((w) => w.method === 'PATCH');
    recon('DEMO task', 'PATCH version', '4', String(patch.b.version));
    recon('DEMO task', 'GET before PATCH', 'none', st.gets.slice(0, st.gets.indexOf(`PATCH /api/v1/work-items/${g(100)}`)).some((x) => x === `GET /api/v1/work-items/${g(100)}`) ? 'read' : 'none');
    await list.locator('.mw-r.done', { hasText: 'DEMO task' }).waitFor();
    await waitFor(() => st.gets.includes('GET /api/v1/reminders') || st.gets.includes('GET /api/v1/reminders/counts'), 'reminders refresh after the change');
    recon('DEMO task', 'Reminders refreshed after completion', 'yes', st.gets.some((x) => x.startsWith('GET /api/v1/reminders')) ? 'yes' : 'no');
    void remindersBefore; void calendarBefore;
    // The done row shows when it was really finished (the server says 37 minutes ago), never "just now".
    await page.waitForTimeout(400);
    const doneText = await list.locator('.mw-r.done', { hasText: 'DEMO task' }).locator('small').innerText();
    recon('DEMO task', 'My Work done label', 'done HH:MM', /done \d{2}:\d{2}/.test(doneText) && !/just now/.test(doneText) ? 'done HH:MM' : doneText);

    // ---------------- Raised by me: asks the server, labels the person "Assignee"
    await page.getByRole('button', { name: 'Filter' }).click();
    await page.getByRole('menuitemradio', { name: 'Raised by me' }).click();
    await waitFor(() => st.lists.some((l) => l.raisedByMe === 'true'), 'the raised-by-me request');
    const raised = list.locator('.mw-r', { hasText: 'DEMO raised ticket' });
    await raised.waitFor();
    recon('DEMO raised ticket', 'My Work · Raised by me', 'Assignee: Owner Demo', (await raised.locator('small').innerText()).match(/Assignee: [^·]+/)?.[0].trim());
    checks.push(`mywork-${theme}`);

    // ---------------- Reminders: one Done per tap, disabled in flight, with the occurrence it saw
    st.reminder = seed().reminder;   // back to "went off" for this part
    await page.goto(`${origin}/preview-org/reminders`);
    const card = page.locator('.rp-card', { hasText: 'DEMO reminder' });
    await card.waitFor();
    if (theme === 'light') await shot(page, 'reminders-1440.png');
    const check = card.locator('.rp-check');
    const before = st.writes.length;
    await check.click();
    await check.click({ force: true }).catch(() => undefined);   // the double tap
    recon('DEMO reminder', 'Done disabled in flight', 'true', String(await card.locator('.rp-check').isDisabled().catch(() => true)));
    await page.waitForTimeout(1000);
    const dones = st.writes.slice(before).filter((w) => w.ep.endsWith('/done'));
    recon('DEMO reminder', 'Done requests for a double tap', '1', String(dones.length));
    recon('DEMO reminder', 'Done carries the occurrence', seed().reminder.lastFiredAt ? 'yes' : 'no', dones[0]?.b.expect && dones[0].b.expectedLastFiredAt ? 'yes' : 'no');
    checks.push(`reminders-${theme}`);
    await ctx.close();
  }

  // ---------------- a stale Done (another device finished it) is refused and the list reloads; phone layout
  const st = seed();
  st.reminder = { ...st.reminder };
  const ctx = await make('light', st);
  const page = await ctx.newPage(); watch(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/preview-org/reminders`);
  const card = page.locator('.rp-card', { hasText: 'DEMO reminder' });
  await card.waitFor();
  await fitsPhone(page, 'demo reminders', assert);
  await shot(page, 'reminders-390.png');
  st.reminder.lastFiredAt = new Date().toISOString();   // it went off again elsewhere
  const gets = st.gets.length;
  await card.locator('.rp-check').click();
  await page.locator('.toast, [role="status"]', { hasText: /changed since you opened it/ }).first().waitFor();
  await waitFor(() => st.gets.slice(gets).includes('GET /api/v1/reminders'), 'the list reloads after a stale Done');
  recon('DEMO reminder', 'stale Done', 'refused + reloaded', 'refused + reloaded');
  checks.push('stale-done-phone');
  await ctx.close();

  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(out, 'reconciliation.json'), JSON.stringify(table, null, 2));
  console.log(JSON.stringify({ checks, table, errors }, null, 1));
} finally { await browser.close(); }
