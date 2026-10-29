// Calendar editing: the Day panel lists everything on the chosen day from the one timeline; time entries are moved and resized by dragging
// (15-minute steps, with the stamp) and the change shows in Insights › Time's week grid, and a grid edit shows on the calendar; a drag over
// empty time logs time; a deadline flag dropped on a later day asks why; a meeting you organise is dragged to a new time and renamed; a
// reminder is dragged and marked done; a locked week refuses; overlapping blocks share the day in columns; dark; phone. Synthetic data only.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/calendar-edit-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Meera Lakshman', email: 'meera@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Lighthouse Works', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 3 };
const pid = '00000000-0000-0000-0000-000000000003';
// Wednesday 28 October 2026, 10:42 in Kolkata: the week is Mon 26 – Fri 30.
const today = '2026-10-28', NOW = new Date('2026-10-28T10:42:00+05:30');
const day = (n) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const mon = day(-2), tue = day(-1), thu = day(1), fri = day(2);
const at = (d, hm) => new Date(`${d}T${hm}:00+05:30`).toISOString();
const HR = 73;
const ids = { w1: '61000000-0000-0000-0000-000000000001', t1: '62000000-0000-0000-0000-000000000001', t3: '62000000-0000-0000-0000-000000000003', t4: '62000000-0000-0000-0000-000000000004',
  m1: '63000000-0000-0000-0000-000000000001', m2: '63000000-0000-0000-0000-000000000002', m3: '63000000-0000-0000-0000-000000000003' };

// ---- the records (the mock server keeps them, so a change made in one screen is what the next request returns)
let state;
function fresh() {
  let n = 0;
  const stamp = () => `st${++n}`;
  return {
    stamp,
    entries: [
      { id: 'te1', kind: 'work', workTaskId: ids.w1, taskId: null, taskKey: 'OPS-21', taskTitle: 'Lamp sensor outage', workDate: today, minutes: 90, startedAt: at(today, '09:00'), endedAt: at(today, '10:30'), note: 'Restarted the gateway', billable: false, locked: false, canEdit: true, stamp: stamp() },
      { id: 'te2', kind: 'task', workTaskId: null, taskId: ids.t1, taskKey: 'PAY-7', taskTitle: 'Harbour invoice export', workDate: today, minutes: 120, startedAt: null, endedAt: null, note: null, billable: true, locked: false, canEdit: true, stamp: stamp() },
      { id: 'te3', kind: 'task', workTaskId: null, taskId: ids.t1, taskKey: 'PAY-7', taskTitle: 'Harbour invoice export', workDate: tue, minutes: 60, startedAt: at(tue, '14:00'), endedAt: at(tue, '15:00'), note: null, billable: true, locked: true, canEdit: false, stamp: stamp() },
    ],
    meetings: [
      { id: ids.m1, kind: 'workspace', title: 'Pier lighting sync', start: at(today, '11:00'), end: at(today, '11:30'), provider: 'google', providerName: 'Google Meet', joinUrl: 'https://meet.google.com/abc-defg-hij', isOrganizer: false, canManage: false, organizerName: 'Ravi Menon', notetaker: 'off', projectId: null, projectName: null, description: null },
      { id: ids.m2, kind: 'project', title: 'Lamp design review', start: at(today, '15:00'), end: at(today, '16:00'), provider: 'ours', providerName: 'Project Tracker call', joinUrl: '/calls/room-7', isOrganizer: true, canManage: true, organizerName: user.displayName, notetaker: 'transcript', projectId: pid, projectName: 'Harbour Lights', description: '1. Colours\n2. Mounting' },
      { id: ids.m3, kind: 'workspace', title: 'Supplier call', start: at(today, '15:30'), end: at(today, '16:30'), provider: 'google', providerName: 'Google Meet', joinUrl: 'https://meet.google.com/xyz', isOrganizer: false, canManage: false, organizerName: 'Ravi Menon', notetaker: 'off', projectId: null, projectName: null, description: null },
    ],
    due: [
      { type: 'work', id: ids.w1, key: 'OPS-21', title: 'Lamp sensor outage', date: today, priority: 'Critical', status: 'InProgress', projectId: null, projectName: null, done: false },
      { type: 'task', id: ids.t1, key: 'PAY-7', title: 'Harbour invoice export', date: fri, priority: 'High', status: 'To do', projectId: pid, projectName: 'Harbour Lights', done: false },
      { type: 'task', id: ids.t3, key: 'PAY-9', title: 'Pole paint order', date: thu, priority: 'Medium', status: 'To do', projectId: pid, projectName: 'Harbour Lights', done: false },
      { type: 'task', id: ids.t4, key: 'PAY-11', title: 'Mounting bracket spec', date: tue, priority: 'High', status: 'In progress', projectId: pid, projectName: 'Harbour Lights', done: false },
    ],
    reminder: { id: 'r1', title: 'Call the bracket vendor', at: at(today, '16:30'), state: 'Scheduled' },
  };
}
const hOf = (iso) => { const d = new Date(new Date(iso).getTime() + 330 * 60e3); return d.getUTCHours() + d.getUTCMinutes() / 60; };
const entryDto = (e) => ({ id: e.id, taskId: e.taskId, taskKey: e.taskKey, taskTitle: e.taskTitle, projectId: e.kind === 'task' ? pid : null, user: { id: user.id, name: user.displayName }, workDate: e.workDate, minutes: e.minutes,
  note: e.note, isRunning: false, startedAt: e.startedAt, endedAt: e.endedAt, canEdit: e.canEdit, workTaskId: e.workTaskId, kind: e.kind, billable: e.billable, locked: e.locked, stamp: e.stamp });
