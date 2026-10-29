import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Portfolio › Plan sheet and the redesigned Portfolio timeline (design apple2 sections 1, round 3 and 8): the deep link, tabs, frozen header and
// Key/Title columns, keyboard editing (Enter / typing / Tab / Esc), the owner picker, a later due date asking for one reason, fill-down, the bulk bar,
// paste from Excel (preview checked on the server, then commit), the export menu, saved views, the phone cards with swipe-to-done; and the timeline:
// fit range, slip tag, hover card, labels never on the today line, drag a bar end with a reason, Quarter, dark and the phone list.
// Synthetic fixtures only (fictional people and projects).
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/plan-sheet-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false, mfaEnabled: true };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Riverline Payments', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 6 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const NOW = new Date('2026-10-29T10:30:00+05:30'), today = '2026-10-29';
const g = (n) => `71000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const P = { LF: [g(901), 'Lena Fischer'], TR: [g(902), 'Tomas Rivera'], RM: [g(903), 'Ravi Menon'], MO: [g(904), 'Mira Okafor'], AR: [user.id, 'Asha Rao'], JB: [g(906), 'Jonas Berg'], NH: [g(907), 'Noor Haddad'], KD: [g(908), 'Kiran Das'] };
const people = Object.values(P).map(([id, name]) => ({ id, name }));
const CVM = g(1), UPA = g(2), MOB = g(3);
const st = (pid, n) => ({ id: `${pid}-s${n}`, projectId: pid, name: ['To do', 'In progress', 'Blocked', 'Done'][n], category: ['Todo', 'Active', 'Active', 'Done'][n] });
const statuses = [CVM, UPA, MOB].flatMap((p) => [0, 1, 2, 3].map((n) => st(p, n)));
const ago = (h) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const row = (o) => ({ kind: 'task', parentId: null, level: 1, ownerId: null, owner: null, start: null, due: null, dueTime: null, durationDays: null, status: 'To do', category: 'Todo', statusId: null,
  progress: 0, dependsOn: [], cadence: null, nextAt: null, updatedAt: ago(5), updatedBy: 'Asha Rao', notes: null, late: false, atRisk: false, version: 3, canEdit: true, ...o });
const who = (k) => ({ ownerId: P[k][0], owner: P[k][1] });
const dur = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;
const task = (pid, id, key, title, k, start, due, sn, progress, extra = {}) => row({ id, projectId: pid, key, title, ...who(k), start, due, durationDays: start && due ? dur(start, due) : null,
  status: st(pid, sn).name, category: st(pid, sn).category, statusId: st(pid, sn).id, progress, ...extra });
const sheetRows = [
  row({ kind: 'project', id: CVM, projectId: CVM, level: 0, key: 'CVM', title: 'Card Vault Migration', ...who('LF'), start: '2026-09-02', due: '2026-11-14', status: 'At risk', category: 'AtRisk', progress: 62, notes: 'Forecast slipping 6d', atRisk: true }),
  task(CVM, g(11), 'CVM-12', 'Tokenise stored cards', 'TR', '2026-09-02', '2026-10-31', 1, 80, { dueTime: '18:00', atRisk: true, notes: 'Waiting on HSM keys', updatedAt: ago(2) }),
  task(CVM, g(12), 'CVM-12.1', 'HSM key ceremony', 'RM', '2026-10-20', '2026-10-27', 2, 30, { kind: 'subtask', level: 2, parentId: g(11), dependsOn: ['CVM-9'], late: true, notes: 'Vendor slot moved', updatedAt: ago(26) }),
  task(CVM, g(13), 'CVM-12.2', 'Re-encrypt archive', 'TR', '2026-10-28', '2026-11-07', 0, 0, { kind: 'subtask', level: 2, parentId: g(11), dependsOn: ['CVM-12.1'], updatedAt: ago(72) }),
  task(CVM, g(14), 'CVM-15', 'PCI evidence pack', 'MO', '2026-10-01', '2026-11-14', 1, 45, { dependsOn: ['CVM-12'], updatedAt: ago(1) }),
  row({ kind: 'meeting', id: g(15), projectId: CVM, key: 'MTG', title: 'Vault stand-up', ...who('LF'), status: 'Scheduled', category: 'Meeting', progress: null, cadence: 'Daily', nextAt: '2026-10-30T04:00:00Z', notes: '15 min', canEdit: false }),
  row({ kind: 'project', id: UPA, projectId: UPA, level: 0, key: 'UPA', title: 'UPI AutoPay', ...who('AR'), start: '2026-08-15', due: '2026-11-21', status: 'Late', category: 'Delayed', progress: 74, late: true }),
  task(UPA, g(21), 'UPA-4', 'Mandate registration API', 'RM', '2026-08-15', '2026-10-24', 1, 90, { late: true, notes: 'Late by 5 days', updatedAt: ago(24) }),
  task(UPA, g(22), 'UPA-7', 'Retry & notification rules', 'AR', '2026-09-20', '2026-11-12', 1, 55, { dependsOn: ['UPA-4'], updatedAt: ago(1) }),
  task(UPA, g(23), 'UPA-9', 'Bank sandbox certification', 'MO', '2026-11-03', '2026-11-21', 0, 0, { dependsOn: ['UPA-4'], notes: 'Needs sandbox date', updatedAt: null }),
  row({ kind: 'meeting', id: g(24), projectId: UPA, key: 'MTG', title: 'AutoPay weekly review', ...who('AR'), status: 'Scheduled', category: 'Meeting', progress: null, cadence: 'Weekly', nextAt: '2026-11-03T05:30:00Z', notes: 'Tue & Mon alt.', canEdit: false }),
  row({ kind: 'project', id: MOB, projectId: MOB, level: 0, key: 'MOB', title: 'Merchant Onboarding v2', ...who('TR'), start: '2026-08-04', due: '2026-10-24', status: 'On track', category: 'OnTrack', progress: 100 }),
  task(MOB, g(31), 'MOB-21', 'KYC document OCR', 'LF', '2026-08-04', '2026-10-10', 3, 100, { updatedAt: ago(24 * 14) }),
  row({ kind: 'meeting', id: g(32), projectId: MOB, key: 'MTG', title: 'Steering committee', ...who('TR'), status: 'Scheduled', category: 'Meeting', progress: null, cadence: 'Monthly', nextAt: '2026-11-05T10:30:00Z', notes: 'First Wed', canEdit: false }),
];
const sheet = () => ({ asOf: today, timeZone: 'Asia/Kolkata', rows: sheetRows, people, statuses, truncated: false, canEdit: true, meetings: true,
  scopes: [{ id: 'all', label: 'Everything I can see', allowed: true, why: null, teamId: null }, { id: 'mine', label: 'My work', allowed: true, why: null, teamId: null },
    { id: 'managed', label: 'Teams I manage', allowed: false, why: 'Comes with the organisation tree', teamId: null }, { id: 'team', label: 'Card Vault', allowed: true, why: null, teamId: g(800) }] });

// The timeline (design: Sep–Dec 2026, today 29 Oct).
const tp = (o) => ({ health: 'OnTrack', group: 'Delivery', originalDue: null, forecast: null, milestones: [], dependsOn: [], slipDays: 0, confidence: 'medium', forecastBasis: 'From pace, 4 wks: 6 done in 28 days, 9 open (medium confidence)',
  openTasks: 6, blockedTasks: 0, finishedLast28Days: 6, version: 4, status: 'Active', lastChange: null, ...o });
const ms = (id, name, due) => ({ id, name, due, status: 'Pending' });
const tl = { from: '2026-09-01', to: '2026-12-19', projects: [
  tp({ id: CVM, key: 'CVM', name: 'Card Vault Migration', health: 'AtRisk', team: 'Team Card Vault', teamId: g(800), ...who('LF'), start: '2026-09-02', due: '2026-11-14', forecast: '2026-11-20', slipDays: 6, progress: 62, milestones: [ms('m1', 'PCI audit', '2026-11-10')] }),
  tp({ id: g(4), key: 'TSDK', name: 'Tokenisation SDK', team: 'Team Card Vault', teamId: g(800), ...who('RM'), start: '2026-10-06', due: '2026-12-05', forecast: '2026-12-01', progress: 40, milestones: [ms('m2', 'Beta to 3 merchants', '2026-11-14')], dependsOn: [CVM] }),
  tp({ id: UPA, key: 'UPA', name: 'UPI AutoPay', health: 'Delayed', team: 'Team AutoPay', teamId: g(801), ...who('AR'), start: '2026-09-08', due: '2026-11-21', forecast: '2026-12-02', slipDays: 11, progress: 74, openTasks: 3, blockedTasks: 1,
    milestones: [ms('m3', 'Bank sandbox cert', '2026-11-07'), ms('m4', 'Go-live', '2026-11-21')], lastChange: { previous: '2026-11-14', revised: '2026-11-21', reason: 'bank changed callback spec', by: 'Asha Rao', at: '2026-10-24T09:00:00Z' } }),
  tp({ id: g(5), key: 'MAN', name: 'Mandate Analytics', team: 'Team AutoPay', teamId: g(801), ...who('KD'), start: '2026-10-20', due: '2026-12-12', progress: 15 }),
  tp({ id: MOB, key: 'MOB', name: 'Merchant Onboarding v2', team: 'Team Merchant', teamId: g(802), ...who('JB'), start: '2026-09-01', due: '2026-10-24', progress: 100, milestones: [ms('m5', 'Launched', '2026-10-24')] }),
  tp({ id: g(6), key: 'MPR', name: 'Merchant Portal Refresh', team: 'Team Merchant', teamId: g(802), ...who('NH'), start: '2026-09-15', due: '2026-11-20', progress: 76, milestones: [ms('m6', 'Release 2', '2026-11-20')] }),
  tp({ id: g(7), key: 'Q4C', name: 'Q4 Close Automation', team: 'Team Finance Ops', teamId: g(803), ...who('MO'), start: '2026-11-10', due: '2026-12-19', progress: 0, milestones: [ms('m7', 'Year-end close', '2026-12-19')] }),
] };
const risk = (p) => ({ projectId: p.id, key: p.key, name: p.name, group: 'Delivery', health: p.health, progress: p.progress, owner: p.owner, startDate: p.start, dueDate: p.due, delayedDays: 0, openTasks: 6, overdueTasks: 0, blockedTasks: 0,
  openActionItems: 0, overdueActionItems: 0, finishedLast28Days: 6, inProgressTasks: 2, projectedFinish: p.forecast, projectedSlipDays: p.slipDays, confidence: 'medium', score: 1, level: 'Low', reasons: [] });
const brief = { asOf: today, projects: 7, onTrack: 4, atRisk: 1, delayed: 1, onHold: 0, overdueTasks: 2, blockedTasks: 1, openActionItems: 0, overdueActionItems: 0, dateChangesLast30Days: 1, headlines: ['7 active projects: 4 on track, 1 at risk, 1 late.'],
  ranked: tl.projects.map(risk), recentSlips: [], stretched: [] };
const board = () => ({ asOf: today, filter: {}, brief, decisions: [], summary: brief.headlines[0], owners: people.map((p) => ({ id: p.id, name: p.name })), groups: [{ id: 'g1', name: 'Delivery' }],
  money: { entitled: false, showMoney: false, currency: 'INR', budget: 0, spent: 0, forecast: 0, overrunning: 0, projects: [], burn: [], notes: [] },
  capacity: { from: today, to: today, people: 6, over: [], projectsAtRisk: [], notes: [] } });

const writes = [], errors = [], checks = [], views = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
async function context(theme, width) {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block', acceptDownloads: true, viewport: { width, height: width < 500 ? 844 : 900 }, ...(width < 500 ? { hasTouch: true, isMobile: true } : {}) });
  await ctx.clock.setFixedTime(NOW);
  await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); localStorage.setItem('pm_home_mode', 'classic'); }, theme);
  await ctx.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
    if (url.origin !== origin) { await route.abort(); return; }
    if (ep.endsWith('/avatar')) { await route.fulfill({ status: 404, body: '' }); return; }
    if (!ep.startsWith('/api/')) {
      const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
      await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
      return;
    }
    if (ep === '/api/v1/portfolio/sheet/export' || ep === '/api/v1/portfolio/export') { writes.push({ ep, q: url.search }); await route.fulfill({ status: 200, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', headers: { 'content-disposition': 'attachment; filename="plan-sheet.xlsx"' }, body: Buffer.from('PK synthetic') }); return; }
    let data = [];
    if (ep === '/api/v1/portfolio/sheet/bulk' && method === 'POST') {
      const b = req.postDataJSON(); writes.push({ ep, b });
      data = { changed: b.changes.length, failed: 0, rows: b.changes.map((c) => ({ id: c.id, key: null, ok: true, error: null, field: null, code: null, version: (c.version ?? 3) + 1 })) };
    } else if (ep === '/api/v1/portfolio/sheet/paste' && method === 'POST') {
      const b = req.postDataJSON(); writes.push({ ep, b });
      const rows = b.rows.map((r, i) => {
        const bad = !/^\d/.test(r.start ?? '1') || r.start === '11/31' || r.owner === 'ops team';
        const upd = r.title === 'Retry & notification rules';
        return { index: i, action: bad ? 'error' : upd ? 'update' : 'create', title: r.title, ownerId: r.owner && !bad ? P.RM[0] : null, owner: r.owner && !bad ? (r.owner === 'Ravi M' ? 'Ravi Menon' : r.owner) : null,
          ownerMatch: bad ? 'none' : r.owner === 'Ravi M' ? 'fuzzy' : 'exact', start: bad ? null : '2026-11-03', due: bad ? null : '2026-11-07', statusId: null, status: r.status ?? null, matchedId: upd ? g(22) : null, matchedKey: upd ? 'UPA-7' : null,
          change: upd ? 'Updates UPA-7 · due 12 Nov→14 Nov' : r.owner === 'Ravi M' ? 'Owner matched → Ravi Menon' : 'New task', problems: bad ? ['Owner unknown: “ops team”', 'Start “11/31” is not a date'] : [], ready: !bad, needsReason: upd,
          saved: !!b.commit && !bad && (!b.include || b.include.includes(i)), savedId: null, error: null };
      });
      data = { projectId: b.projectId, projectKey: 'UPA', projectName: 'UPI AutoPay', committed: !!b.commit, ready: rows.filter((r) => r.ready).length, problems: rows.filter((r) => !r.ready).length, saved: rows.filter((r) => r.saved).length, rows };
    } else if (ep === '/api/v1/saved-views' && method === 'POST') { const b = req.postDataJSON(); writes.push({ ep, b }); const v = { id: g(700 + views.length), scope: 'portfolio', name: b.name, sharing: 'private', teamId: null, teamName: null, ownerId: user.id, ownerName: 'Asha Rao', mine: true, config: b.config, createdAt: NOW.toISOString() }; views.push(v); data = v; }
    else if (ep === '/api/v1/me/ui/plansheet' && method === 'PUT') { writes.push({ ep, b: req.postDataJSON() }); data = { key: 'plansheet', value: req.postDataJSON().value, updatedAt: NOW.toISOString() }; }
    else {
      assert.ok(method === 'GET' || ep.endsWith('/auth/refresh'), `Unexpected write: ${method} ${ep}`);
      if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
      else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['projects.view', 'projects.edit', 'tasks.view', 'tasks.edit', 'org.manage', 'reports.view', 'work.view'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 3, activity: 3, documents: 3, people: 3, reports: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3 } } };
      else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
      else if (ep === '/api/v1/portfolio/board') data = board();
      else if (ep === '/api/v1/portfolio/sheet') data = sheet();
      else if (ep === '/api/v1/portfolio/timeline') data = tl;
      else if (ep === '/api/v1/saved-views') data = views;
      else if (ep === '/api/v1/me/ui/plansheet') data = { key: 'plansheet', value: null, updatedAt: null };
      else if (ep === '/api/v1/me/ui/sidebar') data = { key: 'sidebar', value: null, updatedAt: null };
      else if (ep.endsWith('/ai/status')) data = { enabled: true, configured: true, entitled: true, allowedHere: true };
      else if (ep === '/api/v1/notifications/counts') data = { unread: 0, needsYou: 0, forInfo: 0, snoozed: 0 };
      else if (ep === '/api/v1/notifications') data = { items: [], page: 1, pageSize: 20, totalPages: 0, totalItems: 0 };
      else if (ep === '/api/v1/timer') data = null;
      else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
      else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
      else if (ep === '/api/v1/chat/projects/unread') data = [];
      else if (ep.endsWith('/projects') || ep.endsWith('/tasks') || ep.endsWith('/work-tasks')) data = { items: [], page: 1, totalPages: 0, totalItems: 0 };
      else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page };
}
const shot = async (page, name, full = false) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(250); await page.screenshot({ path: path.join(out, name), fullPage: full }); };
const waitWrite = async (test, from = 0) => { for (let i = 0; i < 50; i++) { const w = writes.slice(from).find(test); if (w) return w; await new Promise((r) => setTimeout(r, 100)); } return null; };
const bulkAfter = (n) => waitWrite((w) => w.ep === '/api/v1/portfolio/sheet/bulk', n);

let page;
try {
  ({ page } = await context('light', 1440));
  // Deep link: the old /portfolio?view=sheet lands on Portfolio › Plan sheet; tabs in the design's order.
  await page.goto(`${origin}/preview-org/portfolio?view=sheet`);
  await page.waitForURL(/\/work\/projects\?view=portfolio&mode=sheet/);
  const tabs = page.getByRole('tablist', { name: 'Portfolio view' });
  await page.getByRole('grid', { name: 'Plan sheet' }).waitFor();
  assert.deepEqual(await tabs.getByRole('tab').allInnerTexts(), ['Board', 'Timeline', 'Plan sheet', 'Capacity', 'Present']);
  assert.equal(await tabs.getByRole('tab', { name: 'Plan sheet' }).getAttribute('aria-selected'), 'true');
  const grid = page.getByRole('grid', { name: 'Plan sheet' });
  await grid.waitFor();
  assert.ok(await page.getByRole('button', { name: 'Paste from Excel' }).isVisible() && await page.getByRole('button', { name: 'Present sheet' }).isVisible());
  assert.ok((await page.getByText('Viewing: Everything I can see').count()) === 1);
  // Grouped Project › Task › sub-item, meeting rows with cadence + next, totals, late red and at-risk amber.
  assert.equal(await grid.locator('tr[aria-level="1"]').count(), 3, 'three project rows');
  assert.ok(await grid.getByRole('gridcell', { name: /Daily/ }).first().isVisible());
  assert.match(await grid.locator('tr.tot').innerText(), /14 rows · 3 projects[\s\S]*owners[\s\S]*late[\s\S]*avg[\s\S]*3 meetings/);
  assert.match(await grid.locator(`#psh-${g(12)}-due`).getAttribute('class'), /late/);
  assert.match(await grid.locator(`#psh-${g(11)}-due`).getAttribute('class'), /risk/);
  assert.equal(await grid.locator(`#psh-${g(12)}-deps`).innerText(), 'CVM-9');
  await shot(page, 'sheet-light-1440.png');
  checks.push('grid');

  // Frozen: the header stays on top while rows scroll; Key and Title stay put while columns scroll right.
  const scroller = page.locator('.psh-scroll');
  const keyX = async () => (await grid.locator(`#psh-${g(14)}-key`).boundingBox()).x;
  const ownerX = async () => (await grid.locator(`#psh-${g(14)}-owner`).boundingBox()).x;
  const [k0, o0] = [await keyX(), await ownerX()];
  await scroller.evaluate((el) => { el.scrollLeft = 400; });
  await page.waitForTimeout(100);
  assert.equal(Math.round(await keyX()), Math.round(k0), 'Key column is frozen');
  assert.ok((await ownerX()) < o0 - 150, 'other columns scroll');
  await scroller.evaluate((el) => { el.scrollLeft = 0; });
  checks.push('frozen-columns');

  // Keyboard: click a cell, type to edit the owner (combobox), Enter saves and moves down.
  await grid.locator(`#psh-${g(13)}-owner`).click();
  await page.keyboard.type('Ra');
  const ownerPop = page.getByRole('dialog', { name: 'Owner of CVM-12.2' });
  await ownerPop.waitFor();
  assert.equal(await ownerPop.getByRole('combobox').inputValue(), 'Ra');
  assert.equal(await ownerPop.getByRole('option').first().innerText().then((t) => t.includes('Ravi Menon')), true);
  await shot(page, 'sheet-edit-owner-1440.png');
  let n = writes.length;
  await page.keyboard.press('Enter');
  const w1 = await bulkAfter(n);
  assert.deepEqual(w1.b.changes.map((c) => [c.id, c.assigneeId]), [[g(13), P.RM[0]]]);
  assert.equal(await grid.locator('[data-active="true"]').getAttribute('id'), `psh-${g(14)}-owner`, 'Enter moved down');
  // Start date: F2, "+3", Tab saves and moves right; Esc cancels an edit.
  await page.keyboard.press('ArrowRight');
  n = writes.length;
  await page.keyboard.press('F2');
  const startPop = page.getByRole('dialog', { name: 'Start date of CVM-15' });
  await startPop.getByRole('textbox', { name: 'Start date' }).fill('+3');
  await page.keyboard.press('Tab');
  const w2 = await bulkAfter(n);
  assert.equal(w2.b.changes[0].startDate, '2026-10-04');
  assert.equal(await grid.locator('[data-active="true"]').getAttribute('id'), `psh-${g(14)}-due`, 'Tab moved right');
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
  n = writes.length;
  await page.keyboard.press('Enter'); await page.getByRole('dialog', { name: 'Owner of CVM-15' }).waitFor(); await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  assert.equal(await page.getByRole('dialog', { name: 'Owner of CVM-15' }).count(), 0); assert.equal(writes.length, n, 'Esc saves nothing');
  // Status: the menu of the project's columns.
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  assert.equal(await grid.locator('[data-active="true"]').getAttribute('id'), `psh-${g(14)}-status`);
  await page.keyboard.press('Enter');
  await page.getByRole('listbox', { name: 'Status of CVM-15' }).waitFor();
  await page.keyboard.press('ArrowDown'); n = writes.length; await page.keyboard.press('Enter');
  assert.equal((await bulkAfter(n)).b.changes[0].statusId, `${CVM}-s2`);
  checks.push('keyboard-edit');

  // A later due date asks for one reason (the existing rule), then saves with it.
  await grid.locator(`#psh-${g(23)}-due`).click();
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Due date' }).fill('28 Nov · 18:00');
  await page.keyboard.press('Enter');
  const reason = page.getByRole('dialog', { name: /Why is UPA-9 moving/ });
  await reason.waitFor();
  await reason.getByRole('button', { name: 'Waiting on external' }).click();
  await reason.getByRole('textbox', { name: 'Reason' }).fill('Bank moved the sandbox slot');
  await shot(page, 'sheet-reason-1440.png');
  n = writes.length; await reason.getByRole('button', { name: 'Save' }).click();
  const w3 = await bulkAfter(n);
  assert.equal(w3.b.changes[0].dueDate, '2026-11-28'); assert.equal(w3.b.changes[0].dueTime, '18:00');
  assert.equal(w3.b.dueDateReason, 'Waiting on external: Bank moved the sandbox slot');
  checks.push('due-reason');

  // Select rows → bulk bar; fill down copies the first selected row's owner to the others (Ctrl D).
  for (const id of [g(12), g(13), g(14)]) await grid.getByRole('checkbox', { name: new RegExp(`Select ${sheetRows.find((r) => r.id === id).key} `) }).click();
  const bar = page.getByRole('toolbar', { name: 'Selected rows' });
  await bar.getByText('3 rows selected').waitFor();
  for (const b of ['Owner', 'Dates…', 'Status', 'Fill down ⌃D', 'Move', 'Delete']) assert.ok(await bar.getByRole('button', { name: b, exact: true }).isVisible(), b);
  await grid.locator(`#psh-${g(12)}-owner`).click();
  await shot(page, 'sheet-edit-light-1440.png');
  n = writes.length; await page.keyboard.press('Control+d');
  const w4 = await bulkAfter(n);
  assert.deepEqual(w4.b.changes.map((c) => c.assigneeId), [P.RM[0], P.RM[0]], 'fill down from the first selected row');
  n = writes.length;
  await bar.getByRole('button', { name: 'Owner', exact: true }).click();
  await page.getByRole('dialog', { name: 'Owner for the selected rows' }).getByRole('option', { name: /Mira Okafor/ }).click();
  assert.equal((await bulkAfter(n)).b.changes.length, 3, 'bulk owner for three rows');
  await bar.getByRole('button', { name: 'Clear the selection' }).click();
  checks.push('fill-down-bulk');

  // Paste from Excel: Ctrl V of rows opens the preview, mapped by headers and checked on the server; bad rows unticked; "Add N rows".
  await grid.focus();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'Task\tAssigned to\tStart\tEnd\tStatus\nLoad test mandate API\tRavi Menon\t3 Nov\t7 Nov\tNot started\nRetry & notification rules\tAsha Rao\t20 Sep\t14 Nov\tIn progress\nFraud rule tuning\tRavi M\t5 Nov\t12 Nov\tNot started\nOps handover\tops team\t11/31\t\tNot started');
    document.querySelector('.psh-scroll').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  });
  const pasteDlg = page.getByRole('dialog', { name: /Paste 4 rows from Excel/ });
  await pasteDlg.waitFor();
  const dry = await waitWrite((w) => w.ep === '/api/v1/portfolio/sheet/paste' && !w.b.commit);
  assert.deepEqual(dry.b.rows[0], { title: 'Load test mandate API', owner: 'Ravi Menon', start: '3 Nov', due: '7 Nov', status: 'Not started' });
  await pasteDlg.getByText('3 ready').waitFor();
  assert.equal(await pasteDlg.getByRole('combobox', { name: 'Column B' }).inputValue(), 'owner');
  assert.equal(await pasteDlg.getByRole('checkbox', { name: 'Include Ops handover' }).isChecked(), false);
  assert.ok(await pasteDlg.getByText('Updates UPA-7', { exact: false }).isVisible());
  await pasteDlg.getByRole('textbox', { name: 'Reason for the date changes' }).fill('Client asked for more time');
  await shot(page, 'sheet-paste-light-1440.png');
  n = writes.length; await pasteDlg.getByRole('button', { name: 'Add 3 rows' }).click();
  const commit = await waitWrite((w) => w.ep === '/api/v1/portfolio/sheet/paste' && w.b.commit, n);
  assert.deepEqual(commit.b.include.sort(), [0, 1, 2]); assert.equal(commit.b.dueDateReason, 'Client asked for more time');
  await pasteDlg.waitFor({ state: 'detached' });
  checks.push('paste-preview');

  // Filter · Group, saved views (per user), export menu.
  await page.getByRole('button', { name: 'Filter · Group' }).click();
  const fg = page.getByRole('dialog', { name: 'Filter and group' });
  await fg.getByRole('menuitemcheckbox', { name: 'Status is not Done' }).click();
  await shot(page, 'sheet-filter-light-1440.png');
  assert.equal(await grid.locator(`#psh-${g(31)}-key`).count(), 0, 'done rows filtered out');
  await fg.getByRole('textbox', { name: 'Save current as view' }).fill('Active portfolio');
  n = writes.length; await fg.getByRole('button', { name: 'Save' }).click();
  const sv = await waitWrite((w) => w.ep === '/api/v1/saved-views', n);
  assert.equal(sv.b.config.list, 'sheet'); assert.equal(sv.b.sharing, 'private'); assert.equal(sv.b.config.filters.notDone, true);
  await page.getByText('View: Active portfolio').waitFor();
  assert.match(page.url(), new RegExp(`v=${g(700)}`));
  await page.getByRole('button', { name: 'Export' }).click();
  const exp = page.getByRole('menu', { name: 'Export' });
  for (const t of ['Excel workbook (.xlsx)', 'CSV (.csv)', 'Only visible columns & filters', 'Keep groups as outline levels', 'Include meeting rows']) assert.ok(await exp.getByText(t).isVisible(), t);
  await shot(page, 'sheet-export-light-1440.png');
  const [dl] = await Promise.all([page.waitForEvent('download'), exp.getByRole('menuitem', { name: /Excel workbook/ }).click()]);
  assert.match(dl.suggestedFilename(), /plan-sheet-.*\.xlsx/);
  const ex = await waitWrite((w) => w.ep === '/api/v1/portfolio/sheet/export');
  assert.match(ex.q, /format=xlsx/); assert.match(ex.q, /columns=Key%2CTitle/);
  checks.push('views-filter-export');

  // Dark.
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.getByRole('button', { name: 'Export' }).click();
  await shot(page, 'sheet-export-dark-1440.png');
  await page.keyboard.press('Escape');
  await shot(page, 'sheet-dark-1440.png');
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  checks.push('sheet-dark');

  // ------------------------------------------------------------------ Timeline
  await tabs.getByRole('tab', { name: 'Timeline' }).click();
  const tlr = page.getByRole('region', { name: 'Timeline' });
  await tlr.locator('.ptl-bar').first().waitFor();
  assert.equal(new URL(page.url()).searchParams.get('mode'), 'timeline');
  assert.ok(await page.getByRole('button', { name: /Fit · Sep–Dec/ }).isVisible(), 'fit to the data range');
  assert.ok(await tlr.getByText('Range fitted to your data: 1 Sep – 31 Dec 2026').isVisible());
  assert.equal(await tlr.locator('.ptl-bar').count(), 7, 'one bar per project');
  assert.equal(await tlr.locator('.ptl-grow').count(), 4, 'team groups');
  assert.ok(await tlr.locator('.ptl-today-pill', { hasText: 'Today 29 Oct' }).isVisible());
  assert.deepEqual((await tlr.locator('.ptl-slipchip').allInnerTexts()).sort(), ['+11d', '+6d'], 'slip tags');
  assert.ok(await tlr.getByText('forecast 20 Nov · Lena').isVisible() && await tlr.getByText('due 5 Dec · Ravi').isVisible() && await tlr.getByText('Done 24 Oct · Jonas').isVisible());
  // No bar label sits on the today line.
  const overlaps = await page.evaluate(() => {
    const t = document.querySelector('.ptl-todayline').getBoundingClientRect().x;
    return [...document.querySelectorAll('.ptl-label, .ptl-glabel')].map((e) => [e.textContent, e.getBoundingClientRect()]).filter(([, r]) => t > r.left - 1 && t < r.right + 1).map(([s]) => s);
  });
  assert.deepEqual(overlaps, [], `labels on the today line: ${overlaps}`);
  await shot(page, 'timeline-light-1440.png');
  // Hover card: owner, plan, forecast and how it was worked out, progress, next milestone, last change with reason.
  const upa = tlr.getByRole('button', { name: /^UPI AutoPay, Asha Rao, late, planned 8 Sep to 21 Nov, forecast 2 Dec, 74% done/ });
  await upa.hover({ position: { x: 60, y: 10 } });
  const card = page.getByRole('tooltip');
  await card.waitFor();
  const ct = await card.innerText();
  assert.match(ct, /Late · \+11d/); assert.match(ct, /8 Sep → 21 Nov · 75d/); assert.match(ct, /From pace, 4 wks/); assert.match(ct, /3 open · 1 blocked/); assert.match(ct, /Bank sandbox cert · 7 Nov/);
  assert.match(ct, /bank changed callback spec/);
  await shot(page, 'timeline-hover-light-1440.png');
  checks.push('timeline-fit-slip-hover-labels');
  // Drag a bar end to re-plan: live tooltip, then the reason popover; saves through the project's due-date change.
  const cvm = tlr.getByRole('slider', { name: 'Due date of Card Vault Migration' });
  const hb = await cvm.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2); await page.mouse.down();
  await page.mouse.move(hb.x + 40, hb.y + hb.height / 2, { steps: 5 }); await page.mouse.move(hb.x + 70, hb.y + hb.height / 2, { steps: 5 });
  await tlr.locator('.ptl-dragtip').waitFor();
  assert.match(await tlr.locator('.ptl-dragtip').innerText(), /^Due 14 Nov → \d+ (Nov|Dec) · \+\d+d$/);
  await shot(page, 'timeline-dragging-light-1440.png');
  await page.mouse.up();
  const rp = page.getByRole('dialog', { name: 'Move Card Vault Migration?' });
  await rp.waitFor();
  assert.ok(await rp.getByText('1 dependent project shift too').isVisible());
  assert.equal(await rp.getByRole('button', { name: 'Re-plan' }).isDisabled(), true, 'a later date needs a reason');
  await rp.getByRole('button', { name: 'Waiting on external' }).click();
  await rp.getByRole('textbox', { name: 'Reason for the new date' }).fill('HSM vendor slot moved to 4 Nov');
  await shot(page, 'timeline-drag-light-1440.png');
  n = writes.length; await rp.getByRole('button', { name: 'Re-plan' }).click();
  const w5 = await bulkAfter(n);
  assert.equal(w5.b.changes[0].id, CVM); assert.equal(w5.b.changes[0].version, 4); assert.ok(w5.b.changes[0].dueDate > '2026-11-14');
  assert.equal(w5.b.dueDateReason, 'Waiting on external: HSM vendor slot moved to 4 Nov');
  await rp.waitFor({ state: 'detached' });
  checks.push('timeline-drag-reason');
  // Quarter (dark): one column per quarter with month ticks; a collapsed group.
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await tlr.getByRole('tab', { name: 'Quarter' }).click();
  assert.ok(await tlr.locator('.ptl-tier1', { hasText: 'Q4' }).isVisible());
  assert.ok(await tlr.locator('.ptl-tier2.m', { hasText: 'Nov' }).isVisible());
  await tlr.getByRole('button', { name: 'Collapse Team Merchant' }).click();
  await shot(page, 'timeline-quarter-dark-1440.png');
  await tlr.getByRole('button', { name: /Fit ·/ }).click(); await tlr.getByRole('tab', { name: 'Week' }).click(); await tlr.getByRole('button', { name: /Fit ·/ }).click();
  await tlr.getByRole('button', { name: 'Expand Team Merchant' }).click();
  await shot(page, 'timeline-dark-1440.png');
  checks.push('timeline-quarter-dark');
  assert.deepEqual(errors, []);

  // ------------------------------------------------------------------ Phone
  const phone = await context('light', 390);
  page = phone.page;
  await page.goto(`${origin}/preview-org/work/projects?view=portfolio&mode=sheet`);
  const firstCard = page.getByRole('group', { name: 'CVM-12.1 HSM key ceremony' });
  await firstCard.waitFor();
  assert.ok(await page.getByRole('toolbar', { name: 'Filters' }).getByRole('button', { name: 'Not done' }).isVisible());
  assert.match(await firstCard.innerText(), /27 Oct · 2d late/);
  await page.waitForTimeout(300);
  await fitsPhone(page, 'plan sheet phone', assert);
  await shot(page, 'sheet-phone-light-390.png', true);
  // Swipe right: Done.
  n = writes.length;
  await firstCard.evaluate((el) => { const t = (x) => new Touch({ identifier: 1, target: el, clientX: x, clientY: 200 }); el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [t(60)], changedTouches: [t(60)] })); el.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [t(200)], changedTouches: [t(200)] })); });
  await page.waitForTimeout(50);
  await shot(page, 'sheet-phone-swipe-390.png');
  await firstCard.evaluate((el) => { const t = (x) => new Touch({ identifier: 1, target: el, clientX: x, clientY: 200 }); el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [t(200)] })); });
  assert.equal((await bulkAfter(n)).b.changes[0].statusId, `${CVM}-s3`, 'swipe right marks it done');
  checks.push('phone-sheet');
  await page.getByRole('tablist', { name: 'Portfolio view' }).getByRole('tab', { name: 'Timeline' }).click();
  await page.locator('.ptl-prow-ph').first().waitFor();
  assert.ok(await page.getByText('Today 29 Oct').isVisible());
  assert.ok(await page.locator('.ptl-prow-ph', { hasText: 'UPI AutoPay' }).getByText('+11d').isVisible());
  await page.waitForTimeout(300);
  await fitsPhone(page, 'timeline phone', assert);
  await shot(page, 'timeline-phone-light-390.png', true);
  checks.push('phone-timeline');
  assert.deepEqual(errors, []);
  await phone.ctx.close();
} catch (e) {
  await page?.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
  console.log('URL:', page?.url()); console.log('errors:', errors);
  throw e;
} finally { await browser.close(); }
console.log('plan sheet ui ok:', checks.join(', '));
