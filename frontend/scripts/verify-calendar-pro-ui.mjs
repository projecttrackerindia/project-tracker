// Calendar Pro: the rail (mini month, Upcoming today with checks, Time breakdown, Unscheduled tray, calendars), the big month header with the
// zone, Day / 3 days / Week / Month / Agenda / People views, quick create with a sentence + attendees' free/busy, drag to move and resize
// (15-minute snap, Undo), a repeating meeting's "this / this and following", the tray dragged onto the grid, the People view's drag to
// reassign, right-click menu, search, keyboard shortcuts, .ics export; 1440 / 1920 / 390 in light and dark. Synthetic data only.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { cutOff } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/calendar-pro-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Alexandra Montgomery', email: 'preview@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 2 };
const pid = '00000000-0000-0000-0000-000000000003';
const PEER = '00000000-0000-0000-0000-0000000000a1', PEER2 = '00000000-0000-0000-0000-0000000000a2';
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
    provider: 'google', providerName: 'Google Meet', joinUrl: 'https://meet.google.com/abc-defg-hij', calendarUrl: null, isScrum: false, recurring: true, sessionsLeft: 8, notetaker: 'off', myRsvp: 'Organizer', isOrganizer: true, canManage: true,
    organizerName: 'Alexandra Montgomery', invited: 3, accepted: 2, declined: 0, status: 'Scheduled', notes: null, live: false },
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

// The one timeline (GET /timeline) the Calendar reads, made from the same records: meetings and open work as scheduled, the finished ticket
// where it was finished, time entries at their hours (the typed-in one placed on the day), the reminder and the day of leave.
const tev = (o) => ({ end: null, allDay: false, link: null, projectId: null, projectName: null, people: [], status: null, colour: '', key: null, approximated: false, overdue: false, priority: null,
  minutes: null, note: null, joinUrl: null, notes: false, userId: user.id, mode: null, running: false, ...o });
const KEYS = { [ids.w1]: 'OPS-21', [ids.w2]: 'OPS-19', [ids.t1]: 'PAY-7', [ids.t3]: 'PAY-9' };
const timeline = (from, to) => ({ from, to, timeZone: 'Asia/Kolkata', scope: 'me', generatedAt: NOW.toISOString(), events: [
  ...calendar().map((e) => (e.type === 'meeting'
    ? tev({ id: `meeting:${e.id}`, type: 'meeting', title: e.title, start: e.startsAt, end: new Date(Date.parse(e.startsAt) + e.durationMinutes * 60e3).toISOString(), date: e.date, sourceType: e.projectId ? 'projectMeeting' : 'workspaceMeeting',
      sourceId: e.id, projectId: e.projectId, projectName: e.projectName, people: e.people, status: e.status, joinUrl: e.joinUrl, notes: !!e.notes })
    : e.category === 'Done'
      ? tev({ id: `done:${e.type}:${e.id}`, type: 'done', title: e.title.replace(/^[A-Z]+-\d+ · /, ''), key: KEYS[e.id], start: at(e.date, '17:00'), date: e.date, sourceType: e.type, sourceId: e.id, status: e.status, priority: e.priority })
      : tev({ id: `due:${e.type}:${e.id}`, type: 'due', title: e.title.replace(/^[A-Z]+-\d+ · /, ''), key: KEYS[e.id], allDay: true, start: at(e.date, '00:00'), date: e.date, sourceType: e.type, sourceId: e.id,
        projectId: e.projectId, projectName: e.projectName, status: e.status, priority: e.priority, overdue: e.overdue }))),
  tev({ id: 'time:te1', type: 'time', title: 'Integration runtime disconnected', start: at(today, '09:00'), end: at(today, '10:30'), date: today, sourceType: 'timeEntry', sourceId: 'te1', minutes: 90, note: 'Restarted the runtime' }),
  tev({ id: 'time:te2', type: 'time', title: 'Settlement report export', start: at(today, '10:30'), end: at(today, '12:30'), date: today, sourceType: 'timeEntry', sourceId: 'te2', minutes: 120, approximated: true, projectId: pid, projectName: 'Payments revamp' }),
  tev({ id: 'reminder:r1', type: 'reminder', title: 'Send the vendor follow-up', start: at(today, '16:30'), date: today, sourceType: 'reminder', sourceId: 'r1', status: 'scheduled' }),
  tev({ id: 'leave:l1', type: 'leave', title: 'Leave', allDay: true, start: at(fri, '00:00'), date: fri, sourceType: 'plannedLeave', sourceId: 'l1', note: 'Family function' }),
].filter((t) => t.date >= from && t.date <= to) });

