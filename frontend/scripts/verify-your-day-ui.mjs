// "Your day" at fixed clock times (09:00, 10:29, 10:35, 14:00, 18:40) with a suggested focus block, time logged as "2h" (saved by an older
// server to end in the future), a date-only deadline and a check-in at 09:31:
//  - the focus block does not move between 10:29 and 10:35 (refresh), and reads "Focus now" once it has started;
//  - no logged block is drawn past the now line, and "logged" counts only time up to now;
//  - no two labels overlap (bounding boxes); the deadline sits at the shift's end, "by end of day";
//  - the check-in is on the timeline; the banner sums the day up instead of repeating Needs you;
//  - Today's free time equals the Calendar's day panel.
// Synthetic data only.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { cutOff } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/your-day-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Tara Menon', email: 'tara@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 3 };
const pid = '00000000-0000-0000-0000-000000000003';
// Thursday 29 October 2026 in Kolkata.
const today = '2026-10-29';
const at = (hm) => new Date(`${today}T${hm}:00+05:30`);
const iso = (hm) => at(hm).toISOString();
const g = (n) => `72000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`;
const tev = (o) => ({ end: null, allDay: false, link: null, projectId: null, projectName: null, people: [], status: null, colour: '', key: null, approximated: false, overdue: false, priority: null,
  minutes: null, note: null, joinUrl: null, notes: false, userId: user.id, mode: null, running: false, date: today, ...o });

/** What the server knows at a given moment: the check-in from 09:31, the "2h" logged at 10:29 (saved as 09:31-11:31 by the old server). */
function events(now) {
  const list = [
    tev({ id: `meeting:${g(1)}:x`, type: 'meeting', title: 'Release sync with the platform team', start: iso('12:00'), end: iso('12:30'), sourceType: 'workspaceMeeting', sourceId: g(1), status: 'Scheduled' }),
    tev({ id: `meeting:${g(2)}:x`, type: 'meeting', title: 'Vendor call', start: iso('12:15'), end: iso('12:45'), sourceType: 'workspaceMeeting', sourceId: g(2), status: 'Scheduled' }),
    tev({ id: `due:task:${g(10)}`, type: 'due', title: 'Rotate the gateway keys', key: 'INFRA-7', allDay: true, start: `${today}T00:00:00+05:30`, sourceType: 'task', sourceId: g(10), status: 'In progress', priority: 'High', projectId: pid, projectName: 'Infra Upgrade', link: `/work?item=${g(10)}` }),
    tev({ id: `reminder:${g(12)}`, type: 'reminder', title: 'Send the patch notes', start: iso('16:00'), sourceType: 'reminder', sourceId: g(12), status: 'scheduled' }),
    tev({ id: `reminder:${g(13)}`, type: 'reminder', title: 'Check the backup job', start: iso('16:10'), sourceType: 'reminder', sourceId: g(13), status: 'scheduled' }),
  ];
  if (now >= at('09:31')) list.push(tev({ id: `attendance:${g(14)}`, type: 'attendance', title: 'Office', start: iso('09:31'), sourceType: 'attendance', sourceId: g(14), status: 'in', mode: 'Office', running: true }));
  if (now >= at('10:29')) list.push(tev({ id: `time:${g(3)}`, type: 'time', title: 'Rotate the gateway keys', start: iso('09:31'), end: iso('11:31'), sourceType: 'timeEntry', sourceId: g(3), minutes: 120, projectId: pid, projectName: 'Infra Upgrade' }));
  return list;
}

