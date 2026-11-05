import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { appCsp } from './lib/csp.mjs';

// Quick actions in the app: an urgent banner shows its buttons (Reject · Approve), Reject asks for a reason inline and posts it to
// /notifications/{id}/quick, a normal-priority notice stays quiet (no buttons), and the desktop mini window (/mini). 1440 and 390, light and dark.
// Built frontend with synthetic API fixtures only (made-up people).
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/quick-actions');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 4 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const APPROVAL = '55555555-5555-5555-5555-555555555555', PROJ = '33333333-3333-3333-3333-333333333333', TASK = '44444444-4444-4444-4444-444444444444';
const now = () => new Date().toISOString();
const N = (id, type, title, body, link, extra = {}) => ({ id, type, category: 'work', title, body, link, isRead: false, createdAt: now(), shownAt: now(), browser: true, needsYou: true, archived: false, actions: [], ...extra });
let items = [];
const writes = [], errors = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });

const make = async (theme) => {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
  await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); localStorage.setItem('pm_home_mode', 'classic'); }, theme);
  await ctx.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
    if (url.origin !== origin) { await route.abort(); return; }
    if (ep.endsWith('/avatar')) { await route.fulfill({ status: 404, body: '' }); return; }
    if (!ep.startsWith('/api/')) {
      const file = path.resolve(dist, ep.startsWith('/assets/') || /^\/favicon|^\/icons\//.test(ep) ? ep.slice(1) : 'index.html');
      assert.ok(file.startsWith(dist + path.sep));
      const body = await fs.readFile(file).catch(() => null);
      if (!body) { await route.fulfill({ status: 404, body: '' }); return; }
      await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream', body, headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
      return;
    }
    let data = [], m;
    if ((m = /^\/api\/v1\/notifications\/([\w-]+)\/quick$/.exec(ep)) && method === 'POST') { const b = req.postDataJSON(); writes.push({ ep, b }); data = { message: b.action === 'reject' ? 'Rejected.' : 'Approved.', alreadyDone: false, open: null }; }
    else if (/^\/api\/v1\/notifications\/[\w-]+\/read$/.test(ep)) { await route.fulfill({ status: 204, body: '' }); return; }
    else if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
    else if (method !== 'GET') data = null;
    else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['projects.view', 'tasks.view', 'org.manage', 'reports.view', 'work.view'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 3, activity: 3, documents: 3, people: 3, reports: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3 } } };
    else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
    else if (ep === '/api/v1/notifications') data = { items, page: 1, pageSize: 50, totalPages: 1, totalItems: items.length };
    else if (ep === '/api/v1/notifications/counts') data = { unread: items.length, needsYou: items.length, forInfo: 0, snoozed: 0 };
    else if (ep === '/api/v1/my-work') data = [
      { kind: 'Task', id: TASK, key: 'PAY-12', title: 'Finalise rollout checklist', projectId: PROJ, projectKey: 'PAY', projectName: 'Payments', status: 'In progress', category: 'InProgress', priority: 'High', dueDate: now().slice(0, 10), isOverdue: false, assignee: null, typeName: null, updatedAt: now() },
      { kind: 'Task', id: 't2', key: 'PAY-14', title: 'Review the payments pull request', projectId: PROJ, projectKey: 'PAY', projectName: 'Payments', status: 'To do', category: 'ToDo', priority: 'Medium', dueDate: now().slice(0, 10), isOverdue: true, assignee: null, typeName: null, updatedAt: now() },
      { kind: 'ActionItem', id: 't3', key: 'AI-3', title: 'Send the weekly note', projectId: null, projectKey: null, projectName: null, status: 'Open', category: 'ToDo', priority: 'Low', dueDate: now().slice(0, 10), isOverdue: false, assignee: null, typeName: null, updatedAt: now() },
    ];
    else if (ep === '/api/v1/me/attendance/today') data = { date: now().slice(0, 10), timeZone: 'Asia/Kolkata', localTime: '14:16', workStart: '09:00', workEnd: '18:00', workingDay: true, onLeave: false, holiday: null, shouldPrompt: false,
      record: { id: 'a1', userId: user.id, userName: 'Asha Rao', date: now().slice(0, 10), checkInAt: new Date(Date.now() - 312 * 60000).toISOString(), checkOutAt: null, mode: 'Office', place: null, note: null, source: 'desktop', autoClosed: false, minutes: 0, checkInLocal: '9:04', checkOutLocal: null },
      recentPlaces: [], canViewTeam: false, policy: { enabled: true, hoursSource: 'workspace', workDays: '1-5', workStart: '09:00', workEnd: '18:00', checkInGraceMinutes: 15, checkOutGraceMinutes: 15, autoClose: true, autoCloseAfterHours: 12, allowedModes: ['Office', 'Home'], requireClientPlace: false, promptAtSignIn: false, timeZone: 'Asia/Kolkata' } };
    else if (ep === '/api/v1/meet') data = { from: now(), to: now(), truncated: false, items: [{ ref: 'w:m1', kind: 'workspace', id: 'm1', title: 'Design review', description: null, start: new Date(Date.now() + 12 * 60000).toISOString(), end: new Date(Date.now() + 42 * 60000).toISOString(), timeZone: 'Asia/Kolkata', projectId: null, projectName: null, projectKey: null, provider: 'ours', providerName: 'ProjectTracker', joinUrl: '/calls/meeting/w/m1', calendarUrl: null, isScrum: false, recurring: false, sessionsLeft: null, notetaker: 'off', myRsvp: 'Accepted', isOrganizer: false, canManage: false, organizerName: 'Neha K', invited: 4, accepted: 3, declined: 0, status: 'Scheduled', notes: null, live: false }] };
    else if (ep === '/api/v1/me/ui/sidebar') data = { key: 'sidebar', value: null, updatedAt: null };
    else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
    else if (ep.endsWith('/ai/status')) data = { enabled: true, configured: true, entitled: true, allowedHere: true };
    else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
    else if (ep === '/api/v1/push/status') data = { publicKey: 'BAAA', devices: 1 };
    else if (ep.endsWith('/projects') || ep.endsWith('/tasks') || ep.endsWith('/work-tasks')) data = { items: [], page: 1, totalPages: 0, totalItems: 0 };
    else if (ep === '/api/v1/timer') data = null;
    else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  return ctx;
};

