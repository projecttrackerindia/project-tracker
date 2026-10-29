// One day, three screens: Today ("Your day"), the Calendar and Time read the same day and change together. The owner's Thursday at 13:31:
// WT-11 2h logged 09:31–11:31 and WT-12 3h logged as a duration ending now (10:31–13:31) overlap.
//  - the three totals agree (5h: the Time grid's count, every entry in full) and all three flag the overlap;
//  - Your day stacks the two entries in the logged lane (packed, never one bar), and draws no "WT-11 is due today" / "WT-12 is due today"
//    pins beside the "2 due · by end of day" marker (a manual reminder still shows);
//  - focus is not planned again on WT-11 / WT-12 (already logged in full today): the block goes to WT-14;
//  - the Calendar packs every timed item of the day into columns (no two bounding boxes intersect) and keeps deadline chips in the due strip;
//  - dragging (and Alt+→) a focus block on Your day moves it on the Calendar; "Trim" on the overlap and dragging a logged entry on Your day
//    write the entry (start, end, stamp) and the Calendar and Time show the change without a reload (one shared cache family).
// The clock is fixed (framer-motion is frozen by it), so everything is asserted on the DOM. Synthetic data only.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { cutOff } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/day-sync-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Nila Varma', email: 'nila@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Riverline Payments', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 3 };
// Thursday 29 October 2026, 13:31 in Kolkata: the week is Mon 26 – Fri 30.
const today = '2026-10-29', NOW = new Date('2026-10-29T13:31:00+05:30');
const day = (n) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const mon = day(-3);
const at = (d, hm) => new Date(`${d}T${hm}:00+05:30`).toISOString();
const g = (n) => `7a000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`;
const W = { w11: g(11), w12: g(12), w14: g(14), m1: g(21) };

