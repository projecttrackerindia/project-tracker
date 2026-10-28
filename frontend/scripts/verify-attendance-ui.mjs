// Attendance: Groot's check-in card at the first open of the day (organization time), once a day; three ways of working; a client office asks
// for the place (recent ones suggested); Not now snoozes 30 minutes; Check in calls the API; the top-bar pill; check-out with the day's
// summary; the 'groot:checkout' event opens the sheet; the calendar band, its card (correct today) and the Team view; Settings › Attendance;
// phone bottom sheet; dark mode. Synthetic data only.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { cutOff } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/attendance-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Alexandra Montgomery', email: 'preview@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 2 };
const pid = '00000000-0000-0000-0000-000000000003';
// A fixed Wednesday, 10:42 in Kolkata: the week is Mon 26 – Fri 30 October 2026.
const today = '2026-10-28', NOW = new Date('2026-10-28T10:42:00+05:30');
const day = (n) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const mon = day(-2), tue = day(-1), thu = day(1), fri = day(2);
const at = (d, hm) => new Date(`${d}T${hm}:00+05:30`).toISOString();
const ids = { w1: '61000000-0000-0000-0000-000000000001', w2: '61000000-0000-0000-0000-000000000002', t1: '62000000-0000-0000-0000-000000000001', t3: '62000000-0000-0000-0000-000000000003',
  m1: '63000000-0000-0000-0000-000000000001', m2: '63000000-0000-0000-0000-000000000002', done: '64000000-0000-0000-0000-00000000000d' };
const ev = (o) => ({ status: 'Open', category: 'Todo', overdue: false, projectId: null, projectName: null, priority: null, ...o });
const calendar = () => [
  ev({ type: 'work', id: ids.w1, title: 'OPS-21 · Integration runtime disconnected', date: today, priority: 'Critical', status: 'InProgress', category: 'Active' }),
  ev({ type: 'work', id: ids.w2, title: 'OPS-19 · Certificate renewal', date: mon, priority: 'High', status: 'Completed', category: 'Done' }),
  ev({ type: 'task', id: ids.t1, title: 'Settlement report export', date: fri, priority: 'High', projectId: pid, projectName: 'Payments revamp' }),
  ev({ type: 'task', id: ids.t3, title: 'Reconcile vendor ledger', date: thu, priority: 'Medium', projectId: pid, projectName: 'Payments revamp' }),
  ev({ type: 'meeting', id: ids.m1, title: 'Release sync', date: today, startsAt: at(today, '11:00'), durationMinutes: 30, status: 'Scheduled', category: null, joinUrl: 'https://meet.google.com/abc-defg-hij', people: ['Rhea Kapoor', 'Alexandra Montgomery', 'Vikram Rao'] }),
  ev({ type: 'meeting', id: ids.m2, title: 'Design review', date: today, startsAt: at(today, '15:00'), durationMinutes: 60, status: 'Scheduled', category: null, projectId: pid, projectName: 'Payments revamp', joinUrl: '/calls/room-42', people: ['Alexandra Montgomery', 'Rhea Kapoor'], notes: true }),
].filter((e) => !doneIds.has(e.id));
const feed = () => ({ from: mon, to: day(5), truncated: false, items: [
  { ref: `w:${ids.m1}`, kind: 'workspace', id: ids.m1, title: 'Release sync', description: 'Go / no-go for Friday\nOpen incidents', start: at(today, '11:00'), end: at(today, '11:30'), timeZone: 'Asia/Kolkata', projectId: null, projectName: null, projectKey: null,
    provider: 'google', providerName: 'Google Meet', joinUrl: 'https://meet.google.com/abc-defg-hij', calendarUrl: null, isScrum: false, recurring: false, sessionsLeft: null, notetaker: 'off', myRsvp: 'NeedsAction', isOrganizer: false, canManage: false,
    organizerName: 'Rhea Kapoor', invited: 3, accepted: 2, declined: 0, status: 'Scheduled', notes: null, live: false },
  { ref: `p:${ids.m2}`, kind: 'project', id: ids.m2, title: 'Design review', description: null, start: at(today, '15:00'), end: at(today, '16:00'), timeZone: 'Asia/Kolkata', projectId: pid, projectName: 'Payments revamp', projectKey: 'PAY',
    provider: 'ours', providerName: 'Project Tracker call', joinUrl: '/calls/room-42', calendarUrl: null, isScrum: false, recurring: false, sessionsLeft: null, notetaker: 'transcript', myRsvp: 'Organizer', isOrganizer: true, canManage: true,
    organizerName: 'Alexandra Montgomery', invited: 2, accepted: 2, declined: 0, status: 'Scheduled', notes: null, live: false },
] });
const entry = (o) => ({ taskId: null, projectId: null, user: { id: user.id, name: user.displayName }, workDate: today, note: null, isRunning: false, startedAt: null, canEdit: true, workTaskId: null, kind: 'task', billable: false, locked: false, ...o });
const timesheet = { from: mon, to: day(4), user: { id: user.id, name: user.displayName }, totalMinutes: 210, billableMinutes: 0, byDay: [{ date: today, minutes: 210 }], entries: [
  entry({ id: 'te1', taskKey: 'OPS-21', taskTitle: 'Integration runtime disconnected', minutes: 90, note: 'Restarted the runtime', startedAt: at(today, '09:00'), workTaskId: ids.w1, kind: 'work' }),
  entry({ id: 'te2', taskId: ids.t1, taskKey: 'PAY-7', taskTitle: 'Settlement report export', minutes: 120, billable: true }),
] };
const gridDays = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ date: day(i - 2), minutes: 0, targetMinutes: i < 5 ? 480 : 0, weekend: i >= 5, leave: day(i - 2) === fri, leaveNote: day(i - 2) === fri ? 'Family function' : null, future: day(i - 2) > today, meetings: 0, meetingMinutes: 0 }));
const task = (id, key, title, due, priority) => ({ id, projectId: pid, projectKey: 'PAY', projectName: 'Payments revamp', number: 7, key, title, description: null, statusId: 's-todo', statusName: 'To do', statusCategory: 'Todo', statusColor: '#8e8e93', priority,
  assignee: { id: user.id, name: user.displayName }, reporter: null, startDate: null, dueDate: due, estimatedHours: 6, actualHours: 2, position: 0, parentTaskId: null, subtaskTotal: 3, subtaskDone: 1, commentCount: 0, labels: [{ id: 'l1', name: 'finance', color: '#000' }],
  completedAt: null, createdAt: at(mon, '09:00'), updatedAt: new Date(NOW.getTime() - 3 * 3600e3).toISOString(), version: 4, isOverdue: false, milestoneId: null, milestoneName: null, dependsOnCount: 0, blocksCount: 0, isBlocked: false, sprintId: null, sprintName: null, checklistTotal: 0, checklistDone: 0 });
