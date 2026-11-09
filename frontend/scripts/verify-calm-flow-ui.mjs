import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Calm build (demo shots 04-04d, 29-29b, 70-75): Approvals (needs me, history, chain detail, the type-adaptive request sheet and the + button's
// `pt:new` event), Time (the hero, requests for attendance correction and leave), Reminders (smart tiles, the day by morning / afternoon /
// evening, quick add with live chips, the detail popover, the snooze menu) and Notes (three panes, the editor, the slash menu) - in light
// and dark at 1440 and 1920, and on a phone at 390. Built frontend with fictional fixtures only. Pages are served at /approvals, /time,
// /reminders and /notes (routes added by the shell).
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/calm-flow-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-0000000000a1', displayName: 'Ravi Menon', email: 'ravi@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Northwind', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 8 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const now = Date.now(), iso = (m) => new Date(now + m * 60000).toISOString();
const U = (id, name) => ({ id: `00000000-0000-0000-0000-0000000000${id}`, name });
const LP = U('b1', 'Lena Park'), SJ = U('b2', 'Sofia Jensen'), RM = { id: user.id, name: user.displayName }, TN = U('b3', 'Tom Nguyen'), PG = U('b4', 'Priya Gupta'), MC = U('b5', 'Mei Chen'), DO = U('b6', 'Dev Okafor');
const step = (order, role, approver, status, comment = null) => ({ order, role, approver, status, decidedAt: status === 'Approved' ? iso(-60 * order) : null, comment });
const A = (id, type, title, requester, risk, ago, extra = {}) => ({
  id, type, title, summary: null, payload: {}, risk, impact: null, links: [], requester, status: 'Pending', currentStep: 1, steps: [step(1, 'Owner', RM, 'Pending')], needsMe: true, mine: false,
  createdAt: iso(-ago), expiresAt: iso(120), decidedAt: null, outcome: null, events: null, ...extra,
});
const deploy = A('ap1', 'Deployment', 'Ship Payments API v2.4.0 to production', SJ, 'High', 130, {
  payload: { service: 'payments-api', environment: 'Production · ap-south-1', version: '2.4.0 (from 2.3.7)', window: 'Today 15:00 – 15:30', rollback: 'Re-deploy 2.3.7 · 4 min · Tom on call' },
  impact: 'All card refunds · 30 min window', links: [{ kind: 'pr', label: 'PR #815' }, { kind: 'task', label: 'ATL-482', href: '/work' }, { kind: 'env', label: 'prod' }], currentStep: 3,
  steps: [step(1, 'Lead', LP, 'Approved', 'QA green on build 412.'), step(2, 'Ops', SJ, 'Approved', 'Window booked.'), step(3, 'Owner', RM, 'Pending')],
  events: [{ id: 'e1', user: SJ, action: 'Requested', step: null, comment: null, at: iso(-130) }, { id: 'e2', user: LP, action: 'Approved', step: 1, comment: 'QA green on build 412.', at: iso(-112) }, { id: 'e3', user: SJ, action: 'Approved', step: 2, comment: 'Window booked.', at: iso(-91) }],
});
const needs = [deploy, A('ap2', 'Incident', 'Emergency fix: refund double-post', TN, 'High', 35, { links: [{ kind: 'p', label: 'Atlas' }, { kind: 'i', label: 'INC-219' }, { kind: 'h', label: 'hotfix' }] }),
  A('ap3', 'Access', 'Prod read access for Priya', PG, 'Low', 60, { payload: { resource: 'Helix warehouse', duration: '7 days' } }),
  A('ap4', 'ConfigChange', 'Raise webhook timeout to 8s', MC, 'Medium', 180, { needsMe: false, payload: { setting: 'Atlas', environment: 'staging → prod' }, steps: [step(1, 'Lead', LP, 'Pending'), step(2, 'Owner', RM, 'Waiting')] })];
const history = [
  A('h1', 'Deployment', 'Orbit iOS 3.2 to TestFlight', SJ, 'Medium', 600, { status: 'Approved', needsMe: false, decidedAt: iso(-500), steps: [step(1, 'Lead', LP, 'Approved', 'Looks good, ship it.')] }),
  A('h2', 'AttendanceCorrection', 'Attendance correction · Fri 30 Oct', RM, 'Low', 900, { status: 'Approved', needsMe: false, decidedAt: iso(-800), steps: [step(1, 'Lead', RM, 'Approved', 'Matched badge log.')] }),
  A('h3', 'ConfigChange', 'Disable legacy webhooks', MC, 'Medium', 2000, { status: 'Rejected', needsMe: false, decidedAt: iso(-1900), steps: [step(1, 'Ops', SJ, 'Rejected', 'Contoso still uses v1. Wait for 2.4.')] }),
  A('h4', 'Access', 'Admin access for vendor', RM, 'High', 4000, { status: 'Expired', needsMe: false, decidedAt: iso(-3000), steps: [step(1, 'Owner', RM, 'Skipped')] }),
  A('h5', 'Expense', 'Design tool seats · ₹12,400', DO, 'Medium', 6000, { status: 'Approved', needsMe: false, decidedAt: iso(-5900), steps: [step(1, 'Finance', DO, 'Approved')] }),
];
const apList = (view) => ({
  items: view === 'history' ? history : view === 'mine' ? needs.slice(3).map((x) => ({ ...x, mine: true })) : view === 'all' ? needs : needs.slice(0, 3),
  counts: { needsMe: 3, mine: 1, all: 4, history: history.length }, week: { approved: 14, rejected: 2, expired: 1, medianMinutes: 18 },
  byType: { Deployment: 4, ConfigChange: 2, ChangeRequest: 1, Incident: 1, AttendanceCorrection: 2, Leave: 1 }, expiringToday: 2, elsewhere: [{ kind: 'release', label: 'Release sign-offs', count: 1, href: '/quality' }],
});
const chain = (type) => ({ type, custom: false, rule: type === 'Leave' ? 'Leave needs Lead → People ops.' : 'Production deploys need Lead → Ops → Owner.',
  steps: (type === 'Leave' ? [['Lead', LP], ['People ops', DO]] : [['Lead', LP], ['Ops', SJ], ['Owner', RM]]).map(([r, p], i) => step(i + 1, r, p, 'Waiting')) });

// ---- time
const monday = (() => { const d = new Date(now + 330 * 60000); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();
const addD = (i, n) => { const d = new Date(`${i}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const todayIst = new Date(now + 330 * 60000).toISOString().slice(0, 10);
const mins = [385, 414, 420, 420, 240, 0, 0];
const days = mins.map((m, i) => { const date = addD(monday, i); return { date, minutes: date <= todayIst ? m : 0, targetMinutes: i < 5 ? 420 : 0, weekend: i >= 5, leave: false, leaveNote: null, future: date > todayIst, meetings: 0, meetingMinutes: 0 }; });
const row = (key, title, pid, pname, total) => ({ kind: 'task', targetId: `t-${key}`, key, title, projectId: pid, projectName: pname, billable: true, cells: [], totalMinutes: total });
const grid = { weekStart: monday, weekEnd: addD(monday, 6), user: RM, mine: true, editable: true, locked: false, status: 'NotSubmitted', days,
  rows: [row('ATL-482', 'ledger refactor', 'p1', 'Atlas Payments', 850), row('ORB-12', 'Design review, empty states', 'p2', 'Orbit Mobile', 460), row('HLX-7', 'Backfill prep', 'p3', 'Helix Data', 330), row('BEA-91', 'Contoso escalation', 'p4', 'Beacon Support', 240)],
  suggestions: [], totalMinutes: days.reduce((a, d) => a + d.minutes, 0), billableMinutes: 1540, targetMinutes: 2100, overtimeMinutes: 0, missingDays: 1, running: null };
const draft = { weekStart: monday, cells: [{ kind: 'task', targetId: 't-ORB-12', key: 'ORB-12', title: 'Orbit review prep', projectName: 'Orbit Mobile', date: monday, minutes: 35, why: 'Your calendar shows Orbit review prep from 13:00 to 13:35' }], days: [] };
const tinsights = { user: RM, from: monday, to: monday, weeks: [], byProject: [], byWeekday: [1, 2, 3, 4, 5].map((d) => ({ day: d, averageMinutes: d === 1 ? 300 : 420 })), loggedMinutes: 0, billableMinutes: 0, targetMinutes: 0, overtimeMinutes: 0, utilisation: null, billableShare: 0.82, sameDayShare: null, streak: 10, missingDays: [] };
const activity = { items: [['Mei Chen', 'Mei added the release checklist', 'Task', 10], ['Lena Park', 'Lena commented on Onboarding spec', 'Comment', 60], ['Ama Kofi', 'Ama signed off Schema v3', 'Document', 120], ['Tom Nguyen', 'Tom booked the load test', 'Task', 180]].map(([n, s, t, m], i) => ({ id: `a${i}`, action: 'x', entityType: t, entityId: null, summary: s, actor: { id: `u${i}`, name: n }, projectId: null, createdAt: iso(-m) })), page: 1, pageSize: 25, totalItems: 4, totalPages: 1 };

// ---- reminders
const at = (h, m, dd = 0) => { const d = new Date(now + 330 * 60000); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + dd, h, m) - 330 * 60000).toISOString(); };
const R = (id, title, extra) => ({ id, source: 'Personal', state: 'Scheduled', title, note: null, targetType: 'None', targetId: null, targetKey: null, targetTitle: null, link: null, timeZone: 'Asia/Kolkata', localAt: null, anchorDays: null, anchorTime: null, recurrence: null, recurrenceText: null, onlyIfOpen: true, exact: true, nextFireAt: null, isSnoozed: false, snoozeCount: 0, fireCount: 0, lastFiredAt: null, quiet: false, completedAt: null, seriesId: null, from: null, for: null, canEdit: true, createdAt: iso(-600), flagged: false, list: null, ...extra });
const reminders = {
  open: [
    R('r1', 'Call Sofia about staging keys', { state: 'Fired', lastFiredAt: at(10, 0), flagged: true, targetType: 'Task', targetId: 't1', targetKey: 'ATL-482', list: 'Work' }),
    R('r2', 'Send Contoso the fix date', { source: 'Nudge', nextFireAt: at(14, 30), from: LP, note: 'Before the 15:00 cut, please.', targetType: 'Task', targetId: 't2', targetKey: 'BEA-91', targetTitle: 'Contoso SSO fix', list: 'Work', snoozeCount: 1, canEdit: false }),
    R('r3', 'Prep for Design review', { source: 'Meeting', nextFireAt: at(13, 50), targetKey: 'ORB-1', targetTitle: 'Design review · 14:00' }),
    R('r4', 'Refund retries due today', { source: 'DueDate', nextFireAt: at(15, 0), targetType: 'Task', targetId: 't1', targetKey: 'ATL-482' }),
    R('r5', 'Submit timesheet', { nextFireAt: at(17, 30), recurrence: 'FREQ=WEEKLY;BYDAY=FR', recurrenceText: 'Every Friday', list: 'Work' }),
    R('r6', 'Water the plants', { nextFireAt: at(19, 0), recurrence: 'FREQ=DAILY;INTERVAL=3', recurrenceText: 'Every 3 days', list: 'Home' }),
    R('r7', 'Book load-test room', { nextFireAt: at(9, 0, 2), list: 'Release 2.4' }),
  ],
  completed: [R('r9', 'Standup notes to Lena', { state: 'Done', completedAt: at(9, 45) })], sent: [R('r10', 'Review the pricing hero', { for: PG, nextFireAt: at(11, 0, 1) })],
  counts: { now: 1, today: 5, upcoming: 6, completed: 1 }, limits: { open: 500, recurring: 100, openUsed: 7, recurringUsed: 2 },
};
const suggestions = [{ id: 's1', title: 'Send the load test plan', fireAt: at(9, 0, 1), sourceKind: 'chat', link: null, quote: 'I’ll send the load test plan tomorrow', createdAt: iso(-30) }, { id: 's2', title: 'Send Ama the file', fireAt: at(10, 0, 1), sourceKind: 'chat', link: null, quote: 'Kal tak bhej dunga', createdAt: iso(-60) }];
const watches = [{ id: 'w1', kind: 'done', targetType: 'Task', targetKey: 'ATL-482', targetTitle: 'Refund retries', status: null, onDate: null, note: null, link: null, state: 'active', createdAt: iso(-100), expiresAt: iso(60 * 24 * 3), firedAt: null, outcome: null, label: 'is done' },
  { id: 'w2', kind: 'slips', targetType: 'Project', targetKey: 'Helix', targetTitle: 'Helix', status: null, onDate: null, note: null, link: null, state: 'active', createdAt: iso(-100), expiresAt: iso(60 * 24 * 30), firedAt: null, outcome: null, label: 'slips past Dec 12' }];

// ---- notes
const blocks = [{ id: 'b1', type: 'p', text: 'Cut is **15:00 sharp**. Anything not merged moves to 2.4.1. Owner on call: @Tom Nguyen.', refs: [{ type: 'mention', userId: TN.id, label: 'Tom Nguyen' }] },
  { id: 'b2', type: 'h', text: 'Before the cut' }, { id: 'b3', type: 'check', text: 'Freeze main at 14:30', done: true },
  { id: 'b4', type: 'check', text: 'Refund retries merged #ATL-482 · Refund webhook retries', refs: [{ type: 'link', kind: 'task', id: 't1', label: 'ATL-482 · Refund webhook retries', href: '/work' }] },
  { id: 'b5', type: 'check', text: 'Staging keys from @Sofia', refs: [{ type: 'mention', userId: SJ.id, label: 'Sofia' }] }, { id: 'b6', type: 'check', text: 'Status page notice drafted', done: true },
  { id: 'b7', type: 'h', text: 'Notes from standup' }, { id: 'b8', type: 'p', text: 'Lena wants QA to start the moment ATL-482 lands. Mei posts the release note in #atlas-release.', refs: [{ type: 'link', kind: 'chat', id: 'c1', label: 'atlas-release' }] },
  { id: 'b9', type: 'file', text: '', fileId: 'f1', name: 'rollback-plan.pdf', size: 245760, projectId: 'p1' }, { id: 'b10', type: 'file', text: '', fileId: 'f2', name: 'load-test.xlsx', size: 18432, projectId: 'p1' }];
const N = (id, title, snippet, folder, pinned, m, extra = {}) => ({ id, title, snippet, folder, tags: [], pinned, sharing: 'private', owner: RM, projectId: folder === 'Atlas' ? 'p1' : null, meetingId: null, mine: true, createdAt: iso(-m - 10), updatedAt: iso(-m), ...extra });
const notes = [N('n1', 'Release 2.4 checklist', 'Cut is 15:00 sharp. Anything not merged moves to 2.4.1.', 'Atlas', true, 60, { tags: ['release'] }), N('n2', '1:1 with Lena', 'Option B for empty states, illustration set v2.', 'Personal', true, 60 * 24 * 2),
  N('n3', 'Contoso SSO call', 'Redirect URL changed Monday. Fix ships today.', 'Meeting notes', false, 90), N('n4', 'Q1 ideas', 'Self-serve analytics, offline mode, Hindi UI.', 'Ideas', false, 60 * 24 * 3),
  N('n5', 'Helix backfill plan', 'Partitions Oct 1–31, Tom runs Wednesday.', 'Helix', false, 60 * 24 * 4), N('n6', 'Reading list', 'Shape Up, Make Time, The Design of Everyday Things.', 'Personal', false, 60 * 24 * 9)];
const noteList = { items: notes, counts: { all: 42, pinned: 2, shared: 5, meetings: 11 }, folders: [{ name: 'Atlas', count: 9, projectId: 'p1' }, { name: 'Helix', count: 4, projectId: 'p3' }, { name: 'Personal', count: 12, projectId: null }, { name: 'Ideas', count: 6, projectId: null }],
  tags: ['release', '1on1', 'customer', 'ideas', 'hiring'].map((t, i) => ({ tag: t, count: 5 - i })) };
const noteOne = { ...notes[0], content: blocks, sharedWith: [MC, LP], links: [], canEdit: true, editors: [RM, MC] };
const members = [RM, LP, SJ, TN, PG, MC, DO].map((u) => ({ userId: u.id, displayName: u.name, email: `${u.name.split(' ')[0].toLowerCase()}@example.test`, role: 'Member', joinedAt: iso(-99999), jobRole: null }));

const writes = [], errors = [], checks = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
try {
  const make = async (theme) => {
    const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
    await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); localStorage.setItem('pm_home_mode', 'classic'); }, theme);
    await ctx.route('**/*', async (route) => {
      const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
      if (url.origin !== origin) { await route.abort(); return; }
      if (ep.endsWith('/avatar') || ep.endsWith('/download')) { await route.fulfill({ status: 404, body: '' }); return; }
      if (!ep.startsWith('/api/')) { const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep)); await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } }); return; }
      let data = [];
      const p = ep.replace('/api/v1', '');
      if (method !== 'GET' && !ep.endsWith('/auth/refresh')) {
        writes.push({ method, p, body: req.postData() });
        if (p.startsWith('/approvals/') && p.endsWith('/decide')) data = { ...deploy, status: 'Approved', needsMe: false };
        else if (p === '/approvals') data = { ...deploy, id: 'ap9' };
        else if (p.startsWith('/notes')) data = noteOne;
        else if (p.startsWith('/reminders')) data = reminders.open[0];
        else data = {};
      }
      else if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
      else if (p === '/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['projects.view', 'tasks.view', 'org.manage', 'reports.view', 'work.view'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 3, activity: 3, documents: 3, people: 3, reports: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3 } } };
      else if (p === '/workspace') data = { ...ws, aiDisabled: false };
      else if (p === '/me/ui/sidebar') data = { key: 'sidebar', value: null, updatedAt: null };
      else if (p === '/approvals') data = apList(url.searchParams.get('view') ?? 'needs');
      else if (p === '/approvals/counts') data = { needsMe: 3 };
      else if (p === '/approvals/chain') data = chain(url.searchParams.get('type'));
      else if (p.startsWith('/approvals/')) data = [...needs, ...history].find((x) => x.id === p.split('/')[2]) ?? deploy;
      else if (p === '/workspace/members') data = members;
      else if (p === '/time/grid') data = grid;
      else if (p === '/time/week') data = { weekStart: monday, weekEnd: addD(monday, 6), userId: user.id, status: 'NotSubmitted', totalMinutes: grid.totalMinutes, billableMinutes: 1540, note: null, submittedAt: null, reviewer: null, reviewedAt: null, reviewNote: null, locked: false, canSubmit: true, canWithdraw: false, canReview: false, id: null, entitled: true };
      else if (p === '/time/insights') data = tinsights;
      else if (p === '/time/grid/draft') data = draft;
      else if (p === '/activity') data = activity;
      else if (p === '/reminders') data = reminders;
      else if (p === '/reminders/settings') data = { defaultTime: '09:00', timeZone: 'Asia/Kolkata', dueLeads: [1, 0], quietStart: '21:00', quietEnd: '08:00', autoEnabled: true };
      else if (p === '/reminders/suggestions') data = suggestions;
      else if (p === '/ai/watches') data = watches;
      else if (p === '/reminders/insights') data = { doneThisWeek: 23, firedThisWeek: 27, onTimePercent: 86, usualTime: '10:00', snoozedOften: [R('r8', 'Expense report', { snoozeCount: 4 })] };
      else if (p === '/reminders/counts') data = reminders.counts;
      else if (p === '/notes') data = noteList;
      else if (p.startsWith('/notes/')) data = noteOne;
      else if (p === '/search') data = { hits: [{ type: 'task', id: 't1', title: 'ATL-482 Refund webhook retries', subtitle: 'Atlas', projectId: 'p1', taskId: 't1' }] };
      else if (ep.endsWith('/projects') || ep.endsWith('/tasks') || ep.endsWith('/work-tasks')) data = { items: [{ id: 'p1', name: 'Atlas Payments', key: 'ATL' }], page: 1, pageSize: 100, totalPages: 1, totalItems: 1 };
      else if (p === '/timer') data = null;
      else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
      else if (ep.endsWith('/ai/status')) data = { enabled: true, configured: true, entitled: true, allowedHere: true };
      else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
      else if (p === '/chat/projects/unread') data = [];
      else if (p === '/notifications') data = { items: [], page: 1, pageSize: 20, totalPages: 0, totalItems: 0 };
      else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
    });
    return ctx;
  };
  const shot = async (page, name) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(450); await page.screenshot({ path: path.join(out, name) }); };
  const open = async (theme, w, h, route, ready) => {
    const ctx = await make(theme); const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(`${route}: ${e.message}`)); await page.setViewportSize({ width: w, height: h });
    await page.goto(`${origin}/preview-org/${route}`); await page.locator(ready).first().waitFor({ timeout: 15000 }); return { ctx, page };
  };
  /** Nothing of the page sits under the floating + button (bottom right) or past the right edge. */
  const clearOfFab = async (page, what) => {
    const hits = await page.evaluate(() => {
      const fab = document.querySelector('.v2-fab, .fab, [data-fab]'); if (!fab) return [];
      const f = fab.getBoundingClientRect(); const out = [];
      for (const el of document.querySelectorAll('.ap-detail-foot button, .nt-saved, .rm-pop-acts button, .apq-foot button, .tm-acts button')) {
        const r = el.getBoundingClientRect(); if (r.width && r.right > f.left && r.left < f.right && r.bottom > f.top && r.top < f.bottom) out.push(el.className);
      }
      return out;
    });
    assert.deepEqual(hits, [], `${what}: nothing under the + button`);
  };

  for (const theme of ['light', 'dark']) {
    for (const [w, h] of [[1440, 900], [1920, 1080]]) {
      if (theme === 'dark' && w === 1920) continue;
      const tag = `${theme}-${w}`;
      // Approvals: needs me, then the chain detail, then history, then the request sheet.
      let { ctx, page } = await open(theme, w, h, 'approvals', '.ap-hero');
      assert.match(await page.locator('.ap-hero-title').innerText(), /3 approvals need you\.\s*The deployment first\./);
      assert.equal(await page.locator('.ap-hero .ap-cst').count(), 3);
      assert.equal(await page.locator('.ap-list .ap-row').count(), 2);
      await shot(page, `approvals-${tag}.png`);
      await page.getByRole('button', { name: 'Details ›' }).click(); await page.locator('.ap-detail').waitFor();
      assert.match(await page.locator('.ap-detail').innerText(), /Approval chain · step 3 of 3/);
      assert.match(await page.locator('.ap-detail').innerText(), /Waiting on you/);
      await clearOfFab(page, `approval detail ${tag}`);
      await shot(page, `approvals-chain-${tag}.png`);
      await page.getByRole('button', { name: 'Close details' }).click();
      await page.getByRole('button', { name: 'History' }).click(); await page.locator('.ap-hrow').first().waitFor();
      for (let i = 0; i < 40 && (await page.locator('.ap-hrow').count()) !== history.length; i++) await page.waitForTimeout(100);   // the list keeps the previous rows while History loads
      assert.equal(await page.locator('.ap-hrow').count(), history.length);
      await shot(page, `approvals-history-${tag}.png`);
      await page.getByRole('button', { name: 'Request approval' }).click(); await page.locator('.apq-types').waitFor();
      assert.equal(await page.locator('.apq-types button').count(), 8);
      await page.locator('.ap-cst').first().waitFor();
      await shot(page, `approvals-request-${tag}.png`);
      await page.getByRole('radio', { name: 'Leave' }).click();
      assert.equal(await page.getByRole('radio', { name: 'Leave' }).getAttribute('aria-checked'), 'true');
      assert.deepEqual(await page.locator('.apq-field > span').allInnerTexts(), ['From', 'To', 'Type', 'Cover', 'Note']);
      await page.keyboard.press('Escape'); await ctx.close();
      checks.push(`approvals ${tag}`);

      // Time, and "Request leave" opening the sheet with Leave chosen.
      ({ ctx, page } = await open(theme, w, h, 'time', '.tm-hero'));
      // On a Monday the week has no past gap yet, so the hero says the week is ready instead.
      assert.match(await page.locator('.tm-hero h2').innerText(), todayIst === monday ? /ready to submit|missing on Monday/ : /missing on Monday/);
      assert.match(await page.locator('.tm-acts').innerText(), todayIst === monday ? /Log 35m|Log time/ : /Log 35m/);
      await shot(page, `time-${tag}.png`);
      await page.getByRole('button', { name: 'Request leave' }).click(); await page.locator('.apq-types').waitFor();
      assert.equal(await page.getByRole('radio', { name: 'Leave' }).getAttribute('aria-checked'), 'true');
      assert.match(await page.locator('.apq-links').innerText(), /Timesheet week/);
      await shot(page, `time-request-leave-${tag}.png`);
      await page.keyboard.press('Escape'); await ctx.close();
      checks.push(`time ${tag}`);

      // Reminders: today, quick add with chips, the detail popover, the snooze menu.
      ({ ctx, page } = await open(theme, w, h, 'reminders', '.rm-row'));
      assert.deepEqual(await page.locator('.rm-grp h3').allInnerTexts(), ['Morning', 'Afternoon', 'Evening']);
      assert.equal(await page.locator('.rm-tile').count(), 5);
      await shot(page, `reminders-${tag}.png`);
      await page.locator('#rp-quick-input').fill('Call Sofia tomorrow 10am every week #Work !');
      await page.locator('.rm-chips .rm-pc').first().waitFor();
      assert.ok((await page.locator('.rm-chips').innerText()).includes('Work'));
      await shot(page, `reminders-quickadd-${tag}.png`);
      await page.locator('#rp-quick-input').fill('');
      await page.locator('.rm-t', { hasText: 'Send Contoso the fix date' }).click(); await page.locator('.rm-pop').waitFor();
      assert.match(await page.locator('.rm-pop').innerText(), /From Lena Park/);
      await shot(page, `reminders-detail-${tag}.png`);
      await page.getByRole('button', { name: 'Close' }).click();
      await page.getByRole('button', { name: 'Snooze Prep for Design review' }).click(); await page.locator('.rm-snz').waitFor();
      assert.equal(await page.locator('.rm-snz button').count(), 8);
      await shot(page, `reminders-snooze-${tag}.png`);
      await ctx.close();
      checks.push(`reminders ${tag}`);

      // Notes: three panes, then the slash menu.
      ({ ctx, page } = await open(theme, w, h, 'notes', '.nt-title'));
      assert.equal(await page.locator('.nt-row').count(), notes.length);
      assert.equal(await page.locator('.nt-title').inputValue(), 'Release 2.4 checklist');
      assert.equal(await page.locator('.nt-men').count(), 2);
      await shot(page, `notes-${tag}.png`);
      await page.locator('.nt-blk.is-check').nth(3).locator('.nt-view').click();
      await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.waitForTimeout(80); await page.keyboard.type('/');
      await page.locator('.nt-menu').waitFor();
      assert.equal(await page.locator('.nt-menu button').count(), 8);
      await shot(page, `notes-slash-${tag}.png`);
      await ctx.close();
      checks.push(`notes ${tag}`);
    }
  }

  // The + button's event opens the request sheet from anywhere the host is mounted.
  {
    const { ctx, page } = await open('light', 1440, 900, 'approvals', '.ap-hero');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('pt:new', { detail: { kind: 'approval' } })));
    await page.locator('.apq-types').waitFor(); checks.push('pt:new');
    await ctx.close();
  }

  // Phone, light and dark: one column, no sideways scroll.
  for (const theme of ['light', 'dark']) {
    for (const [route, ready, name] of [['approvals', '.ap-hero', 'approvals'], ['time', '.tm-hero', 'time'], ['reminders', '.rm-row', 'reminders'], ['notes', '.nt-row', 'notes']]) {
      const { ctx, page } = await open(theme, 390, 844, route, ready);
      await fitsPhone(page, `${name} ${theme}`, assert);
      await shot(page, `${name}-${theme}-390.png`);
      if (name === 'notes') { await page.locator('.nt-row').first().click(); await page.locator('.nt-title').waitFor(); await fitsPhone(page, `note ${theme}`, assert); await shot(page, `notes-open-${theme}-390.png`); }
      if (name === 'approvals') { await page.getByRole('button', { name: 'Request approval' }).click(); await page.locator('.apq-types').waitFor(); await page.waitForTimeout(400); await shot(page, `approvals-request-${theme}-390.png`); }
      if (name === 'reminders') { await page.locator('.rm-t', { hasText: 'Send Contoso the fix date' }).click(); await page.locator('.calm-sheet').waitFor(); await page.waitForTimeout(400); await shot(page, `reminders-detail-${theme}-390.png`); }
      await ctx.close();
    }
  }
  checks.push('phone');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, writes: writes.length, errors }));
} finally { await browser.close(); }
