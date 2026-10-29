import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { cutOff } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';
import { timelineFor } from './lib/timeline.mjs';

// Phone parity (apple/s-mobile, apple/s-phone): Today (needs-you list with one tap, UP NEXT with Join, the outage pill with its running clock,
// one-tap timesheet approval with the reconciliation line), My Work's FOCUS NOW (Start 2h focus, Log time), Desk rows' ⋯ (Assign / Resolve),
// + New › Ticket (Notify on WhatsApp, who is on call, similar tickets), and every place in More — at 390×844 (iPhone UA) and 412×915
// (Android Chrome UA), light and dark: no sideways scroll, nothing cut off, nothing under the tab bar or Aura's dock, toasts above the bars.
// Only the built frontend and synthetic fixtures with made-up names; the only writes allowed are the approval and the timer.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/phone-parity-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Nila Varma', email: 'nila@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 4 };
const g = (n) => `90000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`;
const pid = g(90);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const at = (date, hh, mm) => new Date(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`).toISOString();
const shift = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const monday = (() => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();
const lastMonday = shift(monday, -7);
const teo = { id: g(61), name: 'Teo Brandt' }, ivo = { id: g(62), name: 'Ivo Marsh' };

const rows = [
  { id: `work:${g(1)}`, kind: 'ticket', group: 'assigned', title: 'OPS-5 outage', sub: 'Ivo on it · SLA 70% used', action: { label: 'Open', verb: 'open', endpoint: null }, href: `/work?item=${g(1)}`, at: at(today, 9, 8), urgent: true },
  { id: `finding:${g(2)}`, kind: 'decision', group: 'decisions', title: 'Orchard Ledger: move date or add Teo?', sub: 'Decision · forecast +47d', action: { label: 'Accept', verb: 'accept', endpoint: `/api/v1/agent/findings/${g(2)}/approve` }, href: null, at: at(today, 8, 0), urgent: false },
  { id: `work:${g(3)}`, kind: 'task', group: 'assigned', title: 'GLN-1 settlement timeout with a long descriptive title that must truncate', sub: 'Overdue since 13 Oct', action: { label: 'Open', verb: 'open', endpoint: null }, href: `/work?item=${g(3)}`, at: at(today, 7, 0), urgent: false },
  { id: `timesheet:${g(5)}`, kind: 'approval', group: 'decisions', title: 'Timesheet · Teo Brandt', sub: '40h submitted', action: { label: 'Approve', verb: 'approve', endpoint: `/api/v1/time/approvals/${g(5)}/approve` }, href: '/insights?tab=time', at: at(today, 6, 0), urgent: false },
  { id: `mention:${g(4)}`, kind: 'mention', group: 'mentions', title: 'Reply to Ivo', sub: '#bureau · token rotation', action: { label: 'Reply', verb: 'open', endpoint: null }, href: '/messages', at: at(today, 5, 0), urgent: false },
];
const briefing = { count: 6, headline: '6 things need you.', reasons: ['Bureau sign-off at 11:00 — ask for 4 Nov.'], sources: 'read your work', stats: { overdue: 1, dueToday: 1, decisions: 1, approvals: 1, mentions: 1, reminders: 0 } };
const mtg = (n, title, hh, mm, extra = {}) => ({ type: 'meeting', id: g(n), title, date: today, status: 'Scheduled', category: null, overdue: false, projectId: null, projectName: null, priority: null, startsAt: at(today, hh, mm), durationMinutes: 30, notes: true, joinUrl: 'https://meet.example.test/abc', people: [], ...extra });
const calendar = [mtg(10, 'Stand-up', 9, 30), mtg(11, 'Bureau UAT sign-off', 11, 0, { projectId: pid, projectName: 'Orchard Ledger' })];
const approvals = { weekStart: lastMonday, entitled: true, week: [], pending: [{ id: g(5), user: teo, weekStart: lastMonday, status: 'Submitted', totalMinutes: 2400, billableMinutes: 0, note: null, submittedAt: at(today, 6, 0), reviewer: null, reviewedAt: null, reviewNote: null }] };
const gridDays = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ date: shift(lastMonday, i), minutes: i < 5 ? 480 : 0, targetMinutes: i < 5 ? 480 : 0, weekend: i >= 5, leave: false, leaveNote: null, future: false, meetings: 2, meetingMinutes: i < 5 ? 90 : 0 }));
const cells = (mins) => gridDays.map((d, i) => ({ date: d.date, minutes: i < 5 ? mins : 0, entries: i < 5 ? 1 : 0, running: false, note: null }));
const grid = { weekStart: lastMonday, weekEnd: shift(lastMonday, 6), user: teo, mine: false, editable: false, locked: true, status: 'Submitted', days: gridDays,
  rows: [
    { kind: 'task', targetId: g(71), key: 'ORL-12', title: 'Ledger API', projectId: pid, projectName: 'Lending API', billable: false, cells: cells(264), totalMinutes: 1320 },
    { kind: 'task', targetId: g(72), key: 'BBP-3', title: 'Bulk payments', projectId: g(91), projectName: 'Bank Bulk Payments', billable: false, cells: cells(168), totalMinutes: 840 },
    { kind: 'work', targetId: g(1), key: 'OPS-5', title: 'OPS-5 outage', projectId: null, projectName: null, billable: false, cells: cells(48), totalMinutes: 240 },
  ], suggestions: [], totalMinutes: 2400, billableMinutes: 0, targetMinutes: 2400, overtimeMinutes: 0, missingDays: 0, running: null };
const devLink = (id) => [{ id: `dl${id}`, provider: 'github', kind: 'commit', externalId: 'abc', title: 'Fix', url: 'https://git.example.test/c', repository: 'orchard/ledger', author: 'teo', state: null, occurredAt: at(shift(lastMonday, 2), 12, 0) }];
const work = (n, title, kind, extra = {}) => ({ kind, id: g(n), key: `${kind === 'ticket' ? 'OPS' : 'ORL'}-${n}`, title, projectId: kind === 'ticket' ? null : pid, projectKey: 'ORL', projectName: kind === 'ticket' ? null : 'Orchard Ledger', status: 'To do', category: 'Todo', priority: 'High', dueDate: today, isOverdue: false, assignee: { id: user.id, name: user.displayName }, typeName: kind === 'ticket' ? 'Incident' : null, updatedAt: at(today, 8, 0), slaStartAt: kind === 'ticket' ? at(today, 9, 0) : null, slaDueAt: kind === 'ticket' ? at(today, 13, 0) : null, slaState: kind === 'ticket' ? 'tracked' : null, ...extra });
const mine = [work(21, 'Fix duplicate row after restructure', 'task', { priority: 'Critical' }), work(22, 'Sanction PDF timeout', 'task'), work(23, 'Retry queue for the bureau', 'task'), work(24, 'Update runbook: cutover', 'task', { dueDate: shift(today, 3) })];
const tickets = [work(1, 'VPN down at the collections office', 'ticket', { priority: 'Critical', assignee: ivo }), work(31, 'Receipt upload fails for one branch', 'ticket'), work(32, 'Password reset for a field agent', 'ticket', { priority: 'Low', assignee: null })];
const detail = (r) => ({ ...r, version: 1, reporter: teo, description: 'Synthetic ticket.', channel: 'app', activity: [], comments: [], attachments: [], detail: {}, can: { edit: true } });
const ops = { canManage: true, businessHoursOnly: false, dayStartMinutes: 540, dayEndMinutes: 1080, workDays: [1, 2, 3, 4, 5], timeZone: 'Asia/Kolkata', escalateOnBreach: false, escalateTo: null,
  rules: [{ id: g(80), workTypeId: null, workType: null, mode: 'round_robin', members: [ivo, teo], escalateTo: null, enabled: true, lastAssigned: teo }] };
const triage = { workTypeId: null, workType: null, typeReason: null, priority: 'High', priorityReason: null, assignee: ivo, assigneeReason: 'resolved 3 similar items · 1 open now', duplicates: [{ id: g(31), key: 'OPS-31', title: 'Receipt upload fails', status: 'ToDo', assignee: null, score: .6 }, { id: g(32), key: 'OPS-32', title: 'Receipts not posting', status: 'ToDo', assignee: null, score: .5 }], routed: 'to the next person on the rota' };

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
};
const DEVICES = [{ name: 'iphone', width: 390, height: 844 }, { name: 'android', width: 412, height: 915 }];
const PLACES = [
  ['today', '/', '[data-testid="phone-today"]'], ['my-work', '/work', '.mw-h1'], ['desk', '/desk', '.dq-t'], ['quality', '/quality', 'h1, h2'],
  ['projects', '/work/projects', 'h1, h2'], ['portfolio', '/work/projects?view=portfolio', 'h1, h2'], ['calendar', '/?tab=calendar', '[data-testid="week-planner"]'],
  ['messages', '/messages', 'main'], ['mail', '/mail', 'main h1, main h2'], ['library', '/library', 'main h1, main h2'], ['vault', '/library/vault', 'main h1, main h2'],
  ['insights', '/insights', 'main h1, main h2'], ['settings', '/settings', 'main h1, main h2'],
];

let timer = null;
const errors = [], checks = [], shots = [], audit = {}, writes = [], unexpected = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const make = async (device, theme) => {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block', userAgent: UA[device.name], isMobile: true, hasTouch: true, viewport: { width: device.width, height: device.height }, deviceScaleFactor: 2, colorScheme: theme });
  await ctx.clock.setFixedTime(new Date(at(today, 10, 42)));
  await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); localStorage.setItem('pm_tour_done', '1'); }, theme);
  await ctx.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
    if (url.origin !== origin) { await route.abort(); return; }
    if (ep.endsWith('/avatar') || ep.endsWith('/thumbnail') || ep.endsWith('/logo/image')) { await route.fulfill({ status: 404, body: '' }); return; }
    if (!ep.startsWith('/api/')) {
      const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
      await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file).catch(() => ''), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
      return;
    }
    // The desk's drafted reply asks the paid assistant: it is refused here, as it would be without credits.
    if (ep === '/api/v1/chat/ai/ask') { await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ errors: [{ code: 'AI_OFF', message: 'Off in this check.' }] }) }); return; }
    if (method !== 'GET' && !ep.endsWith('/auth/refresh') && ep !== '/api/v1/operations/triage') {
      if (!(ep === `/api/v1/time/approvals/${g(5)}/approve` || ep === `/api/v1/tasks/${g(21)}/timer/start` || /\/work-items\/[^/]+$/.test(ep) || ep.endsWith('/timer/stop'))) { unexpected.push(`${method} ${ep}`); await route.fulfill({ status: 403, body: '' }); return; }
      writes.push(`${method} ${ep}`);
      if (ep.endsWith('/timer/start')) timer = { id: 'te1', taskId: g(21), workTaskId: null, taskKey: 'ORL-21', taskTitle: 'Fix', isRunning: true, startedAt: at(today, 10, 42), minutes: 0 };
      if (ep.endsWith('/timer/stop')) timer = null;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: ep.includes('/approvals/') ? { ...approvals.pending[0], status: 'Approved' } : ep.includes('/work-items/') ? detail(tickets[0]) : { id: 'te1', taskId: g(21), workTaskId: null, isRunning: true, startedAt: at(today, 10, 42), minutes: 0 } }) });
      return;
    }
    let data = [];
    if (ep.endsWith('/auth/refresh')) data = { accessToken: `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`, expiresAt: '2099-01-01T00:00:00Z', user };
    else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['projects.view', 'projects.edit', 'projects.create', 'tasks.view', 'tasks.edit', 'tasks.create', 'tasks.comment', 'org.manage', 'work.view', 'work.edit', 'work.create', 'reports.view', 'reports.broad', 'vault.use'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 3, activity: 3, documents: 3, people: 3, reports: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3 } } };
    else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
    else if (ep === '/api/v1/doctracker/catalog') data = { projects: [{ id: g(70), key: 'ORL', name: 'Orchard Ledger', endpoints: [], definitions: [], documents: [], diagrams: 1, designs: 0 }], canCreate: true, isAdmin: true, truncated: 0, teams: [] };
    else if (ep === '/api/v1/documents/dashboard') data = { total: 0, byStatus: [], byType: [], mine: 0, waitingForMe: 0, updatedThisWeek: 0, notUpdatedIn90Days: 0, unpublished: 0, recent: [] };
    else if (ep === '/api/v1/timer') data = timer;
    else if (ep === '/api/v1/inbox') data = { rows, counts: { all: 6, assigned: 2, decisions: 2, mentions: 1 }, later: 0 };
    else if (ep === '/api/v1/inbox/briefing') data = briefing;
    else if (ep === '/api/v1/calendar') data = calendar;
    else if (ep === '/api/v1/timeline') data = timelineFor(url, calendar);
    else if (ep === '/api/v1/time/approvals') data = approvals;
    else if (ep === '/api/v1/time/grid') data = url.searchParams.get('userId') ? grid : { ...grid, user: { id: user.id, name: user.displayName }, mine: true, editable: true, locked: false, status: 'NotSubmitted', rows: [] };
    else if (ep === '/api/v1/time/week') data = { weekStart: monday, weekEnd: shift(monday, 6), userId: user.id, status: 'NotSubmitted', totalMinutes: 0, billableMinutes: 0, note: null, submittedAt: null, reviewer: null, reviewedAt: null, reviewNote: null, locked: false, canSubmit: true, canWithdraw: false, canReview: false, id: null, entitled: true };
    else if (ep === '/api/v1/time') data = { from: today, to: today, user: { id: user.id, name: user.displayName }, entries: [], byDay: [], totalMinutes: 0, billableMinutes: 0 };
    else if (/\/tasks\/[^/]+\/dev-links$/.test(ep)) data = devLink(ep.split('/')[4]);
    else if (ep === '/api/v1/work-items') { const k = url.searchParams.get('kind'); const closed = url.searchParams.get('status') === 'closed'; data = { items: closed ? [] : k === 'ticket' ? tickets : mine, offset: 0, limit: 200, hasMore: false }; }
    else if (/^\/api\/v1\/work-items\/[^/]+$/.test(ep)) { const id = ep.split('/').pop(); data = detail([...tickets, ...mine].find((r) => r.id === id) ?? tickets[0]); }
    else if (ep === '/api/v1/operations/settings') data = ops;
    else if (ep === '/api/v1/operations/triage') data = triage;
    else if (ep === '/api/v1/integrations/whatsapp/status') data = { configured: true, receptionEnabled: true, eligible: true, connected: true, displayName: 'Preview Support', connectedAt: at(today, 1, 0), installationEnabled: true, messagingEnabled: true };
    else if (ep === '/api/v1/work-types') data = [{ id: g(81), name: 'Incident', isActive: true }];
    else if (ep === '/api/v1/projects') data = { items: [], page: 1, pageSize: 100, totalItems: 0, totalPages: 0 };
    else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
    else if (ep.endsWith('/ai/status')) data = { enabled: true, configured: true, entitled: true, allowedHere: true };
    else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
    else if (ep.endsWith('/workspace/members')) data = [{ userId: user.id, displayName: user.displayName, email: user.email, role: 'Owner' }, { userId: teo.id, displayName: teo.name, email: 'teo@example.test', role: 'Member' }];
    else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
    else data = null;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  return ctx;
};

/** Visible things in the page (not fixed bars or sheets) that sit under the tab bar or the Ask bar once the page is scrolled to its end. */
const underBars = (page) => page.evaluate(() => {
  scrollTo(0, document.documentElement.scrollHeight);
  const bar = document.querySelector('.v2-phone-bar')?.getBoundingClientRect();
  const ask = document.querySelector('.v2-ask')?.getBoundingClientRect();
  const limit = Math.min(bar?.top ?? innerHeight, ask && ask.height ? ask.top : innerHeight);
  const out = [];
  for (const el of document.querySelectorAll('main#main-content *')) {
    if (el.children.length && !/^(BUTTON|A|INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) continue;
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
    let p = el, fixed = false, scroller = false;
    while (p && p !== document.body) { const s = getComputedStyle(p); if (s.position === 'fixed' || s.position === 'sticky') fixed = true; if (p !== el && /(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 1) scroller = true; p = p.parentElement; }
    if (fixed || scroller) continue;
    if (r.bottom > limit + 1 && r.top < innerHeight) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} ${Math.round(r.top)}-${Math.round(r.bottom)} > ${Math.round(limit)}`);
  }
  return out.slice(0, 8);
});
/** Tap targets under 44×44 in the page (reported per place; the new phone controls must pass). */
const tinyTargets = (page, scope = 'main#main-content') => page.evaluate((scope) => [...document.querySelectorAll(`${scope} button, ${scope} a[href], ${scope} [role="tab"], ${scope} input[type="checkbox"]`)]
  .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && (r.height < 44 && r.width < 44 || r.height < 30); })
  .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 24)}" ${Math.round(el.getBoundingClientRect().width)}×${Math.round(el.getBoundingClientRect().height)}`), scope);

