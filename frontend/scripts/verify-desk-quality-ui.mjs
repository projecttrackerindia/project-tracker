import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { appCsp } from './lib/csp.mjs';
import { assertFills, assertFillsMain, assertInToolbar } from './lib/fit.mjs';

// Release 1 Desk (/desk) and Quality (/quality). Desk: the red incident strip for an open Critical ticket (timer, War room), the live queue
// sorted by SLA with rings and channel icons, j/k moving through it, the open ticket as a conversation with a reply box (⌘↵ posts a
// comment), and the context column (requester, linked project, similar solved tickets, suggested reply with Send / Edit). Quality: the
// readiness ring card, the cases × runs matrix (a click on a dot sets the result), the failed case's detail with File bug, the create
// dialogs and the empty state. 1440 light and dark. Synthetic API only; every write is checked.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/desk-quality-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const g = (n) => `91000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const user = { id: g(1), displayName: 'Maya C', email: 'maya@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const me = { id: user.id, name: user.displayName };
const p = (n, name) => ({ id: g(n), name });
const shiva = p(2, 'Shiva Kumar'), siva = p(3, 'Siva Rao'), ravi = p(4, 'Ravi Teja'), priya = p(5, 'Priya S'), rakshit = p(6, 'Rakshit M');
const ramesh = p(20, 'Ramesh Naidu'), lakshmi = p(21, 'Lakshmi P'), kavya = p(22, 'Kavya R'), nellore = p(23, 'Branch Nellore'), anil = p(24, 'Anil Kumar'), hrops = p(25, 'HR Ops'), sujatha = p(26, 'Sujatha M');
const ws = { id: g(9), slug: 'preview-org', name: 'Northwind Finance', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 6 };
const members = [me, shiva, siva, ravi].map((x, i) => ({ userId: x.id, displayName: x.name, email: `${x.name.split(' ')[0].toLowerCase()}@example.test`, role: i ? 'Member' : 'Owner', joinedAt: '2026-01-01T00:00:00Z', jobRole: null }));
const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();
const ahead = (min) => new Date(Date.now() + min * 60e3).toISOString();
const pid = g(50);
const project = { id: pid, key: 'WT', name: 'Razorpay Payments', description: null, status: 'Active', priority: 'High', owner: me, teamId: null, teamName: null, startDate: null, dueDate: null, progress: 40, health: 'OnTrack',
  stats: { total: 0, done: 0, inProgress: 0, cancelled: 0, todo: 0, overdue: 0 }, memberCount: 3, version: 1, position: 0, enforceDependencies: false, projectGroupId: null, projectGroupName: null, projectType: 'NewProject', deliveryMethod: 'Phased' };

