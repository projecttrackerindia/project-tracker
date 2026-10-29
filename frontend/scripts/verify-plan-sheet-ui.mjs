import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Portfolio › Plan sheet v3 (design plansheet3) and the Portfolio timeline: the full-width grid with proportional columns (Task with key, depends-on
// and meeting; Dates "23 Oct → 28 Oct +2d"; status dots; project rows with a ring and a summary), the one command field (typed tokens, Aura's
// reading of a sentence, People / Status / Dates / Projects, a live "N of M tasks", saved views), ⋯ and ⌘K for Paste / Export / Present, the date
// editor (calendar, chips, slip, ripple, overlap warning, reason), the people picker with weekly load, the fill handle with smart fill, the undo
// toast and ⌘Z, paste from Excel with the column mapping, the inspector, dragging a row into another project, Sheet / Split / Timeline, dark, and
// the phone cards; then the timeline. Synthetic fixtures only (fictional people and projects).
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/plan-sheet-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false, mfaEnabled: true };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Riverline Payments', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 8 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const NOW = new Date('2026-10-29T10:30:00+05:30'), today = '2026-10-29';
const g = (n) => `71000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
// Timeline people (unchanged fixture) and the sheet's people (the design's).
const P = { LF: [g(901), 'Lena Fischer'], TR: [g(902), 'Tomas Rivera'], RM: [g(903), 'Ravi Menon'], MO: [g(904), 'Mira Okafor'], AR: [user.id, 'Asha Rao'], JB: [g(906), 'Jonas Berg'], NH: [g(907), 'Noor Haddad'], KD: [g(908), 'Kiran Das'] };
const S = { RM: [g(911), 'Ravi Menon'], LP: [g(912), 'Lena Park'], JW: [g(913), 'Jonas Weber'], AK: [g(914), 'Aisha Khan'], TO: [g(915), 'Tomás Ortega'], MC: [g(916), 'Mei Chen'], AR: [user.id, 'Asha Rao'] };
const people = Object.values(S).map(([id, name]) => ({ id, name }));
const who = (k) => ({ ownerId: P[k][0], owner: P[k][1] });
const sw = (k) => ({ ownerId: S[k][0], owner: S[k][1] });
const CVM = g(1), UPA = g(2), MOB = g(3);
const AA = g(41), CB = g(42), UP = g(43), DP = g(44), PR = g(45);
const st = (pid, n) => ({ id: `${pid}-s${n}`, projectId: pid, name: ['To do', 'In progress', 'Review', 'Done'][n], category: ['Todo', 'Active', 'Active', 'Done'][n] });
const statuses = [AA, CB, UP, DP, PR].flatMap((p) => [0, 1, 2, 3].map((n) => st(p, n)));
const ago = (h) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const row = (o) => ({ kind: 'task', parentId: null, level: 1, ownerId: null, owner: null, start: null, due: null, dueTime: null, durationDays: null, status: 'To do', category: 'Todo', statusId: null,
  progress: 0, dependsOn: [], cadence: null, nextAt: null, updatedAt: ago(5), updatedBy: 'Asha Rao', notes: null, late: false, atRisk: false, version: 3, canEdit: true,
  estimatedHours: null, checklistTotal: null, checklistDone: null, manualProgress: false, slipDays: null, ...o });
const T = {};
const task = (pid, n, key, title, k, start, due, sn, progress, extra = {}) => { const id = g(100 + n); T[key] = id; return row({ id, projectId: pid, key, title, ...sw(k), start, due, status: st(pid, sn).name, category: st(pid, sn).category, statusId: st(pid, sn).id, progress, ...extra }); };
const proj = (id, key, title, k, start, due, status, category, progress, extra = {}) => row({ kind: 'project', id, projectId: id, level: 0, key, title, ...sw(k), start, due, status, category, progress, ...extra });
const mtg = (pid, n, title, nextAt) => row({ kind: 'meeting', id: g(300 + n), projectId: pid, key: 'MTG', title, ...sw('AR'), status: 'Scheduled', category: 'Meeting', progress: null, cadence: 'Weekly', nextAt, canEdit: false });
const sheetRows = [
  proj(AA, 'AA', 'Account Aggregator', 'RM', '2026-10-02', '2026-11-14', 'At risk', 'AtRisk', 58, { atRisk: true }),
  task(AA, 1, 'AA-04', 'Consent manager sandbox onboarding with FIU partner', 'LP', '2026-10-02', '2026-10-18', 3, 100, { notes: 'Sandbox certified; prod keys requested' }),
  task(AA, 2, 'AA-05', 'Validate skip-consent flow for repeat lenders', 'RM', '2026-10-23', '2026-10-30', 1, 40, { dependsOn: ['AA-04'], atRisk: true, slipDays: 2, notes: 'Edge case on expired artefacts — @Lena to confirm', checklistTotal: 5, checklistDone: 2, estimatedHours: 16 }),
  task(AA, 3, 'AA-06', 'Production cut-over and smoke tests', 'RM', '2026-11-06', '2026-11-14', 0, 0, { dependsOn: ['AA-05'], estimatedHours: 24 }),
  mtg(AA, 1, 'Review', '2026-10-30T05:30:00Z'),
  proj(CB, 'CB', 'Credit Bureau Integration', 'TO', '2026-10-09', '2026-11-24', 'At risk', 'AtRisk', 47, { atRisk: true }),
  task(CB, 4, 'CB-01', 'UAT SSL certificate configuration', 'TO', '2026-10-09', '2026-10-13', 3, 100, { notes: 'Rotated in UAT and pre-prod' }),
  task(CB, 5, 'CB-02', 'Consumer report and score parsing for v2 schema', 'AK', '2026-10-22', '2026-10-27', 1, 35, { dependsOn: ['CB-01'], atRisk: true, notes: 'Waiting on bureau field mapping sheet', checklistTotal: 7, checklistDone: 3 }),
  task(CB, 6, 'CB-03', 'Bulk enquiry batch job with retry policy', 'JW', '2026-11-03', '2026-11-24', 1, 10, { dependsOn: ['CB-02'], checklistTotal: 9, checklistDone: 1, estimatedHours: 30 }),
  mtg(CB, 2, 'Sync', '2026-11-02T05:30:00Z'),
  proj(UP, 'UP', 'UPI AutoPay', 'MC', '2026-08-05', '2026-10-18', 'Late', 'Delayed', 45, { late: true }),
  task(UP, 7, 'UP-01', 'Mandate registration and revoke callbacks', 'MC', '2026-08-05', '2026-10-18', 1, 45, { late: true, notes: 'Bank simulator unstable; escalated to @Ravi', estimatedHours: 30 }),
  mtg(UP, 3, 'Go / No-go', '2026-10-30T09:30:00Z'),
  proj(DP, 'DP', 'Data Privacy API', 'JW', '2026-10-20', '2026-11-10', 'On track', 'OnTrack', 100),
  task(DP, 8, 'DP-03', 'Complete SIT deployment and sign-off', 'JW', '2026-10-26', '2026-10-27', 3, 100, { notes: 'Signed off by QA' }),
  task(DP, 9, 'DP-04', 'Masking rules for PII fields in logs', 'LP', '2026-10-20', '2026-11-10', 1, 70, { notes: 'Rules versioned in config', estimatedHours: 20 }),
  proj(PR, 'PR', 'Payments Revamp', 'AK', '2026-10-27', '2026-12-12', 'On track', 'OnTrack', 20),
  task(PR, 10, 'PR-01', 'Checkout flow API contract and mocks', 'AK', '2026-10-27', '2026-11-07', 1, 20, { estimatedHours: 24 }),
  mtg(PR, 4, 'Design crit', '2026-11-03T08:30:00Z'),
];
const sheet = () => ({ asOf: today, timeZone: 'Asia/Kolkata', rows: sheetRows, people, statuses, truncated: false, canEdit: true, meetings: true,
  scopes: [{ id: 'all', label: 'Everything I can see', allowed: true, why: null, teamId: null }, { id: 'mine', label: 'My work', allowed: true, why: null, teamId: null }] });
// The capacity plan for the people picker: booked vs capacity in the week of 2 Nov.
const load = { RM: 120, LP: 85, JW: 60, TO: 40, MC: 95, AK: 70, AR: 30 };
const plan = (from) => ({ from, weeks: 1, scope: 'Everyone', available: ['Everyone'], entitled: true, weekStarts: [from], suggestion: null,
  totals: { capacityMinutes: 0, bookedMinutes: 0, booked: null, overWeeks: 0, leaveWeeks: 0, publicHolidays: 0 },
  people: Object.entries(S).map(([k, [id, name]]) => ({ userId: id, name, weeklyCapacityMinutes: 2400, weeks: [{ weekStart: from, capacityMinutes: 2400, bookedMinutes: Math.round(load[k] * 24), leaveDays: 0, workingDays: 5, onLeave: false, over: load[k] > 100 }] })) });
const checklist = { items: [['Collect expired-artefact samples', true], ['Map re-consent screens', true], ['Confirm copy with legal', false], ['Regression on sandbox', false], ['Sign-off', false]]
  .map(([title, isDone], i) => ({ id: g(500 + i), title, isDone, position: i, completedAt: null })), total: 5, done: 2, progress: 40 };
const history = [{ id: 'h1', at: ago(26), actor: { id: S.RM[0], name: 'Ravi Menon' }, field: 'Due date', from: '2026-10-26', to: '2026-10-28' }];

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
    } else if (ep === '/api/v1/portfolio/sheet/move' && method === 'POST') {
      const b = req.postDataJSON(); writes.push({ ep, b });
      data = { id: b.id, key: b.projectId === CB ? 'CB-4' : 'PR-01', projectId: b.projectId, version: 4, position: 2048, movedProject: b.projectId === CB };
    } else if (ep === '/api/v1/portfolio/sheet/paste' && method === 'POST') {
      const b = req.postDataJSON(); writes.push({ ep, b });
      const byName = Object.fromEntries(people.map((p) => [p.name, p.id]));
      const rows = b.rows.map((r, i) => {
        const problems = [];
        if (r.owner && !byName[r.owner]) problems.push(`Owner unknown: “${r.owner}”`);
        if (r.start && !/^\d{4}-\d{2}-\d{2}$/.test(r.start)) problems.push(`Start “${r.start}” is not a date`);
        const status = !r.status ? null : /wip|progress/i.test(r.status) ? st(b.projectId, 1) : /open|to do/i.test(r.status) ? st(b.projectId, 0) : null;
        const ok = problems.length === 0;
        return { index: i, action: ok ? 'create' : 'error', title: r.title, ownerId: ok && r.owner ? byName[r.owner] : null, owner: ok ? r.owner ?? null : null, ownerMatch: r.owner ? (byName[r.owner] ? 'exact' : 'none') : 'empty',
          start: ok ? r.start ?? null : null, due: ok ? r.due ?? null : null, statusId: status?.id ?? null, status: status?.name ?? null, matchedId: null, matchedKey: null, change: 'New task', problems, ready: ok, needsReason: false,
          saved: !!b.commit && ok && (!b.include || b.include.includes(i)), savedId: b.commit && ok ? g(600 + i) : null, error: null };
      });
      data = { projectId: b.projectId, projectKey: 'CB', projectName: 'Credit Bureau Integration', committed: !!b.commit, ready: rows.filter((r) => r.ready).length, problems: rows.filter((r) => !r.ready).length, saved: rows.filter((r) => r.saved).length, rows };
    } else if (ep === '/api/v1/saved-views' && method === 'POST') { const b = req.postDataJSON(); writes.push({ ep, b }); const v = { id: g(700 + views.length), scope: 'portfolio', name: b.name, sharing: 'private', teamId: null, teamName: null, ownerId: user.id, ownerName: 'Asha Rao', mine: true, config: b.config, createdAt: NOW.toISOString() }; views.push(v); data = v; }
    else if (ep === '/api/v1/me/ui/plansheet' && method === 'PUT') { writes.push({ ep, b: req.postDataJSON() }); data = { key: 'plansheet', value: req.postDataJSON().value, updatedAt: NOW.toISOString() }; }
    else if (/\/api\/v1\/tasks\/[^/]+\/checklist\/[^/]+$/.test(ep) && method === 'PUT') { writes.push({ ep, b: req.postDataJSON() }); data = checklist; }
    else {
      assert.ok(method === 'GET' || ep.endsWith('/auth/refresh'), `Unexpected write: ${method} ${ep}`);
      if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
      else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['projects.view', 'projects.edit', 'tasks.view', 'tasks.edit', 'tasks.create', 'org.manage', 'reports.view', 'work.view'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 3, activity: 3, documents: 3, people: 3, reports: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3 } } };
      else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
      else if (ep === '/api/v1/portfolio/board') data = board();
      else if (ep === '/api/v1/portfolio/sheet') data = sheet();
      else if (ep === '/api/v1/portfolio/timeline') data = tl;
      else if (ep === '/api/v1/resources/plan') data = plan(url.searchParams.get('from'));
      else if (/\/api\/v1\/tasks\/[^/]+\/checklist$/.test(ep)) data = checklist;
      else if (/\/api\/v1\/work-items\/[^/]+\/history$/.test(ep)) data = history;
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
const cellOf = (page, key, col) => page.locator(`td[data-cell="${T[key]}:${col}"]`);

let page, n;
try {
  ({ page } = await context('light', 1440));
  // Deep link: the old /portfolio?view=sheet lands on Portfolio › Plan sheet; the tabs sit in the head.
  await page.goto(`${origin}/preview-org/portfolio?view=sheet`);
  await page.waitForURL(/\/work\/projects\?view=portfolio&mode=sheet/);
  const tabs = page.getByRole('tablist', { name: 'Portfolio view' });
  const grid = page.getByRole('grid', { name: 'Plan sheet' });
  await grid.waitFor();
  assert.deepEqual(await tabs.getByRole('tab').allInnerTexts(), ['Board', 'Timeline', 'Plan sheet', 'Capacity', 'Present']);
  assert.equal(await tabs.getByRole('tab', { name: 'Plan sheet' }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('.ps3-head h1').innerText(), 'Plan');

  // 1. The grid: six proportional columns that fill the width, five project rows with ring and summary, meetings folded into the Task cell.
  assert.deepEqual(await grid.locator('thead th').allInnerTexts(), ['Task', 'Owner', 'Dates', 'Status', 'Progress', 'Notes']);
  const widths = await page.evaluate(() => { const t = document.querySelector('.ps3-table'); return { table: t.getBoundingClientRect().width, frame: t.parentElement.getBoundingClientRect().width }; });
  assert.ok(Math.abs(widths.table - widths.frame) < 2, `the grid fills its width (${JSON.stringify(widths)})`);
  assert.equal(await grid.locator('tr.g').count(), 5);
  assert.match(await grid.locator('tr.g').first().innerText(), /Account Aggregator\s*3 · 58%[\s\S]*1 at risk[\s\S]*Ends 14 Nov/);
  assert.match(await grid.locator('tr.g', { hasText: 'UPI AutoPay' }).innerText(), /1 late/);
  assert.equal(await grid.locator('tr[data-row]').count(), 10, 'meeting rows are folded into tasks, not rows');
  assert.match(await cellOf(page, 'AA-05', 'task').innerText(), /AA-05\s*Validate skip-consent flow for repeat lenders\s*↳ after AA-04\s*◆ Review · Fri 30 Oct/);
  assert.equal((await cellOf(page, 'AA-05', 'dates').innerText()).replace(/\s+/g, ' '), '23 Oct → 30 Oct+2d');
  assert.equal((await cellOf(page, 'UP-01', 'dates').innerText()).replace(/\s+/g, ' '), '5 Aug → 18 Oct+11d');
  assert.equal(await cellOf(page, 'AA-05', 'status').innerText(), 'At risk');
  assert.equal(await cellOf(page, 'AA-06', 'status').innerText(), 'Not started');
  assert.ok(await cellOf(page, 'AA-06', 'status').locator('.ps3-gl.todo').count() === 1, 'not started is a hollow dot');
  assert.match(await cellOf(page, 'AA-05', 'notes').locator('.ps3-mention').innerText(), /@Lena/);
  assert.equal(await page.locator('.ps3-count').innerText(), '10 tasks');
  for (const gone of ['Paste from Excel', 'Present sheet', 'My views', 'Filter · Group']) assert.equal(await page.getByRole('button', { name: gone, exact: true }).count(), 0, `${gone} left the toolbar`);
  await shot(page, '01-sheet-light-1440.png');
  checks.push('grid');

  // 2. The command field: a person token from People, then a sentence Aura reads into tokens; the count is live; save as a view.
  const field = page.getByRole('textbox', { name: 'Filter, search or ask' });
  await field.click();
  const sug = page.getByRole('dialog', { name: 'Filter suggestions' });
  await sug.waitFor();
  assert.match(await sug.innerText(), /PEOPLE[\s\S]*STATUS[\s\S]*Late\s*1[\s\S]*At risk\s*2[\s\S]*DATES[\s\S]*Overdue[\s\S]*This week[\s\S]*PROJECTS[\s\S]*Payments Revamp[\s\S]*Saved views/i);
  await field.fill('ravi');
  await sug.getByRole('button', { name: 'Ravi Menon 2 tasks' }).waitFor();
  await field.press('Enter');
  assert.match(await page.locator('.ps3-cmd .ps3-tok').first().innerText(), /owner\s*Ravi Menon/);
  assert.equal(await page.locator('.ps3-count').innerText(), '2 of 10 tasks');
  await field.fill('late this week');
  assert.match(await sug.innerText(), /Aura read this as\s*status\s*Late or at risk\s*due\s*This week/);
  assert.equal(await page.locator('.ps3-count').innerText(), '1 of 10 tasks');
  await shot(page, '02-filter-command-light-1440.png');
  await sug.getByRole('button', { name: '＋ Save as view' }).click();
  await sug.getByRole('textbox', { name: 'Name for the view' }).fill('Ravi this week');
  n = writes.length; await sug.getByRole('button', { name: 'Save', exact: true }).click();
  const sv = await waitWrite((w) => w.ep === '/api/v1/saved-views', n);
  assert.deepEqual(sv.b.config.tokens.map((t) => `${t.kind}:${t.label}`), ['owner:Ravi Menon', 'status:Late or at risk', 'due:This week']);
  assert.equal(sv.b.config.list, 'sheet');
  // Typed tokens work too.
  await page.locator('.ps3-cmd').getByRole('button', { name: /Remove/ }).first().waitFor();
  while (await page.locator('.ps3-cmd .ps3-tok .x').count()) await page.locator('.ps3-cmd .ps3-tok .x').first().click();
  await field.fill('status:late');
  await field.press('Enter');
  assert.equal(await page.locator('.ps3-count').innerText(), '1 of 10 tasks');
  await page.locator('.ps3-cmd .ps3-tok .x').first().click();
  await field.press('Escape');
  assert.equal(await page.locator('.ps3-count').innerText(), '10 tasks');
  checks.push('command-field-tokens-views');

  // ⋯ and ⌘K carry Paste, Export and Present.
  await page.getByRole('button', { name: 'More on the plan sheet' }).click();
  for (const label of ['Paste from Excel', 'Export to Excel', 'Export as CSV', 'Present']) assert.ok(await page.getByRole('menuitem', { name: new RegExp(`^${label}`) }).isVisible(), label);
  n = writes.length; await page.getByRole('menuitem', { name: /^Export to Excel/ }).click();
  assert.match((await waitWrite((w) => w.ep === '/api/v1/portfolio/sheet/export', n)).q, /format=xlsx/);
  await page.locator('body').click({ position: { x: 700, y: 870 } });
  // ⌘K goes to Aura's dock; pressed again it opens the command palette, which carries the sheet's commands.
  await page.keyboard.press('Control+k'); await page.waitForTimeout(150); await page.keyboard.press('Control+k');
  const pal = page.getByRole('dialog', { name: 'Command palette' });
  await pal.waitFor();
  await pal.getByRole('textbox').fill('paste');
  assert.ok(await pal.getByText('Paste from Excel').isVisible());
  await page.keyboard.press('Escape');
  checks.push('more-menu-palette');

  // 3. Dates: calendar with chips, slip, ripple for the task after it, the overlap warning; a later date asks one reason; Undo puts it back.
  await cellOf(page, 'CB-02', 'dates').click();
  const dp = page.getByRole('dialog', { name: 'Dates of CB-02' });
  await dp.waitFor();
  for (const c of ['Today', 'Fri', '+1 week', '+2d']) assert.ok(await dp.getByRole('button', { name: c, exact: true }).isVisible(), c);
  assert.equal(await dp.getByRole('textbox', { name: 'Type a date' }).getAttribute('placeholder'), 'Type “next tue”');
  await dp.getByRole('button', { name: '30 Oct', exact: true }).click();
  assert.match(await dp.innerText(), /Due\s*27 Oct → 30 Oct \+3d slip/);
  assert.match(await dp.innerText(), /Ripple\s*CB-03 moves 3 Nov → 6 Nov/);
  await dp.getByRole('button', { name: 'Next month' }).click();
  await dp.getByRole('button', { name: '4 Nov', exact: true }).click();
  assert.match(await dp.innerText(), /CB-03 starts 3 Nov, before this ends\. Shift it too/);
  await dp.getByRole('button', { name: 'Previous month' }).click();
  await dp.getByRole('textbox', { name: 'Type a date' }).fill('fri');
  await dp.getByRole('textbox', { name: 'Type a date' }).press('Enter');
  assert.match(await dp.innerText(), /27 Oct → 30 Oct \+3d slip/);
  await shot(page, '03-edit-date-light-1440.png');
  await dp.getByRole('button', { name: 'Save', exact: true }).click();
  const why = page.getByRole('dialog', { name: /Why are 2 due dates moving\?/ });
  await why.waitFor();
  await why.getByRole('button', { name: 'Dependency late' }).click();
  n = writes.length; await why.getByRole('button', { name: 'Save' }).click();
  const w1 = await bulkAfter(n);
  assert.deepEqual(w1.b.changes.map((c) => [c.id, c.dueDate, c.startDate ?? null]), [[T['CB-02'], '2026-10-30', null], [T['CB-03'], '2026-11-27', '2026-11-06']]);
  assert.equal(w1.b.dueDateReason, 'Dependency late');
  const toastEl = page.locator('.ps3-toast').first();
  await toastEl.waitFor();
  assert.match(await toastEl.innerText(), /Moved CB-02 and 1 after it[\s\S]*Undo ⌘Z[\s\S]*History/);
  n = writes.length; await grid.focus(); await page.keyboard.press('Control+z');
  const w2 = await bulkAfter(n);
  assert.deepEqual(w2.b.changes.map((c) => [c.id, c.dueDate]), [[T['CB-02'], '2026-10-27'], [T['CB-03'], '2026-11-24']]);
  assert.equal(w2.b.dueDateReason, 'Undone on the plan sheet');
  checks.push('date-editor-ripple-reason-undo');

  // 4. People: weekly load per person (the capacity plan), over 100% in red with a warning that names Aura's suggestion.
  await cellOf(page, 'AA-06', 'owner').click();
  const pp = page.getByRole('dialog', { name: 'Owner of AA-06' });
  await pp.waitFor();
  assert.match(await pp.innerText(), /Workload · 2–8 Nov[\s\S]*SUGGESTED[\s\S]*Asha Rao[\s\S]*Free most of the week[\s\S]*EVERYONE/);
  const ravi = pp.getByRole('option', { name: /Ravi Menon/ });
  assert.match(await ravi.innerText(), /1\d\d%/);
  await ravi.hover();
  const warnT = page.locator('.ps3-toast.warn');
  await warnT.waitFor();
  assert.match(await warnT.innerText(), /Ravi Menon would be at 1\d\d% the week of 2 Nov — Aura suggests Asha Rao/);
  await shot(page, '04-edit-people-workload-light-1440.png');
  n = writes.length; await pp.getByRole('option', { name: /Tomás Ortega/ }).click();
  assert.equal((await bulkAfter(n)).b.changes[0].assigneeId, S.TO[0]);
  await warnT.waitFor({ state: 'detached' });
  checks.push('people-workload');

  // Status picker and the progress slider.
  await cellOf(page, 'PR-01', 'status').click();
  const sp = page.getByRole('listbox', { name: 'Status of PR-01' });
  await sp.waitFor();
  n = writes.length; await sp.getByRole('option', { name: /Review/ }).click();
  assert.equal((await bulkAfter(n)).b.changes[0].statusId, `${PR}-s2`);
  await cellOf(page, 'DP-04', 'progress').click();
  const pg = page.getByRole('dialog', { name: 'Progress of DP-04' });
  await pg.getByRole('slider', { name: 'Progress' }).fill('85');
  n = writes.length; await pg.getByRole('button', { name: 'Save' }).click();
  assert.equal((await bulkAfter(n)).b.changes[0].progress, 85);
  // Notes: @ suggests people.
  await cellOf(page, 'AA-06', 'notes').click();
  const ne = page.getByRole('dialog', { name: 'Notes of AA-06' });
  await ne.getByRole('textbox', { name: 'Note' }).fill('Needs a window from @Le');
  await ne.getByRole('option', { name: /Lena Park/ }).waitFor();
  await ne.getByRole('textbox', { name: 'Note' }).press('Enter');
  await ne.getByRole('textbox', { name: 'Note' }).pressSequentially('https://wiki.example.test/cutover');
  n = writes.length; await ne.getByRole('button', { name: 'Save' }).click();
  assert.equal((await bulkAfter(n)).b.changes[0].notes, 'Needs a window from @Lena https://wiki.example.test/cutover');
  checks.push('status-progress-notes');

  // 5. Fill handle: drag 100% down two rows; Aura offers the checklists instead; the toast offers Undo and History.
  await cellOf(page, 'CB-01', 'progress').click();
  await page.getByRole('dialog', { name: 'Progress of CB-01' }).waitFor();
  await page.keyboard.press('Escape');
  const handle = cellOf(page, 'CB-01', 'progress').locator('.ps3-handle');
  const hb0 = await handle.boundingBox();
  const target = await cellOf(page, 'CB-03', 'progress').boundingBox();
  await page.mouse.move(hb0.x + 4, hb0.y + 4); await page.mouse.down();
  await page.mouse.move(hb0.x + 4, target.y + target.height / 2, { steps: 8 });
  assert.equal(await grid.locator('td.rng').count(), 2, 'the range is outlined while dragging');
  await page.mouse.up();
  const smart = page.getByRole('dialog', { name: 'Smart fill' });
  await smart.waitFor();
  assert.match(await smart.innerText(), /Fill progress from status\?[\s\S]*CB-02 and CB-03 aren’t done[\s\S]*CB-02\s*100% → 43% 3 of 7 items[\s\S]*CB-03\s*100% → 11% 1 of 9 items/);
  await shot(page, '05-fill-handle-aura-light-1440.png');
  n = writes.length; await smart.getByRole('button', { name: 'Use smart fill' }).click();
  assert.deepEqual((await bulkAfter(n)).b.changes.map((c) => c.progress), [43, 11]);
  await page.locator('.ps3-toast', { hasText: 'Smart-filled 2 cells' }).waitFor();
  assert.match(await page.locator('.ps3-toast').innerText(), /edits this minute/);
  await shot(page, '05b-undo-toast-light-1440.png');
  await page.locator('.ps3-toast').getByRole('button', { name: 'History' }).click();
  assert.match(await page.getByRole('dialog', { name: 'Edit history' }).innerText(), /Smart-filled 2 cells[\s\S]*Gave AA-06 to Tomás Ortega/);
  await page.keyboard.press('Escape');
  checks.push('fill-handle-smart-fill-history');

  // 6. Paste from Excel: columns matched by header, loose names matched, WIP → In progress, DD/MM dates, a bad row flagged.
  const tsv = ['Task name\tAssignee\tStart date\tEnd date\tState\t% done', 'Bulk enquiry reconciliation report\tJ. Weber\t10/11/2026\t21/11/2026\tWIP\t15',
    'Retry dashboard alerts\tAisha K\t12/11/2026\t14/11/2026\tOpen\t0', 'Bureau v2 cut-over runbook\ttomas.ortega\t17/11/2026\t24/11/2026\tOpen\t0', 'Archive old bureau files\tops team\t31/11/2026\t02/12/2026\tOpen\t0'].join('\n');
  await cellOf(page, 'CB-02', 'task').click();   // the inspector's project is where the rows go
  await page.evaluate((text) => { const dt = new DataTransfer(); dt.setData('text/plain', text); document.querySelector('.ps3-scroll').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true })); }, tsv);
  const pm = page.getByRole('dialog', { name: 'Paste from Excel' });
  await pm.waitFor();
  await pm.getByText('Bulk enquiry reconciliation report').waitFor();
  const pt = await pm.innerText();
  assert.match(pt, /Paste 4 rows into/);
  assert.equal(await pm.getByRole('combobox', { name: 'Project to paste into' }).inputValue(), CB);
  for (const s of ['From Excel · Task name', '✓ Title', '! Matched 3 of 4 people', '✓ Dates · start', '“WIP” → In progress', '✓ Percent']) assert.ok(pt.includes(s), s);
  assert.match(pt, /Jonas Weber\s*10 Nov\s*21 Nov\s*In progress\s*15%/);
  assert.match(pt, /“Archive old bureau files” — Owner unknown: “ops team” · Start “31\/11\/2026” is not a date/);
  assert.match(pt, /Dates read as DD\/MM/);
  assert.equal(await pm.getByRole('button', { name: 'Add 3 tasks' }).isEnabled(), true);
  await shot(page, '06-paste-mapping-light-1440.png');
  const pw = writes.filter((w) => w.ep === '/api/v1/portfolio/sheet/paste').pop();
  assert.deepEqual(pw.b.rows[0], { title: 'Bulk enquiry reconciliation report', owner: 'Jonas Weber', start: '2026-11-10', due: '2026-11-21', status: 'WIP' });
  assert.equal(pw.b.rows[2].owner, 'Tomás Ortega');
  n = writes.length; await pm.getByRole('button', { name: 'Add 3 tasks' }).click();
  const commit = await waitWrite((w) => w.ep === '/api/v1/portfolio/sheet/paste' && w.b.commit, n);
  assert.deepEqual(commit.b.include, [0, 1, 2]);
  assert.deepEqual((await bulkAfter(n)).b.changes, [{ id: g(600), progress: 15 }]);
  await pm.waitFor({ state: 'detached' });
  checks.push('paste-mapping');

  // 7. Inspector: the grid shrinks to Task, Owner, Due, Status; fields, notes, checklist, meeting and activity on the right.
  await cellOf(page, 'AA-05', 'task').click();
  const insp = page.getByRole('complementary', { name: 'AA-05 details' });
  await insp.waitFor();
  assert.deepEqual(await grid.locator('thead th').allInnerTexts(), ['Task', 'Owner', 'Due', 'Status']);
  await insp.getByText('Collect expired-artefact samples').waitFor();
  const it = await insp.innerText();
  for (const s of ['Validate skip-consent flow for repeat lenders', 'Status', 'At risk', 'Ravi Menon', '23 Oct → 30 Oct', 'AA-04 · done', 'AA-06', 'CHECKLIST · 2 of 5', 'Review', 'ACTIVITY', 'Ravi moved due 26 Oct → 28 Oct']) assert.ok(it.toUpperCase().includes(s.toUpperCase()), s);
  await shot(page, '07-inspector-light-1440.png');
  n = writes.length; await insp.getByRole('checkbox', { name: /Confirm copy with legal/ }).click();
  assert.deepEqual((await waitWrite((w) => w.ep.includes('/checklist/'), n)).b, { isDone: true });
  await insp.getByRole('button', { name: 'Close details' }).click();
  await insp.waitFor({ state: 'detached' });
  checks.push('inspector');

  // 8. Dark: drag PR-01 into Credit Bureau Integration (after CB-03).
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  const grip = page.getByRole('button', { name: 'Drag PR-01 to move it' });
  await cellOf(page, 'PR-01', 'task').hover();
  const gb = await grip.boundingBox();
  const cb3 = await page.locator(`tr[data-row="${T['CB-03']}"]`).boundingBox();
  await page.mouse.move(gb.x + 4, gb.y + 4); await page.mouse.down();
  await page.mouse.move(600, cb3.y + cb3.height - 6, { steps: 10 });
  await page.locator('.ps3-dragrow', { hasText: 'Move to Credit Bureau Integration' }).waitFor();
  assert.ok(await page.locator('.ps3-drop').isVisible());
  await shot(page, '08-dark-drag-reorder-1440.png');
  n = writes.length; await page.mouse.up();
  const mv = await waitWrite((w) => w.ep === '/api/v1/portfolio/sheet/move', n);
  assert.deepEqual(mv.b, { id: T['PR-01'], projectId: CB, afterId: T['CB-03'], beforeId: null, version: 3 });
  await page.locator('.ps3-toast', { hasText: 'Moved PR-01 to Credit Bureau Integration as CB-4' }).waitFor();
  checks.push('drag-to-project');
  await shot(page, '08b-dark-sheet-1440.png');
  // Split and Timeline layouts.
  await page.getByRole('tablist', { name: 'Sheet layout' }).getByRole('tab', { name: 'Split' }).click();
  assert.deepEqual((await grid.locator('thead th').allInnerTexts()).slice(0, 4), ['Task', 'Owner', 'Dates', 'Status']);
  assert.equal(await grid.locator('.ps3-gantt b').count(), 10);
  await shot(page, '08c-split-dark-1440.png');
  await page.getByRole('tablist', { name: 'Sheet layout' }).getByRole('tab', { name: 'Sheet' }).click();
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  checks.push('split-timeline-dark');
  assert.deepEqual(errors, []);

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
  await page.locator('.ps3-card').first().waitFor();
  const pf = page.getByRole('textbox', { name: 'Filter, search or ask' });
  await pf.fill('late or at risk'); await pf.press('Enter'); await pf.press('Escape');
  assert.match(await page.locator('.ps3-cmd .ps3-tok').innerText(), /Late or at risk/);
  assert.equal(await page.locator('.ps3-count').innerText(), '3');
  assert.equal(await page.locator('.ps3-card-row').count(), 3);
  const up1 = page.getByRole('button', { name: 'UP-01 Mandate registration and revoke callbacks' });
  assert.match(await up1.innerText(), /Mei ·\s*18 Oct\s*\+11d[\s\S]*45%/);
  await page.waitForTimeout(300);
  await fitsPhone(page, 'plan sheet phone', assert);
  await shot(page, '09-phone-light-390.png');
  // Swipe right: Done.
  n = writes.length;
  await up1.evaluate((el) => { const t = (x) => new Touch({ identifier: 1, target: el, clientX: x, clientY: 200 }); el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [t(60)], changedTouches: [t(60)] })); el.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [t(200)], changedTouches: [t(200)] })); });
  await page.waitForTimeout(50);
  await shot(page, '09b-phone-swipe-390.png');
  await up1.evaluate((el) => { const t = (x) => new Touch({ identifier: 1, target: el, clientX: x, clientY: 200 }); el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [t(200)] })); });
  assert.equal((await bulkAfter(n)).b.changes[0].statusId, `${UP}-s3`, 'swipe right marks it done');
  // A tap opens the bottom sheet.
  await page.getByRole('button', { name: /^CB-02 / }).click();
  const bs = page.getByRole('dialog', { name: /^CB-02 / });
  await bs.waitFor();
  await page.waitForTimeout(250);
  await shot(page, '09c-phone-sheet-390.png');
  await bs.getByRole('button', { name: '+2d' }).click();
  const why2 = page.getByRole('dialog', { name: 'Why is CB-02 moving?' });
  await why2.waitFor();
  await why2.getByRole('button', { name: 'Cancel' }).click();
  checks.push('phone-sheet');
  await page.goto(`${origin}/preview-org/work/projects?view=portfolio&mode=timeline`);
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