const errors = [], checks = [], writes = [];
const doneIds = new Set();
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
try {
  async function context(theme) {
    const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
    await ctx.clock.setFixedTime(NOW);
    await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); window.__opened = []; window.open = (u) => { window.__opened.push(String(u)); return null; }; }, theme);
    await ctx.route('**/*', async (route) => {
      const url = new URL(route.request().url()), ep = url.pathname, method = route.request().method();
      if (url.origin !== origin) { await route.abort(); return; }
      if (ep.endsWith('/avatar')) { await route.fulfill({ status: 404, body: '' }); return; }
      if (!ep.startsWith('/api/')) {
        const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
        const type = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream';
        await route.fulfill({ contentType: type, body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } }); return;
      }
      let data = [];
      const body = () => { try { return route.request().postDataJSON(); } catch { return null; } };
      if (method !== 'GET' && !ep.endsWith('/auth/refresh')) {
        writes.push({ method, ep, body: body() });
        if (ep === `/api/v1/work-tasks/${ids.w1}/status`) { doneIds.add(ids.w1); data = { ...work, status: 'Completed' }; }
        else if (ep.endsWith('/timer/start')) data = entry({ id: 'run', taskKey: 'OPS-21', taskTitle: 'x', minutes: 0, isRunning: true, startedAt: NOW.toISOString() });
        else if (ep === `/api/v1/tasks/${ids.t1}`) data = task(ids.t1, 'PAY-7', 'Settlement report export', body().dueDate, 'High');
        else if (ep.endsWith('/rsvp')) data = { rsvp: 'Accepted' };
        else data = {};
      }
      else if (ep.endsWith('/auth/refresh')) data = { accessToken: `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`, expiresAt: '2099-01-01T00:00:00Z', user };
      else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['org.manage', 'work.view', 'work.edit', 'work.create', 'reports.view'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 3, activity: 3, documents: 3, people: 3, reports: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: {} } };
      else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
      else if (ep === '/api/v1/calendar') data = calendar();
      else if (ep === '/api/v1/timeline') { const t = timeline(url.searchParams.get('from'), url.searchParams.get('to')); if (url.searchParams.get('scope') === 'team') { t.scope = 'team'; t.events = t.events.map((e) => (e.sourceId === ids.t3 ? { ...e, userId: PEER } : e)).concat([tev({ id: 'time:tp', type: 'time', title: 'Ledger checks', start: at(tue, '10:00'), end: at(tue, '12:00'), date: tue, sourceType: 'timeEntry', sourceId: 'tp', minutes: 120, userId: PEER2 })]); } data = t; }
      else if (ep === '/api/v1/meet') data = feed();
      else if (ep === '/api/v1/reminders') data = { open: [{ id: 'r1', title: 'Send the vendor follow-up', nextFireAt: at(today, '16:30') }], done: [] };
      else if (ep === '/api/v1/time') data = timesheet;
      else if (ep === '/api/v1/time/grid') data = { weekStart: mon, weekEnd: day(4), user: { id: user.id, name: user.displayName }, mine: true, editable: true, locked: false, status: 'NotSubmitted', days: gridDays, rows: [], suggestions: [], totalMinutes: 0, billableMinutes: 0, targetMinutes: 2400, overtimeMinutes: 0, missingDays: 0, running: null };
      else if (ep === `/api/v1/tasks/${ids.t1}`) data = { task: task(ids.t1, 'PAY-7', 'Settlement report export', fri, 'High'), subtasks: [] };
      else if (ep === `/api/v1/tasks/${ids.t3}`) data = { task: task(ids.t3, 'PAY-9', 'Reconcile vendor ledger', thu, 'Medium'), subtasks: [] };
      else if (ep === `/api/v1/work-tasks/${ids.w1}`) data = work;
      else if (ep === `/api/v1/projects/${pid}`) data = { project: { id: pid, name: 'Payments revamp' }, statuses: [{ id: 's-todo', name: 'To do', category: 'Todo' }, { id: 's-done', name: 'Done', category: 'Done' }], stages: [], members: [] };
      else if (ep.endsWith('/workspace/members')) data = [{ userId: user.id, displayName: user.displayName, email: user.email, role: 'Owner' }, { userId: PEER, displayName: 'Rhea Kapoor', email: 'rhea@example.test', role: 'Member' }, { userId: PEER2, displayName: 'Vikram Rao', email: 'vikram@example.test', role: 'Member' }];
      else if (ep === '/api/v1/meet/free-busy') data = { from: url.searchParams.get('from'), to: url.searchParams.get('to'), everyoneFree: false, busyCount: 1, people: [{ userId: PEER, name: 'Rhea Kapoor', freeAtSlot: false, busy: [{ start: at(thu, '15:00'), end: at(thu, '16:00'), kind: 'meeting' }] }] };
      else if (ep === '/api/v1/projects' || ep === '/api/v1/work-tasks') data = { items: [], page: 1, totalPages: 0, totalItems: 0 };
      else if (ep === '/api/v1/timer') data = null;
      else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
      else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
    });
    return ctx;
  }
  let page;
  async function open(ctx, width) {
    page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(origin + '/preview-org/calendar');
    await page.locator('[data-testid="week-planner"]').waitFor({ timeout: 15000 });
    await page.locator('.wp-e').first().waitFor();
  }
  async function capture(name) {
    const wide = await page.evaluate(() => { if (document.documentElement.scrollWidth <= innerWidth + 1) return null; return [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).slice(0, 6).map((e) => `${e.tagName}.${e.className}`); });
    assert.equal(wide, null, name + ' viewport overflow ' + JSON.stringify(wide));
    assert.deepEqual(await cutOff(page), [], name + ' cut off at the right edge');
    await page.screenshot({ path: path.join(out, name + '.png'), animations: 'disabled' }); checks.push(name);
  }
  const HR = 73;
  const card = () => page.locator('[data-testid="event-detail"]');
  const block = (type, text) => page.locator(`.wp-col [data-type="${type}"]`, { hasText: text }).first();
  const scrollTo = async (h) => { await page.locator('[data-testid="wp-scroll"]').evaluate((el, y) => { el.scrollTop = y; }, h * HR - 10); await page.waitForTimeout(120); };
  const lastWrite = (pred) => [...writes].reverse().find(pred);
  const waitWrite = async (pred) => { for (let i = 0; i < 40 && !lastWrite(pred); i++) await page.waitForTimeout(100); return lastWrite(pred); };
  async function drag(loc, dx, dy, where = 'center') {
    const b = await loc.boundingBox();
    const x = b.x + b.width / 2, y = where === 'bottom' ? b.y + b.height - 2 : where === 'top' ? b.y + 2 : b.y + Math.min(b.height / 2, 14);
    await page.mouse.move(x, y); await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dx * i) / 8, y + (dy * i) / 8);
    await page.mouse.up(); await page.waitForTimeout(300);
  }
  const view = (name) => page.getByRole('tablist', { name: 'Calendar view' }).getByRole('tab', { name, exact: true }).click();

  // ---------------------------------------------------------------- 1440 light
  const light = await context('light');
  await open(light, 1440);
  await scrollTo(8);
  assert.match(await page.locator('.wp-title').innerText(), /October\s+2026/);
  assert.match(await page.getByTestId('cp-tz').innerText(), /GMT\+5:30/);
  assert.match(await page.getByTestId('cp-today').innerText(), /Release sync[\s\S]*OPS-21/);
  assert.match(await page.getByTestId('cp-breakdown').innerText(), /Meetings[\s\S]*Projects[\s\S]*Focus[\s\S]*Reviews/);
  checks.push('rail: today, breakdown');
  await capture('calendar-1440-light');

  // Upcoming today: ticking the ticket marks it done for real.
  await page.getByTestId('cp-today').getByLabel(/Mark done: OPS-21/).click();
  assert.ok(await waitWrite((x) => x.ep === `/api/v1/work-tasks/${ids.w1}/status`), 'ticket marked done from the rail');
  checks.push('today: check marks work done');

  // Drag a meeting I organise 30 minutes later, then its bottom edge 15 minutes down (snap), each with Undo.
  await scrollTo(13);
  await drag(block('meeting', 'Design review'), 0, HR / 2);
  let w = await waitWrite((x) => x.ep === `/api/v1/meetings/${ids.m2}/reschedule`);
  assert.equal(w.body.startTime, at(today, '15:30')); assert.equal(w.body.endTime, at(today, '16:30'));
  await page.locator('.talk-toast', { hasText: 'Design review moved' }).waitFor();
  checks.push('drag: move 30 min with undo toast');
  const n0 = writes.length;
  await drag(block('meeting', 'Design review'), 0, HR / 4 + 2, 'bottom');
  w = await waitWrite((x) => x.ep === `/api/v1/meetings/${ids.m2}/reschedule` && writes.indexOf(x) >= n0);
  assert.equal(w.body.endTime, at(today, '16:45'), 'resize snaps to 15 minutes');
  checks.push('resize: bottom edge snaps 15 min');

  // A repeating meeting asks: this event, or this and following.
  await scrollTo(10);
  await drag(block('meeting', 'Release sync'), 0, HR);
  const ask = page.getByTestId('recur-ask'); await ask.waitFor();
  await shot('recurring-ask-1440');
  await ask.getByRole('button', { name: 'This and following' }).click();
  w = await waitWrite((x) => x.ep === `/api/v1/meet/w/${ids.m1}/occurrence`);
  assert.equal(w.body.scope, 'following'); assert.equal(w.body.startTime, at(today, '12:00'));
  checks.push('recurring: this and following');

  // Quick create: drag over empty time Thursday 14:00–15:00, type a sentence, attendees' free/busy, Add event.
  await scrollTo(13);
  const col = await page.locator(`.wp-col[data-day="${thu}"]`).boundingBox();
  const y14 = col.y + 14 * HR + 2;
  await page.mouse.move(col.x + col.width / 2, y14); await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(col.x + col.width / 2, y14 + (HR - 4) * i / 6);
  await page.mouse.up();
  await page.getByTestId('quick-create').waitFor();
  await page.getByTestId('qc-title').fill('Review with Rhea tomorrow 3pm 45m');
  assert.equal(await page.getByLabel('Starts').inputValue(), '15');
  assert.equal(await page.getByLabel('Ends').inputValue(), '15.75');
  await page.getByTestId('qc-freebusy').waitFor();
  assert.match(await page.getByTestId('qc-freebusy').innerText(), /Rhea is busy/);
  await shot('quick-create-1440');
  await page.getByTestId('qc-freebusy').getByRole('button', { name: 'Find a time' }).click();
  assert.equal(await page.getByLabel('Starts').inputValue(), '9');
  await page.getByTestId('qc-add').click();
  w = await waitWrite((x) => x.ep === '/api/v1/meetings/schedule');
  assert.equal(w.body.title, 'Review with Rhea'); assert.deepEqual(w.body.participantUserIds, [PEER]);
  assert.equal(w.body.startTime, at(thu, '09:00')); assert.equal(w.body.endTime, at(thu, '09:45'));
  checks.push('quick create: sentence, free/busy, find a time, add');

  // The Unscheduled tray: drag an item onto Thursday 11:00 to time-block it.
  const item = page.getByTestId('cp-tray-item').first();
  const label = await item.innerText();
  await scrollTo(9);
  const ib = await item.boundingBox(), c2 = await page.locator(`.wp-col[data-day="${thu}"]`).boundingBox();
  const scrollTop = await page.locator('[data-testid="wp-scroll"]').evaluate((el) => el.scrollTop); void scrollTop;
  await page.mouse.move(ib.x + 20, ib.y + ib.height / 2); await page.mouse.down();
  const ty = c2.y + 11 * HR + 10;
  for (let i = 1; i <= 10; i++) await page.mouse.move(ib.x + 20 + (c2.x + c2.width / 2 - ib.x - 20) * i / 10, ib.y + (ty - ib.y) * i / 10);
  await page.mouse.up(); await page.waitForTimeout(400);
  const fb = page.locator(`.wp-col[data-day="${thu}"] [data-type="focus"][data-start="11"]`);
  const starts = await page.locator(`.wp-col[data-day="${thu}"] [data-type="focus"]`).evaluateAll((els) => els.map((e) => e.dataset.start + ' ' + e.textContent));
  assert.equal(await fb.count(), 1, `focus block from the tray (${label}) ${JSON.stringify({ ib, ty, starts })}`);
  checks.push('tray: drag onto the grid time-blocks');

  // Right-click: Set reminder.
  await scrollTo(14);
  await block('meeting', 'Design review').click({ button: 'right' });
  await page.getByTestId('cp-ctx').waitFor();
  await page.getByTestId('cp-ctx').getByRole('menuitem', { name: 'Set reminder' }).click();
  w = await waitWrite((x) => x.method === 'POST' && x.ep === '/api/v1/reminders');
  assert.equal(w.body.targetType, 'Meeting'); assert.equal(w.body.targetId, ids.m2);
  checks.push('context menu: set reminder');

  // Search narrows the grid.
  await page.getByTestId('cp-search').fill('Design');
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.wp-col [data-type="meeting"]', { hasText: 'Release sync' }).count(), 0);
  assert.equal(await page.locator('.wp-col [data-type="meeting"]', { hasText: 'Design review' }).count(), 1);
  await page.getByTestId('cp-search').fill('');
  checks.push('search filters events');

  // Export .ics
  await page.locator('.cp-more > summary').click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('cp-export').click()]);
  const ics = await fs.readFile(await dl.path(), 'utf8');
  assert.match(ics, /BEGIN:VCALENDAR[\s\S]*SUMMARY:Design review/);
  checks.push('export .ics');

  // Keyboard: M month, W week, 3 three days, A agenda, P people.
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('m'); await page.locator('section.wp-month').waitFor();
  await page.keyboard.press('a'); await page.getByTestId('wp-agenda').waitFor();
  await page.keyboard.press('3'); await page.waitForTimeout(300);
  assert.equal(await page.locator('.wp-col').count(), 3, '3-day view');
  await capture('calendar-3day-1440-light');
  await page.keyboard.press('w'); await page.waitForTimeout(300);
  assert.equal(await page.locator('.wp-col').count(), 7);
  checks.push('keyboard shortcuts');

  // People: one row per person; drag Rhea's PAY-9 onto Vikram to reassign.
  await page.keyboard.press('p');
  const rv = page.getByTestId('resource-view'); await rv.waitFor();
  await rv.locator(`[data-person="${PEER2}"]`).waitFor();
  await capture('calendar-people-1440-light');
  const chip = rv.locator(`[data-person="${PEER}"] [data-testid="rv-chip"]`, { hasText: 'PAY-9' });
  const cb = await chip.boundingBox(), row2 = await rv.locator(`[data-person="${PEER2}"] .rv-cell`).nth(1).boundingBox();
  await page.mouse.move(cb.x + 10, cb.y + 8); await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(cb.x + 10 + (row2.x + 20 - cb.x - 10) * i / 8, cb.y + 8 + (row2.y + 20 - cb.y - 8) * i / 8);
  await page.mouse.up();
  w = await waitWrite((x) => x.method === 'PUT' && x.ep === `/api/v1/tasks/${ids.t3}`);
  assert.equal(w.body.assigneeId, PEER2);
  await page.locator('.talk-toast', { hasText: 'Vikram Rao' }).waitFor();
  checks.push('people: drag to reassign with undo');
  await light.close();

  // ---------------------------------------------------------------- 1920 light, 1440 / 1920 dark
  for (const [theme, width] of [['light', 1920], ['dark', 1440], ['dark', 1920]]) {
    const c = await context(theme); await open(c, width); await scrollTo(8);
    await capture(`calendar-${width}-${theme}`);
    if (width === 1440) {
      const b = await page.locator(`.wp-col[data-day="${thu}"]`).boundingBox();
      await page.mouse.click(b.x + b.width / 2, b.y + 10 * HR + 30);
      await page.getByTestId('quick-create').waitFor();
      await capture(`quick-create-${width}-${theme}`);
    }
    await c.close();
  }

  // ---------------------------------------------------------------- phone 390, light and dark
  for (const theme of ['light', 'dark']) {
    const c = await context(theme); await open(c, 390); await scrollTo(9);
    await capture(`calendar-390-${theme}-day`);
    await view('3 days'); await page.waitForTimeout(300);
    assert.equal(await page.locator('.wp-col').count(), 3);
    await capture(`calendar-390-${theme}-3day`);
    // a tap on empty time opens quick create as a sheet
    await scrollTo(14);
    const b = await page.locator('.wp-col').nth(1).boundingBox();
    await page.mouse.click(b.x + b.width / 2, b.y + 15 * HR + 50);
    await page.getByTestId('quick-create').waitFor();
    await capture(`calendar-390-${theme}-create`);
    await page.keyboard.press('Escape');
    await view('Agenda'); await page.getByTestId('wp-agenda').waitFor();
    await capture(`calendar-390-${theme}-agenda`);
    await view('People'); await page.getByTestId('resource-view').waitFor(); await page.waitForTimeout(300);
    await capture(`calendar-390-${theme}-people`);
    await c.close();
  }
  async function shot(name) { await page.waitForTimeout(250); await page.screenshot({ path: path.join(out, name + '.png'), animations: 'disabled' }); checks.push(name); }
  assert.deepEqual(errors, [], 'no page errors');
  console.log(`calendar pro ui: ${checks.length} checks passed\n  ${checks.join('\n  ')}`);
} finally { await browser.close(); }