const errors = [], checks = [];
let NOW = at('09:00');
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
try {
  async function context(theme) {
    const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
    await ctx.clock.setFixedTime(NOW);
    await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); }, theme);
    await ctx.route('**/*', async (route) => {
      const url = new URL(route.request().url()), ep = url.pathname, method = route.request().method();
      if (url.origin !== origin) { await route.abort(); return; }
      if (ep.endsWith('/avatar') || ep.endsWith('/thumbnail')) { await route.fulfill({ status: 404, body: '' }); return; }
      if (!ep.startsWith('/api/')) {
        const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
        const type = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream';
        await route.fulfill({ contentType: type, body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } }); return;
      }
      assert.ok(method === 'GET' || ep.endsWith('/auth/refresh'), `Unexpected write: ${method} ${ep}`);
      let data = [];
      if (ep === '/api/v1/timeline') {
        const from = url.searchParams.get('from'), to = url.searchParams.get('to');
        data = { from, to, timeZone: 'Asia/Kolkata', scope: 'me', generatedAt: NOW.toISOString(), events: events(NOW).filter((t) => t.date >= from && t.date <= to) };
      }
      else if (ep.endsWith('/auth/refresh')) data = { accessToken: `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`, expiresAt: '2099-01-01T00:00:00Z', user };
      else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['org.manage', 'work.view', 'work.edit', 'work.create', 'reports.view'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 3, activity: 3, documents: 3, people: 3, reports: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: {} } };
      else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
      else if (ep === '/api/v1/inbox') data = {
        rows: [
          { id: 'ticket:1', kind: 'ticket', group: 'assigned', title: 'Payments API returns 502', sub: 'Critical · Desk', action: { label: 'Open', verb: 'open', endpoint: null }, href: '/desk', at: iso('08:00'), urgent: true },
          { id: 'task:1', kind: 'task', group: 'assigned', title: 'INFRA-7 Rotate the gateway keys', sub: 'Due today', action: { label: 'Done', verb: 'done', endpoint: null }, href: '/work', at: iso('08:00'), urgent: false, dueToday: true },
        ], counts: { all: 2, assigned: 2, decisions: 0, mentions: 0 }, later: 0 };
      else if (ep === '/api/v1/inbox/briefing') data = { count: 2, headline: '2 things need you.', reasons: ['Payments API returns 502 is critical.', 'INFRA-7 is due today.'], sources: 'read your work', stats: { overdue: 0, dueToday: 1, decisions: 0, approvals: 0, mentions: 0, reminders: 0 } };
      else if (ep === '/api/v1/meet') data = { items: [], from: '', to: '', truncated: false };
      else if (ep === '/api/v1/dashboard') data = { counts: { myDueToday: 1, myCompletedToday: 0, myOpen: 1, myOverdue: 0, activeProjects: 1, completedProjects: 0, totalProjects: 1, openTasks: 1, overdueTasks: 0, members: 3, overallProgress: 40, myLoggedMinutesThisWeek: 0 }, myTasks: [], projects: [], activity: [], myWork: [] };
      else if (ep === '/api/v1/projects' || ep === '/api/v1/work-tasks') data = { items: [], page: 1, pageSize: 100, totalItems: 0, totalPages: 0 };
      else if (ep === '/api/v1/workload') data = { scope: 'Everyone', available: ['Everyone'], members: [], totals: { people: 3, open: 1, overdue: 0 } };
      else if (ep === '/api/v1/time/approvals') data = { pending: [], recent: [] };
      else if (ep === '/api/v1/timer') data = null;
      else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
      else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
    });
    return ctx;
  }
  let page;
  const y = () => page.locator('[data-testid="your-day"]');
  async function openToday() {
    await page.goto(origin + '/preview-org/');
    await y().waitFor({ timeout: 15000 });
    await page.waitForFunction(() => (document.querySelector('[data-testid="your-day"]')?.getAttribute('data-sig') ?? '') !== '');
    await page.waitForTimeout(200);
  }
  async function at$(hm) { NOW = at(hm); await page.clock.setFixedTime(NOW); await openToday(); }
  const boxes = (sel) => page.locator(sel).evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { t: el.textContent?.trim() ?? '', type: el.getAttribute('data-type'), x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; }));
  async function noOverlap(label) {
    const all = (await boxes('[data-testid="your-day"] .hm-cap, [data-testid="your-day"] .hm-pin')).filter((b) => b.w > 0);
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      const ox = Math.min(a.right, b.right) - Math.max(a.x, b.x), oy = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
      assert.ok(ox <= 1 || oy <= 1, `${label}: "${a.t}" and "${b.t}" overlap (${ox.toFixed(1)} x ${oy.toFixed(1)})`);
    }
    checks.push(`${label}: ${all.length} labels, none overlap`);
  }
  async function loggedBeforeNow(label) {
    const now = await page.locator('[data-testid="your-day-now"]').boundingBox();
    for (const b of await boxes('[data-testid="your-day"] [data-type="time"]')) assert.ok(b.right <= now.x + now.width / 2 + 1, `${label}: logged time drawn past now (${b.right} > ${now.x})`);
  }
  const focusStart = async () => Number(await y().locator('[data-type="focus"]').first().getAttribute('data-start'));
  const counts = async () => (await page.locator('[data-testid="your-day-counts"]').innerText()).replace(/\s+/g, ' ');

  let ctx = await context('light');
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });

  // ---- 09:00: not checked in, nothing logged; the deadline at the shift's end
  await at$('09:00');
  assert.equal(await y().locator('[data-type="time"]').count(), 0);
  assert.equal(await y().locator('[data-testid="your-day-checkin"]').count(), 0);
  const dl = y().locator('[data-testid="your-day-deadline"]');
  assert.equal(await dl.count(), 1);
  assert.equal(Number(await dl.getAttribute('data-hour')), 18, 'a date-only deadline is at the shift end');
  assert.match(await y().locator('[data-type="deadline"]').innerText(), /INFRA-7 · by end of day/);
  assert.ok(await y().locator('[data-type="focus"]').count() >= 1, 'a focus block is suggested');
  await noOverlap('09:00');
  // The banner sums up the day instead of repeating Needs you.
  const sum = await page.locator('[data-testid="briefing-summary"]').innerText();
  assert.match(sum, /^1 critical · 1 due today · .+ free$/, sum);
  assert.doesNotMatch(await page.locator('.hm-brief').innerText(), /Payments API returns 502 is critical/);
  assert.ok(await page.locator('.hm-brief .hm-plan').count() <= 1);
  checks.push('09:00: deadline by end of day, banner summary: ' + sum);
  await page.screenshot({ path: path.join(out, 'your-day-0900-1440.png'), animations: 'disabled' });

  // A block that starts now (9:00) stays at 9:00 for the day; the 10:29 visit below is a fresh device (the screenshot's day).
  assert.equal(await focusStart(), 9);
  await page.close(); await ctx.close();
  ctx = await context('light');
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });

  // ---- 10:29: the focus block that is about to start stays put
  await at$('10:29');
  const s1029 = await focusStart();
  assert.equal(s1029, 10.5, `the focus block starts at 10:30 (${s1029})`);
  await loggedBeforeNow('10:29');
  assert.match(await counts(), /58m logged/, 'only the 58 minutes since 9:31 count');
  assert.equal(await y().locator('[data-testid="your-day-checkin"]').count(), 1, 'the check-in is on the timeline');
  assert.match(await y().locator('[data-type="checkin"]').innerText(), /In 9:31/);
  await noOverlap('10:29');

  // ---- 10:35: refreshed - the block has not slid to 10:45, and reads "Focus now"
  await at$('10:35');
  const s1035 = await focusStart();
  assert.equal(s1035, s1029, `the focus block stays at 10:30 after a refresh (now ${s1035})`);
  assert.match(await y().locator('[data-type="focus"]').first().innerText(), /^Focus now · INFRA-7/);
  await loggedBeforeNow('10:35');
  await noOverlap('10:35');
  checks.push('focus block fixed at 10:30 from 10:29 to 10:35, "Focus now"');
  await page.screenshot({ path: path.join(out, 'your-day-1035-1440.png'), animations: 'disabled' });

  // ---- 14:00: the logged block ends where it was saved (11:31, before now); free time agrees with the Calendar
  await at$('14:00');
  assert.equal(await focusStart(), s1029, 'still at 10:30 in the afternoon');
  await loggedBeforeNow('14:00');
  assert.match(await counts(), /2h logged/);
  await noOverlap('14:00');
  const free = (await page.locator('[data-testid="your-day-free"]').innerText()).trim();
  await page.goto(origin + '/preview-org/calendar');
  await page.locator('[data-testid="week-planner"]').waitFor({ timeout: 15000 });
  const calFree = (await page.locator('[data-testid="day-free"]').innerText()).trim();
  assert.equal(calFree, free, `Today says ${free}, the Calendar ${calFree}`);
  checks.push(`14:00: Today and Calendar both "${free}"`);
  await page.screenshot({ path: path.join(out, 'calendar-1400-1440.png'), animations: 'disabled' });

  // ---- 18:40: after the shift: nothing free, nothing drawn past now
  await at$('18:40');
  await loggedBeforeNow('18:40');
  assert.match(await counts(), /0m free/);
  await noOverlap('18:40');
  await page.screenshot({ path: path.join(out, 'your-day-1840-1440.png'), animations: 'disabled' });
  await page.close(); await ctx.close();

  // ---- dark, and the phone
  NOW = at('10:35');
  ctx = await context('dark');
  page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openToday();
  await noOverlap('dark 10:35');
  await page.screenshot({ path: path.join(out, 'your-day-dark-1440.png'), animations: 'disabled' });
  await page.close(); await ctx.close();

  ctx = await context('light');
  page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await openToday();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'phone: no horizontal scroll');
  assert.deepEqual(await cutOff(page), [], 'phone: nothing cut off');
  for (const type of ['focus', 'time', 'deadline', 'checkin']) assert.ok(await y().locator(`[data-type="${type}"]`).count() > 0, `phone lists ${type}`);
  assert.match(await y().locator('[data-type="deadline"]').innerText(), /Due by end of day/);
  await page.screenshot({ path: path.join(out, 'your-day-390.png'), animations: 'disabled', fullPage: true });
  checks.push('phone list: focus, logged, deadline, check-in');
  await page.close(); await ctx.close();

  assert.deepEqual(errors, [], 'no page errors');
  console.log(JSON.stringify({ ok: true, checks, out }, null, 1));
} finally { await browser.close(); }
