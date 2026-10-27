import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// History, saved views, bulk edit, data location, holidays and the public API status page: Work › Team list with saved-view chips (save one,
// shared) and Select → the bulk bar (one POST /work-items/bulk, the items it could not change listed); the item panel's History tab (old →
// new); Desk queue selection; Settings › Security › Data location (Keep data in India), › General › Holidays (India preset), › Integrations ›
// Status page (publish); the public /status/{slug} page with no session. 1440 light and dark, and a 390 phone. Synthetic API only
// (made-up names); every write is checked.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/platform-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const g = (n) => `91000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const user = { id: g(1), displayName: 'Tara Tenali', email: 'tara@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false, mfaEnabled: true };
const tara = { id: user.id, name: user.displayName }, dev = { id: g(2), name: 'Dev Dorai' }, omi = { id: g(3), name: 'Omi Oberoi' };
const ws = { id: g(9), slug: 'kestrel', name: 'Kestrel Lending', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 3 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const members = [tara, dev, omi].map((p, i) => ({ userId: p.id, displayName: p.name, email: `${p.name.split(' ')[0].toLowerCase()}@example.test`, role: i ? 'Member' : 'Owner', joinedAt: '2026-01-01T00:00:00Z', jobRole: null }));
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const day = (n) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const pid = g(50);
const rowOf = (n, kind, title, o = {}) => ({ kind, id: g(100 + n), key: kind === 'ticket' ? `WT-${n}` : `LED-${n}`, title, projectId: kind === 'ticket' ? null : pid, projectKey: kind === 'ticket' ? null : 'LED',
  projectName: kind === 'ticket' ? null : 'Loan Ledger', status: o.status ?? 'To Do', category: o.category ?? 'Todo', priority: o.priority ?? 'Medium', dueDate: o.due ?? null, isOverdue: false,
  assignee: o.who === undefined ? dev : o.who, typeName: kind === 'ticket' ? 'Bug fix' : null, updatedAt: ago(n), slaStartAt: o.sla ? ago(2) : null, slaDueAt: o.sla ? new Date(Date.now() + o.sla * 60e3).toISOString() : null, slaState: o.sla ? 'Running' : null });
const rows = [
  rowOf(1, 'task', 'Reconcile the EMI ledger', { priority: 'High', due: day(2) }), rowOf(2, 'task', 'Statement PDF footer', { due: day(5) }),
  rowOf(3, 'ticket', 'Collections API timeouts', { priority: 'Critical', sla: 40 }), rowOf(4, 'ticket', 'NACH mandate stuck', { priority: 'High', who: null, sla: 200 }),
  rowOf(5, 'task', 'Bureau pull retry', { priority: 'Low', who: omi }),
];
const detail = (r) => ({ ...r, description: 'Mismatch between the ledger and the bank file.', startDate: null, reporter: tara, version: 4, createdAt: ago(72), completedAt: null, loggedMinutes: 0,
  detail: r.kind === 'task' ? { id: r.id, projectId: pid, statusId: g(61), statusName: 'To Do', canEdit: true, labels: [] } : { id: r.id, status: 'ToDo', workTypeId: g(81), workType: 'Bug fix', relatedProject: null, sla: null, can: { edit: true, delete: true } },
  activity: [{ type: 'change', id: g(900), at: ago(3), actor: tara, summary: 'LED-1: priority Medium → High', action: 'task.priority_changed' }], channel: r.kind === 'ticket' ? 'app' : null });
const history = [
  { id: g(700), at: ago(3), actor: tara, field: 'Priority', from: 'Medium', to: 'High' },
  { id: g(700), at: ago(3), actor: tara, field: 'Assignee', from: null, to: 'Dev Dorai' },
  { id: g(701), at: ago(30), actor: dev, field: 'Due date', from: day(-1), to: day(2) },
];
const apis = [{ apiId: g(400), name: 'Collections', documentTitle: 'Collections API' }, { apiId: g(401), name: 'Disbursal', documentTitle: 'Disbursal API' }];
const daysOf = (bad) => Array.from({ length: 90 }, (_, i) => ({ date: day(i - 89), state: bad.includes(89 - i) ? (89 - i === 0 ? 'down' : 'degraded') : 'up' }));
const publicStatus = { title: 'Kestrel API status', workspace: 'Kestrel Lending', state: 'outage', updatedAt: new Date().toISOString(), source: 'incidents',
  components: [{ name: 'Collections API', state: 'outage', uptime: 99.62, days: daysOf([0, 12, 40]) }, { name: 'Disbursal API', state: 'operational', uptime: 100, days: daysOf([]) }],
  incidents: [{ title: 'Collections API timeouts from [host] [address]', severity: 'major', startedAt: ago(2), resolvedAt: null, components: ['Collections API'] },
    { title: 'Slow mandate callbacks', severity: 'minor', startedAt: ago(24 * 12), resolvedAt: ago(24 * 12 - 3), components: ['Collections API'] }] };

const errors = [], checks = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const make = async (theme, state, signedIn = true) => {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
  await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); }, theme);
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
    if (ep === '/api/v1/public/status/kestrel-status') { assert.equal(req.headers().authorization, undefined, 'the public page sends no session'); return json(publicStatus); }
    if (ep.startsWith('/api/v1/public/status/')) return json({ message: 'Status page not found.', errors: [{ code: 'STATUS_PAGE_NOT_FOUND', message: 'Status page not found.' }] }, 404);
    if (!signedIn) { if (ep.endsWith('/auth/refresh')) return json({ message: 'Sign in', errors: [{ code: 'UNAUTHORIZED', message: 'Sign in' }] }, 401); return json(null); }
    if (method !== 'GET' && !ep.endsWith('/auth/refresh')) {
      const b = req.postDataJSON?.() ?? null; state.writes.push({ ep, method, b });
      if (ep === '/api/v1/work-items/bulk') {
        if (b.delete) return json({ changed: b.ids.length, failed: [] });
        return json(b.priority === 'Low' ? { changed: 1, failed: [{ id: b.ids[1], key: 'LED-2', reason: 'You cannot change this task.' }] } : { changed: b.ids.length, failed: [] });
      }
      if (ep === '/api/v1/saved-views' && method === 'POST') { const v = { id: g(800 + state.views.length), scope: b.scope, name: b.name, sharing: b.sharing, teamId: null, teamName: null, ownerId: tara.id, ownerName: tara.name, mine: true, config: b.config, createdAt: new Date().toISOString() }; state.views.push(v); return json(v, 201); }
      if (ep.startsWith('/api/v1/saved-views/') && method === 'DELETE') { state.views = state.views.filter((v) => !ep.endsWith(v.id)); return route.fulfill({ status: 204, body: '' }); }
      if (ep === '/api/v1/settings/data-location' && method === 'PUT') { state.location.keepDataInIndia = b.keepDataInIndia; return json(state.location); }
      if (ep === '/api/v1/holidays/preset') { state.holidays = [{ id: g(600), date: `${b.year}-01-26`, name: 'Republic Day', region: null }, { id: g(601), date: `${b.year}-08-15`, name: 'Independence Day', region: null }, { id: g(602), date: `${b.year}-11-08`, name: 'Diwali (Deepavali)', region: null }]; return json({ added: 3, alreadyThere: 0, holidays: state.holidays }); }
      if (ep === '/api/v1/holidays' && method === 'POST') { const h = { id: g(650), date: b.date, name: b.name, region: b.region }; state.holidays.push(h); return json(h, 201); }
      if (ep === '/api/v1/status-page' && method === 'PUT') { Object.assign(state.status, { slug: b.slug, title: b.title, published: b.published, components: b.components, url: b.published ? `/status/${b.slug}` : null }); return json(state.status); }
      if (ep === '/api/v1/operations/triage' || ep.includes('/ai/')) { state.writes.pop(); return json({ workType: null, priority: null, assignee: null, duplicates: [], routed: null }); }
      assert.fail(`Unexpected write: ${method} ${ep}`);
    }
    let data = null;
    if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
    else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, reportCount: 2,
      permissions: ['projects.view', 'projects.edit', 'projects.create', 'tasks.view', 'tasks.create', 'tasks.edit', 'work.create', 'work.view', 'org.manage', 'reports.view', 'reports.broad', 'members.manage', 'labels.manage', 'audit.view'],
      modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 3, activity: 3, documents: 3, people: 3, reports: 3, billing: 3, members: 3, audit: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { RESOURCE_MANAGEMENT: 1 } } };
    else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
    else if (ep === '/api/v1/workspace/members') data = members;
    else if (ep === '/api/v1/work-items') { const kind = sp.get('kind'); const list = kind === 'ticket' ? rows.filter((r) => r.kind === 'ticket') : rows; data = { items: list, offset: 0, limit: 200, hasMore: false }; }
    else if (ep.match(/^\/api\/v1\/work-items\/[0-9a-f-]{36}\/history$/)) { state.historyAsked = true; data = history; }
    else if (ep.match(/^\/api\/v1\/work-items\/[0-9a-f-]{36}$/)) data = detail(rows.find((r) => ep.endsWith(r.id)) ?? rows[0]);
    else if (ep === '/api/v1/saved-views') data = state.views.filter((v) => v.scope === sp.get('scope'));
    else if (ep === '/api/v1/teams') data = [{ id: g(30), name: 'Collections squad', description: null, memberCount: 3, projectCount: 1, lead: tara }];
    else if (ep === '/api/v1/labels') data = [{ id: g(31), name: 'Regulatory', color: '#ff9500' }];
    else if (ep === '/api/v1/projects') data = { items: [{ id: pid, key: 'LED', name: 'Loan Ledger' }], page: 1, pageSize: 100, totalItems: 1, totalPages: 1 };
    else if (ep === '/api/v1/workload') data = { totals: { open: 5, overdue: 0 }, members: [{ userId: dev.id, name: dev.name, open: 3, overdue: 0 }, { userId: omi.id, name: omi.name, open: 2, overdue: 0 }] };
    else if (ep === '/api/v1/settings/data-location') data = state.location;
    else if (ep === '/api/v1/holidays') data = state.holidays;
    else if (ep === '/api/v1/status-page') data = state.status;
    else if (ep.endsWith('/ai/status')) data = { enabled: true, configured: true, entitled: true, allowedHere: true };
    else if (ep === '/api/v1/notifications/counts') data = { unread: 0, needsYou: 0, forInfo: 0, snoozed: 0 };
    else if (ep === '/api/v1/notifications') data = { items: [], page: 1, pageSize: 20, totalPages: 0, totalItems: 0 };
    else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
    else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
    else if (ep.startsWith('/api/v1/me/ui/')) data = { key: 'x', value: null, updatedAt: null };
    else if (ep === '/api/v1/settings/changes' || ep.startsWith('/api/v1/settings/')) data = { items: [] };
    else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
    else if (ep.endsWith('s')) data = [];
    return json(data);
  });
  return ctx;
};
const fresh = () => ({ writes: [], views: [{ id: g(799), scope: 'work', name: 'Ledger critical', sharing: 'workspace', teamId: null, teamName: null, ownerId: dev.id, ownerName: dev.name, mine: false, config: { list: 'team', group: 'kind', sort: 'priority', show: 'open' }, createdAt: ago(48) }],
  location: { region: 'asia-south1', regionName: 'Mumbai, India', backupRegionName: 'Mumbai, India', country: 'India', keepDataInIndia: false, canManage: true,
    providers: [{ key: 'anthropic', name: 'Claude (Anthropic)', location: 'United States', inIndia: false, inUse: true }, { key: 'slack', name: 'Slack', location: 'United States', inIndia: false, inUse: false }] },
  holidays: [], status: { canManage: true, slug: 'kestrel', title: 'Kestrel Lending API status', published: false, publishedAt: null, components: [], available: apis, url: null }, historyAsked: false });
