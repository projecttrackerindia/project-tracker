// Meetings connected everywhere (apple2 design: meet-schedule, meet-where, meet-log, meet-capture, mywork, mywork-item):
//  - the Aura chip "Schedule a meeting" reads the sentence into the one schedule sheet (title, attendee, weekly, 45m, free/busy) and
//    Schedule sends the series with its end date and video choice;
//  - Today shows "Log 45m to UPI AutoPay?" and nothing is logged until Log is tapped (then exactly one POST);
//  - My Work lists today's meeting with Join and its agenda, "◆ From:" tags and the "◆ From meetings" chip; an item opens with its
//    "From meeting" card;
//  - the meeting page's one-line capture reads "@Ravi fri" into chips and Enter creates the task with this meeting as its source.
// 1440 light and dark, and 390 (phone: no sideways scroll, nothing cut off). Synthetic data only.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/meetings-connected-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Riverline Payments', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 4 };
const pid = '00000000-0000-0000-0000-000000000003';
const ravi = '00000000-0000-0000-0000-000000000011', mira = '00000000-0000-0000-0000-000000000012';
const mid = '00000000-0000-0000-0000-0000000000a1', weekly = '00000000-0000-0000-0000-0000000000a2';
// Monday 2 November 2026, 12:20 in Kolkata (the sandbox sync ran 11:30–12:15).
const day = '2026-11-02';
const at = (d, hm) => new Date(`${d}T${hm}:00+05:30`);
const NOW = at(day, '12:20');
const iso = (d, hm) => at(d, hm).toISOString();

const meetItem = (o) => ({ ref: `p:${mid}`, kind: 'project', id: mid, title: 'Bank sandbox sync', description: '1. Sandbox date status (Mira)\n2. Mandate API late items\n3. Review action items since last sync',
  start: iso(day, '15:00'), end: iso(day, '16:00'), timeZone: 'Asia/Kolkata', projectId: pid, projectName: 'UPI AutoPay', projectKey: 'UPA', provider: 'ours', providerName: 'Project Tracker call',
  joinUrl: `/calls/meeting/${mid}`, calendarUrl: null, isScrum: false, recurring: true, sessionsLeft: 3, notetaker: 'off', myRsvp: 'Organizer', isOrganizer: true, canManage: true, organizerName: 'Asha Rao',
  invited: 3, accepted: 2, declined: 0, status: 'Scheduled', notes: null, live: false, cadence: 'Weekly', recurrence: 'Every Mon · until 21 Dec', originalStart: iso(day, '15:00'), video: 'inapp',
  seriesRef: `p:${mid}`, agenda: '1. Sandbox date status (Mira)\n2. Mandate API late items\n3. Review action items since last sync', ...o });
const feed = () => ({ items: [
  meetItem({}),
  meetItem({ ref: `p:${weekly}`, id: weekly, title: 'Steering committee', start: iso('2026-11-04', '16:00'), end: iso('2026-11-04', '17:00'), cadence: 'Monthly', originalStart: iso('2026-11-04', '16:00'), seriesRef: `p:${weekly}`, agenda: null, description: null }),
], from: '', to: '', truncated: false });
const row = (o) => ({ kind: 'task', id: o.id, key: o.key, title: o.title, projectId: pid, projectKey: 'UPA', projectName: 'UPI AutoPay', status: 'In Progress', category: 'Active', priority: 'Medium',
  dueDate: o.dueDate ?? null, isOverdue: !!o.isOverdue, assignee: { id: user.id, name: 'Asha Rao' }, typeName: null, updatedAt: iso(day, '09:00'), version: 1, completedAt: null, reporterId: user.id, source: o.source ?? null, ...o });