// ---------------------------------------------------------------- Desk: the tickets (the server's state for one run)
function tickets() {
  const t = [];
  const add = (key, title, o) => t.push({ id: g(100 + t.length), key, title, priority: o.priority ?? 'Medium', assignee: o.who ?? null, reporter: o.from, channel: o.channel ?? 'whatsapp', description: o.description ?? null,
    slaStartAt: ago(o.started ?? 60), slaDueAt: o.left == null ? null : ahead(o.left), slaState: o.left != null && o.left < 60 ? 'AtRisk' : 'OnTrack', createdAt: ago(o.started ?? 60), status: 'ToDo', version: 2, activity: o.activity ?? [],
    projectName: o.project ? project.name : null, projectKey: o.project ? 'WT-5' : null, type: o.type ?? 'Loans', updatedAt: ago(t.length) });
  add('WT-5', 'Payout server disconnected', { priority: 'Critical', from: siva, who: siva, channel: 'app', started: 90.7, left: 300, description: 'Payouts to 1,284 borrowers paused', project: true, type: 'Production Support',
    activity: [{ type: 'comment', id: g(700), at: ago(80), actor: shiva, summary: 'commented', body: 'Looking at the payout workers now.' }] });
  add('ST-2302', 'NOC letter not received after closure', { from: lakshmi, channel: 'email', started: 10, left: 245 });
  add('ST-2291', 'EMI debited twice, loan account still shows overdue', { priority: 'High', from: ramesh, who: shiva, started: 160, left: 9, project: true,
    description: 'Sir my EMI ₹8,450 got debited two times on 25 Oct from SBI account. App still showing overdue and I am getting penalty SMS. Please check urgently.',
    activity: [
      { type: 'file', id: g(710), at: ago(150), actor: ramesh, summary: '2 debits · NACH · 25 Oct', fileId: g(711), fileName: 'bank_statement_oct.jpg' },
      { type: 'comment', id: g(712), at: ago(142), actor: shiva, summary: 'commented', body: "Thanks Ramesh garu, I can see both NACH debits. Checking with our payments team now — you won't be charged any penalty." },
      { type: 'ai', id: g(713), at: ago(140), actor: shiva, summary: 'linked to WT-5, duplicate NACH during failover', auto: false, action: 'LinkTicket' },
      { type: 'comment', id: g(714), at: ago(118), actor: ramesh, summary: 'commented', body: 'When will refund come? It is big amount for us.' },
    ] });
  add('ST-2288', 'Payout not credited — WT-5', { priority: 'High', from: kavya, who: siva, left: 38 });
  add('ST-2285', 'CRIF score mismatch on application', { from: nellore, who: ravi, channel: 'email', left: 52 });
  add('ST-2280', 'Unable to download repayment schedule', { from: anil, who: priya, left: 125 });
  add('ST-2277', 'Darwin Box payslip API returns 401', { from: hrops, who: rakshit, channel: 'email', left: 190 });
  add('ST-2270', 'Change registered mobile number', { from: sujatha, left: 310 });
  return t;
}
const row = (w) => ({ kind: 'ticket', id: w.id, key: w.key, title: w.title, projectId: w.projectName ? pid : null, projectKey: w.projectName ? 'WT' : null, projectName: w.projectName, status: w.status === 'Completed' ? 'Completed' : 'To Do',
  category: w.status === 'Completed' ? 'Done' : 'Todo', priority: w.priority, dueDate: null, isOverdue: false, assignee: w.assignee, typeName: w.type, updatedAt: w.updatedAt, slaStartAt: w.slaStartAt, slaDueAt: w.slaDueAt, slaState: w.slaState });
const detailOf = (w) => ({ ...row(w), description: w.description, startDate: null, reporter: w.reporter, version: w.version, createdAt: w.createdAt, updatedAt: w.updatedAt, completedAt: null, loggedMinutes: 0,
  detail: { id: w.id, status: w.status, workTypeId: g(81), workType: w.type, relatedProject: w.projectName ? { id: pid, name: project.name, key: 'WT-5' } : null, can: { edit: true, delete: true } },
  activity: [...w.activity].sort((a, b) => b.at.localeCompare(a.at)), channel: w.channel });

