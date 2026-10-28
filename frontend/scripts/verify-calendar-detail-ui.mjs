// Calendar block details: every block (focus, meeting, deadline flag, logged time, reminder, leave) opens a card that says what it is and why
// it is there; the day plan gives each open item one focus block (none for finished items, past days or leave); Join, Start focus, Mark done,
// Move and Ask for more time call the right APIs; keyboard; phone sheet; dark mode. Synthetic data only.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { cutOff } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/calendar-detail-ui');
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
      else if (ep === '/api/v1/timeline') data = timeline(url.searchParams.get('from'), url.searchParams.get('to'));
      else if (ep === '/api/v1/meet') data = feed();
      else if (ep === '/api/v1/reminders') data = { open: [{ id: 'r1', title: 'Send the vendor follow-up', nextFireAt: at(today, '16:30') }], done: [] };
      else if (ep === '/api/v1/time') data = timesheet;
      else if (ep === '/api/v1/time/grid') data = { weekStart: mon, weekEnd: day(4), user: { id: user.id, name: user.displayName }, mine: true, editable: true, locked: false, status: 'NotSubmitted', days: gridDays, rows: [], suggestions: [], totalMinutes: 0, billableMinutes: 0, targetMinutes: 2400, overtimeMinutes: 0, missingDays: 0, running: null };
      else if (ep === `/api/v1/tasks/${ids.t1}`) data = { task: task(ids.t1, 'PAY-7', 'Settlement report export', fri, 'High'), subtasks: [] };
      else if (ep === `/api/v1/tasks/${ids.t3}`) data = { task: task(ids.t3, 'PAY-9', 'Reconcile vendor ledger', thu, 'Medium'), subtasks: [] };
      else if (ep === `/api/v1/work-tasks/${ids.w1}`) data = work;
      else if (ep === `/api/v1/projects/${pid}`) data = { project: { id: pid, name: 'Payments revamp' }, statuses: [{ id: 's-todo', name: 'To do', category: 'Todo' }, { id: 's-done', name: 'Done', category: 'Done' }], stages: [], members: [] };
      else if (ep.endsWith('/workspace/members')) data = [{ userId: user.id, displayName: user.displayName, email: user.email, role: 'Owner' }];
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
    await page.locator('.wp-e.f').first().waitFor();
  }
  async function capture(name) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, name + ' viewport overflow');
    assert.deepEqual(await cutOff(page), [], name + ' cut off at the right edge');
    await page.screenshot({ path: path.join(out, name + '.png'), animations: 'disabled' }); checks.push(name);
  }
  const card = () => page.locator('[data-testid="event-detail"]');
  const focusOf = (text) => page.locator('.wp-e.f', { hasText: text });

  // ---------------------------------------------------------------- desktop, light
  let ctx = await context('light');
  await open(ctx, 1440);
  // The day plan: one block per open item, on or before its due day; nothing for the finished ticket, past days or the day of leave.
  assert.equal(await focusOf('OPS-21').count(), 1, 'one focus block for the open critical ticket, not one a day');
  assert.equal(await focusOf('OPS-19').count(), 0, 'no focus for a finished ticket');
  assert.equal(await page.locator(`.wp-col[data-day="${mon}"] .wp-e.f, .wp-col[data-day="${tue}"] .wp-e.f, .wp-col[data-day="${fri}"] .wp-e.f`).count(), 0, 'no focus on past days or leave');
  assert.equal(await page.locator(`.wp-col[data-day="${today}"] .wp-e.f`, { hasText: 'OPS-21' }).count(), 1, 'the critical ticket due today is planned today');
  assert.equal(await page.locator('.wp-flag', { hasText: 'OPS-19' }).count(), 0, 'no deadline flag for a finished ticket');
  const titles = await page.locator('.wp-e.f').evaluateAll((els) => els.map((e) => e.textContent));
  assert.equal(new Set(titles).size, titles.length, 'no identical focus blocks repeated');
  // Focus blocks are named after their item (key and title), never a generic "Deep work".
  assert.ok(titles.every((t) => /^Focus(OPS|PAY)-\d+ /.test(t)), titles.join(' | '));
  // Focus: not hatched any more
  assert.equal(await focusOf('OPS-21').evaluate((el) => getComputedStyle(el).backgroundImage), 'none', 'the focus block is a tinted block, not stripes');

  // focus card
  await focusOf('OPS-21').click();
  await card().waitFor();
  assert.equal(await card().getAttribute('data-kind'), 'focus');
  const why = await page.locator('[data-testid="ed-why"]').innerText();
  assert.match(why, /planned by your day plan for OPS-21 · Critical · due today/, why);
  await page.locator('.ed-pill', { hasText: 'SLA at risk' }).waitFor();
  assert.equal(await focusOf('OPS-21').getAttribute('aria-expanded'), 'true', 'the block is lifted while its card is open');
  await page.waitForTimeout(400); await capture('focus-card-1440');
  await page.locator('[data-testid="ed-start"]').click();
  await page.waitForFunction(() => true);
  await assert.doesNotReject(async () => { for (let i = 0; i < 20 && !writes.some((w) => w.ep === `/api/v1/work-tasks/${ids.w1}/timer/start`); i++) await page.waitForTimeout(100); });
  assert.ok(writes.some((w) => w.method === 'POST' && w.ep === `/api/v1/work-tasks/${ids.w1}/timer/start`), 'Start focus starts the timer on the ticket');
  await page.locator('[data-testid="ed-done"]').click();
  await card().waitFor({ state: 'detached' });
  const doneW = writes.find((w) => w.ep === `/api/v1/work-tasks/${ids.w1}/status`);
  assert.deepEqual(doneW?.body, { status: 'Completed' }, 'Mark done completes the ticket');
  await page.waitForFunction(() => ![...document.querySelectorAll('.wp-e.f')].some((e) => e.textContent.includes('OPS-21')));
  checks.push('focus: Start focus + Mark done');

  // move a focus block to another time, then take one out of the plan (kept on this device, with Undo)
  await focusOf('Settlement report export').click();
  await page.locator('[data-testid="ed-move"]').click();
  await page.locator('[data-testid="ed-pick"] select[aria-label="Day"]').selectOption(thu);
  await page.locator('[data-testid="ed-pick"] select[aria-label="Start time"]').selectOption('14');
  await page.locator('[data-testid="ed-pick"] button', { hasText: 'Move' }).click();
  const moved = page.locator(`.wp-col[data-day="${thu}"] .wp-e.f`, { hasText: 'Settlement report export' });
  await moved.waitFor();
  assert.equal(await moved.getAttribute('data-start'), '14', 'moved to 2 PM Thursday');
  assert.match(await page.evaluate(() => Object.entries(localStorage).find(([k]) => k.startsWith('pt.calendar.plan'))?.[1] ?? ''), /"start":14/);
  await focusOf('Reconcile vendor ledger').click();
  await page.locator('[data-testid="ed-remove"]').click();
  await page.waitForFunction(() => ![...document.querySelectorAll('.wp-e.f')].some((e) => e.textContent.includes('Reconcile vendor ledger')));
  checks.push('focus: move + remove from plan');

  // meeting with a Google Meet link: countdown, big Join, RSVP
  await page.locator('.wp-e', { hasText: 'Release sync' }).click();
  await card().waitFor();
  assert.equal(await card().getAttribute('data-kind'), 'meeting');
  assert.equal(await page.locator('[data-testid="ed-countdown"]').innerText(), 'in 18 min');
  assert.match(await page.locator('[data-testid="ed-why"]').innerText(), /Meeting from Google Calendar · Rhea Kapoor invited you/);
  const join = page.locator('[data-testid="ed-join"]');
  assert.match(await join.innerText(), /Join Google Meet/);
  assert.equal(await join.evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(0, 113, 227)', 'Join is the big blue button');
  await page.locator('.ed-rsvp button', { hasText: 'Yes' }).click();
  await page.waitForTimeout(150);
  assert.deepEqual(writes.find((w) => w.ep === `/api/v1/meet/w/${ids.m1}/rsvp`)?.body, { response: 'accepted' });
  await page.waitForTimeout(250); await capture('meeting-card-1440');
  await join.click();
  assert.deepEqual(await page.evaluate(() => window.__opened), ['https://meet.google.com/abc-defg-hij'], 'Join opens the meeting link');
  checks.push('meeting: Join + RSVP');

  // keyboard: Enter opens, Esc closes, arrows walk the blocks
  await page.locator('.wp-e', { hasText: 'Design review' }).focus();
  await page.keyboard.press('Enter');
  await card().waitFor();
  assert.match(await page.locator('[data-testid="ed-join"]').innerText(), /Join Project Tracker call/);
  await page.keyboard.press('Escape');
  await card().waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.includes('Design review')), true, 'focus goes back to the block');
  await page.keyboard.press('ArrowUp');
  assert.notEqual(await page.evaluate(() => document.activeElement?.dataset.block), undefined);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.includes('Design review')), false, 'ArrowUp moves to the block above');
  checks.push('keyboard');

  // deadline flag: Ask for more time moves the date with a reason
  await page.locator('.wp-flag', { hasText: 'PAY-7' }).click();
  await card().waitFor();
  assert.equal(await card().getAttribute('data-kind'), 'deadline');
  assert.match(await page.locator('[data-testid="ed-why"]').innerText(), /Deadline of PAY-7 in Payments revamp · High priority/);
  await page.locator('[data-testid="ed-more-time"]').click();
  await page.locator('[data-testid="ed-date"] input[aria-label="Reason"]').fill('Waiting on the bank file format');
  await page.locator('[data-testid="ed-date"] button[type="submit"]').click();
  await card().waitFor({ state: 'detached' });
  const upd = writes.find((w) => w.method === 'PUT' && w.ep === `/api/v1/tasks/${ids.t1}`);
  assert.equal(upd?.body.dueDate, day(3)); assert.equal(upd?.body.dueDateReason, 'Waiting on the bank file format'); assert.equal(upd?.body.version, 4);
  checks.push('deadline: move date with reason');

  // logged time chip: the entries that make the total
  await page.locator(`.wp-dh.tdy [data-testid="wp-logged"]`).click();
  await card().waitFor();
  assert.equal(await card().getAttribute('data-kind'), 'loggedDay');
  assert.equal(await page.locator('[data-testid="ed-entries"] li').count(), 2);
  assert.match(await page.locator('[data-testid="ed-why"]').innerText(), /Logged 3h 30m today across 2 entries/);
  await capture('logged-card-1440');
  await page.keyboard.press('Escape');
  // leave (read-only) and reminder
  await page.locator('.wp-leave').click(); await card().waitFor();
  assert.equal(await card().getAttribute('data-kind'), 'leave'); assert.match(await card().innerText(), /Family function/);
  assert.equal(await card().locator('.ed-btn').count(), 0, 'leave is read-only');
  await page.keyboard.press('Escape');
  await page.locator('.wp-rem').first().click(); await card().waitFor();
  assert.equal(await card().getAttribute('data-kind'), 'reminder');
  await page.keyboard.press('Escape');
  checks.push('leave + reminder');
  await page.close(); await ctx.close();

  // ---------------------------------------------------------------- dark
  doneIds.clear();
  ctx = await context('dark');
  await open(ctx, 1440);
  await page.locator('.wp-e', { hasText: 'Release sync' }).click(); await card().waitFor(); await page.waitForTimeout(400);
  const bg = await card().evaluate((el) => getComputedStyle(el).backgroundColor);
  const [r, g, b] = bg.match(/\d+(\.\d+)?/g).map(Number);
  assert.ok(r + g + b < 200, `the card is dark in dark mode (${bg})`);
  await capture('meeting-card-dark-1440');
  await page.keyboard.press('Escape');
  await focusOf('OPS-21').click(); await card().waitFor(); await page.waitForTimeout(400);
  await capture('focus-card-dark-1440');
  await page.close(); await ctx.close();

  // ---------------------------------------------------------------- phone: a bottom sheet
  ctx = await context('light');
  await open(ctx, 390);
  await capture('calendar-day-390');
  await focusOf('OPS-21').click(); await card().waitFor(); await page.waitForTimeout(450);
  const sheet = await card().evaluate((el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, b: r.bottom, w: document.documentElement.clientWidth, h: innerHeight, cls: el.className }; });
  assert.match(sheet.cls, /ed-sheet/); assert.ok(Math.abs(sheet.b - sheet.h) <= 1 && sheet.l <= 0.5 && Math.abs(sheet.r - sheet.w) <= 0.5, JSON.stringify(sheet));
  await capture('focus-sheet-390');
  await page.mouse.click(195, 40);
  await card().waitFor({ state: 'detached' });
  await page.locator('.wp-e', { hasText: 'Release sync' }).click(); await card().waitFor(); await page.waitForTimeout(450);
  assert.equal(await page.locator('[data-testid="ed-join"]').isVisible(), true);
  await capture('meeting-sheet-390');
  await page.close(); await ctx.close();

  assert.deepEqual(errors, [], 'no page errors');
  console.log(JSON.stringify({ ok: true, checks, out }, null, 1));
} finally { await browser.close(); }