const src = (title, d) => ({ meetingRef: `p:${mid}`, seriesRef: `p:${mid}`, title, occurrenceStart: iso(d, '11:30') });
const items = [
  row({ id: 'w1', key: 'UPA-7', title: 'Retry & notification rules', dueDate: day }),
  row({ id: 'w2', key: 'AI-14', kind: 'action', title: 'Escalation matrix for failed mandates', dueDate: '2026-10-28', isOverdue: true, status: 'Open', category: 'Todo', source: src('AutoPay weekly', '2026-10-26') }),
  row({ id: 'w3', key: 'AI-15', kind: 'action', title: 'Confirm bank sandbox date', dueDate: '2026-11-06', source: src('Bank sandbox sync', day) }),
  row({ id: 'w4', key: 'MPR-8', title: 'Settlement statements review', dueDate: '2026-11-05', projectName: 'Merchant Portal' }),
];
const proposal = { id: 'tp1', meetingRef: `p:${mid}`, meetingId: mid, meetingTitle: 'Bank sandbox sync', projectId: pid, projectName: 'UPI AutoPay', projectKey: 'UPA',
  start: iso(day, '11:30'), end: iso(day, '12:15'), minutes: 45, status: 'Proposed', billable: true, assignedToMe: 2, overlap: null };
const detail = { kind: 'action', id: 'w3', key: 'AI-15', title: 'Confirm bank sandbox date', description: null, projectId: pid, projectKey: 'UPA', projectName: 'UPI AutoPay', status: 'In Progress', category: 'Active',
  priority: 'Medium', startDate: null, dueDate: '2026-11-06', isOverdue: false, assignee: { id: ravi, name: 'Ravi Menon' }, reporter: { id: user.id, name: 'Asha Rao' }, version: 2, createdAt: iso(day, '11:40'),
  updatedAt: iso(day, '11:40'), completedAt: null, loggedMinutes: 25, detail: { status: 'InProgress', can: { edit: true, delete: true, complete: true } },
  activity: [{ type: 'change', id: 'a1', at: iso(day, '11:40'), actor: { id: user.id, name: 'Asha Rao' }, summary: 'Created from Bank sandbox sync' }], source: src('Bank sandbox sync', day) };
const meeting = { id: mid, projectId: pid, title: 'Bank sandbox sync', description: '1. Sandbox date status (Mira)', startTime: iso('2026-10-26', '11:30'), endTime: iso('2026-10-26', '12:15'), timeZone: 'Asia/Kolkata',
  status: 'Scheduled', meetUri: `/calls/meeting/${mid}`, organizerUserId: user.id, organizerName: 'Asha Rao', recurrenceRule: 'RRULE:FREQ=WEEKLY;COUNT=8', calendarUrl: null, isScrum: false, provider: 'ours', providerName: 'Project Tracker call', notetaker: 'off',
  participants: [{ userId: user.id, name: 'Asha Rao', email: 'asha@example.test', role: 'Organizer', rsvpStatus: 'Accepted' }, { userId: ravi, name: 'Ravi Menon', email: 'ravi@example.test', role: 'Attendee', rsvpStatus: 'Accepted' }, { userId: mira, name: 'Mira Okafor', email: 'mira@example.test', role: 'Attendee', rsvpStatus: 'Accepted' }] };