const arrive = async (page, n) => {
  items = [n, ...items];
  await page.evaluate(() => window.dispatchEvent(new Event('pm:check-notifications')));
};
const noHScroll = async (page, w) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= w, `no horizontal scroll at ${w}`);

try {
  for (const theme of ['light', 'dark']) for (const [w, h, tag] of [[1440, 900, 'desktop'], [390, 844, 'phone']]) {
    items = [];
    const ctx = await make(theme);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    if (process.env.QA_DEBUG) { page.on('console', (m) => console.log('console:', m.type(), m.text().slice(0, 200))); page.on('requestfailed', (r) => console.log('failed', r.url(), r.failure()?.errorText)); page.on('response', async (r) => { if (r.url().includes('/api/') || r.status() !== 200) console.log('res', r.status(), r.url().slice(-40), (await r.text().catch(() => '')).slice(0, 120)); }); }
    await page.setViewportSize({ width: w, height: h });
    await page.goto(origin + '/preview-org/');
    if (process.env.QA_DEBUG) { await page.waitForTimeout(5000); console.log('root', await page.evaluate(() => document.body.innerHTML.slice(0, 600)), errors); console.log('scripts', await page.evaluate(() => [...document.scripts].map((x) => x.src || x.textContent.slice(0, 80)).join(' | '))); }
    page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text().slice(0, 300)); }); await page.locator('[data-ncx-bell]').first().waitFor({ timeout: 20000 });
    await page.waitForTimeout(1200);
    // A normal-priority update: no buttons (quiet).
    await arrive(page, N(`q-${theme}-${w}`, 'TaskAssigned', 'You were assigned PAY-20: Tidy the docs', 'Payments', `/projects/${PROJ}?task=${TASK}`, { priority: 'normal' }));
    await page.locator('.v2-live-card').first().waitFor();
    assert.equal(await page.locator('.v2-live-card .qa-row').count(), 0, 'a normal notice has no buttons');
    // An urgent approval: Reject · Approve.
    await arrive(page, N(`a-${theme}-${w}`, 'Approval', 'Expense approval · ₹4,200', 'Kiran · Travel', `/approvals?open=${APPROVAL}`, { priority: 'urgent' }));
    const row = page.locator('.v2-live-card .qa-row').first();
    await row.waitFor();
    assert.deepEqual(await row.locator('button').allTextContents(), ['Reject', 'Approve']);
    const card = row.locator('xpath=ancestor::*[contains(@class,"v2-live-card")]');
    await card.hover();
    if (w < 500) { const box = await row.locator('button').first().boundingBox(); assert.ok(box.height >= 44, `touch target ${box.height}`); }
    await noHScroll(page, w);
    await page.screenshot({ path: path.join(out, `banner-${tag}-${theme}.png`), clip: w < 500 ? { x: 0, y: 0, width: w, height: 420 } : { x: w - 520, y: 0, width: 520, height: 360 } });
    await row.locator('button', { hasText: 'Reject' }).click();
    const ask = page.locator('[data-testid="qa-ask"]');
    await ask.waitFor();
    await ask.locator('input').fill('Over the travel limit');
    await page.screenshot({ path: path.join(out, `banner-reject-${tag}-${theme}.png`), clip: w < 500 ? { x: 0, y: 0, width: w, height: 420 } : { x: w - 520, y: 0, width: 520, height: 360 } });
    await ask.locator('button[type=submit]').click();
    await page.waitForTimeout(400);
    const last = writes.at(-1);
    assert.ok(last && last.ep.endsWith(`/notifications/a-${theme}-${w}/quick`) && last.b.action === 'reject' && last.b.text === 'Over the travel limit', JSON.stringify(last));
    await ctx.close();

    // The desktop mini window (tray / menu bar).
    if (tag === 'desktop') {
      const mctx = await make(theme);
      const mini = await mctx.newPage();
      mini.on('pageerror', (e) => errors.push(e.message)); if (process.env.QA_DEBUG) mini.on('console', (m) => console.log('mini console', m.text().slice(0, 400)));
      await mini.setViewportSize({ width: 360, height: 520 });
      await mini.goto(origin + '/mini');
      await mini.waitForTimeout(4000); if (process.env.QA_DEBUG) console.log('mini errors', errors);
      await mini.locator('[data-testid="mini"] .mini-list li').first().waitFor({ timeout: 20000 });
      await mini.locator('.mini-meet').waitFor();
      await mini.screenshot({ path: path.join(out, `mini-${theme}.png`) });
      await noHScroll(mini, 360);
      await mctx.close();
    }
  }
  assert.deepEqual(errors, []);
  console.log('quick actions UI ok:', out);
} finally { await browser.close(); }