// ---------------------------------------------------------------- Quality: cases, runs and results
function quality(empty) {
  if (empty) return { cases: [], runs: [], results: [] };
  const cases = [
    ['Loan dispatch API returns 200 for valid PAN', 'TC-118', 'Loan dispatch', 'Critical', 'ppxp'], ['Rejects invalid PAN with 422', 'TC-119', 'Loan dispatch', 'High', 'pppp'],
    ['CRIF bureau pull under 3s', 'TC-131', 'CRIF Bureau', 'High', 'ppxs'], ['Razorpay payout webhook is idempotent', 'TC-204', 'Razorpay Payments', 'High', 'pppp'],
    ['SBI bulk file accepts 10k rows', 'TC-220', 'SBI bulk payments', 'Medium', 'pbbs'], ['Darwin Box employee sync — 401 on expired token', 'TC-305', 'Darwin Box API', 'Medium', 'pppp'],
    ['Rate limit returns 429 after 100 rpm', 'TC-140', 'Gateway', 'Low', 'ppps'], ['Masks Aadhaar in response logs', 'TC-152', 'Security', 'Critical', 'pppp'],
    ['EMI schedule matches LMS for 36 months', 'TC-171', 'Loan servicing', 'High', 'pxxs'],
  ].map(([title, key, tags, priority, dots], i) => ({ id: g(300 + i), key, title, tags, priority, dots, projectId: pid, projectName: 'SIA Internal API', createdAt: ago(9000), updatedAt: null,
    steps: i === 0 ? 'POST /sia/v1/loan/dispatch with PAN ABCPK1234F\nBureau check via CRIF sandbox\nAssert status and dispatch_id' : 'Call the API\nAssert the response', expected: i === 0 ? '200 · dispatch_id present' : 'As specified' }));
  const runs = [
    { id: g(400), name: 'DEV #212', environment: 'DEV', build: '212', status: 'Done', createdAt: ago(5000), startedAt: ago(5000), completedAt: ago(4900) },
    { id: g(401), name: 'DEV #213', environment: 'DEV', build: '213', status: 'Done', createdAt: ago(3000), startedAt: ago(3000), completedAt: ago(2900) },
    { id: g(402), name: 'UAT 1.4', environment: 'UAT', build: '214', status: 'Running', createdAt: ago(60), startedAt: ago(40), completedAt: null, releaseId: g(470) },
    { id: g(403), name: 'PROD-like', environment: 'PROD-like', build: null, status: 'Open', createdAt: ago(30), startedAt: null, completedAt: null },
  ].map((r) => ({ ...r, projectId: pid }));
  const S = { p: 'Pass', x: 'Fail', b: 'Blocked' };
  const results = [];
  cases.forEach((c) => c.dots.split('').forEach((d, j) => {
    if (d === 's') return;
    const fail = d === 'x' && j === 2;
    results.push({ id: g(500 + results.length), runId: runs[j].id, caseId: c.id, status: S[d], actual: fail ? '502 · CRIF token expired' : d === 'x' ? '401 · CRIF token expired' : null,
      evidence: fail && c.key === 'TC-118' ? '$ curl -X POST $UAT/sia/v1/loan/dispatch\nHTTP/1.1 502 Bad Gateway\n{ "error": "BUREAU_AUTH_FAILED",\n  "source": "crif-sys-api",\n  "correlationId": "7f3c-91ab-uat14" }' : null,
      runBy: me, at: ago(20), linkedWorkItemId: null });
  }));
  return { cases, runs, results };
}
const caseDto = ({ dots: _d, ...c }) => c;
function readiness(q, runId) {
  const rs = q.results.filter((r) => r.runId === runId);
  const passed = rs.filter((r) => r.status === 'Pass').length, failed = rs.filter((r) => r.status === 'Fail').length, blocked = rs.filter((r) => r.status === 'Blocked').length, ran = passed + failed + blocked;
  const blockers = rs.filter((r) => r.status === 'Fail').map((r) => q.cases.find((c) => c.id === r.caseId)).filter((c) => ['Critical', 'High'].includes(c.priority)).map((c) => ({ caseId: c.id, key: c.key, title: c.title, priority: c.priority }));
  // The mockup's numbers for the seeded UAT run (42 run, 4 failed, 2 blocked, 86%, 3 blockers) where the seed is smaller.
  const big = q.cases.length === 9 && runId === g(402) && !q.touched;
  return { run: q.runs.find((r) => r.id === runId), cases: q.cases.length, ran: big ? 42 : ran, passed: big ? 36 : passed, failed: big ? 4 : failed, blocked: big ? 2 : blocked, notRun: q.cases.length - ran,
    passPercent: big ? 86 : ran ? Math.round((passed * 100) / ran) : 0, blockers, ready: false };
}