let state;
function fresh() {
  let n = 0;
  const stamp = () => `st${++n}`;
  return {
    stamp,
    entries: [
      { id: 'te11', workTaskId: W.w11, taskKey: 'WT-11', taskTitle: 'Production issue: BBPS transaction failed', workDate: today, startedAt: at(today, '09:31'), endedAt: at(today, '11:31'), minutes: 120, stamp: stamp() },
      { id: 'te12', workTaskId: W.w12, taskKey: 'WT-12', taskTitle: 'Juspay QR payment functionality', workDate: today, startedAt: at(today, '10:31'), endedAt: at(today, '13:31'), minutes: 180, stamp: stamp() },
    ],
    meeting: { id: W.m1, title: 'Settlement review', start: at(today, '15:30'), end: at(today, '16:30') },
  };
}
const hOf = (iso) => { const d = new Date(new Date(iso).getTime() + 330 * 60e3); return d.getUTCHours() + d.getUTCMinutes() / 60; };
const hm = (iso) => { const d = new Date(new Date(iso).getTime() + 330 * 60e3); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const overlapsOf = (e) => state.entries.filter((o) => o.id !== e.id && o.workDate === e.workDate && Date.parse(o.startedAt) < Date.parse(e.endedAt) && Date.parse(e.startedAt) < Date.parse(o.endedAt));
const entryDto = (e) => {
  const ov = overlapsOf(e).map((o) => ({ id: o.id, taskKey: o.taskKey, taskTitle: o.taskTitle, startedAt: o.startedAt, endedAt: o.endedAt, span: `${hm(o.startedAt)}–${hm(o.endedAt)}` }));
  return { id: e.id, taskId: null, taskKey: e.taskKey, taskTitle: e.taskTitle, projectId: null, user: { id: user.id, name: user.displayName }, workDate: e.workDate, minutes: e.minutes, note: null, isRunning: false,
    startedAt: e.startedAt, endedAt: e.endedAt, canEdit: true, workTaskId: e.workTaskId, kind: 'work', billable: false, locked: false, stamp: e.stamp,
    overlaps: ov.length ? ov : null, warning: ov.length ? `Overlaps ${ov[0].taskKey} ${ov[0].span}` : null };
};
const tev = (o) => ({ end: null, allDay: false, link: null, projectId: null, projectName: null, people: [], status: null, colour: '', key: null, approximated: false, overdue: false, priority: null,
  minutes: null, note: null, joinUrl: null, notes: false, userId: user.id, mode: null, running: false, date: today, ...o });
function timeline(from, to) {
  const ev = [
    tev({ id: `meeting:${W.m1}:x`, type: 'meeting', title: state.meeting.title, start: state.meeting.start, end: state.meeting.end, sourceType: 'workspaceMeeting', sourceId: W.m1, status: 'Scheduled', people: [user.displayName, 'Arun Das'] }),
    tev({ id: `due:work:${W.w11}`, type: 'due', title: 'Production issue: BBPS transaction failed', key: 'WT-11', allDay: true, start: at(today, '00:00'), sourceType: 'work', sourceId: W.w11, priority: 'High', status: 'InProgress', link: `/work?item=${W.w11}` }),
    tev({ id: `due:work:${W.w12}`, type: 'due', title: 'Juspay QR payment functionality', key: 'WT-12', allDay: true, start: at(today, '00:00'), sourceType: 'work', sourceId: W.w12, priority: 'Critical', status: 'InProgress', link: `/work?item=${W.w12}` }),
    tev({ id: `due:work:${W.w14}`, type: 'due', title: 'Reconcile the UPI refunds', key: 'WT-14', allDay: true, start: at(today, '00:00'), sourceType: 'work', sourceId: W.w14, priority: 'High', status: 'Open', link: `/work?item=${W.w14}` }),
    // the reminders engine's own "is due today" reminders (one from a current server, one from an older one) and a reminder the person set
    tev({ id: 'reminder:r1', type: 'reminder', title: 'WT-11 is due today', key: 'WT-11', start: at(today, '10:30'), sourceType: 'reminder', sourceId: 'r1', status: 'fired', origin: 'dueDate', itemId: W.w11 }),
    tev({ id: 'reminder:r2', type: 'reminder', title: 'WT-12 is due today', key: 'WT-12', start: at(today, '15:45'), sourceType: 'reminder', sourceId: 'r2', status: 'scheduled' }),
    tev({ id: 'reminder:r3', type: 'reminder', title: 'Call the bank about WT-12', key: 'WT-12', start: at(today, '17:00'), sourceType: 'reminder', sourceId: 'r3', status: 'scheduled', origin: 'personal' }),
    tev({ id: 'attendance:a1', type: 'attendance', title: 'Office', start: at(today, '09:31'), sourceType: 'attendance', sourceId: 'a1', status: 'in', mode: 'Office', running: true }),
  ];
  for (const e of state.entries) ev.push(tev({ id: `time:${e.id}`, type: 'time', title: e.taskTitle, key: e.taskKey, start: e.startedAt, end: e.endedAt, date: e.workDate, sourceType: 'timeEntry', sourceId: e.id,
    minutes: e.minutes, itemId: e.workTaskId, itemType: 'work', link: `/work?item=${e.workTaskId}` }));
  return { from, to, timeZone: 'Asia/Kolkata', scope: 'me', generatedAt: NOW.toISOString(), events: ev.filter((t) => t.date >= from && t.date <= to) };
}
const feed = () => ({ from: mon, to: day(4), truncated: false, items: [{ ref: `w:${W.m1}`, kind: 'workspace', id: W.m1, title: state.meeting.title, description: null, start: state.meeting.start, end: state.meeting.end,
  timeZone: 'Asia/Kolkata', projectId: null, projectName: null, projectKey: null, provider: 'ours', providerName: 'Project Tracker call', joinUrl: '/calls/room-1', calendarUrl: null, isScrum: false, recurring: false,
  sessionsLeft: null, notetaker: 'off', myRsvp: 'Organizer', isOrganizer: true, canManage: true, organizerName: user.displayName, invited: 2, accepted: 1, declined: 0, status: 'Scheduled', notes: null, live: false }] });
const gridDays = () => [0, 1, 2, 3, 4, 5, 6].map((i) => { const d = day(i - 3); return { date: d, minutes: state.entries.filter((e) => e.workDate === d).reduce((n, e) => n + e.minutes, 0), targetMinutes: i < 5 ? 480 : 0, weekend: i >= 5, leave: false, leaveNote: null, future: d > today, meetings: 0, meetingMinutes: 0 }; });
function grid() {
  const rows = state.entries.map((e) => {
    const cells = gridDays().map((d) => ({ date: d.date, minutes: d.date === e.workDate ? e.minutes : 0, entries: d.date === e.workDate ? 1 : 0, running: false, note: null }));
    return { kind: 'work', targetId: e.workTaskId, key: e.taskKey, title: e.taskTitle, projectId: null, projectName: null, billable: false, cells, totalMinutes: e.minutes };
  });
  const total = state.entries.reduce((n, e) => n + e.minutes, 0);
  return { weekStart: mon, weekEnd: day(1), user: { id: user.id, name: user.displayName }, mine: true, editable: true, locked: false, status: 'NotSubmitted', days: gridDays(), rows, suggestions: [],
    totalMinutes: total, billableMinutes: 0, targetMinutes: 2400, overtimeMinutes: 0, missingDays: 0, running: null };
}

const errors = [], checks = [], writes = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
try {
  async function context(theme) {
    state = fresh();
    const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
    await ctx.clock.setFixedTime(NOW);
    await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); window.open = () => null; }, theme);
    await ctx.route('**/*', async (route) => {
      const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
      if (url.origin !== origin) { await route.abort(); return; }
      if (ep.endsWith('/avatar') || ep.endsWith('/thumbnail')) { await route.fulfill({ status: 404, body: '' }); return; }
      if (!ep.startsWith('/api/')) {
        const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
        const type = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream';
        await route.fulfill({ contentType: type, body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } }); return;
      }
      const body = (() => { try { return req.postDataJSON(); } catch { return null; } })();
      if (method !== 'GET' && !ep.endsWith('/auth/refresh')) writes.push({ method, ep, body });
      let data = [];
      const tm = /^\/api\/v1\/time\/(te\d+)$/.exec(ep);
      if (tm && method === 'PUT') {
        const e = state.entries.find((x) => x.id === tm[1]);
        if (body.stamp && body.stamp !== e.stamp) { await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ errors: [{ code: 'TIME_ENTRY_CHANGED', message: 'This entry was changed somewhere else.' }] }) }); return; }
        e.startedAt = body.startedAt; e.endedAt = body.endedAt; e.minutes = Math.round((Date.parse(body.endedAt) - Date.parse(body.startedAt)) / 60e3); e.stamp = state.stamp();
        data = entryDto(e);
      } else if (/^\/api\/v1\/meetings\/workspace\/[\w-]+\/reschedule$|^\/api\/v1\/workspace-meetings\/[\w-]+\/reschedule$/.test(ep)) {
        state.meeting.start = body.startTime; state.meeting.end = body.endTime; data = {};
      } else if (method !== 'GET' && !ep.endsWith('/auth/refresh')) data = {};
      else if (ep.endsWith('/auth/refresh')) data = { accessToken: `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`, expiresAt: '2099-01-01T00:00:00Z', user };
      else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['org.manage', 'work.view', 'work.edit', 'work.create', 'reports.view'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 3, activity: 3, documents: 3, people: 3, reports: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: {}, reportCount: 0 } };
      else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
      else if (ep === '/api/v1/timeline') data = timeline(url.searchParams.get('from'), url.searchParams.get('to'));
      else if (ep === '/api/v1/meet') data = feed();
      else if (ep === '/api/v1/time') { const es = state.entries.filter((e) => (!url.searchParams.get('from') || e.workDate >= url.searchParams.get('from')) && (!url.searchParams.get('to') || e.workDate <= url.searchParams.get('to')));
        data = { from: mon, to: day(3), user: { id: user.id, name: user.displayName }, entries: es.map(entryDto), totalMinutes: es.reduce((n, e) => n + e.minutes, 0), byDay: [], billableMinutes: 0 }; }
      else if (ep === '/api/v1/time/grid') data = grid();
      else if (ep === '/api/v1/time/week') data = { weekStart: mon, weekEnd: day(3), userId: user.id, status: 'NotSubmitted', totalMinutes: 0, billableMinutes: 0, note: null, submittedAt: null, reviewer: null, reviewedAt: null, reviewNote: null, locked: false, canSubmit: true, canWithdraw: false, canReview: false, days: [] };
      else if (ep === '/api/v1/time/grid/draft') data = { weekStart: mon, cells: [], days: [] };
      else if (ep === '/api/v1/time/insights') data = null;
      else if (ep === '/api/v1/time/approvals') data = { pending: [], recent: [] };
      else if (ep === '/api/v1/inbox') data = { rows: [], counts: { all: 0, assigned: 0, decisions: 0, mentions: 0 }, later: 0 };
      else if (ep === '/api/v1/inbox/briefing') data = { count: 3, headline: '3 things are due today.', reasons: [], sources: 'read your work', stats: { overdue: 0, dueToday: 3, decisions: 0, approvals: 0, mentions: 0, reminders: 0 } };
      else if (ep === '/api/v1/dashboard') data = { counts: { myDueToday: 3, myCompletedToday: 0, myOpen: 3, myOverdue: 0, activeProjects: 0, completedProjects: 0, totalProjects: 0, openTasks: 0, overdueTasks: 0, members: 3, overallProgress: 0, myLoggedMinutesThisWeek: 300 }, myTasks: [], projects: [], activity: [], myWork: [] };
      else if (ep === '/api/v1/workload') data = { scope: 'Everyone', available: ['Everyone'], members: [], totals: { people: 3, open: 3, overdue: 0 } };
      else if (ep === '/api/v1/reminders') data = { open: [], completed: [], sent: [], counts: { now: 0, today: 0, upcoming: 0, completed: 0 }, limits: { open: 100, recurring: 10, openUsed: 0, recurringUsed: 0 } };
      else if (ep.endsWith('/workspace/members')) data = [{ userId: user.id, displayName: user.displayName, email: user.email, role: 'Owner' }];
      else if (ep === '/api/v1/projects' || ep === '/api/v1/work-tasks') data = { items: [], page: 1, pageSize: 100, totalPages: 0, totalItems: 0 };
      else if (ep === '/api/v1/timer') data = null;
      else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
      else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
      else if (ep === '/api/v1/calendar') data = [];
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
    });
    return ctx;
  }
  let page;
  const y = () => page.locator('[data-testid="your-day"]');
  /** In-app navigation (the React Query cache is kept, so only invalidation can refresh a screen; the fixed clock never makes data stale). */
  const go = async (to) => { await page.evaluate((u) => { history.pushState({}, '', u); dispatchEvent(new PopStateEvent('popstate')); }, `/preview-org${to}`); await page.waitForTimeout(500); };
  const boxes = (loc) => loc.evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { t: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 50), x: r.x, y: r.y, r: r.right, b: r.bottom, w: r.width }; }));
  function disjoint(list, label) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j], ox = Math.min(a.r, b.r) - Math.max(a.x, b.x), oy = Math.min(a.b, b.b) - Math.max(a.y, b.y);
      assert.ok(ox <= 1 || oy <= 1, `${label}: "${a.t}" and "${b.t}" overlap (${ox.toFixed(1)} x ${oy.toFixed(1)})`);
    }
  }
  const yCounts = async () => (await page.getByTestId('your-day-counts').innerText()).replace(/\s+/g, ' ');
  const todayCol = () => page.locator(`.wp-col[data-day="${today}"]`);
  const calLogged = async () => (await page.locator(`.wp-dh[data-day="${today}"] [data-testid="wp-logged"]`).innerText()).trim();
  const panelLogged = async () => (await page.locator('[data-testid="day-panel"] section[aria-label="Logged time"] h3').innerText()).replace(/\s+/g, ' ');
  const timeTotal = async () => page.locator(`[data-testid="tsg-day-total"][data-day="${today}"]`);
  async function totals(label, expect) {
    await go('/');
    await y().waitFor(); await page.waitForFunction(() => (document.querySelector('[data-testid="your-day"]')?.getAttribute('data-sig') ?? '') !== '');
    const yd = await yCounts();
    assert.match(yd, new RegExp(`${expect} logged`), `${label}: Today says ${yd}`);
    await go('/calendar');
    await page.locator('[data-testid="week-planner"]').waitFor();
    await page.locator(`.wp-dh[data-day="${today}"] [data-testid="wp-logged"]`).waitFor();
    assert.equal(await calLogged(), expect, `${label}: Calendar day header`);
    assert.match(await panelLogged(), new RegExp(`^Logged time ?${expect} of 8h`), `${label}: Day panel`);
    await go('/insights?tab=time');
    const tt = await timeTotal(); await tt.waitFor({ timeout: 15000 });
    assert.match(await tt.locator('b').innerText(), new RegExp(`^${expect.replace('h', '(:00|h)')}`), `${label}: Time grid`);
    checks.push(`${label}: Today, Calendar and Time all ${expect}`);
  }

  let ctx = await context('light');
  page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin + '/preview-org/');
  await y().waitFor({ timeout: 15000 });
  await page.waitForFunction(() => (document.querySelector('[data-testid="your-day"]')?.getAttribute('data-sig') ?? '') !== '');
  await page.waitForTimeout(300);

  // ---- Your day at 13:31
  const yd = await yCounts();
  assert.match(yd, /5h logged/, yd);
  assert.match(yd, /2 entries overlap/, yd);
  const lg = await boxes(y().locator('[data-type="time"]'));
  assert.equal(lg.length, 2, 'both logged entries are drawn');
  disjoint(lg, 'logged lane');
  assert.ok(Math.abs(lg[0].y - lg[1].y) > 3, 'the two overlapping entries are stacked in the logged lane');
  assert.equal(await y().locator('[data-type="time"][data-overlaps]').count(), 2, 'both marked as overlapping');
  // one marker per deadline: no "is due today" pins next to "3 due · by end of day"; the reminder you set is there
  const pins = await y().locator('.hm-pin').allInnerTexts();
  assert.ok(!pins.some((t) => /is due today/.test(t)), `no automatic due pins: ${pins.join(' | ')}`);
  assert.ok(pins.some((t) => /3 due · by end of day/.test(t)), `the deadline marker: ${pins.join(' | ')}`);
  assert.ok(pins.some((t) => /Call the bank/.test(t)), 'the manual reminder stays');
  disjoint(await boxes(y().locator('.hm-cap, .hm-pin')), 'Your day labels');
  // focus is not planned again on work logged in full today
  const focusT = await y().locator('[data-type="focus"]').allInnerTexts();
  assert.ok(focusT.length >= 1 && focusT.every((t) => /WT-14/.test(t)), `focus only on WT-14: ${focusT.join(' | ')}`);
  const f0 = Number(await y().locator('[data-type="focus"]').first().getAttribute('data-start'));
  assert.ok(f0 >= 13.5, `focus starts after now (${f0})`);
  checks.push('Your day: 5h logged, 2 entries stacked + flagged, no duplicate due pins, focus skips logged work');
  await page.screenshot({ path: path.join(out, 'today-1440.png'), animations: 'disabled' });

  // ---- the Calendar: the same 5h, every timed item packed, deadlines in the due strip
  await go('/calendar');
  await page.locator('[data-testid="week-planner"]').waitFor();
  await todayCol().locator('[data-type="time"]').first().waitFor();
  assert.equal(await calLogged(), '5h');
  const calBoxes = await boxes(todayCol().locator('.wp-e, .wp-rem, .wp-done'));
  assert.ok(calBoxes.length >= 5, `today's column draws its blocks (${calBoxes.length})`);
  disjoint(calBoxes, 'Calendar column');
  assert.equal(await todayCol().locator('[data-type="time"][data-overlaps]').count(), 2, 'the Calendar flags both entries');
  assert.equal(await todayCol().locator('.wp-rem', { hasText: 'is due today' }).count(), 0, 'no automatic due reminders on the grid');
  assert.equal(await todayCol().locator('.wp-rem', { hasText: 'Call the bank' }).count(), 1);
  const strip = page.locator(`.wp-allday-d[data-day="${today}"]`);
  assert.ok(await strip.locator('.wp-flag').count() >= 1, 'deadlines are chips in the due strip');
  assert.equal(await todayCol().locator('.wp-flag, [data-testid="wp-due"], [data-testid="wp-sla"]').count(), 0, 'no deadline chip on the grid');
  checks.push('Calendar: 5h, packed columns (no intersecting boxes), due strip, no duplicate reminders');
  await page.screenshot({ path: path.join(out, 'calendar-1440.png'), animations: 'disabled' });

  // ---- Time: the same 5h, and the overlap flagged
  await go('/insights?tab=time');
  const tt = await timeTotal(); await tt.waitFor({ timeout: 15000 }).catch(async (e) => { await page.screenshot({ path: path.join(out, 'debug-time.png') }); throw e; });
  assert.equal(await tt.getAttribute('data-minutes'), '300');
  assert.match(await tt.getByTestId('tsg-overlap').innerText(), /2 overlapping/);
  checks.push('Time: 300 minutes on Thursday, overlap flagged');
  await page.screenshot({ path: path.join(out, 'time-1440.png'), animations: 'disabled' });

  // ---- Your day: Alt+→ moves the focus block a quarter hour; a drag moves it 30 minutes more; the Calendar has it there
  await go('/');
  await y().locator('[data-type="focus"]').first().waitFor();
  const fb = y().locator('[data-type="focus"]').first();
  await fb.focus(); await page.keyboard.press('Alt+ArrowRight'); await page.waitForTimeout(200);
  assert.equal(Number(await y().locator('[data-type="focus"]').first().getAttribute('data-start')), f0 + .25, 'Alt+→ moves it 15 minutes');
  const track = await page.locator('.hm-day-track').boundingBox();
  const hours = await page.locator('.hm-hours span').count();
  const perH = track.width / hours;
  async function dragX(loc, dh) {
    const b = await loc.boundingBox();
    const x = b.x + b.width / 2, yy = b.y + b.height / 2;
    await page.mouse.move(x, yy); await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dh * perH * i) / 8, yy);
    await page.mouse.up(); await page.waitForTimeout(300);
  }
  await dragX(y().locator('[data-type="focus"]').first(), .5);
  const f1 = Number(await y().locator('[data-type="focus"]').first().getAttribute('data-start'));
  assert.equal(f1, f0 + .75, `dragged 30 minutes later (${f1})`);
  await go('/calendar');
  await todayCol().locator('[data-type="focus"]').first().waitFor();
  assert.equal(Number(await todayCol().locator('[data-type="focus"]').first().getAttribute('data-start')), f1, 'the Calendar shows the moved focus block');
  checks.push('Your day: focus moved by Alt+→ and by drag, the Calendar agrees');

  // ---- Your day: open WT-12, "Trim" the overlap: the entry is written (start, end, stamp); the overlap goes everywhere; totals follow (4h)
  await go('/');
  await y().locator('[data-type="time"][data-id="time:te12"]').click();
  const card = page.locator('.ed');
  await card.getByTestId('ed-overlap').waitFor();
  assert.match(await card.getByTestId('ed-overlap').innerText(), /Overlaps WT-11 09:31–11:31/);
  await card.getByTestId('ed-overlap-trim').click();
  await page.waitForTimeout(500);
  let w = [...writes].reverse().find((x) => x.method === 'PUT' && x.ep === '/api/v1/time/te12');
  assert.ok(w, 'trim saves the entry');
  assert.equal(w.body.startedAt, at(today, '11:31')); assert.equal(w.body.endedAt, at(today, '13:31')); assert.equal(w.body.stamp, 'st2');
  await page.waitForFunction(() => !document.querySelector('[data-testid="your-day-overlap"]'));
  await totals('after Trim', '4h');
  assert.equal(await page.locator('[data-testid="tsg-overlap"]').count(), 0, 'Time no longer flags it');

  // ---- Your day: drag WT-11 half an hour earlier (09:30 → 09:00): saved with its stamp; the Calendar draws it there; Time keeps 4h
  await go('/');
  const te11 = y().locator('[data-type="time"][data-id="time:te11"]');
  await te11.waitFor();
  await dragX(te11, -.5);
  w = [...writes].reverse().find((x) => x.method === 'PUT' && x.ep === '/api/v1/time/te11');
  assert.ok(w, 'the drag saves the entry');
  assert.equal(w.body.startedAt, at(today, '09:00')); assert.equal(w.body.endedAt, at(today, '11:00')); assert.equal(w.body.stamp, 'st1');
  await page.waitForTimeout(400);
  await go('/calendar');
  await page.waitForFunction((d) => Math.abs(Number(document.querySelector(`.wp-col[data-day="${d}"] [data-type="time"][data-id="time:te11"]`)?.getAttribute('data-start')) - 9) < 0.01, today);
  await totals('after the drag', '4h');
  checks.push('Your day: Trim and drag write the entry; Calendar and Time follow without a reload');
  await page.close(); await ctx.close();

  // ---- dark and the phone
  ctx = await context('dark');
  page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin + '/preview-org/');
  await y().waitFor({ timeout: 15000 });
  await page.waitForTimeout(300);
  disjoint(await boxes(y().locator('.hm-cap, .hm-pin')), 'dark Your day');
  await page.screenshot({ path: path.join(out, 'today-dark-1440.png'), animations: 'disabled' });
  await go('/calendar');
  await todayCol().locator('[data-type="time"]').first().waitFor();
  disjoint(await boxes(todayCol().locator('.wp-e, .wp-rem, .wp-done')), 'dark Calendar');
  await page.screenshot({ path: path.join(out, 'calendar-dark-1440.png'), animations: 'disabled' });
  await page.close(); await ctx.close();

  ctx = await context('light');
  page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + '/preview-org/');
  await y().waitFor({ timeout: 15000 });
  await page.waitForTimeout(300);
  assert.match(await y().getByTestId('your-day-counts').innerText(), /5h logged/);
  assert.equal(await y().locator('[data-type="reminder"]', { hasText: 'is due today' }).count(), 0, 'phone: no duplicate due reminders');
  assert.match(await y().locator('[data-type="time"]').first().innerText(), /Overlaps/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'phone: no horizontal scroll');
  assert.deepEqual(await cutOff(page), [], 'phone: nothing cut off');
  await page.screenshot({ path: path.join(out, 'today-390.png'), animations: 'disabled', fullPage: true });
  await page.goto(origin + '/preview-org/calendar');
  await page.locator('[data-testid="week-planner"]').waitFor({ timeout: 15000 });
  await todayCol().locator('[data-type="time"]').first().waitFor();
  disjoint(await boxes(todayCol().locator('.wp-e, .wp-rem, .wp-done')), 'phone day');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'phone calendar: no horizontal scroll');
  await page.screenshot({ path: path.join(out, 'calendar-day-390.png'), animations: 'disabled' });
  checks.push('dark + phone: packed, no duplicate due reminders, overlap shown');
  await page.close(); await ctx.close();

  assert.deepEqual(errors, [], 'no page errors');
  console.log(JSON.stringify({ ok: true, checks, out }, null, 1));
} finally { await browser.close(); }