const shot = async (page, name) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(350); await page.screenshot({ path: path.join(out, name), fullPage: true }); };
const waitFor = async (state, test) => { for (let i = 0; i < 50 && !state.writes.some(test); i++) await new Promise((r) => setTimeout(r, 100)); return state.writes.find(test); };

try {
  // ------------------------------------------------------------------ Work › Team: saved views, select, bulk edit, History
  const state = fresh();
  const ctx = await make('light', state);
  const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 960 });
  try {
    await page.goto(`${origin}/kestrel/work?tab=team`);
    const list = page.getByRole('region', { name: 'Work list' });
    await list.waitFor();
    const views = list.getByRole('toolbar', { name: 'Views' });
    await views.getByRole('button', { name: 'Ledger critical', exact: true }).click();
    assert.equal(await views.getByRole('button', { name: 'Ledger critical', exact: true }).getAttribute('aria-pressed'), 'true', 'the applied view is lit');
    assert.ok(await list.getByRole('group', { name: 'Tickets' }).isVisible(), 'grouped by kind from the view');
    await list.getByLabel('Sort by').selectOption('due');
    assert.equal(await views.getByRole('button', { name: 'Ledger critical', exact: true }).getAttribute('aria-pressed'), 'false');
    await views.getByRole('button', { name: 'Save view' }).click();
    const dlg = page.getByRole('dialog', { name: 'Save view' });
    await dlg.getByLabel('View name').fill('Due soon');
    await dlg.getByRole('tab', { name: 'Everyone' }).click();
    await dlg.getByRole('button', { name: 'Save view' }).click();
    const saved = await waitFor(state, (w) => w.ep === '/api/v1/saved-views');
    assert.equal(saved.b.scope, 'work'); assert.equal(saved.b.sharing, 'workspace'); assert.equal(saved.b.config.sort, 'due'); assert.equal(saved.b.config.list, 'team');
    await views.getByRole('button', { name: 'Due soon', exact: true }).waitFor();
    checks.push('saved views');

    await list.getByRole('button', { name: 'Select' }).click();
    await list.getByRole('checkbox', { name: /Select LED-1 / }).check();
    await list.getByRole('checkbox', { name: /Select WT-3 / }).check();
    const bar = page.getByRole('toolbar', { name: 'Change the selected items' });
    await bar.waitFor();
    assert.match(await bar.innerText(), /2 selected/);
    await shot(page, 'work-bulk-1440.png');
    await bar.getByLabel('Set priority').selectOption('Critical');
    const bulk = await waitFor(state, (w) => w.ep === '/api/v1/work-items/bulk');
    assert.deepEqual(bulk.b, { ids: [rows[0].id, rows[2].id], priority: 'Critical' });
    checks.push('bulk priority');
    // Select a group, and an item left out is named with why.
    await list.getByRole('button', { name: 'Select' }).click();
    await list.getByRole('checkbox', { name: 'Select all in Tasks' }).check();
    await bar.getByLabel('Set priority').selectOption('Low');
    await bar.getByText('You cannot change this task.').waitFor();
    const second = state.writes.filter((w) => w.ep === '/api/v1/work-items/bulk')[1];
    assert.equal(second.b.ids.length, 3, 'every task in the group');
    await bar.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    const del = await waitFor(state, (w) => w.ep === '/api/v1/work-items/bulk' && w.b.delete);
    assert.equal(del.b.ids.length, 3);
    checks.push('bulk failures and delete');

    // The item panel: Activity · History.
    await page.goto(`${origin}/kestrel/work?tab=team&item=${rows[0].id}`);
    const hist = page.getByRole('tab', { name: 'History' });
    await hist.click();
    const h = page.getByRole('list', { name: 'History' });
    await h.waitFor();
    assert.ok(state.historyAsked);
    const text = await h.innerText();
    assert.match(text, /Tara Tenali changed 2 fields/);
    assert.match(text, /Priority\s*Medium\s*→\s*High/);
    assert.match(text, /Assignee\s*none\s*→\s*Dev Dorai/);
    await shot(page, 'history-1440.png');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark')); await shot(page, 'history-dark-1440.png');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    checks.push('history');

    // ------------------------------------------------------------------ Desk: select in the queue
    await page.goto(`${origin}/kestrel/desk`);
    const queue = page.getByRole('region', { name: 'Live queue' });
    await queue.waitFor();
    await queue.getByRole('button', { name: 'Select' }).click();
    await queue.getByRole('checkbox', { name: /Select WT-4 / }).check();
    const dbar = page.getByRole('toolbar', { name: 'Change the selected items' });
    await dbar.getByLabel('Set owner').selectOption(dev.id);
    const db = await waitFor(state, (w) => w.ep === '/api/v1/work-items/bulk' && w.b.assigneeId);
    assert.deepEqual(db.b, { ids: [rows[3].id], assigneeId: dev.id });
    await queue.getByRole('button', { name: 'Unassigned' }).click();
    assert.ok(await queue.getByRole('toolbar', { name: 'Views' }).isVisible());
    await shot(page, 'desk-1440.png');
    checks.push('desk bulk');

    // ------------------------------------------------------------------ Settings
    await page.goto(`${origin}/kestrel/settings/security/data-location`);
    const keep = page.getByRole('switch', { name: 'Keep data in India' });
    await keep.waitFor();
    assert.match(await page.locator('.pv-pane').innerText(), /Mumbai, India/);
    assert.doesNotMatch(await page.locator('.pv-pane').innerText(), /postgres|10\.\d|internal/i);
    await keep.click();
    await page.getByRole('dialog').getByRole('button', { name: 'Keep data in India' }).click();
    const loc = await waitFor(state, (w) => w.ep === '/api/v1/settings/data-location');
    assert.deepEqual(loc.b, { keepDataInIndia: true });
    await page.waitForTimeout(300);
    await shot(page, 'data-location-1440.png');
    checks.push('data location');

    await page.goto(`${origin}/kestrel/settings/general/holidays`);
    await page.getByRole('button', { name: /Add India’s \d{4} holidays/ }).click();
    const pre = await waitFor(state, (w) => w.ep === '/api/v1/holidays/preset');
    assert.equal(pre.b.country, 'IN');
    await page.getByText('Independence Day').waitFor();
    await page.getByLabel('Holiday date').fill(`${pre.b.year}-04-09`);
    await page.getByLabel('Holiday name').fill('Ugadi');
    await page.getByLabel('Where it is observed').fill('Telangana');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    const hol = await waitFor(state, (w) => w.ep === '/api/v1/holidays' && w.method === 'POST');
    assert.deepEqual(hol.b, { date: `${pre.b.year}-04-09`, name: 'Ugadi', region: 'Telangana' });
    await shot(page, 'holidays-1440.png');
    checks.push('holidays');

    await page.goto(`${origin}/kestrel/settings/integrations/status-page`);
    await page.getByRole('switch', { name: 'Show Collections' }).click();
    await page.getByLabel('Name shown for Collections').fill('Collections API');
    await page.locator('#sp-slug').fill('kestrel-status');
    await page.getByRole('button', { name: 'Publish' }).click();
    const pub = await waitFor(state, (w) => w.ep === '/api/v1/status-page');
    assert.deepEqual(pub.b, { slug: 'kestrel-status', title: 'Kestrel Lending API status', published: true, components: [{ apiId: apis[0].apiId, name: 'Collections API' }] });
    await page.getByText('Published', { exact: true }).waitFor();
    await shot(page, 'status-settings-1440.png');
    checks.push('status page settings');

    // ------------------------------------------------------------------ phone
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/kestrel/work?tab=team`);
    await list.waitFor();
    await list.getByRole('button', { name: 'Select' }).click();
    await list.getByRole('checkbox', { name: /Select LED-1 / }).check();
    await bar.waitFor(); await page.waitForTimeout(400);
    await fitsPhone(page, 'work list with bulk bar', assert);
    await shot(page, 'work-bulk-390.png');
    await page.goto(`${origin}/kestrel/work?tab=team&item=${rows[0].id}`);
    await page.getByRole('tab', { name: 'History' }).click(); await page.getByRole('list', { name: 'History' }).waitFor();
    await fitsPhone(page, 'history', assert); await shot(page, 'history-390.png');
    await page.goto(`${origin}/kestrel/settings/security/data-location`); await page.getByRole('switch', { name: 'Keep data in India' }).waitFor();
    await fitsPhone(page, 'data location', assert); await shot(page, 'data-location-390.png');
    await page.goto(`${origin}/kestrel/settings/general/holidays`); await page.getByLabel('Holiday name').waitFor();
    await fitsPhone(page, 'holidays', assert); await shot(page, 'holidays-390.png');
    checks.push('phone');
    assert.deepEqual(errors, []);
  } catch (e) { await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {}); console.log('URL:', page.url()); console.log('errors:', errors); throw e; }
  await ctx.close();

  // ------------------------------------------------------------------ the public status page, signed out
  for (const theme of ['light', 'dark']) {
    const pctx = await make(theme, fresh(), false);
    const p = await pctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    await p.setViewportSize({ width: 1440, height: 960 });
    await p.goto(`${origin}/status/kestrel-status`);
    await p.getByRole('heading', { name: 'Kestrel API status' }).waitFor();
    assert.equal(await p.getByRole('status').innerText(), 'Some systems are down');
    assert.equal(await p.locator('.st-bars').first().locator('i').count(), 90);
    assert.equal(await p.locator('.st-bars').first().locator('i.down').count(), 1);
    const body = await p.locator('main').innerText();
    assert.match(body, /99\.62% uptime/); assert.match(body, /Collections API timeouts from \[host\]/);
    await shot(p, `status-public-${theme}-1440.png`);
    if (theme === 'light') {
      await p.setViewportSize({ width: 390, height: 844 }); await p.waitForTimeout(300);
      await fitsPhone(p, 'public status', assert); await shot(p, 'status-public-390.png');
      await p.goto(`${origin}/status/nobody-here`); await p.getByRole('heading', { name: 'Status page not found' }).waitFor();
    }
    await pctx.close();
  }
  checks.push('public status');
  assert.deepEqual(errors, []);
  console.log('platform ui ok:', checks.join(', '));
} finally { await browser.close(); }
