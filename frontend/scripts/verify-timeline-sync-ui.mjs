// One timeline, two screens: Today ("Your day", desktop and phone) and the Calendar (week and day) read the same GET /timeline and must show
// the same day — the same meetings, calls held, logged time, finished work, reminders and focus blocks (an automated identity check on both).
// Also: every type renders distinctly, the sidebar's Show toggles hide their type, done / call / time open their own detail card, the grid
// opens at the first thing of the week, the now line agrees, dark mode, and the phone. Synthetic data only.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { cutOff } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/timeline-sync-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Tara Menon', email: 'tara@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 3 };
const pid = '00000000-0000-0000-0000-000000000003';
// Wednesday 28 October 2026, 3:20 PM in Kolkata (the browser runs in Kolkata, the "server" answers in UTC instants).
const today = '2026-10-28', NOW = new Date('2026-10-28T15:20:00+05:30');
const day = (n) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const tue = day(-1), fri = day(2);
const at = (d, hm) => new Date(`${d}T${hm}:00+05:30`).toISOString();
const g = (n) => `71000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`;
const tev = (o) => ({ end: null, allDay: false, link: null, projectId: null, projectName: null, people: [], status: null, colour: '', key: null, approximated: false, overdue: false, priority: null,
  minutes: null, note: null, joinUrl: null, notes: false, userId: user.id, mode: null, running: false, ...o });
const events = [
  tev({ id: `meeting:${g(1)}:x`, type: 'meeting', title: 'Release sync', start: at(today, '11:00'), end: at(today, '11:30'), date: today, sourceType: 'workspaceMeeting', sourceId: g(1), people: ['Rhea Kapoor', 'Tara Menon'], status: 'Scheduled', joinUrl: 'https://meet.google.com/abc-defg-hij' }),
  tev({ id: `call:${g(2)}`, type: 'call', title: 'Gateway war room', start: at(today, '12:00'), end: at(today, '12:40'), date: today, sourceType: 'call', sourceId: g(2), people: ['Tara Menon', 'Vikram Rao', 'Rhea Kapoor'], status: 'ended', link: `/messages/${g(9)}`, projectId: pid, projectName: 'Infra Upgrade' }),
  tev({ id: `time:${g(3)}`, type: 'time', title: 'Patch the gateway', start: at(today, '09:30'), end: at(today, '10:45'), date: today, sourceType: 'timeEntry', sourceId: g(3), minutes: 75, link: `/work?item=${g(5)}`, projectId: pid, projectName: 'Infra Upgrade' }),
  tev({ id: `time:${g(4)}`, type: 'time', title: 'Ticket triage', start: at(today, '13:00'), end: at(today, '14:00'), date: today, sourceType: 'timeEntry', sourceId: g(4), minutes: 60, approximated: true, note: 'Typed in' }),
  tev({ id: `done:task:${g(5)}`, type: 'done', title: 'Patch the gateway', key: 'INFRA-2', start: at(today, '11:33'), date: today, sourceType: 'task', sourceId: g(5), status: 'Done', priority: 'High', projectId: pid, projectName: 'Infra Upgrade', people: ['Tara Menon'], link: `/work?item=${g(5)}` }),
  tev({ id: `done:work:${g(6)}`, type: 'done', title: 'VPN certificate expired', key: 'WT-12', start: at(today, '13:50'), date: today, sourceType: 'work', sourceId: g(6), status: 'Completed', priority: 'Critical', link: `/work?item=${g(6)}` }),
  tev({ id: `done:action:${g(7)}`, type: 'done', title: 'Share the cutover runbook', key: 'AI-3', start: at(today, '15:00'), date: today, sourceType: 'action', sourceId: g(7), status: 'Completed', priority: 'Medium', projectId: pid, projectName: 'Infra Upgrade', link: `/work?item=${g(7)}` }),
  tev({ id: `done:task:${g(8)}`, type: 'done', title: 'Drain the old node pool', key: 'INFRA-1', start: at(tue, '07:40'), date: tue, sourceType: 'task', sourceId: g(8), status: 'Done', projectId: pid, projectName: 'Infra Upgrade', link: `/work?item=${g(8)}` }),
  tev({ id: `due:task:${g(10)}`, type: 'due', title: 'Rotate the certificates', key: 'INFRA-4', allDay: true, start: at(today, '00:00'), date: today, sourceType: 'task', sourceId: g(10), status: 'In progress', priority: 'High', projectId: pid, projectName: 'Infra Upgrade', link: `/work?item=${g(10)}` }),
  tev({ id: `due:work:${g(11)}`, type: 'due', title: 'Renew the load balancer contract', key: 'WT-15', allDay: true, start: at(fri, '00:00'), date: fri, sourceType: 'work', sourceId: g(11), status: 'To Do', priority: 'Medium', link: `/work?item=${g(11)}` }),
  tev({ id: `reminder:${g(12)}`, type: 'reminder', title: 'Send the patch notes', start: at(today, '17:30'), date: today, sourceType: 'reminder', sourceId: g(12), status: 'scheduled' }),
  tev({ id: `reminder:${g(13)}`, type: 'reminder', title: 'Check the backup job', start: at(today, '10:00'), date: today, sourceType: 'reminder', sourceId: g(13), status: 'fired' }),
  tev({ id: `attendance:${g(14)}`, type: 'attendance', title: 'Office', start: at(today, '09:12'), date: today, sourceType: 'attendance', sourceId: g(14), status: 'in', mode: 'Office', running: true }),
];
const timeline = (from, to) => ({ from, to, timeZone: 'Asia/Kolkata', scope: 'me', generatedAt: NOW.toISOString(), events: events.filter((t) => t.date >= from && t.date <= to) });