const errors = [], checks = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const make = async (theme, state) => {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
  await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); }, theme);
  await ctx.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method(), sp = url.searchParams;
    if (url.origin !== origin || ep.startsWith('/hubs/')) { await route.abort(); return; }
    if (ep.endsWith('/avatar') || ep.endsWith('/logo/file') || ep.endsWith('/thumbnail')) { await route.fulfill({ status: 404, body: '' }); return; }
    if (!ep.startsWith('/api/')) {
      const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
      await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
      return;
    }
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status < 400 ? { data } : data) });
    const find = (id) => state.tickets.find((w) => w.id === id);
    const q = state.q;
    const m = ep.match(/^\/api\/v1\/work-items\/([0-9a-f-]{36})(\/comments)?$/);
    if (method !== 'GET' && !ep.endsWith('/auth/refresh')) {
      const b = method === 'DELETE' ? null : req.postDataJSON();
      state.writes.push({ ep, method, b });
      if (m && m[2] && method === 'POST') {
        const w = find(m[1]);
        const c = { type: 'comment', id: g(800 + state.writes.length), at: new Date().toISOString(), actor: me, summary: 'commented', body: b.body };
        w.activity.push(c);
        return json({ comment: c, time: null, timeProblem: null }, 201);
      }
      // Desk replies on the ticket's channel, and saved replies filled in from the ticket.
      const tell = ep.match(/^\/api\/v1\/work-tasks\/([0-9a-f-]{36})\/(tell-customer|fill-reply)$/);
      if (tell && tell[2] === 'tell-customer') {
        const w = find(tell[1]);
        w.activity.push({ type: 'comment', id: g(850 + state.writes.length), at: new Date().toISOString(), actor: me, summary: 'commented', body: `📣 Told the customer on WhatsApp: ${b.text}` });
        return json({ channel: w.channel === 'email' ? 'email' : 'whatsapp', sent: true, note: 'sent' });
      }
      if (tell && tell[2] === 'fill-reply') {
        const w = find(tell[1]);
        const text = b.text.replace(/\{name\}/g, w.reporter.name.split(' ')[0]).replace(/\{key\}/g, w.key).replace(/\{eta\}/g, '28 Oct, 18:00 UTC');
        return json({ text, missing: [...text.matchAll(/\{(\w+)\}/g)].map((x) => x[1]) });
      }
      if (m && !m[2] && method === 'PATCH') {
        const w = find(m[1]);
        assert.equal(b.version, w.version);
        if (b.assigneeId) w.assignee = me;
        if (b.status) w.status = b.status;
        w.version += 1;
        return json(detailOf(w));
      }
      if (ep === '/api/v1/operations/triage') return json({ workTypeId: null, workType: null, typeReason: null, priority: null, priorityReason: null, assignee: null, assigneeReason: null, routed: null,
        duplicates: [{ id: g(901), key: 'ST-2140', title: 'Double NACH debit, refund via Razorpay', status: 'Completed', assignee: null, score: .9 }, { id: g(902), key: 'ST-1987', title: 'Penalty reversal after payout outage', status: 'Completed', assignee: null, score: .8 }] });
      const res = ep.match(/^\/api\/v1\/quality\/runs\/([0-9a-f-]{36})\/results\/([0-9a-f-]{36})$/);
      if (res && method === 'PUT') {
        assert.ok(['Pass', 'Fail', 'Blocked', 'NotRun'].includes(b.status));
        q.touched = true;
        let r = q.results.find((x) => x.runId === res[1] && x.caseId === res[2]);
        if (!r) { r = { id: g(600 + q.results.length), runId: res[1], caseId: res[2], actual: null, evidence: null, linkedWorkItemId: null }; q.results.push(r); }
        Object.assign(r, { status: b.status, runBy: me, at: new Date().toISOString() });
        return json(r);
      }
      const bug = ep.match(/^\/api\/v1\/quality\/results\/([0-9a-f-]{36})\/bug$/);
      if (bug && method === 'POST') {
        const r = q.results.find((x) => x.id === bug[1]); r.linkedWorkItemId = g(990);
        return json({ result: r, workItem: { ...detailOf(state.tickets[0]), id: g(990), key: 'WT-31' } }, 201);
      }
      if (ep === '/api/v1/quality/cases' && method === 'POST') {
        assert.ok(b.title);
        const c = { id: g(350 + q.cases.length), key: `TC-${101 + q.cases.length}`, title: b.title, steps: b.steps || null, expected: b.expected || null, priority: b.priority, tags: b.tags || null, projectId: b.projectId, projectName: null, createdAt: new Date().toISOString(), updatedAt: null, dots: '' };
        q.cases.push(c);
        return json(caseDto(c), 201);
      }
      if (ep === '/api/v1/quality/runs' && method === 'POST') {
        assert.ok(b.name);
        const r = { id: g(450 + q.runs.length), name: b.name, environment: b.environment || null, build: b.build || null, status: 'Open', projectId: b.projectId, createdAt: new Date().toISOString(), startedAt: null, completedAt: null };
        q.runs.push(r);
        return json(r, 201);
      }
      assert.fail(`Unexpected write: ${method} ${ep}`);
    }
    let data = [];
    if (ep.endsWith('/auth/refresh')) data = { accessToken: `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`, expiresAt: '2099-01-01T00:00:00Z', user };
    else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, reportCount: 2, permissions: ['projects.view', 'projects.edit', 'projects.create', 'tasks.view', 'tasks.edit', 'tasks.create', 'tasks.comment', 'org.manage', 'work.view', 'work.create', 'work.edit', 'reports.view', 'reports.broad'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 0, activity: 3, documents: 3, people: 3, reports: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: {} } };
    else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: true };
    else if (ep === '/api/v1/workspace/members') data = members;
    else if (ep === '/api/v1/work-items') {
      state.lists.push(Object.fromEntries(sp));
      const status = sp.get('status') ?? 'open';
      let list = state.tickets.map(row).filter((r) => (status === 'closed' ? r.category === 'Done' : r.category !== 'Done'));
      if (sp.get('mine') === 'true') list = list.filter((r) => r.assignee?.id === user.id);
      data = { items: list, offset: 0, limit: 200, hasMore: false };
    }
    else if (m && !m[2]) data = detailOf(find(m[1]));
    else if (ep === '/api/v1/desk/reply-templates') data = [
      { id: 'ack', title: 'Acknowledge', text: 'Hi {name}, thanks for reaching out. We have logged this as {key} and will update you by {eta}.', source: 'built-in' },
      { id: 'account', title: 'Account check', text: 'Hi {name}, we are checking account {account} for you under {key}.', source: 'built-in' },
      { id: 'wa-1', title: 'Refund timeline', text: 'Refunds reach your bank in 5-7 working days.', source: 'Loans care line' },
    ];
    else if (ep === '/api/v1/quality/matrix') data = { runs: q.runs, cases: q.cases.map(caseDto), results: q.results };
    else if (ep === '/api/v1/quality/readiness') data = readiness(q, sp.get('runId'));
    else if (ep === '/api/v1/releases') data = [{ id: g(470), name: 'v1.4', projectId: pid, projectName: 'SIA Internal API', targetDate: null, status: 'Planned', notes: null, items: 3, runs: 1, approvedBy: null, approvedAt: null, shippedAt: null, createdAt: ago(9000) }];
    else if (ep === '/api/v1/projects') data = { items: [project], page: 1, pageSize: 100, totalItems: 1, totalPages: 1 };
    else if (ep === '/api/v1/work-types') data = [{ id: g(81), name: 'Bug Fix', description: null, isActive: true, order: 0 }];
    else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
    else if (ep.endsWith('/ai/status')) data = { enabled: false, configured: false, entitled: true, allowedHere: false };
    else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
    else if (ep === '/api/v1/timer') data = null;
    else if (ep === '/api/v1/chat/projects/unread') data = [];
    else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
    else if (ep === '/api/v1/priorities') data = null;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  return ctx;
};
const shot = async (page, name) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(700); await page.screenshot({ path: path.join(out, name), fullPage: false, animations: 'disabled' }); };
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => { if (e.type() === 'error' && !e.text().startsWith('Failed to load resource')) errors.push(e.text()); });
};
const waitFor = async (fn, what) => { for (let i = 0; i < 40; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 100)); } assert.fail(`timed out waiting for ${what}`); };