const tev = (o) => ({ end: null, allDay: false, link: null, projectId: null, projectName: null, people: [], status: null, colour: '', key: null, approximated: false, overdue: false, priority: null,
  minutes: null, note: null, joinUrl: null, notes: false, userId: user.id, mode: null, running: false, ...o });
function timeline(from, to) {
  const s = state, ev = [];
  for (const m of s.meetings) ev.push(tev({ id: `meeting:${m.id}`, type: 'meeting', title: m.title, start: m.start, end: m.end, date: today, sourceType: m.kind === 'project' ? 'projectMeeting' : 'workspaceMeeting', sourceId: m.id,
    projectId: m.projectId, projectName: m.projectName, people: [m.organizerName, user.displayName], status: 'Scheduled', joinUrl: m.joinUrl, notes: m.notetaker !== 'off' }));
  for (const d of s.due.filter((x) => !x.done)) ev.push(tev({ id: `due:${d.type}:${d.id}`, type: 'due', title: d.title, key: d.key, allDay: true, start: at(d.date, '00:00'), date: d.date, sourceType: d.type, sourceId: d.id,
    projectId: d.projectId, projectName: d.projectName, status: d.status, priority: d.priority, overdue: d.date < today, people: ['Arjun Pillai'] }));
  ev.push(tev({ id: 'done:work:wt5', type: 'done', title: 'Replace the pier fuse', key: 'WT-5', start: at(today, '10:05'), date: today, sourceType: 'work', sourceId: 'wt5', status: 'Completed' }));
  ev.push(tev({ id: 'call:c1', type: 'call', title: 'Bank sandbox call', start: at(today, '12:30'), end: at(today, '12:50'), date: today, sourceType: 'call', sourceId: 'c1', people: ['Ravi Menon', user.displayName] }));
  // a short call that already happened (10:31-10:40), under the typed-in time that ends at now: that time is drawn as the slim lane
  ev.push(tev({ id: 'call:c2', type: 'call', title: 'Quick vendor callback', start: at(today, '10:31'), end: at(today, '10:40'), date: today, sourceType: 'call', sourceId: 'c2', people: ['Ravi Menon', user.displayName] }));
  ev.push(tev({ id: 'attendance:a1', type: 'attendance', title: 'Office', start: at(today, '09:12'), date: today, sourceType: 'attendance', sourceId: 'a1', status: 'in', running: true }));
  const r = s.reminder;
  ev.push(tev({ id: `reminder:${r.id}`, type: 'reminder', title: r.title, start: r.at, date: new Date(new Date(r.at).getTime() + 330 * 60e3).toISOString().slice(0, 10), sourceType: 'reminder', sourceId: r.id, status: r.state.toLowerCase() }));
  // time entries: placed ones at their hours; typed-in minutes from 10:30 - but, as the server does, never past now (ending now instead)
  for (const e of s.entries) {
    const placed = e.startedAt && e.endedAt;
    let start = placed ? e.startedAt : at(e.workDate, '10:30'), end = placed ? e.endedAt : new Date(Date.parse(at(e.workDate, '10:30')) + e.minutes * 60e3).toISOString();
    if (!placed && Date.parse(end) > NOW.getTime()) { end = NOW.toISOString(); start = new Date(NOW.getTime() - e.minutes * 60e3).toISOString(); }
    ev.push(tev({ id: `time:${e.id}`, type: 'time', title: e.taskTitle, start, end, date: e.workDate, sourceType: 'timeEntry', sourceId: e.id, minutes: e.minutes, approximated: !placed, note: e.note, projectId: e.kind === 'task' ? pid : null, projectName: e.kind === 'task' ? 'Harbour Lights' : null }));
  }
  return { from, to, timeZone: 'Asia/Kolkata', scope: 'me', generatedAt: NOW.toISOString(), events: ev.filter((t) => t.date >= from && t.date <= to) };
}
const feed = () => ({ from: mon, to: day(5), truncated: false, items: state.meetings.map((m) => ({ ref: `${m.kind === 'project' ? 'p' : 'w'}:${m.id}`, kind: m.kind, id: m.id, title: m.title, description: m.description,
  start: m.start, end: m.end, timeZone: 'Asia/Kolkata', projectId: m.projectId, projectName: m.projectName, projectKey: m.projectId ? 'PAY' : null, provider: m.provider, providerName: m.providerName, joinUrl: m.joinUrl, calendarUrl: null,
  isScrum: false, recurring: false, sessionsLeft: null, notetaker: m.notetaker, myRsvp: m.isOrganizer ? 'Organizer' : 'NeedsAction', isOrganizer: m.isOrganizer, canManage: m.canManage, organizerName: m.organizerName,
  invited: 2, accepted: 1, declined: 0, status: 'Scheduled', notes: null, live: false })) });