const watch = (page) => { page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`)); };
const shot = async (page, name) => { await page.evaluate(() => scrollTo(0, 0)); await page.waitForTimeout(250); const f = path.join(out, `${name}.png`); await page.screenshot({ path: f, animations: 'disabled' }); shots.push(f); };

try {
  for (const device of DEVICES) for (const theme of ['light', 'dark']) {
    const tag = `${device.name}-${device.width}${theme === 'dark' ? '-dark' : ''}`;
    const ctx = await make(device, theme);
    const page = await ctx.newPage(); watch(page);
    for (const [name, to, ready] of PLACES) {
      await page.goto(`${origin}/preview-org${to}`);
      await page.locator(ready).first().waitFor({ timeout: 15000 }).catch(() => {});
      await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(700);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${name} ${tag}: sideways scroll`);
      assert.deepEqual(await cutOff(page), [], `${name} ${tag}: cut off at the right edge`);
      assert.deepEqual(await underBars(page), [], `${name} ${tag}: content under the tab bar or the Ask bar`);
      audit[`${name}/${tag}`] = await tinyTargets(page);
      await shot(page, `${name}-${tag}`);
      checks.push(`${name}-${tag}`);
    }

    // Today: the design's parts, wired to the fixtures.
    await page.goto(`${origin}/preview-org/`);
    await page.locator('[data-testid="phone-today"]').waitFor();
    assert.equal(await page.locator('.pt-h1').innerText(), 'Today');
    const pill = page.locator('[data-testid="outage-pill"]');
    assert.match(await pill.innerText(), /OPS-5 outage[\s\S]*1h 34m/);
    assert.match(await page.locator('.pt-brief').innerText(), /^6 things need you\. Bureau sign-off/);
    await page.locator('[data-testid="timesheet-approval"]').waitFor();   // the approval card takes over the timesheet's row once it is read
    assert.equal(await page.locator('.pt-li').count(), 3, 'the outage and the timesheet are not listed twice');
    assert.match(await page.locator('[data-testid="phone-up-next"]').innerText(), /UP NEXT · IN 18 MIN[\s\S]*Bureau UAT sign-off[\s\S]*Join/);
    const ts = page.locator('[data-testid="timesheet-approval"]');
    await ts.locator('.pt-dl.total').waitFor();
    assert.match(await ts.innerText(), /Teo Brandt[\s\S]*Lending API\s*22h[\s\S]*Bank Bulk Payments\s*14h[\s\S]*OPS-5 outage \(ticket\)\s*4h[\s\S]*Total\s*40h/);
    await page.locator('[data-testid="timesheet-reconcile"]').filter({ hasText: 'commits' }).waitFor();
    assert.match(await page.locator('[data-testid="timesheet-reconcile"]').innerText(), /^✓\s*Matches calendar and commits\. No gaps\.$/);
    assert.deepEqual(await tinyTargets(page, '[data-testid="phone-today"]'), [], 'Today phone controls are 44px');
    await shot(page, `today-detail-${tag}`);
    await ts.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(out, `timesheet-${tag}.png`) }); shots.push(path.join(out, `timesheet-${tag}.png`));
    // Approve in one tap; the toast rises above the Ask bar and the tab bar, clear of the page's header.
    await ts.getByRole('button', { name: 'Approve', exact: true }).click();
    const toast = page.locator('.toast').first(); await toast.waitFor();
    const box = await toast.boundingBox(), barTop = await page.locator('.v2-phone-bar').evaluate((el) => el.getBoundingClientRect().top);
    assert.ok(box.y + box.height <= barTop, `toast above the tab bar (${box.y + box.height} <= ${barTop})`);
    assert.ok(box.y > device.height / 2, 'toast is at the bottom, not over the header');
    await page.screenshot({ path: path.join(out, `toast-${tag}.png`) }); shots.push(path.join(out, `toast-${tag}.png`));
    assert.ok(writes.includes(`POST /api/v1/time/approvals/${g(5)}/approve`));

    // My Work: FOCUS NOW with Start 2h focus (starts the timer) and Log time.
    await page.goto(`${origin}/preview-org/work`);
    const focus = page.locator('[data-testid="focus-now"]'); await focus.waitFor();
    assert.match(await focus.innerText(), /FOCUS NOW[\s\S]*Fix duplicate row after restructure[\s\S]*ORL-21 · Orchard Ledger/);
    assert.deepEqual(await tinyTargets(page, '[data-testid="focus-now"]'), []);
    await shot(page, `my-work-focus-${tag}`);
    await focus.getByRole('button', { name: 'Start 2h focus' }).click();
    await focus.getByRole('button', { name: /End focus, (1:59:\d\d|2:00:00) left/ }).waitFor();
    assert.ok(writes.includes(`POST /api/v1/tasks/${g(21)}/timer/start`));
    await focus.getByRole('button', { name: 'Log time' }).click(); await page.waitForURL(/\/insights\?tab=time&log=ORL-21/);
    await page.evaluate(() => localStorage.removeItem('pm_focus_until'));

    // Aura's dock steps aside while scrolling down a long page, and comes back on scroll up.
    await page.goto(`${origin}/preview-org/?tab=calendar`); await page.locator('.v2-ask').waitFor();
    const dockOp = () => page.getByTestId('aura-dock').evaluate((el) => getComputedStyle(el).opacity);
    for (let i = 0; i < 6; i++) { await page.evaluate(() => scrollBy(0, 100)); await page.waitForTimeout(60); }
    await page.waitForTimeout(500);
    if (await page.evaluate(() => document.documentElement.scrollHeight > innerHeight + 200)) {
      assert.equal(await dockOp(), '0', 'the dock steps aside while scrolling down');
      await page.screenshot({ path: path.join(out, `ask-pill-${tag}.png`) }); shots.push(path.join(out, `ask-pill-${tag}.png`));
      for (let i = 0; i < 3; i++) { await page.evaluate(() => scrollBy(0, -100)); await page.waitForTimeout(60); }
      await page.waitForTimeout(500);
      assert.equal(await dockOp(), '1', 'the dock is back on scroll up');
    }

    // Desk: each row has a visible ⋯ with Assign and Resolve as full-size buttons.
    await page.goto(`${origin}/preview-org/desk`); await page.locator('.dq-t').first().waitFor();
    const more = page.locator('.dq-more').first(); await more.waitFor();
    assert.ok((await more.boundingBox()).height >= 44);
    await more.click();
    const acts = page.locator('.dq-tacts.open').first();
    for (const n of ['Assign', 'Resolve']) assert.ok((await acts.getByRole('button', { name: n }).boundingBox()).height >= 44, `${n} is a 44px target`);
    await acts.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: path.join(out, `desk-actions-${tag}.png`) }); shots.push(path.join(out, `desk-actions-${tag}.png`));

    // + New › Ticket: who is on call, similar open tickets.
    await page.goto(`${origin}/preview-org/work?new=1`);
    await page.getByLabel('What to create').fill('Receipts not posting at the branch');
    assert.equal(await page.locator('[data-testid="notify-whatsapp"]').count(), 0, 'no WhatsApp switch in + New');
    await page.locator('.v2-understood p').filter({ hasText: 'similar tickets open' }).waitFor();
    assert.match(await page.locator('.v2-understood p').innerText(), /^Incident · .*Ivo is on call · 2 similar tickets open$/);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(out, `new-ticket-${tag}.png`) }); shots.push(path.join(out, `new-ticket-${tag}.png`));
    await ctx.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, [], 'no other writes');
  await fs.writeFile(path.join(out, 'checks.json'), JSON.stringify({ checks, shots, writes: [...new Set(writes)], tinyTargets: audit, note: 'Safe areas cannot be emulated in Chromium; env(safe-area-inset-*) is 0 here, and every bar adds it on devices.' }, null, 2));
  console.log(JSON.stringify({ checks: checks.length, shots: shots.length, writes: [...new Set(writes)] }));
} finally { await browser.close(); }