const errors = [], checks = [], writes = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
try {
  async function context(theme, opts = {}) {
    const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block', ...opts });
    await ctx.clock.setFixedTime(NOW);
    await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); }, theme);
    let proposals = [proposal];
    let created = [];
    await ctx.route('**/*', async (route) => {
      const req = route.request(); const url = new URL(req.url()), ep = url.pathname, method = req.method();
      if (url.origin !== origin) { await route.abort(); return; }
      if (ep.endsWith('/avatar') || ep.endsWith('/thumbnail')) { await route.fulfill({ status: 404, body: '' }); return; }
      if (!ep.startsWith('/api/')) {
        const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
        const type = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream';
        await route.fulfill({ contentType: type, body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } }); return;
      }
      let data = [];
      let status = 200;
      if (method !== 'GET' && !ep.endsWith('/auth/refresh')) writes.push({ method, ep, body: req.postDataJSON?.() ?? null });
      if (ep.endsWith('/auth/refresh')) data = { accessToken: `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`, expiresAt: '2099-01-01T00:00:00Z', user };
      else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['org.manage', 'work.view', 'work.edit', 'work.create', 'reports.view', 'tasks.create', 'tasks.edit', 'projects.edit'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 3, activity: 3, documents: 3, people: 3, reports: 3, billing: 3, chat: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: {} } };
      else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
      else if (ep === '/api/v1/meet/time-proposals') data = proposals;
      else if (ep === '/api/v1/meet/time-proposals/tp1/log') { proposals = []; data = { id: 'te1', kind: 'meeting', minutes: 45, taskTitle: 'Bank sandbox sync', warning: null }; }
      else if (ep === '/api/v1/meet') data = feed();
      else if (ep === '/api/v1/meet/series') data = [];
      else if (ep === '/api/v1/meet/free-busy') data = { from: '', to: '', people: [{ userId: user.id, name: 'Asha Rao', busy: [], freeAtSlot: true }, { userId: ravi, name: 'Ravi Menon', busy: [], freeAtSlot: true }], everyoneFree: true, busyCount: 0 };
      else if (ep === `/api/v1/meet/p/${mid}/items`) data = { meetingRef: `p:${mid}`, seriesRef: `p:${mid}`, title: 'Bank sandbox sync', cadence: 'Weekly', recurrence: 'Every Mon', nextSession: iso('2026-11-09', '11:30'), previousSession: iso('2026-10-26', '11:30'),
        createdHere: [{ id: 'c1', key: 'AI-12', title: 'Draft merchant comms for v1.1 retry rules', owner: { id: user.id, name: 'Asha Rao' }, dueDate: '2026-11-06', status: 'Open', isOverdue: false, occurrenceStart: iso(day, '11:30') },
          { id: 'c2', key: 'AI-13', title: 'Deploy retry fix to staging', owner: { id: mira, name: 'Mira Okafor' }, dueDate: '2026-11-04', status: 'Open', isOverdue: false, occurrenceStart: iso(day, '11:30') }, ...created],
        openInSeries: 4 + created.length, projectId: pid, projectName: 'UPI AutoPay' };
      else if (ep === `/api/v1/meet/p/${mid}/capture`) { const b = req.postDataJSON(); created = [...created, { id: 'c3', key: 'AI-16', title: 'Confirm bank sandbox date', owner: { id: ravi, name: 'Ravi Menon' }, dueDate: '2026-11-06', status: 'Open', isOverdue: false, occurrenceStart: b.occurrenceStart }];
        status = 201; data = { item: { id: 'c3', key: 'AI-16', title: 'Confirm bank sandbox date' }, meetingRef: `p:${mid}`, seriesRef: `p:${mid}`, occurrenceStart: b.occurrenceStart }; }
      else if (ep === `/api/v1/meetings/${mid}`) data = meeting;
      else if (ep === `/api/v1/projects/${pid}/meetings/participants` || ep === '/api/v1/meetings/participants') data = meeting.participants;
      else if (ep === `/api/v1/projects/${pid}/meetings/schedule`) { status = 201; data = { ...meeting, title: req.postDataJSON().title }; }
      else if (ep === '/api/v1/teams') data = [{ id: 't1', name: 'AutoPay', description: null, memberCount: 3, projectCount: 1, lead: null }];
      else if (ep === '/api/v1/work-items') data = { items: url.searchParams.get('status') === 'closed' ? [] : items, offset: 0, limit: 50, hasMore: false };
      else if (ep === '/api/v1/work-items/w3') data = detail;
      else if (ep === '/api/v1/projects') data = { items: [{ id: pid, key: 'UPA', name: 'UPI AutoPay', status: 'Active', dueDate: '2026-11-21', priority: 'High' }], page: 1, pageSize: 50, totalItems: 1, totalPages: 1 };
      else if (ep === '/api/v1/inbox') data = { rows: [], counts: { all: 0, assigned: 0, decisions: 0, mentions: 0 }, later: 0 };
      else if (ep === '/api/v1/inbox/briefing') data = { count: 3, headline: '3 things need you.', reasons: [], sources: 'read your work', stats: { overdue: 1, dueToday: 1, decisions: 0, approvals: 0, mentions: 0, reminders: 0 } };
      else if (ep === '/api/v1/timeline') data = { from: url.searchParams.get('from'), to: url.searchParams.get('to'), timeZone: 'Asia/Kolkata', scope: 'me', generatedAt: NOW.toISOString(), events: [] };
      else if (ep === '/api/v1/dashboard') data = { counts: { myDueToday: 1, myCompletedToday: 0, myOpen: 4, myOverdue: 1, activeProjects: 1, completedProjects: 0, totalProjects: 1, openTasks: 4, overdueTasks: 1, members: 4, overallProgress: 40, myLoggedMinutesThisWeek: 0 }, myTasks: [], projects: [], activity: [], myWork: [] };
      else if (ep === '/api/v1/workload') data = { scope: 'Everyone', available: ['Everyone'], members: [], totals: { people: 3, open: 1, overdue: 0 } };
      else if (ep === '/api/v1/members' || ep === '/api/v1/workspace/members') data = [{ userId: user.id, displayName: 'Asha Rao', role: 'Owner', isActive: true }, { userId: ravi, displayName: 'Ravi Menon', role: 'Member', isActive: true }];
      else if (ep === '/api/v1/timer') data = null;
      else if (ep === '/api/v1/me/ui/mywork') data = { value: {} };
      else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
      else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ data }) });
    });
    return ctx;
  }

  async function page$(theme, width, height = 1000, opts = {}) {
    const ctx = await context(theme, width <= 430 ? { isMobile: true, hasTouch: true, ...opts } : opts);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${theme} ${width}: ${e.message}`));
    await page.setViewportSize({ width, height });
    return { ctx, page };
  }

  // ---------------------------------------------------------------- 1440 light: schedule from Aura, Today's prompt, My Work, capture
  let { ctx, page } = await page$('light', 1440);
  await page.goto(origin + '/preview-org/');
  const prompt = page.getByTestId('meeting-time-proposal').first();
  await prompt.waitFor({ timeout: 15000 });
  assert.match(await prompt.innerText(), /Log 45m to UPI AutoPay\?/);
  assert.match(await prompt.innerText(), /2 action items were assigned to you in this meeting/);
  assert.equal(writes.filter((w) => w.ep.includes('time-proposals')).length, 0, 'nothing is logged without the tap');
  await page.screenshot({ path: path.join(out, 'meet-log-light-1440.png'), animations: 'disabled' });
  await prompt.getByRole('button', { name: 'Log 45m' }).click();
  await page.waitForTimeout(300);
  assert.deepEqual(writes.filter((w) => w.ep.includes('time-proposals')).map((w) => w.ep), ['/api/v1/meet/time-proposals/tp1/log'], 'one Log, one entry');
  assert.equal(writes.find((w) => w.ep.endsWith('/log')).body.minutes, 45);
  checks.push('Today: "Log 45m to UPI AutoPay?" logs only on the tap');

  // The Aura chip reads the sentence into the sheet.
  const dock = page.getByTestId('aura-dock');
  await dock.locator('input').first().click();
  await dock.locator('input').first().fill('weekly sandbox sync with Ravi tomorrow 11:30 for 45m');
  await page.locator('[data-chip="meeting"]').click();
  const sheet = page.getByTestId('schedule-sheet');
  await sheet.waitFor({ timeout: 5000 });
  assert.match(await page.getByTestId('schedule-from-aura').innerText(), /From Aura: “weekly sandbox sync with Ravi tomorrow 11:30 for 45m”/);
  assert.equal(await sheet.getByLabel('Title', { exact: true }).inputValue(), 'Sandbox sync');
  await sheet.getByText('Ravi Menon').first().waitFor();
  assert.equal(await sheet.getByRole('radio', { name: 'Weekly' }).getAttribute('aria-checked'), 'true');
  assert.equal(await sheet.getByRole('radio', { name: '45m' }).getAttribute('aria-checked'), 'true');
  assert.equal(await sheet.getByLabel('Start', { exact: true }).inputValue(), '11:30');
  await sheet.getByLabel('Project', { exact: true }).selectOption(pid);
  await page.getByTestId('free-busy').getByText('Everyone free').waitFor();
  assert.match(await page.getByTestId('repeat-line').innerText(), /^Every Tue · until 21 Nov \(project due\)$/);
  await sheet.getByRole('button', { name: 'Review action items since last' }).click();
  assert.match(await sheet.getByRole('textbox', { name: 'Agenda' }).inputValue(), /Review action items since last/);
  await page.locator('.ms-where').getByText('logs time to UPI AutoPay').waitFor();
  await page.screenshot({ path: path.join(out, 'meet-schedule-light-1440.png'), animations: 'disabled' });
  await page.getByRole('dialog').getByRole('button', { name: 'Schedule', exact: true }).click();
  await page.getByTestId('meeting-ready').waitFor();
  const sent = writes.find((w) => w.ep.endsWith('/meetings/schedule')).body;
  assert.equal(sent.title, 'Sandbox sync');
  assert.deepEqual(sent.participantUserIds, [ravi]);
  assert.equal(sent.repeat.frequency, 'Weekly');
  assert.equal(sent.repeat.until, '2026-11-21');
  assert.equal(sent.video, 'inapp');
  assert.equal(new Date(sent.endTime) - new Date(sent.startTime), 45 * 60_000);
  checks.push('Aura chip → schedule sheet (title, Ravi, weekly until project due, 45m, everyone free) → one schedule POST');
  await page.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click();

  // My Work: today's meeting with Join and agenda, From tags, the From meetings chip, the item's From meeting card.
  await page.goto(origin + '/preview-org/work');
  const mw = page.getByTestId('my-work-meeting').first();
  await mw.waitFor({ timeout: 15000 });
  assert.match(await mw.innerText(), /Bank sandbox sync/);
  assert.match(await mw.innerText(), /Agenda · 1 Sandbox date status \(Mira\)/);
  assert.ok(await mw.getByRole('link', { name: 'Join' }).isVisible(), 'Join on today’s meeting');
  assert.ok(await page.getByTestId('my-work-meeting').filter({ hasText: 'Steering committee' }).count() === 1, 'this week’s meeting');
  assert.equal(await page.getByTestId('from-meeting-tag').count(), 2);
  await page.screenshot({ path: path.join(out, 'mywork-light-1440.png'), animations: 'disabled' });
  await page.getByTestId('from-meetings-chip').click();
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.mw-lists [data-task-id]').count(), 2, 'From meetings: only the two items from meetings');
  assert.equal(await page.getByTestId('my-work-meeting').count(), 0);
  checks.push('My Work: meetings in Today/This week with Join + agenda, ◆ From tags, From meetings chip');
  await page.goto(origin + '/preview-org/work?item=w3');
  const card = page.getByTestId('from-meeting-card');
  await card.waitFor({ timeout: 15000 });
  assert.match(await card.innerText(), /From meeting/i);
  assert.match(await card.innerText(), /Bank sandbox sync · Mon 2 Nov/);
  assert.match(await card.innerText(), /next review Mon 9 Nov/);
  await page.screenshot({ path: path.join(out, 'mywork-item-light-1440.png'), animations: 'disabled' });
  checks.push('Item detail: From meeting card with next review and cadence');

  // The meeting page: capture one line into a task with this meeting as its source.
  await page.goto(origin + `/preview-org/meetings?open=p:${mid}&at=${encodeURIComponent(iso(day, '11:30'))}`);
  const cap = page.getByTestId('meeting-capture');
  await cap.waitFor({ timeout: 15000 });
  const line = cap.getByRole('textbox').first();
  await line.fill('Confirm bank sandbox date @Ravi fri');
  await cap.locator('.mc-chips').getByText('Ravi Menon').waitFor();
  assert.match(await cap.locator('.mc-chips').innerText(), /Fri 6 Nov/);
  assert.match(await cap.locator('.mc-chips').innerText(), /Source: this meeting/);
  await page.screenshot({ path: path.join(out, 'meet-capture-light-1440.png'), animations: 'disabled' });
  await line.press('Enter');
  await cap.locator('.mc-list').getByText('Confirm bank sandbox date').waitFor();
  assert.equal(await line.inputValue(), '', 'the line is cleared for the next one');
  const capBody = writes.find((w) => w.ep.endsWith('/capture')).body;
  assert.equal(capBody.text, 'Confirm bank sandbox date @Ravi fri');
  assert.equal(capBody.assigneeId, ravi);
  assert.match(await cap.locator('.mc-side').innerText(), /5 open/);
  checks.push('Capture: "@Ravi fri" → chips, Enter creates it with this meeting as source, line stays for the next');
  await page.close(); await ctx.close();

  // ---------------------------------------------------------------- 1440 dark
  ({ ctx, page } = await page$('dark', 1440));
  await page.goto(origin + '/preview-org/work');
  await page.getByTestId('my-work-meeting').first().waitFor({ timeout: 15000 });
  await page.screenshot({ path: path.join(out, 'mywork-dark-1440.png'), animations: 'disabled' });
  await page.locator('button[aria-label^="Ask Aura"], [data-testid="aura-dock"] input').first().click().catch(() => {});
  await page.goto(origin + '/preview-org/work');
  await page.getByRole('button', { name: 'Schedule a meeting' }).first().click();
  await page.getByTestId('schedule-sheet').waitFor();
  await page.screenshot({ path: path.join(out, 'meet-schedule-dark-1440.png'), animations: 'disabled' });
  // Text stays readable in the dark theme (no dark-on-dark title).
  const color = await page.getByTestId('schedule-sheet').locator('.ms-title').evaluate((el) => getComputedStyle(el).color);
  assert.notEqual(color, 'rgb(29, 29, 31)', 'the title follows the dark theme');
  await page.close(); await ctx.close();
  checks.push('dark: My Work and the schedule sheet');

  // ---------------------------------------------------------------- 390 phone
  ({ ctx, page } = await page$('light', 390, 844));
  await page.goto(origin + '/preview-org/');
  await page.getByTestId('meeting-time-proposal').first().waitFor({ timeout: 15000 });
  assert.match(await page.getByTestId('meeting-time-proposal').first().innerText(), /Meeting ended · 12:15/i);
  await fitsPhone(page, 'today-phone', assert);
  await page.screenshot({ path: path.join(out, 'meet-log-phone-light-390.png'), animations: 'disabled' });
  await page.goto(origin + '/preview-org/work');
  await page.getByTestId('from-meetings-chip').waitFor({ timeout: 15000 });
  await fitsPhone(page, 'mywork-phone', assert);
  await page.screenshot({ path: path.join(out, 'mywork-phone-light-390.png'), animations: 'disabled' });
  await page.getByTestId('from-meetings-chip').click();
  await page.getByRole('button', { name: 'Schedule a meeting' }).first().click();
  await page.getByTestId('schedule-sheet').waitFor();
  await fitsPhone(page, 'schedule-phone', assert);
  await page.screenshot({ path: path.join(out, 'meet-schedule-phone-light-390.png'), animations: 'disabled' });
  await page.close(); await ctx.close();
  checks.push('phone: Today card, My Work, schedule sheet fit at 390');

  assert.deepEqual(errors, [], 'no page errors');
  console.log(`meetings connected UI OK (${checks.length} checks)\n- ${checks.join('\n- ')}\nScreenshots: ${out}`);
} finally {
  await browser.close();
}