const errors = [], checks = [], requests = [];
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
      if (ep === '/api/v1/timeline') { requests.push(url.search); data = timeline(url.searchParams.get('from'), url.searchParams.get('to')); }
      else if (ep.endsWith('/auth/refresh')) data = { accessToken: `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`, expiresAt: '2099-01-01T00:00:00Z', user };
      else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['org.manage', 'work.view', 'work.edit', 'work.create', 'reports.view'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 3, activity: 3, documents: 3, people: 3, reports: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: {} } };
      else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
      else if (ep === '/api/v1/inbox') data = { rows: [], counts: { all: 0, assigned: 0, decisions: 0, mentions: 0 }, later: 0 };
      else if (ep === '/api/v1/inbox/briefing') data = { count: 0, headline: "You're all caught up.", reasons: [], sources: 'read your work', stats: { overdue: 0, dueToday: 0, decisions: 0, approvals: 0, mentions: 0, reminders: 0 } };
      else if (ep === '/api/v1/meet') data = { items: [], from: '', to: '', truncated: false };
      else if (ep === '/api/v1/dashboard') data = { counts: { myDueToday: 1, myCompletedToday: 3, myOpen: 2, myOverdue: 0, activeProjects: 1, completedProjects: 0, totalProjects: 1, openTasks: 2, overdueTasks: 0, members: 3, overallProgress: 40, myLoggedMinutesThisWeek: 135 }, myTasks: [], projects: [], activity: [], myWork: [] };
      else if (ep === '/api/v1/projects' || ep === '/api/v1/work-tasks') data = { items: [], page: 1, pageSize: 100, totalItems: 0, totalPages: 0 };
      else if (ep === '/api/v1/workload') data = { scope: 'Everyone', available: ['Everyone'], members: [], totals: { people: 3, open: 2, overdue: 0 } };
      else if (ep === '/api/v1/time/approvals') data = { pending: [], recent: [] };
      else if (ep === '/api/v1/timer') data = null;
      else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
      else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
    });
    return ctx;
  }
  let page;
  async function newPage(ctx, width) {
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width, height: 1000 });
  }
  async function capture(name) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, name + ' viewport overflow');
    assert.deepEqual(await cutOff(page), [], name + ' cut off at the right edge');
    await page.screenshot({ path: path.join(out, name + '.png'), animations: 'disabled' }); checks.push(name);
  }
  const card = () => page.locator('[data-testid="event-detail"]');
  async function todaySig() {
    await page.goto(origin + '/preview-org/');
    const y = page.locator('[data-testid="your-day"]');
    await y.waitFor({ timeout: 15000 });
    await page.waitForFunction(() => (document.querySelector('[data-testid="your-day"]')?.getAttribute('data-sig') ?? '') !== '');
    return { sig: await y.getAttribute('data-sig'), counts: await page.locator('[data-testid="your-day-counts"]').innerText() };
  }
  async function calendarSig() {
    await page.goto(origin + '/preview-org/calendar');
    await page.locator('[data-testid="week-planner"]').waitFor({ timeout: 15000 });
    await page.locator('.wp-done').first().waitFor();
    return page.locator(`.wp-dh[data-day="${today}"]`).getAttribute('data-sig');
  }

  // ---------------------------------------------------------------- desktop: Today and the Calendar agree
  let ctx = await context('light');
  await newPage(ctx, 1440);
  const home = await todaySig();
  assert.match(home.counts, /^1 meeting · 1 call · \d focus blocks? · .+ free · 3 done · 2h 15m logged$/, home.counts);
  const y = page.locator('[data-testid="your-day"]');
  for (const [type, n] of [['meeting', 1], ['call', 1], ['time', 2], ['done', 3], ['reminder', 2]]) assert.equal(await y.locator(`[data-type="${type}"]`).count(), n, `Today shows ${n} ${type}`);
  const homeFocus = await y.locator('[data-type="focus"]').allInnerTexts();
  assert.ok(homeFocus.length >= 1 && homeFocus.every((t) => /^Focus · (INFRA-4 Rotate the certificates|WT-15 Renew)/.test(t)), homeFocus.join(' | '));
  assert.equal(await y.locator('[data-type="focus"]', { hasText: 'Deep work' }).count(), 0, 'never a generic "Deep work"');
  const homeNow = (await y.locator('[data-testid="your-day-now"]').innerText()).trim();
  assert.equal(homeNow, '3:20');
  // Today's done pill opens the same card as the Calendar's
  await y.locator('[data-type="done"]', { hasText: 'WT-12' }).click();
  await card().waitFor();
  assert.equal(await card().getAttribute('data-kind'), 'done');
  await page.waitForTimeout(350); await capture('today-done-card-1440');
  await page.keyboard.press('Escape');
  await page.screenshot({ path: path.join(out, 'today-1440.png'), animations: 'disabled' });

  const cal = await calendarSig();
  assert.equal(cal, home.sig, `Today and the Calendar show the same day\n  today:    ${home.sig}\n  calendar: ${cal}`);
  checks.push('today = calendar (same events, same focus)');
  // Your day and the week both ask for Monday–Sunday (one cached request per page); the only other range is Up next's two weeks.
  assert.equal(requests.filter((r) => r.includes('from=2026-10-26&to=2026-11-01')).length, 2, `one week request per page: ${requests.join(' ')}`);
  assert.ok(requests.every((r) => r.includes('from=2026-10-26&to=2026-11-01') || r.includes('from=2026-10-28&to=2026-11-11')), requests.join(' '));

  // every type, drawn distinctly in today's column
  const col = page.locator(`.wp-col[data-day="${today}"]`);
  assert.equal(await col.locator('[data-type="meeting"]').count(), 1);
  assert.equal(await col.locator('[data-type="call"] svg').count(), 1, 'a call carries the phone glyph');
  assert.equal(await col.locator('[data-type="time"]').count(), 2);
  assert.equal(await col.locator('[data-type="time"].ap').count(), 1, 'typed-in time is marked approximate');
  assert.equal(await col.locator('.wp-done').count(), 3, 'three check pills where the work was finished');
  assert.equal(await col.locator('.wp-rem').count(), 2);
  assert.ok(await col.locator('[data-type="focus"]').count() >= 1);
  assert.equal(await page.locator(`.wp-col[data-day="${tue}"] .wp-done`).count(), 1, 'work finished on Tuesday shows on Tuesday');
  // the 11:33 pill sits at 11:33 on the grid
  const pill = await col.locator('.wp-done', { hasText: 'INFRA-2' }).getAttribute('data-start');
  assert.ok(Math.abs(Number(pill) - 11.55) < 0.01, `INFRA-2 finished at 11:33 (${pill})`);
  // the now line agrees with Today's
  assert.equal((await page.locator('.wp-nowl').innerText()).trim(), homeNow);
  // the grid opens at the first thing of the week (07:40 on Tuesday), showing whole hours from 7 AM
  const scroll = await page.locator('[data-testid="wp-scroll"]').evaluate((el) => el.scrollTop);
  assert.ok(Math.abs(scroll - (7 * 73 - 12)) <= 2, `auto-scrolled to 7 AM (${scroll})`);
  const firstLabel = await page.locator('[data-testid="wp-scroll"]').evaluate((el) => { const top = el.getBoundingClientRect().top; return [...el.querySelectorAll('.wp-hrs span[data-hour]')].find((s) => s.getBoundingClientRect().top >= top - 1)?.textContent; });
  assert.equal(firstLabel, '7 AM', 'the first hour is shown whole (not clipped)');
  checks.push('types + now line + auto-scroll');
  await capture('calendar-week-1440');

  // legend toggles map to types
  const layers = [['meetings', '[data-type="meeting"]'], ['calls', '[data-type="call"]'], ['logged', '[data-type="time"]'], ['done', '.wp-done'], ['focus', '[data-type="focus"]'], ['reminders', '.wp-rem'], ['deadlines', '.wp-flag']];
  for (const [layer, sel] of layers) {
    const scope = layer === 'deadlines' ? page.locator('.wp-days') : page.locator('.wp-body');
    const before = await scope.locator(sel).count();
    assert.ok(before > 0, `${layer} drawn before the toggle`);
    await page.locator(`[data-testid="wp-layers"] label[data-layer="${layer}"]`).click();
    await page.waitForFunction(([s, d]) => document.querySelectorAll(`${d} ${s}`).length === 0, [sel, layer === 'deadlines' ? '.wp-days' : '.wp-body']);
    await page.locator(`[data-testid="wp-layers"] label[data-layer="${layer}"]`).click();
    await page.waitForFunction(([s, d, n]) => document.querySelectorAll(`${d} ${s}`).length === n, [sel, layer === 'deadlines' ? '.wp-days' : '.wp-body', before]);
  }
  checks.push('legend toggles: ' + layers.map(([l]) => l).join(', '));

  // detail cards: done, call, time
  await col.locator('.wp-done', { hasText: 'INFRA-2' }).click(); await card().waitFor();
  assert.equal(await card().getAttribute('data-kind'), 'done');
  assert.match(await card().innerText(), /finished at 11:33 AM/);
  assert.match(await card().innerText(), /Infra Upgrade/);
  await page.keyboard.press('Escape'); await card().waitFor({ state: 'detached' });
  await col.locator('[data-type="call"]').click(); await card().waitFor();
  assert.equal(await card().getAttribute('data-kind'), 'call');
  assert.match(await card().innerText(), /12:00 PM – 12:40 PM/);
  assert.match(await card().innerText(), /People · 3/);
  await page.waitForTimeout(350); await capture('call-card-1440');
  await page.keyboard.press('Escape'); await card().waitFor({ state: 'detached' });
  await col.locator('[data-type="time"].ap').click(); await card().waitFor();
  assert.equal(await card().getAttribute('data-kind'), 'time');
  assert.match(await card().innerText(), /typed in as minutes/);
  await page.keyboard.press('Escape');
  checks.push('detail cards: done, call, time');
  await page.close(); await ctx.close();

  // ---------------------------------------------------------------- dark
  ctx = await context('dark');
  await newPage(ctx, 1440);
  const darkHome = await todaySig();
  assert.equal(darkHome.sig, home.sig);
  await page.screenshot({ path: path.join(out, 'today-dark-1440.png'), animations: 'disabled' });
  assert.equal(await calendarSig(), home.sig);
  const pillBg = await page.locator('.wp-done').first().evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.notEqual(pillBg, 'rgba(0, 0, 0, 0)');
  await capture('calendar-week-dark-1440');
  await page.close(); await ctx.close();

  // ---------------------------------------------------------------- phone: Today's list and the Calendar's day agree
  ctx = await context('light');
  await newPage(ctx, 390);
  const phone = await todaySig();
  assert.equal(phone.sig, home.sig, 'the phone shows the same day');
  for (const type of ['meeting', 'call', 'time', 'done', 'reminder', 'focus']) assert.ok(await page.locator(`[data-testid="your-day"] [data-type="${type}"]`).count() > 0, `phone lists ${type}`);
  await capture('today-390');
  await page.locator('[data-testid="your-day"] [data-type="call"]').click(); await card().waitFor(); await page.waitForTimeout(450);
  assert.match(await card().getAttribute('class'), /ed-sheet/);
  await capture('today-call-sheet-390');
  await page.mouse.click(195, 40); await card().waitFor({ state: 'detached' });
  assert.equal(await calendarSig(), home.sig, 'the Calendar day on a phone is the same day');
  assert.equal(await page.locator('.wp-dh').count(), 1, 'a phone opens on the day');
  await capture('calendar-day-390');
  await page.close(); await ctx.close();

  assert.deepEqual(errors, [], 'no page errors');
  console.log(JSON.stringify({ ok: true, checks, out }, null, 1));
} finally { await browser.close(); }