const gridDays = () => [0, 1, 2, 3, 4, 5, 6].map((i) => { const d = day(i - 2); return { date: d, minutes: state.entries.filter((e) => e.workDate === d).reduce((n, e) => n + e.minutes, 0), targetMinutes: i < 5 ? 480 : 0, weekend: i >= 5, leave: false, leaveNote: null, future: d > today, meetings: 0, meetingMinutes: 0 }; });
function grid() {
  const rows = new Map();
  for (const e of state.entries) {
    const k = `${e.kind}:${e.kind === 'work' ? e.workTaskId : e.taskId}`;
    if (!rows.has(k)) rows.set(k, { kind: e.kind, targetId: e.kind === 'work' ? e.workTaskId : e.taskId, key: e.taskKey, title: e.taskTitle, projectId: e.kind === 'task' ? pid : null, projectName: e.kind === 'task' ? 'Harbour Lights' : null, billable: e.billable, cells: [], totalMinutes: 0 });
  }
  for (const r of rows.values()) {
    r.cells = gridDays().map((d) => { const es = state.entries.filter((e) => e.workDate === d.date && `${e.kind}:${e.kind === 'work' ? e.workTaskId : e.taskId}` === `${r.kind}:${r.targetId}`); return { date: d.date, minutes: es.reduce((n, e) => n + e.minutes, 0), entries: es.length, running: false, note: null }; });
    r.totalMinutes = r.cells.reduce((n, c) => n + c.minutes, 0);
  }
  const total = state.entries.reduce((n, e) => n + e.minutes, 0);
  return { weekStart: mon, weekEnd: day(4), user: { id: user.id, name: user.displayName }, mine: true, editable: true, locked: false, status: 'NotSubmitted', days: gridDays(), rows: [...rows.values()], suggestions: [],
    totalMinutes: total, billableMinutes: 0, targetMinutes: 2400, overtimeMinutes: 0, missingDays: 0, running: null };
}
const task = (d) => ({ id: d.id, projectId: pid, projectKey: 'PAY', projectName: 'Harbour Lights', number: 11, key: d.key, title: d.title, description: null, statusId: 's-todo', statusName: 'To do', statusCategory: 'Todo', statusColor: '#8e8e93', priority: d.priority,
  assignee: { id: user.id, name: user.displayName }, reporter: null, startDate: null, dueDate: d.date, estimatedHours: 4, actualHours: 1, position: 0, parentTaskId: null, subtaskTotal: 0, subtaskDone: 0, commentCount: 0, labels: [],
  completedAt: null, createdAt: at(mon, '09:00'), updatedAt: at(mon, '09:00'), version: 4, isOverdue: false, milestoneId: null, milestoneName: null, dependsOnCount: 0, blocksCount: 0, isBlocked: false, sprintId: null, sprintName: null, checklistTotal: 0, checklistDone: 0 });