const work = { id: ids.w1, key: 'OPS-21', number: 21, title: 'Integration runtime disconnected', description: null, workTypeId: 'wt', workType: 'Incident', relatedProject: null, assignee: { id: user.id, name: user.displayName }, reporter: null, priority: 'Critical', status: 'InProgress',
  startDate: null, dueDate: today, isOverdue: false, completedAt: null, createdAt: at(mon, '08:00'), version: 2, commentCount: 1, attachmentCount: 0, can: { edit: true, delete: false }, loggedMinutes: 90,
  sla: { response: null, resolution: { dueAt: at(today, '18:00'), metAt: null, state: 'AtRisk' }, state: 'AtRisk' } };

// ---------------------------------------------------------------- attendance state (the organization's clock: India)
const policy = { enabled: true, hoursSource: 'workspace', workDays: '1,2,3,4,5', workStart: '09:30', workEnd: '18:30', checkInGraceMinutes: 30, checkOutGraceMinutes: 30, autoClose: true,
  autoCloseAfterHours: 4, allowedModes: ['Office', 'Home', 'ClientSite'], requireClientPlace: true, promptAtSignIn: true, timeZone: 'Asia/Kolkata' };
let record = null;
const rec = (o) => ({ id: 'a-' + o.date + (o.userId ?? user.id), userId: user.id, userName: user.displayName, checkOutAt: null, place: null, note: null, source: 'web', autoClosed: false, minutes: 0, checkOutLocal: null, ...o });
const monday = rec({ date: mon, mode: 'Office', checkInAt: at(mon, '09:12'), checkOutAt: at(mon, '18:05'), checkInLocal: '09:12', checkOutLocal: '18:05', minutes: 533 });
const team = [
  rec({ date: today, userId: 'u2', userName: 'Rhea Kapoor', mode: 'Office', checkInAt: at(today, '09:05'), checkInLocal: '09:05' }),
  rec({ date: today, userId: 'u3', userName: 'Vikram Rao', mode: 'Home', checkInAt: at(today, '09:40'), checkInLocal: '09:40' }),
  rec({ date: today, userId: 'u4', userName: 'Meera Iyer', mode: 'ClientSite', place: 'Contoso Ltd', checkInAt: at(today, '10:02'), checkInLocal: '10:02' }),
  rec({ date: mon, userId: 'u2', userName: 'Rhea Kapoor', mode: 'Office', checkInAt: at(mon, '09:00'), checkInLocal: '09:00' }),
];
const todayDto = () => ({ date: today, timeZone: 'Asia/Kolkata', localTime: '10:42', workStart: '09:30', workEnd: '18:30', workingDay: true, onLeave: false, holiday: null,
  shouldPrompt: !record, record, recentPlaces: ['Northwind Traders, Hitech City', 'Contoso Ltd'], canViewTeam: true, policy });
