// One consistent, stateful Portfolio fixture for the shell checks: the same five fictional projects on the Plan sheet, the Board (brief), the
// Timeline and Capacity, so an edit on one tab can be seen on the others. A sheet edit (status, due date) is applied to the in-memory rows and
// the project's progress, health and due date are worked out again, the way the server does. Synthetic data only (fictional people and projects).
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { appCsp } from './csp.mjs';

export const origin = 'https://projecttracker-preview.test';
export const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false, mfaEnabled: true };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Riverline Payments', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 8 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
export const NOW = new Date('2026-10-29T10:30:00+05:30'); export const today = '2026-10-29';
const g = (n) => `72000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const S = { RM: [g(911), 'Ravi Menon'], LP: [g(912), 'Lena Park'], JW: [g(913), 'Jonas Weber'], AK: [g(914), 'Aisha Khan'], TO: [g(915), 'Tomás Ortega'], MC: [g(916), 'Mei Chen'], AR: [user.id, 'Asha Rao'] };
export const people = Object.values(S).map(([id, name]) => ({ id, name }));
export const P = { AA: g(41), CB: g(42), UP: g(43), DP: g(44), PR: g(45) };
export const T = {};

export function makeState() {
  const st = (pid, n) => ({ id: `${pid}-s${n}`, projectId: pid, name: ['To do', 'In progress', 'Review', 'Done'][n], category: ['Todo', 'Active', 'Active', 'Done'][n] });
  const statuses = Object.values(P).flatMap((p) => [0, 1, 2, 3].map((n) => st(p, n)));
  const row = (o) => ({ kind: 'task', parentId: null, level: 1, ownerId: null, owner: null, start: null, due: null, dueTime: null, durationDays: null, status: 'To do', category: 'Todo', statusId: null,
    progress: 0, dependsOn: [], cadence: null, nextAt: null, updatedAt: null, updatedBy: null, notes: null, late: false, atRisk: false, version: 3, canEdit: true,
    estimatedHours: null, checklistTotal: null, checklistDone: null, manualProgress: false, slipDays: null, ...o });
  const sw = (k) => ({ ownerId: S[k][0], owner: S[k][1] });
  const task = (pid, n, key, title, k, start, due, sn, progress, extra = {}) => { const id = g(100 + n); T[key] = id; return row({ id, projectId: pid, key, title, ...sw(k), start, due, status: st(pid, sn).name, category: st(pid, sn).category, statusId: st(pid, sn).id, progress, ...extra }); };
  const proj = (id, key, title, k, start, due, status, category, progress, extra = {}) => row({ kind: 'project', id, projectId: id, level: 0, key, title, ...sw(k), start, due, status, category, progress, canEdit: false, ...extra });
  const rows = [
    proj(P.AA, 'AA', 'Account Aggregator', 'RM', '2026-10-02', '2026-11-14', 'At risk', 'AtRisk', 58, { atRisk: true }),
    task(P.AA, 1, 'AA-04', 'Consent manager sandbox onboarding', 'LP', '2026-10-02', '2026-10-18', 3, 100),
    task(P.AA, 2, 'AA-05', 'Validate skip-consent flow for repeat lenders', 'RM', '2026-10-23', '2026-10-30', 1, 40, { atRisk: true }),
    task(P.AA, 3, 'AA-06', 'Production cut-over and smoke tests', 'RM', '2026-11-06', '2026-11-14', 0, 0),
    proj(P.CB, 'CB', 'Credit Bureau Integration', 'TO', '2026-10-09', '2026-11-24', 'At risk', 'AtRisk', 47, { atRisk: true }),
    task(P.CB, 4, 'CB-01', 'UAT SSL certificate configuration', 'TO', '2026-10-09', '2026-10-13', 3, 100),
    task(P.CB, 5, 'CB-02', 'Consumer report parsing for v2 schema', 'AK', '2026-10-22', '2026-10-27', 1, 35, { atRisk: true }),
    task(P.CB, 6, 'CB-03', 'Bulk enquiry batch job with retry policy', 'JW', '2026-11-03', '2026-11-24', 1, 10),
    proj(P.UP, 'UP', 'UPI AutoPay', 'MC', '2026-08-05', '2026-10-18', 'Late', 'Delayed', 45, { late: true }),
    task(P.UP, 7, 'UP-01', 'Mandate registration and revoke callbacks', 'MC', '2026-08-05', '2026-10-18', 1, 45, { late: true }),
    proj(P.DP, 'DP', 'Data Privacy API', 'JW', '2026-10-20', '2026-11-10', 'On track', 'OnTrack', 85),
    task(P.DP, 8, 'DP-03', 'Complete SIT deployment and sign-off', 'JW', '2026-10-26', '2026-10-27', 3, 100),
    task(P.DP, 9, 'DP-04', 'Masking rules for PII fields in logs', 'LP', '2026-10-20', '2026-11-10', 1, 70),
    proj(P.PR, 'PR', 'Payments Revamp', 'AK', '2026-10-27', '2026-12-12', 'On track', 'OnTrack', 20),
    task(P.PR, 10, 'PR-01', 'Checkout flow API contract and mocks', 'AK', '2026-10-27', '2026-11-07', 1, 20),
  ];
  return { rows, statuses, writes: [] };
}

const HEALTH = { AtRisk: 'AtRisk', Delayed: 'Delayed', OnTrack: 'OnTrack', Done: 'Completed' };
/** The server's roll-up, simplified: progress is the mean of the tasks, a project with nothing open is complete, any late task makes it late. */
function rollUp(s) {
  for (const p of s.rows.filter((r) => r.kind === 'project')) {
    const tasks = s.rows.filter((r) => r.kind === 'task' && r.projectId === p.id);
    p.progress = Math.round(tasks.reduce((n, t) => n + (t.category === 'Done' ? 100 : t.progress ?? 0), 0) / Math.max(1, tasks.length));
    const open = tasks.filter((t) => t.category !== 'Done');
    p.late = open.some((t) => t.late); p.atRisk = !p.late && open.some((t) => t.atRisk);
    p.category = open.length === 0 ? 'Done' : p.late ? 'Delayed' : p.atRisk ? 'AtRisk' : 'OnTrack';
    p.status = { Done: 'Done', Delayed: 'Late', AtRisk: 'At risk', OnTrack: 'On track' }[p.category];
    p.due = tasks.reduce((d, t) => (t.due && t.due > d ? t.due : d), p.due);
  }
}
const sheet = (s) => ({ asOf: today, timeZone: 'Asia/Kolkata', rows: s.rows, people, statuses: s.statuses, truncated: false, canEdit: true, meetings: false, calendarFeed: false, calendarSyncedAt: null,
  scopes: [{ id: 'all', label: 'Everything I can see', allowed: true, why: null, teamId: null }] });
const projectsOf = (s) => s.rows.filter((r) => r.kind === 'project');
const timeline = (s) => ({ from: '2026-08-01', to: '2026-12-19', projects: projectsOf(s).map((p, i) => ({
  id: p.id, key: p.key, name: p.title, health: HEALTH[p.category] ?? 'OnTrack', group: 'Delivery', start: p.start, due: p.due, originalDue: null, forecast: null, progress: p.progress, milestones: [], dependsOn: [],
  ownerId: p.ownerId, owner: p.owner, team: i < 2 ? 'Team Lending' : 'Team Payments', teamId: g(800 + (i < 2 ? 0 : 1)), slipDays: 0, confidence: 'medium', forecastBasis: null, openTasks: 2, blockedTasks: 0, finishedLast28Days: 3, version: 4, status: 'Active', lastChange: null })) });
const brief = (s) => {
  const ps = projectsOf(s), n = (c) => ps.filter((p) => p.category === c).length;
  return { asOf: today, projects: ps.length, onTrack: n('OnTrack'), atRisk: n('AtRisk'), delayed: n('Delayed'), onHold: 0, workComplete: n('Done'), overdueTasks: 1, blockedTasks: 0, openActionItems: 0, overdueActionItems: 0, dateChangesLast30Days: 0,
    headlines: [`${ps.length} active projects: ${n('OnTrack')} on track, ${n('AtRisk')} at risk, ${n('Delayed')} late.`], recentSlips: [], stretched: [],
    ranked: ps.map((p) => ({ projectId: p.id, key: p.key, name: p.title, group: 'Delivery', health: HEALTH[p.category], progress: p.progress, owner: p.owner, startDate: p.start, dueDate: p.due, delayedDays: 0, openTasks: 2, overdueTasks: 0,
      blockedTasks: 0, openActionItems: 0, overdueActionItems: 0, finishedLast28Days: 3, inProgressTasks: 1, projectedFinish: null, projectedSlipDays: 0, confidence: 'medium', score: 1, level: 'Low', reasons: [] })) };
};
const board = (s) => { const b = brief(s); return { asOf: today, filter: {}, brief: b, decisions: [], summary: b.headlines[0], owners: people, groups: [{ id: 'g1', name: 'Delivery' }],
  money: { entitled: false, showMoney: false, currency: 'INR', budget: 0, spent: 0, forecast: 0, overrunning: 0, projects: [], burn: [], notes: [] }, capacity: { from: today, to: today, people: 7, over: [], projectsAtRisk: [], notes: [] } }; };
const mon = '2026-10-26';
const wk = (i) => new Date(Date.parse(mon) + i * 7 * 86_400_000).toISOString().slice(0, 10);
const plan = () => ({ from: mon, weeks: 6, scope: 'Everyone', available: ['Everyone', 'Me'], entitled: true, weekStarts: [0, 1, 2, 3, 4, 5].map(wk), suggestion: null,
  totals: { capacityMinutes: 7 * 6 * 2400, bookedMinutes: 7 * 6 * 2000, booked: 0.83, overWeeks: 2, leaveWeeks: 0, publicHolidays: 0 },
  people: people.map((p, k) => ({ userId: p.id, name: p.name, weeklyCapacityMinutes: 2400, weeks: [0, 1, 2, 3, 4, 5].map((i) => { const b = [2600, 2100, 1700, 2300, 1500, 2000, 900][k] - i * 120; return { weekStart: wk(i), capacityMinutes: 2400, bookedMinutes: b, leaveDays: 0, workingDays: 5, onLeave: false, over: b > 2400, holidayDays: 0 }; }) })) });

/** A browser context that serves dist and answers the API from `state`. `delay` (ms) holds every portfolio read back, to see the loading state. */
export async function portfolioContext(browser, { theme = 'light', width = 1440, state, delay = 0 }) {
  const dist = path.resolve('dist'), csp = await appCsp();
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block', acceptDownloads: true, viewport: { width, height: width < 500 ? 844 : 900 }, ...(width < 500 ? { hasTouch: true, isMobile: true } : {}) });
  await ctx.clock.setFixedTime(NOW);
  await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); localStorage.setItem('pm_home_mode', 'classic'); }, theme);
  const reads = [];
  await ctx.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
    if (url.origin !== origin) { await route.abort(); return; }
    if (ep.endsWith('/avatar')) { await route.fulfill({ status: 404, body: '' }); return; }
    if (!ep.startsWith('/api/')) {
      const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
      await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
      return;
    }
    let data = [];
    if (ep === '/api/v1/portfolio/sheet/bulk' && method === 'POST') {
      const b = req.postDataJSON(); state.writes.push({ ep, b });
      for (const c of b.changes) {
        const r = state.rows.find((x) => x.id === c.id); if (!r) continue;
        if (c.statusId) { const s = state.statuses.find((x) => x.id === c.statusId); r.statusId = s.id; r.status = s.name; r.category = s.category; if (s.category === 'Done') { r.late = false; r.atRisk = false; r.progress = 100; } }
        if (c.dueDate) { r.due = c.dueDate; r.late = r.category !== 'Done' && c.dueDate < today; }
        if (c.title) r.title = c.title;
        r.version++;
      }
      rollUp(state);
      data = { changed: b.changes.length, failed: 0, rows: b.changes.map((c) => ({ id: c.id, key: null, ok: true, error: null, field: null, code: null, version: 9, told: 0, emailed: 0 })) };
    } else if (ep === '/api/v1/me/ui/plansheet' && method === 'PUT') { data = { key: 'plansheet', value: req.postDataJSON().value, updatedAt: NOW.toISOString() }; }
    else if (ep === '/api/v1/meet/review' && method === 'POST') data = { sessionId: g(1100), scope: 'all', seriesRef: null, title: 'All projects', cadence: '', occurrence: null, previousSession: null, nextSession: null, attendees: 0,
      counts: { total: 0, reviewed: 0, done: 0, inProgress: 0, overdue: 0, blocked: 0, noUpdate: 0 }, items: [], finished: false, sent: false, draft: [], projectId: null };
    else {
      assert.ok(method === 'GET' || ep.endsWith('/auth/refresh'), `Unexpected write: ${method} ${ep}`);
      if (ep.startsWith('/api/v1/portfolio/') || ep === '/api/v1/resources/plan') { reads.push(ep); if (delay) await new Promise((r) => setTimeout(r, delay)); }
      if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
      else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['projects.view', 'projects.edit', 'tasks.view', 'tasks.edit', 'tasks.create', 'org.manage', 'reports.view', 'reports.broad', 'work.view'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 3, activity: 3, documents: 3, people: 3, reports: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3 } } };
      else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
      else if (ep === '/api/v1/portfolio/board') data = board(state);
      else if (ep === '/api/v1/portfolio/sheet') data = sheet(state);
      else if (ep === '/api/v1/portfolio/timeline') data = timeline(state);
      else if (ep === '/api/v1/resources/plan') data = plan();
      else if (ep === '/api/v1/saved-views') data = [];
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
  const errors = [];
  const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page, errors, reads };
}