const errors = [], checks = [], writes = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const fail = (status, code, message) => ({ status, body: JSON.stringify({ errors: [{ code, message }] }) });
try {
  async function context(theme) {
    state = fresh();
    const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
    await ctx.clock.setFixedTime(NOW);
    await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); window.open = () => null; }, theme);
    await ctx.route('**/*', async (route) => {
      const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
      if (url.origin !== origin) { await route.abort(); return; }
      if (ep.endsWith('/avatar')) { await route.fulfill({ status: 404, body: '' }); return; }
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
        if (e.locked) { const f = fail(409, 'TIMESHEET_LOCKED', 'The week of 26 Oct has been submitted for approval. Withdraw it first to change its time.'); await route.fulfill({ status: f.status, contentType: 'application/json', body: f.body }); return; }
        if (body.stamp && body.stamp !== e.stamp) { const f = fail(409, 'TIME_ENTRY_CHANGED', 'This entry was changed somewhere else.'); await route.fulfill({ status: f.status, contentType: 'application/json', body: f.body }); return; }
        if (body.startedAt) { e.startedAt = body.startedAt; e.endedAt = body.endedAt; e.minutes = Math.round((Date.parse(body.endedAt) - Date.parse(body.startedAt)) / 60e3); }
        else { e.minutes = body.minutes; if (e.startedAt) e.endedAt = new Date(Date.parse(e.startedAt) + e.minutes * 60e3).toISOString(); }
        e.workDate = body.workDate; e.note = body.note ?? null; if (body.billable != null) e.billable = body.billable; e.stamp = state.stamp();
        data = entryDto(e);
      } else if (method === 'POST' && (/^\/api\/v1\/(tasks|work-tasks)\/[\w-]+\/time$/.test(ep))) {
        const work = ep.includes('/work-tasks/'), tid = ep.split('/')[4];
        const src = state.entries.find((x) => (work ? x.workTaskId : x.taskId) === tid) ?? state.entries[0];
        const e = { id: `te${state.entries.length + 1}`, kind: work ? 'work' : 'task', workTaskId: work ? tid : null, taskId: work ? null : tid, taskKey: src.taskKey, taskTitle: src.taskTitle, workDate: body.workDate, minutes: body.startedAt ? Math.round((Date.parse(body.endedAt) - Date.parse(body.startedAt)) / 60e3) : body.minutes,
          startedAt: body.startedAt ?? null, endedAt: body.endedAt ?? null, note: body.note ?? null, billable: !!body.billable, locked: false, canEdit: true, stamp: state.stamp() };
        state.entries.push(e); data = entryDto(e);
      } else if (ep === '/api/v1/time/grid' && method === 'PUT') {
        for (const c of body.cells) { const e = state.entries.find((x) => x.workDate === c.date && (c.kind === 'work' ? x.workTaskId : x.taskId) === c.targetId); if (e) { e.minutes = c.minutes; if (e.startedAt) e.endedAt = new Date(Date.parse(e.startedAt) + c.minutes * 60e3).toISOString(); e.stamp = state.stamp(); } }
        data = { grid: grid(), saved: body.cells.length, errors: [] };
      } else if (/^\/api\/v1\/meetings\/[\w-]+\/reschedule$/.test(ep)) {
        const m = state.meetings.find((x) => x.id === ep.split('/')[4]); m.start = body.startTime; m.end = body.endTime; data = {};
      } else if (/^\/api\/v1\/meetings\/[\w-]+$/.test(ep) && method === 'PATCH') {
        const m = state.meetings.find((x) => x.id === ep.split('/')[4]); m.title = body.title; m.description = body.description; data = { id: m.id, title: m.title };
      } else if (/^\/api\/v1\/tasks\/[\w-]+$/.test(ep) && method === 'PUT') {
        const d = state.due.find((x) => x.id === ep.split('/')[4]); d.date = body.dueDate; data = task(d);
      } else if (/^\/api\/v1\/work-tasks\/[\w-]+\/status$/.test(ep)) {
        state.due.find((x) => x.id === ep.split('/')[4]).done = true; data = {};
      } else if (ep === '/api/v1/reminders/r1' && method === 'PUT') {
        state.reminder.at = new Date(`${body.when.at}:00+05:30`).toISOString(); data = {};
      } else if (ep === '/api/v1/reminders/r1/done') { state.reminder.state = 'Done'; data = {}; }
      else if (method !== 'GET' && !ep.endsWith('/auth/refresh')) data = {};
      else if (ep.endsWith('/auth/refresh')) data = { accessToken: `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`, expiresAt: '2099-01-01T00:00:00Z', user };
      else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['org.manage', 'work.view', 'work.edit', 'work.create', 'reports.view'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 3, activity: 3, documents: 3, people: 3, reports: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: {}, reportCount: 0 } };
      else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
      else if (ep === '/api/v1/timeline') data = timeline(url.searchParams.get('from'), url.searchParams.get('to'));
      else if (ep === '/api/v1/meet') data = feed();
      else if (ep === '/api/v1/reminders') { const r = state.reminder; const x = { id: r.id, source: 'Personal', state: r.state, title: r.title, note: null, targetType: 'None', targetId: null, timeZone: 'Asia/Kolkata', recurrence: null, onlyIfOpen: false, exact: false, canEdit: true, nextFireAt: r.at };
        data = { open: [x], completed: [], sent: [], counts: { now: 0, today: 1, upcoming: 0, completed: 0 }, limits: { open: 100, recurring: 10, openUsed: 1, recurringUsed: 0 } }; }
      else if (ep === '/api/v1/time') { const es = state.entries.filter((e) => (!url.searchParams.get('from') || e.workDate >= url.searchParams.get('from')) && (!url.searchParams.get('to') || e.workDate <= url.searchParams.get('to')));
        data = { from: mon, to: day(6), user: { id: user.id, name: user.displayName }, entries: es.map(entryDto), totalMinutes: es.reduce((n, e) => n + e.minutes, 0), byDay: [], billableMinutes: 0 }; }
      else if (ep === '/api/v1/time/grid') data = grid();
      else if (ep === '/api/v1/time/week') data = { weekStart: mon, weekEnd: day(6), userId: user.id, status: 'NotSubmitted', totalMinutes: 0, billableMinutes: 0, note: null, submittedAt: null, reviewer: null, reviewedAt: null, reviewNote: null, locked: false, canSubmit: true, canWithdraw: false, canReview: false, days: [] };
      else if (ep === '/api/v1/time/grid/draft') data = { weekStart: mon, cells: [], days: [] };
      else if (ep === '/api/v1/time/insights') data = null;
      else if (/^\/api\/v1\/tasks\/[\w-]+$/.test(ep)) { const d = state.due.find((x) => x.id === ep.split('/')[4]); data = d ? { task: task(d), subtasks: [] } : null; }
      else if (ep === `/api/v1/projects/${pid}`) data = { project: { id: pid, name: 'Harbour Lights' }, statuses: [{ id: 's-todo', name: 'To do', category: 'Todo' }, { id: 's-done', name: 'Done', category: 'Done' }], stages: [], members: [] };
      else if (ep.endsWith('/workspace/members')) data = [{ userId: user.id, displayName: user.displayName, email: user.email, role: 'Owner' }];
      else if (ep === '/api/v1/projects' || ep === '/api/v1/work-tasks') data = { items: [], page: 1, totalPages: 0, totalItems: 0 };
      else if (ep === '/api/v1/timer') data = null;
      else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
      else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
      else if (ep === '/api/v1/calendar') data = [];
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
    });
    return ctx;
  }
  let page;
  async function open(ctx, width, height = 1000) {
    page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width, height });
    await page.goto(origin + '/preview-org/calendar');
    await page.locator('[data-testid="week-planner"]').waitFor({ timeout: 15000 });
    await page.locator('[data-type="time"]').first().waitFor();
    await page.locator('[data-testid="day-panel"]').waitFor();
  }
  const block = (type, text) => page.locator(`[data-type="${type}"].wp-e, .wp-rem[data-type="${type}"]`).filter({ hasText: text }).first();
  const panel = () => page.locator('[data-testid="day-panel"]');
  const scrollTo = async (h) => { await page.locator('[data-testid="wp-scroll"]').evaluate((el, y) => { el.scrollTop = y; }, h * HR - 10); await page.waitForTimeout(100); };
  async function drag(loc, dx, dy, where = 'center') {
    const b = await loc.boundingBox();
    const x = b.x + b.width / 2, y = where === 'bottom' ? b.y + b.height - 2 : where === 'top' ? b.y + 2 : b.y + Math.min(b.height / 2, 14);
    await page.mouse.move(x, y); await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(x + (dx * i) / 6, y + (dy * i) / 6);
    await page.mouse.up(); await page.waitForTimeout(250);
  }
  const lastWrite = (pred) => [...writes].reverse().find(pred);
  async function shot(name) { await page.waitForTimeout(250); await page.screenshot({ path: path.join(out, name + '.png'), animations: 'disabled' }); checks.push(name); }

  // ---------------------------------------------------------------- 1440, light
  let ctx = await context('light');
  await open(ctx, 1440);
  // The Day panel: everything on today from the same timeline the grid draws.
  const p = panel();
  for (const s of ['Now and next', 'Meetings and calls', 'Work due', 'Done', 'Logged time', 'Reminders', 'Attendance']) assert.ok(await p.getByRole('region', { name: s }).count() + await p.locator(`section[aria-label="${s}"]`).count() > 0, `the Day panel has ${s}`);
  const pt = await p.innerText();
  for (const t of ['Pier lighting sync', 'Lamp design review', 'Supplier call', 'Bank sandbox call', 'OPS-21', 'PAY-11', 'WT-5', 'finished 10:05', 'Lamp sensor outage', 'Harbour invoice export', 'Call the bracket vendor', 'Office']) assert.ok(pt.includes(t), `the Day panel lists ${t}`);
  assert.match(pt, /overdue/, 'overdue work first'); assert.match(pt, /3h 30m of 8h/, 'logged against capacity');
  assert.ok(pt.indexOf('PAY-11') < pt.indexOf('OPS-21'), 'overdue before due today');
  assert.equal(await p.getByTestId('day-empty').count(), 0, 'no empty state on a full day');
  await shot('day-panel-1440');
  checks.push('panel: all types');

  // Overlap: the two meetings at 15:00 share the column; logged time beside a meeting is packed beside it (never under its text); approximate time is marked.
  const col = page.locator(`.wp-col[data-day="${today}"]`);
  const cw = (await col.boundingBox()).width;
  const a = await block('meeting', 'Lamp design review').boundingBox(), b2 = await block('meeting', 'Supplier call').boundingBox();
  assert.ok(a.width < cw * .6 && b2.width < cw * .6 && Math.abs(a.x - b2.x) > 10, `overlapping meetings in columns (${a.width}/${b2.width} of ${cw})`);
  const te2 = col.locator('[data-type="time"].ap');
  {
    // Every timed block of the day is packed: no two bounding boxes in the column intersect (the logged entry sits beside the meeting it overlaps).
    const bx = await col.locator('.wp-e:not(.wp-visit), .wp-rem, .wp-done').evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { t: (el.getAttribute('aria-label') ?? el.textContent ?? '').slice(0, 40), x: r.x, y: r.y, r: r.right, b: r.bottom }; }));
    for (let i = 0; i < bx.length; i++) for (let j = i + 1; j < bx.length; j++) {
      const p = bx[i], q = bx[j], ox = Math.min(p.r, q.r) - Math.max(p.x, q.x), oy = Math.min(p.b, q.b) - Math.max(p.y, q.y);
      assert.ok(ox <= 1 || oy <= 1, `"${p.t}" and "${q.t}" overlap on the grid (${ox.toFixed(1)} x ${oy.toFixed(1)})`);
    }
    assert.match(await te2.getAttribute('class'), /narrow/, 'logged time beside a meeting or call shares the column');
  }
  assert.match(await te2.getAttribute('aria-label'), /approximate/);
  assert.match(await block('meeting', 'Lamp design review').getAttribute('title'), /Lamp design review/, 'the full title on hover');
  checks.push('overlap columns');

  // Time entry: drag the top edge 30 minutes earlier (resize), then the block 30 minutes earlier (move): each saves start and end with the stamp.
  // (Its end stays before now, 10:42: logged time is for time that has happened.)
  await scrollTo(7);
  await drag(block('time', 'Lamp sensor outage'), 0, -HR / 2, 'top');
  let w = lastWrite((x) => x.method === 'PUT' && x.ep === '/api/v1/time/te1');
  assert.ok(w, 'resize saves the entry');
  assert.equal(w.body.startedAt, at(today, '08:30')); assert.equal(w.body.endedAt, at(today, '10:30')); assert.equal(w.body.minutes, 120); assert.equal(w.body.stamp, 'st1');
  await page.locator('.talk-toast', { hasText: '2h' }).waitFor();
  await page.waitForTimeout(400);
  await drag(block('time', 'Lamp sensor outage'), 0, -HR / 2);
  w = lastWrite((x) => x.method === 'PUT' && x.ep === '/api/v1/time/te1');
  assert.equal(w.body.startedAt, at(today, '08:00')); assert.equal(w.body.endedAt, at(today, '10:00')); assert.equal(w.body.stamp, 'st4', 'the second edit carries the new stamp');
  await page.waitForTimeout(400);
  const tb = await block('time', 'Lamp sensor outage').boundingBox();
  assert.ok(Math.abs(tb.height - (2 * HR - 2)) < 3, `the block is 2 hours tall (${tb.height})`);
  // Dragging logged time into the future is refused, and nothing is sent.
  const n0 = writes.length;
  await drag(block('time', 'Lamp sensor outage'), 0, HR * 2);
  assert.equal(writes.length, n0, 'no write for time that has not happened');
  await page.getByText('Logged time is for time that has happened').first().waitFor();
  checks.push('time: resize + move');

  // Click it: the edit form opens in the Day panel; change the note and save.
  await block('time', 'Lamp sensor outage').click();
  const card = page.locator('[data-testid="event-detail"]');
  await card.waitFor();
  assert.equal(await card.evaluate((el) => !!el.closest('[data-testid="day-panel"]')), true, 'the card opens in the Day panel on a wide window');
  await card.getByLabel('Note').fill('Gateway restarted twice');
  await card.getByTestId('ed-save').click();
  await card.waitFor({ state: 'detached' });
  w = lastWrite((x) => x.method === 'PUT' && x.ep === '/api/v1/time/te1');
  assert.equal(w.body.note, 'Gateway restarted twice'); assert.equal(w.body.minutes, 120);
  checks.push('time: edit form');

  // The same entry in Insights › Time: the week grid shows 2:00; change it there to 2:30 and the calendar block grows.
  await page.goto(origin + '/preview-org/insights?tab=time');
  const cell = page.getByLabel(/^OPS-21 on .*28/);
  await cell.waitFor({ timeout: 15000 }).catch(async (e) => { await page.screenshot({ path: path.join(out, 'debug.png') }); throw e; });
  assert.equal(await cell.inputValue(), '2:00', 'Insights › Time shows the calendar edit');
  await cell.fill('2:30'); await cell.press('Tab');
  await page.waitForFunction(() => true); await page.waitForTimeout(1500);
  assert.ok(writes.some((x) => x.method === 'PUT' && x.ep === '/api/v1/time/grid'), 'grid saved');
  await page.goBack();
  await page.locator('[data-testid="week-planner"]').waitFor();
  await page.waitForTimeout(800);
  const tb2 = await block('time', 'Lamp sensor outage').boundingBox();
  assert.ok(Math.abs(tb2.height - (2.5 * HR - 2)) < 3, `the grid edit shows on the calendar (${tb2.height})`);
  assert.match(await block('time', 'Lamp sensor outage').innerText(), /8:00 – 10:30/);
  checks.push('time: calendar <-> week grid');

  // Create by dragging over empty time on Tuesday 10:00–11:00: Log time.
  await scrollTo(9);
  const tcol = await page.locator(`.wp-col[data-day="${tue}"]`).boundingBox();
  const y10 = tcol.y + 10 * HR + 2;
  await page.mouse.move(tcol.x + tcol.width / 2, y10); await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(tcol.x + tcol.width / 2, y10 + (HR - 4) * i / 6);
  await page.mouse.up();
  await card.waitFor();
  assert.equal(await card.getAttribute('data-kind'), 'create');
  assert.match(await page.locator('[data-testid="day-panel"] .dp-hd h2').innerText(), /Tue/);
  await shot('create-chooser-1440');
  await card.getByLabel('Work item').selectOption({ label: /OPS-21/ }).catch(async () => { const v = await card.getByLabel('Work item').locator('option', { hasText: 'OPS-21' }).getAttribute('value'); await card.getByLabel('Work item').selectOption(v); });
  await card.getByTestId('ed-save').click();
  await card.waitFor({ state: 'detached' });
  w = lastWrite((x) => x.method === 'POST' && x.ep === `/api/v1/work-tasks/${ids.w1}/time`);
  assert.ok(w, 'logged on the work item'); assert.equal(w.body.startedAt, at(tue, '10:00')); assert.equal(w.body.endedAt, at(tue, '11:00')); assert.equal(w.body.workDate, tue);
  await page.locator(`.wp-col[data-day="${tue}"] [data-type="time"]`, { hasText: 'Lamp sensor outage' }).waitFor();
  checks.push('create by drag: log time');

  // Locked week: the entry cannot be dragged and says why.
  const locked = page.locator(`.wp-col[data-day="${tue}"] [data-type="time"]`, { hasText: 'Harbour invoice export' });
  assert.match(await locked.getAttribute('title'), /submitted for approval or approved/);
  const before = writes.length;
  await drag(locked, 0, HR);
  assert.equal(writes.filter((x) => x.ep === '/api/v1/time/te3').length, 0, 'a locked entry is never sent'); void before;
  await locked.click(); await card.waitFor();
  assert.match(await card.getByTestId('ed-lock').innerText(), /Withdraw it on the timesheet/);
  await page.keyboard.press('Escape'); await card.waitFor({ state: 'detached' });
  checks.push('locked week refuses');

  // A deadline flag dropped on a later day asks why, then moves the date with the reason.
  const flag = page.locator(`.wp-allday-d[data-day="${tue}"] .wp-flag`);
  const fb = await flag.boundingBox(), thuH = await page.locator(`.wp-dh[data-day="${thu}"]`).boundingBox();
  await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2); await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(fb.x + (thuH.x + thuH.width / 2 - fb.x) * i / 8, fb.y + 10);
  await page.mouse.up();
  const ask = page.getByRole('dialog', { name: 'Why it needs more time' });
  await ask.waitFor();
  await shot('due-reason-1440');
  await ask.getByLabel('Reason').fill('Bracket supplier is out of stock');
  await ask.getByRole('button', { name: 'Move date' }).click();
  await ask.waitFor({ state: 'detached' });
  for (let i = 0; i < 40 && !lastWrite((x) => x.method === 'PUT' && x.ep === `/api/v1/tasks/${ids.t4}`); i++) await page.waitForTimeout(100);
  w = lastWrite((x) => x.method === 'PUT' && x.ep === `/api/v1/tasks/${ids.t4}`);
  assert.equal(w.body.dueDate, thu); assert.equal(w.body.dueDateReason, 'Bracket supplier is out of stock'); assert.equal(w.body.version, 4);
  checks.push('due date: drag with reason');

  // A meeting I organise: drag 30 minutes later (reschedule), then rename it.
  await scrollTo(13);
  await drag(block('meeting', 'Lamp design review'), 0, HR / 2);
  w = lastWrite((x) => x.ep === `/api/v1/meetings/${ids.m2}/reschedule`);
  assert.ok(w, 'reschedule sent'); assert.equal(w.body.startTime, at(today, '15:30')); assert.equal(w.body.endTime, at(today, '16:30'));
  await page.waitForTimeout(500);
  await block('meeting', 'Lamp design review').click(); await card.waitFor();
  await card.getByTestId('ed-edit-meeting').click();
  await card.getByLabel('Meeting title').fill('Lamp design review · final');
  await card.getByRole('button', { name: 'Save' }).click();
  await card.waitFor({ state: 'detached' });
  w = lastWrite((x) => x.method === 'PATCH' && x.ep === `/api/v1/meetings/${ids.m2}`);
  assert.equal(w.body.title, 'Lamp design review · final');
  // Someone else's meeting cannot be dragged.
  assert.match(await block('meeting', 'Supplier call').getAttribute('title'), /Only the organiser/);
  checks.push('meeting: reschedule + rename');

  // A reminder: drag an hour later, then mark it done from the Day panel.
  await drag(page.locator('.wp-rem', { hasText: 'Call the bracket vendor' }), 0, HR);
  w = lastWrite((x) => x.method === 'PUT' && x.ep === '/api/v1/reminders/r1');
  assert.equal(w?.body.when.at, `${today}T17:30`);
  await page.waitForTimeout(400);
  await panel().getByRole('region', { name: 'Reminders' }).getByRole('button', { name: 'Done' }).click();
  await page.waitForTimeout(300);
  assert.ok(writes.some((x) => x.ep === '/api/v1/reminders/r1/done'), 'reminder done');
  // Work due completed from the panel.
  await panel().getByRole('button', { name: 'Complete OPS-21' }).click();
  await page.waitForTimeout(300);
  assert.ok(writes.some((x) => x.ep === `/api/v1/work-tasks/${ids.w1}/status` && x.body.status === 'Completed'), 'completed from the panel');
  checks.push('reminder + complete');

  // A day header chooses the Day panel's day; an empty day says so.
  await page.locator(`.wp-dh[data-day="${mon}"] .wp-dh-pick`).click();
  await panel().getByText('Nothing on Monday 26 October.').waitFor();
  checks.push('day header selects day');
  await page.locator(`.wp-dh[data-day="${today}"] .wp-dh-pick`).click();
  await shot('calendar-edit-1440');
  await page.close(); await ctx.close();

  // ---------------------------------------------------------------- dark
  ctx = await context('dark');
  await open(ctx, 1440);
  const bg = await panel().evaluate((el) => getComputedStyle(el).backgroundColor);
  const [r, g, bb] = bg.match(/\d+(\.\d+)?/g).map(Number);
  assert.ok(r + g + bb < 200, `the Day panel is dark (${bg})`);
  await block('time', 'Lamp sensor outage').click(); await page.locator('[data-testid="event-detail"]').waitFor();
  await shot('calendar-edit-dark-1440');
  await page.close(); await ctx.close();

  // ---------------------------------------------------------------- phone
  ctx = await context('light');
  await open(ctx, 390, 844);
  await fitsPhone(page, 'Calendar day', assert);
  await shot('calendar-day-390');
  await panel().scrollIntoViewIfNeeded();
  await fitsPhone(page, 'Day panel', assert);
  await page.screenshot({ path: path.join(out, 'day-panel-390.png'), fullPage: true }); checks.push('day-panel-390');
  await block('time', 'Lamp sensor outage').click();
  const sheet = page.locator('[data-testid="event-detail"]'); await sheet.waitFor(); await page.waitForTimeout(450);
  assert.match(await sheet.getAttribute('class'), /ed-sheet/, 'a bottom sheet on a phone');
  await sheet.getByTestId('ed-time-form').waitFor();
  await shot('time-sheet-390');
  await page.close(); await ctx.close();

  assert.deepEqual(errors, [], 'no page errors');
  console.log(JSON.stringify({ ok: true, checks, out }, null, 1));
} finally { await browser.close(); }