function attendance(method, ep, url, body) {
  if (ep === '/api/v1/me/attendance/today') return todayDto();
  if (ep === '/api/v1/me/attendance/check-in') { record = rec({ date: today, mode: body.mode, place: body.place ?? null, note: body.note ?? null, source: body.source, checkInAt: NOW.toISOString(), checkInLocal: '10:42' }); return record; }
  if (ep === '/api/v1/me/attendance/check-out') { record = { ...record, checkOutAt: NOW.toISOString(), checkOutLocal: '18:10', minutes: 448 }; return { day: record, minutes: 448, tasksDone: 3, loggedMinutes: 390 }; }
  if (ep === `/api/v1/me/attendance/${today}`) { record = { ...record, mode: body.mode ?? record.mode, place: body.place ?? null, note: body.note ?? record.note }; return record; }
  if (ep === '/api/v1/attendance') return url.searchParams.get('scope') === 'team' ? [...team, ...(record ? [record] : [])] : [monday, ...(record ? [record] : [])];
  if (ep === '/api/v1/attendance/team/today') return { date: today, office: 1, home: 1, clientSite: 1, onLeave: 0, notIn: 0, people: [] };
  if (ep === '/api/v1/attendance/settings') { if (method === 'PUT') Object.assign(policy, body); return policy; }
  return undefined;
}