try {
  for (const theme of ['light', 'dark']) {
    const tag = `1440${theme === 'dark' ? '-dark' : ''}`;
    const state = { tickets: tickets(), q: quality(false), writes: [], lists: [] };
    const ctx = await make(theme, state);
    const page = await ctx.newPage();
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    // ---------------------------------------------------------------- Desk
    await page.goto(`${origin}/preview-org/desk`);
    await page.getByRole('heading', { level: 1, name: 'Desk' }).waitFor();
    for (const w of [1920, 1440, 1366]) {
      await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(150);
      if (w < 1680) await assertFills(page, '#main-content .dq-cols', `Desk ${w}`);
      await assertFillsMain(page, '#main-content .dq-cols', `Desk ${w}`);
      await assertInToolbar(page, '.v2-tb [role="tablist"][aria-label="Desk views"]', `Desk ${w}`);
      if (w === 1366 && theme === 'light' && process.env.PM_SHOT_DIR) { await page.locator('.dq-q-row, .dq-row').first().waitFor().catch(() => undefined); await page.waitForTimeout(300); await page.screenshot({ path: path.join(process.env.PM_SHOT_DIR, 'fix-desk-1366.png') }); }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    const strip = page.locator('.dq-inc');
    await strip.getByText('Critical incident · WT-5 Payout server disconnected').waitFor();
    await strip.getByText(/Payouts to 1,284 borrowers paused · Siva and Shiva on it/).waitFor();
    assert.match(await strip.locator('.dq-tm').innerText(), /^1:3\d:\d\d$/);
    assert.equal(await strip.getByRole('button', { name: 'War room' }).count(), 1);
    assert.equal(await page.locator('.dq-eyebrow').innerText(), '8 open · 3 breaching within 1h');
    const queue = page.getByRole('listbox', { name: 'Tickets' });
    const opts = queue.getByRole('option');
    await opts.first().waitFor();
    assert.equal(await opts.count(), 8);
    // By SLA left: 9m, 38m, 52m, 2h, 3h, 4h, 5h, 5h.
    assert.deepEqual((await queue.locator('.dq-ring i').allInnerTexts()).slice(0, 4), ['8m', '37m', '51m', '2h']);
    assert.match(await opts.first().getAttribute('class'), /on/);
    assert.equal(await opts.first().locator('.dq-ring.t-late').count(), 1);
    assert.equal(await opts.nth(1).locator('.dq-ring.t-warn').count(), 1);
    assert.equal(await opts.nth(3).locator('.dq-ring.t-ok').count(), 1);
    await opts.first().getByText('Ramesh Naidu · Shiva').waitFor();
    assert.equal(await opts.nth(2).locator('svg[aria-label="E-mail"]').count(), 1);
    // Each row: priority · key · channel · category (s-desk), with Assign / Resolve inline.
    assert.match(await opts.first().getByTestId('dq-row-meta').innerText(), /High\s*ST-2291 · via WhatsApp · Loans/);
    checks.push('queue');

    const conv = page.getByRole('region', { name: 'Ticket' });
    await conv.getByRole('heading', { name: 'EMI debited twice, loan account still shows overdue' }).waitFor();
    await conv.getByText('ST-2291 · via WhatsApp · Loans').waitFor();
    await conv.getByText('High', { exact: true }).waitFor();
    await conv.getByText('bank_statement_oct.jpg').waitFor();
    await conv.getByText('Internal · linked to WT-5, duplicate NACH during failover').waitFor();
    assert.equal(await conv.locator('.dq-m.out').count(), 1);
    assert.equal(await conv.locator('.dq-m.in').count(), 3);
    const ctxCol = page.getByRole('complementary', { name: 'Context' });
    await ctxCol.getByText('Ramesh Naidu', { exact: true }).waitFor();
    await ctxCol.getByText('Razorpay Payments').waitFor();
    await ctxCol.getByText('Double NACH debit, refund via Razorpay').waitFor();
    await ctxCol.getByRole('button', { name: 'Send' }).waitFor();
    // The customer card: account facts read from what they wrote, and their past tickets.
    const cust = ctxCol.getByTestId('dq-customer');
    await cust.getByText('₹8,450').waitFor(); await cust.getByText('EMI', { exact: true }).waitFor(); await cust.getByText('Past tickets').waitFor();
    await shot(page, `desk-${tag}.png`);
    checks.push('conversation');

    // j / k move through the queue; ⌘↵ posts the reply as a comment.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('j');
    await conv.getByRole('heading', { name: 'Payout not credited — WT-5' }).waitFor();
    await page.keyboard.press('k');
    await conv.getByRole('heading', { name: 'EMI debited twice, loan account still shows overdue' }).waitFor();
    await ctxCol.getByRole('button', { name: 'Edit' }).click();
    const box = conv.getByLabel('Reply');
    await waitFor(() => true, '');
    assert.match(await box.inputValue(), /Hi Ramesh/);
    await box.fill('Refund is initiated today.');
    await box.press('Control+Enter');
    // A WhatsApp ticket: the reply goes to the customer on WhatsApp (and is kept on the ticket), not only as a comment.
    await waitFor(() => state.writes.some((x) => x.ep.endsWith('/tell-customer') && x.b.text === 'Refund is initiated today.'), 'the reply sent on WhatsApp');
    checks.push('reply-on-channel');

    // Saved replies: Insert fills in the customer's name, the ticket key and the ETA.
    await conv.getByRole('button', { name: 'Saved replies' }).click();
    const sr = page.getByTestId('dq-saved');
    await sr.getByText('Acknowledge').waitFor();
    await sr.getByText('· Loans care line').waitFor();
    assert.equal(await sr.getByRole('button', { name: 'AI fill' }).count(), 0, 'no AI fill while AI is off');
    if (theme === 'light') await shot(page, 'desk-saved-replies-1440.png');
    await sr.locator('.dq-sr-i', { hasText: 'Acknowledge' }).getByRole('button', { name: 'Insert' }).click();
    await waitFor(() => state.writes.some((x) => x.ep.endsWith('/fill-reply')), 'template filled');
    await sr.waitFor({ state: 'detached' });
    assert.equal(await box.inputValue(), 'Hi Ramesh, thanks for reaching out. We have logged this as ST-2291 and will update you by 28 Oct, 18:00 UTC.');
    await box.fill('');
    checks.push('saved-replies');
    await conv.getByRole('button', { name: 'Assign' }).click();
    await waitFor(() => state.writes.some((x) => x.method === 'PATCH' && x.b.assigneeId === user.id), 'assigned to me');
    checks.push('keyboard-reply-assign');
    const lastRow = opts.last(); await lastRow.hover();
    const lastId = await lastRow.getAttribute('data-id');
    await lastRow.getByRole('button', { name: 'Resolve' }).click();
    await waitFor(() => state.writes.some((x) => x.method === 'PATCH' && x.ep.endsWith(lastId) && x.b.status === 'Completed'), 'resolved from the queue row');
    checks.push('row-resolve');
    if (theme === 'light') {
      await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'desk 390 scrolls sideways');
      await shot(page, 'desk-390.png');
      await conv.getByRole('button', { name: 'Saved replies' }).click();
      await page.getByTestId('dq-saved').getByText('Acknowledge').waitFor();
      const sheet = await page.getByTestId('dq-saved').boundingBox();
      const vw = await page.evaluate(() => document.querySelector('#main-content').getBoundingClientRect().right);
      assert.ok(sheet && sheet.x <= 1 && sheet.width >= vw - 1 && Math.abs(sheet.y + sheet.height - 844) <= 2, `saved replies is a bottom sheet on a phone (${JSON.stringify(sheet)})`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'saved replies 390 scrolls sideways');
      await shot(page, 'desk-saved-replies-390.png');
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 1440, height: 900 }); checks.push('desk-390');
    }

    // ---------------------------------------------------------------- Quality
    await page.goto(`${origin}/preview-org/quality`);
    await page.getByRole('heading', { level: 1, name: 'Quality' }).waitFor();
    await page.locator('.dq-eyebrow', { hasText: 'SIA Internal API · Release 1.4' }).waitFor();
    await page.getByText('UAT 1.4 · 86% passing · 3 blockers').waitFor();
    await page.getByText('Not ready to ship. Ship needs 95% and zero blockers when the run ends.').waitFor();
    assert.equal(await page.locator('.qa-ring span').innerText(), '86%');
    assert.deepEqual(await page.locator('.qa-st .n').allInnerTexts(), ['42', '4', '2']);
    await page.getByText('All 4 failures share the CRIF token — fix it once to clear them.').waitFor();
    const heads = await page.locator('.qa-mx thead th').allInnerTexts();
    const hd = heads.map((h) => h.replace(/\s+/g, ' ').trim().toUpperCase());
    assert.deepEqual([hd[0], hd[1], hd[2], hd[4]], ['TEST CASE', 'DEV #212', 'DEV #213', 'PROD-LIKE QUEUED']);
    assert.match(heads[3].replace(/\s+/g, ' '), /UAT 1\.4 running · \d\d:\d\d/i);
    assert.equal(await page.locator('.qa-mx tbody tr').count(), 9);
    assert.equal(await page.locator('.qa-mx .qa-d.x').count(), 4);
    assert.equal(await page.locator('.qa-mx .qa-d.b').count(), 2);
    assert.equal(await page.locator('.qa-mx .qa-d.s').count(), 4);
    assert.match(await page.locator('.qa-mx tbody tr').first().getAttribute('class'), /sel/);
    const det = page.getByRole('complementary', { name: 'Selected test case' });
    await det.getByText('Failed · UAT 1.4').waitFor();
    await det.getByRole('heading', { name: 'Loan dispatch API returns 200 for valid PAN' }).waitFor();
    await det.getByText('POST /sia/v1/loan/dispatch with PAN ABCPK1234F').waitFor();
    await det.getByText('502 · CRIF token expired').waitFor();
    await det.locator('.qa-pre .r', { hasText: '502 Bad Gateway' }).waitFor();
    // The run tests release v1.4: the bug goes into that release (and blocks its go), with a link to it.
    await det.getByText('Creates a work item in SIA Internal API, linked to this run and to release v1.4, where it blocks the go until fixed.').waitFor();
    assert.match(await det.getByRole('link', { name: 'Open v1.4 ›' }).getAttribute('href'), /\/quality\?release=/);
    await shot(page, `quality-${tag}.png`);
    checks.push('quality-matrix');

    // A click on a dot sets the result; File bug files a ticket linked to the result.
    await page.locator('.qa-mx tbody tr').nth(2).locator('td').nth(4).locator('button').click();
    await page.getByRole('menuitem', { name: 'Passed' }).click();
    await waitFor(() => state.writes.some((x) => x.method === 'PUT' && x.ep.endsWith(`/results/${g(302)}`) && x.b.status === 'Pass'), 'result set');
    await page.locator('.qa-mx tbody tr').first().click();
    await det.getByRole('button', { name: 'File bug' }).click();
    await waitFor(() => state.writes.some((x) => x.ep.endsWith('/bug')), 'bug filed');
    await det.getByRole('button', { name: 'Open bug' }).waitFor();
    checks.push('set-result-file-bug');

    // Create a case and a run.
    await page.getByRole('tab', { name: 'Cases' }).click();
    await page.getByRole('button', { name: '＋ New case' }).click();
    await page.getByLabel('Title').fill('Refund API is idempotent');
    await page.getByRole('button', { name: 'Add test case' }).click();
    await waitFor(() => state.writes.some((x) => x.ep === '/api/v1/quality/cases' && x.b.title === 'Refund API is idempotent'), 'case created');
    await page.getByRole('tab', { name: 'Runs' }).click();
    await page.getByRole('button', { name: 'New run' }).click();
    await page.getByLabel('Name').fill('UAT 1.5');
    await page.getByRole('button', { name: 'Create run' }).click();
    await waitFor(() => state.writes.some((x) => x.ep === '/api/v1/quality/runs' && x.b.name === 'UAT 1.5'), 'run created');
    checks.push('create');

    if (theme === 'dark') {
      const bg = await page.locator('.qa-det').evaluate((e) => getComputedStyle(e).backgroundColor);
      const [r, gg, b] = bg.match(/\d+/g).map(Number); assert.ok(r < 40 && gg < 40 && b < 40, `dark card (${bg})`);
      checks.push('dark');
    }
    await ctx.close();
  }

  // Empty Quality: the first test case.
  {
    const state = { tickets: tickets(), q: quality(true), writes: [], lists: [] };
    const ctx = await make('light', state);
    const page = await ctx.newPage();
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${origin}/preview-org/quality`);
    await page.getByRole('button', { name: 'Add your first test case' }).click();
    await page.getByLabel('Title').fill('Loan dispatch API returns 200');
    await page.getByRole('button', { name: 'Add test case' }).click();
    await waitFor(() => state.writes.some((x) => x.ep === '/api/v1/quality/cases'), 'first case created');
    await page.getByText('Loan dispatch API returns 200').first().waitFor();
    checks.push('empty');
    await ctx.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors }));
} finally { await browser.close(); }