const errors = [], checks = [], writes = [];
const doneIds = new Set();
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
try {
  async function context(theme) {
    const ctx = await browser.newContext({ timezoneId: 'America/Los_Angeles', serviceWorkers: 'block' });   // the browser is elsewhere; the organization is in India
    await ctx.clock.setFixedTime(NOW);
    await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); }, theme);
    await ctx.route('**/*', async (route) => {
      const url = new URL(route.request().url()), ep = url.pathname, method = route.request().method();
      if (url.origin !== origin) { await route.abort(); return; }
      if (ep.endsWith('/avatar')) { await route.fulfill({ status: 404, body: '' }); return; }
      if (!ep.startsWith('/api/')) {
        const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
        const type = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream';
        await route.fulfill({ contentType: type, body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } }); return;
      }
      const body = (() => { try { return route.request().postDataJSON(); } catch { return null; } })();
      if (method !== 'GET' && !ep.endsWith('/auth/refresh')) writes.push({ method, ep, body });
      let data = attendance(method, ep, url, body);
      if (data !== undefined) { /* attendance */ }
      else if (method !== 'GET' && !ep.endsWith('/auth/refresh')) data = {};
      else if (ep.endsWith('/auth/refresh')) data = { accessToken: `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`, expiresAt: '2099-01-01T00:00:00Z', user };
      else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['org.manage', 'work.view', 'work.edit', 'work.create', 'reports.view'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 3, activity: 3, documents: 3, people: 3, reports: 3, billing: 3, members: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: {} } };
      else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
      else if (ep === '/api/v1/calendar') data = calendar();
      else if (ep === '/api/v1/meet') data = feed();
      else if (ep === '/api/v1/reminders') data = { open: [], done: [] };
      else if (ep === '/api/v1/time') data = timesheet;
      else if (ep === '/api/v1/time/grid') data = { weekStart: mon, weekEnd: day(4), user: { id: user.id, name: user.displayName }, mine: true, editable: true, locked: false, status: 'NotSubmitted', days: gridDays, rows: [], suggestions: [], totalMinutes: 0, billableMinutes: 0, targetMinutes: 2400, overtimeMinutes: 0, missingDays: 0, running: null };
      else if (ep.endsWith('/workspace/members')) data = [{ userId: user.id, displayName: user.displayName, email: user.email, role: 'Owner' }];
      else if (ep === '/api/v1/projects' || ep === '/api/v1/work-tasks') data = { items: [], page: 1, totalPages: 0, totalItems: 0 };
      else if (ep === '/api/v1/timer') data = null;
      else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
      else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
      else data = [];
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
    });
    return ctx;
  }
  let page;
  async function open(ctx, width, where = '/preview-org/calendar') {
    page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(origin + where);
  }
  async function capture(name) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, name + ' viewport overflow');
    assert.deepEqual(await cutOff(page), [], name + ' cut off at the right edge');
    await page.screenshot({ path: path.join(out, name + '.png'), animations: 'disabled' }); checks.push(name);
  }
  const promptKey = `pt.attendance.prompt.${ws.id}.${today}`;
  const checkin = () => page.locator('[data-testid="att-checkin"]');

  // ---------------------------------------------------------------- desktop, light: the sign-in prompt
  let ctx = await context('light');
  await open(ctx, 1440);
  await checkin().waitFor({ timeout: 15000 });
  assert.equal(await checkin().locator('.groot-avatar[data-state="greeting"]').count(), 1, 'Groot avatar slot');
  assert.match(await checkin().innerText(), /Good morning, Alexandra/);
  assert.match(await checkin().innerText(), /India time/, 'the organization clock is named');
  assert.equal(await checkin().locator('[role="radio"]').count(), 3, 'three ways of working');
  for (const t of ['Work from home', 'Office', 'Client office']) assert.ok(await checkin().getByRole('radio', { name: new RegExp(t) }).count(), t);
  assert.ok(await checkin().getByRole('button', { name: 'Check in' }).isDisabled(), 'needs a choice');
  await capture('checkin-card-1440');
  // Not now: snoozed for 30 minutes; a reload in the meantime does not ask again
  await checkin().getByRole('button', { name: 'Not now' }).click();
  await checkin().waitFor({ state: 'detached' });
  const st = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), promptKey);
  assert.equal(st.s, 'snoozed'); assert.ok(st.until - NOW.getTime() >= 29 * 60_000 && st.until - NOW.getTime() <= 31 * 60_000, 'snoozed 30 minutes');
  await page.reload(); await page.locator('[data-testid="week-planner"]').waitFor();
  await page.waitForTimeout(800);
  assert.equal(await checkin().count(), 0, 'not asked again while snoozed');
  // the snooze is over: asked again, then shown counts as once for the day
  await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({ s: 'snoozed', until: 1 })), promptKey);
  await page.reload();
  await checkin().waitFor();
  assert.equal(JSON.parse(await page.evaluate((k) => localStorage.getItem(k), promptKey)).s, 'shown');
  // client office: asks where, suggests recent places
  await checkin().getByRole('radio', { name: /Client office/ }).click();
  await checkin().getByLabel('Client or place').waitFor();
  assert.ok(await checkin().getByRole('button', { name: 'Check in' }).isDisabled(), 'needs the place');
  await checkin().getByRole('button', { name: 'Northwind Traders, Hitech City' }).click();
  await checkin().getByRole('button', { name: 'Add a note' }).click();
  await checkin().getByLabel('Note').fill('Sprint demo');
  await capture('checkin-client-1440');
  await checkin().getByRole('button', { name: 'Check in' }).click();
  await checkin().waitFor({ state: 'detached' });
  const ci = writes.find((w) => w.ep === '/api/v1/me/attendance/check-in');
  assert.deepEqual({ mode: ci.body.mode, place: ci.body.place, note: ci.body.note, source: ci.body.source }, { mode: 'ClientSite', place: 'Northwind Traders, Hitech City', note: 'Sprint demo', source: 'web' });
  // the pill
  const pill = page.locator('.v2-tb [data-testid="att-pill"]');
  await pill.waitFor();
  assert.match(await pill.innerText(), /In · Client · 10:42 →/);
  assert.ok(await pill.getByRole('button', { name: 'Check out' }).count());
  // reload: never asked twice the same day
  await page.reload(); await page.locator('[data-testid="week-planner"]').waitFor(); await page.waitForTimeout(800);
  assert.equal(await checkin().count(), 0, 'once a day');

  // the calendar band and its card
  const band = (d) => page.locator(`[data-testid="att-band"][data-day="${d}"]`);
  await band(today).waitFor();
  assert.match(await band(today).innerText(), /Client\s*10:42 →/);
  assert.match(await band(mon).innerText(), /Office\s*09:12–18:05/);
  await capture('calendar-band-1440');
  await band(today).click();
  const card = page.locator('[data-testid="att-card"]');
  await card.waitFor();
  assert.match(await card.innerText(), /Client office · Northwind Traders/);
  await card.getByRole('button', { name: 'Correct' }).click();
  await card.locator('[data-testid="att-edit"]').waitFor();
  await card.getByRole('radio', { name: /Home/ }).click();
  await capture('attendance-card-edit-1440');
  await card.getByRole('button', { name: 'Save' }).click();
  await card.waitFor({ state: 'detached' });
  assert.equal(writes.find((w) => w.method === 'PUT' && w.ep === `/api/v1/me/attendance/${today}`).body.mode, 'Home');
  // a past day cannot be changed here
  await band(mon).click();
  await card.waitFor();
  assert.match(await card.innerText(), /Only today’s day can be changed/);
  await page.keyboard.press('Escape'); await card.waitFor({ state: 'detached' });
  // Team view
  await page.locator('[data-testid="att-team-toggle"]').click();
  await page.waitForFunction((d) => document.querySelectorAll(`[data-testid="att-band"][data-day="${d}"] .att-grp`).length === 3, today);
  assert.equal(await band(today).locator('.att-grp').count(), 3, 'faces grouped by office, home and client');
  await band(today).click();
  await page.locator('[data-testid="att-team-list"]').waitFor();
  assert.match(await page.locator('[data-testid="att-team-list"]').innerText(), /Meera Iyer[\s\S]*Contoso Ltd/);
  await capture('calendar-team-1440');
  await page.keyboard.press('Escape');

  // Groot asks to check out: the sheet opens; check-out shows the day's summary
  await page.evaluate(() => window.dispatchEvent(new Event('groot:checkout')));
  const co = page.locator('[data-testid="att-checkout"]');
  await co.waitFor();
  assert.match(await co.innerText(), /Wrapping up\?/);
  await co.getByLabel('Note for the day').fill('Demo went well');
  await co.getByRole('button', { name: 'Check out' }).click();
  await co.locator('[data-testid="att-summary"]').waitFor();
  const sum = await co.locator('[data-testid="att-summary"]').innerText();
  assert.match(sum, /7h 28m/); assert.match(sum, /3\s*tasks done/); assert.match(sum, /6h 30m/);
  assert.equal(writes.find((w) => w.ep === '/api/v1/me/attendance/check-out').body.note, 'Demo went well');
  await capture('checkout-summary-1440');
  await co.getByRole('button', { name: 'Done' }).click();
  await page.close();

  // Settings › General › Attendance
  await open(ctx, 1440, '/preview-org/settings/general/attendance');
  const set = page.locator('[data-testid="att-settings"]');
  await set.waitFor({ timeout: 15000 });
  assert.match(await set.innerText(), /Asia\/Kolkata/);
  await set.getByRole('switch', { name: 'Allow Client office' }).click();
  await page.waitForTimeout(300);
  assert.deepEqual(writes.filter((w) => w.ep === '/api/v1/attendance/settings').at(-1).body, { allowedModes: ['Office', 'Home'] });
  await capture('settings-attendance-1440');
  await page.close(); await ctx.close();

  // ---------------------------------------------------------------- phone, dark: a bottom sheet
  record = null; policy.allowedModes = ['Office', 'Home', 'ClientSite'];
  ctx = await context('dark');
  await open(ctx, 390);
  await checkin().waitFor({ timeout: 15000 });
  assert.ok(await checkin().evaluate((el) => el.classList.contains('att-sheet')), 'a bottom sheet on a phone');
  await page.waitForTimeout(600); await page.screenshot({ path: path.join(out, 'checkin-sheet-dark-390.png') });
  const box = await checkin().boundingBox();
  if (!(box.y + box.height >= 990 && box.width >= 370)) console.log(box);
  assert.ok(box.y + box.height >= 990 && box.width >= 370, 'docked to the bottom, full width');
  const bg = await checkin().evaluate((el) => getComputedStyle(el).backgroundColor);
  const [r, g, b] = bg.match(/\d+/g).map(Number);
  assert.ok(r + g + b < 200, `dark sheet (${bg})`);

  await checkin().getByRole('radio', { name: /Office/ }).click();
  await checkin().getByRole('button', { name: 'Check in' }).click();
  await checkin().waitFor({ state: 'detached' });
  assert.equal(writes.filter((w) => w.ep === '/api/v1/me/attendance/check-in').at(-1).body.source, 'phone');
  const mpill = page.locator('.m-top [data-testid="att-pill"]');
  await mpill.waitFor();
  await capture('pill-phone-dark-390');
  await mpill.getByRole('button').first().click();
  await page.locator('[data-testid="att-checkout"].att-sheet').waitFor();
  await capture('checkout-sheet-dark-390');
  await page.close(); await ctx.close();

  assert.deepEqual(errors, [], 'no page errors');
  console.log(JSON.stringify({ ok: true, checks, out }, null, 1));
} finally { await browser.close(); }
