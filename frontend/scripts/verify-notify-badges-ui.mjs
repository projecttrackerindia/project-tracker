import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { appCsp } from './lib/csp.mjs';

// Per-tab badges and the desktop-notification check (docs/badges.md, docs/notification-sounds.md). At 1440 and on a 390x844 phone:
//  - a new notification arriving over the (mocked) live connection puts a red number on the sidebar place it belongs to (My Work for an
//    assignment, Library for a document share, Meetings for an invite) with no reload, and "(n)" in the title; the places add up to the bell;
//  - the phone tab bar shows the same (Work in the bar, Library folded into More);
//  - reading one on another device (a `notification` read event) takes it off its place everywhere;
//  - Settings → Notifications → This device: "Send test notification" walks permission, subscription, server and delivery.
// The live connection is a fake SignalR hub. Synthetic API, made-up people.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist');
const out = path.resolve(process.env.PM_UI_ARTIFACTS || 'test-results/enterprise-ui', 'notify-badges');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const g = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const user = { id: g(1), displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: g(2), slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 4 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const RS = '\u001e';
const DEST = { TaskAssigned: 'work', Document: 'library', Meeting: 'meetings' };
const CAT = { TaskAssigned: 'work', Document: 'work', Meeting: 'meetings' };
let state;
const reset = () => { state = { items: [], sockets: [], tested: 0 }; };
const counts = () => {
  const unread = state.items.filter((n) => !n.isRead);
  const tabs = {};
  for (const n of unread) { const k = `${DEST[n.type]}:${CAT[n.type]}`; tabs[k] = (tabs[k] ?? 0) + 1; }
  const by = (c) => unread.filter((n) => CAT[n.type] === c).length;
  return { unread: unread.length, needsYou: 0, forInfo: unread.length, messages: 0, reminders: 0, meetings: by('meetings'), work: by('work'), tabs };
};
const errors = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const make = async (phone, theme = 'light') => {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block',
    ...(phone ? { viewport: { width: 390, height: 844 }, userAgent: IPHONE, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } }) });
  await ctx.grantPermissions(['notifications'], { origin });
  await ctx.addInitScript((t) => {
    localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t);
    // Headless Chromium answers "denied" whatever is granted: a stand-in that records what the page shows.
    window.__shown = [];
    class FakeNotification { constructor(title, o) { window.__shown.push({ title, ...(o || {}) }); } close() {} }
    FakeNotification.permission = 'granted';
    FakeNotification.requestPermission = async () => 'granted';
    window.Notification = FakeNotification;
  }, theme);
  await ctx.routeWebSocket(/\/hubs\/chat/, (socket) => {
    state.sockets.push(socket);
    socket.onMessage((m) => { if (String(m).includes('"protocol"')) socket.send(`{}${RS}`); });
    socket.onClose(() => { state.sockets = state.sockets.filter((s) => s !== socket); });
  });
  await ctx.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
    if (url.origin !== origin) { await route.abort(); return; }
    if (ep.startsWith('/hubs/chat/negotiate')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ negotiateVersion: 1, connectionId: 'c1', connectionToken: 't1', availableTransports: [{ transport: 'WebSockets', transferFormats: ['Text', 'Binary'] }] }) });
      return;
    }
    if (ep.startsWith('/hubs/')) { await route.abort(); return; }
    if (ep.endsWith('/avatar') || ep.endsWith('/logo/file')) { await route.fulfill({ status: 404, body: '' }); return; }
    if (!ep.startsWith('/api/')) {
      const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
      await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file).catch(() => ''), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
      return;
    }
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ data }) });
    let data = [];
    if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
    else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['org.manage', 'work.view', 'chat.view', 'projects.view', 'calendar.view', 'tasks.view', 'documents.view'], modules: { projects: 3, work: 3, ai: 3, chat: 3, people: 3, documents: 3, calendar: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3 } } };
    else if (ep.startsWith('/api/v1/me/ui/')) data = { key: ep.split('/').pop(), value: null, updatedAt: null };
    else if (ep === '/api/v1/notifications/counts') data = counts();
    else if (ep === '/api/v1/notifications') { const items = url.searchParams.get('unreadOnly') === 'true' ? state.items.filter((n) => !n.isRead) : state.items; data = { items, page: 1, pageSize: 20, totalItems: items.length, totalPages: 1 }; }
    else if (ep === '/api/v1/chat/conversations') data = [];
    else if (ep === '/api/v1/chat/unread') data = { count: 0, conversations: 0, mutedMentions: 0, mutedActivity: false };
    else if (ep === '/api/v1/push') data = { publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U', devices: 1, nativeEnabled: false };
    else if (ep === '/api/v1/push/test' && method === 'POST') { state.tested++; data = { keysReady: true, devices: 1, thisDeviceKnown: false, tag: 'pt-test-1', results: [{ device: 'Chrome on Windows', thisDevice: false, status: 201, accepted: true, message: 'Accepted by the push service.' }] }; }
    else if (ep === '/api/v1/me/notification-preferences') data = [];
    else if (ep === '/api/v1/reminders/settings') data = { workDays: [1, 2, 3, 4, 5], workStart: '09:00', workEnd: '18:00', quietStart: null, quietEnd: null, defaultTime: '09:00', autoEnabled: true, dueLeads: [], overdueSteps: [], dailyAutoLimit: 5, briefingEnabled: false, briefingTime: '08:30', followDeviceTimeZone: true, muteNudges: false, timeZone: 'Asia/Kolkata' };
    else if (ep.includes('/unread') || ep.includes('/counts')) data = { count: 0, total: 0 };
    else if (ep === '/api/v1/calls/status') data = { available: true, maxParticipants: 50 };
    else if (ep === '/api/v1/timer') data = null;
    else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
    else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
    else if (ep === '/api/v1/inbox') data = { rows: [], counts: { all: 0, assigned: 0, decisions: 0, mentions: 0 }, later: 0 };
    else if (ep === '/api/v1/work-items') data = { items: [], offset: 0, limit: 200, hasMore: false };
    else if (ep === '/api/v1/projects') data = { items: [], page: 1, pageSize: 100, totalItems: 0, totalPages: 0 };
    await json(data);
  });
  return ctx;
};

const push = (target, payload) => { for (const s of state.sockets) s.send(JSON.stringify({ type: 1, target, arguments: [payload] }) + RS); };
let seq = 0;
const arrive = (type, title, link) => {
  const n = { id: g(8000 + ++seq), type, title, body: null, link, isRead: false, createdAt: new Date().toISOString(), browser: false, category: CAT[type] };
  state.items.unshift(n);
  push('notification', {});   // "somebody just created a notification for me"
  return n;
};
const badgeText = (page, scope, key) => page.evaluate(([sc, k]) => { const e = document.querySelector(`${sc} [data-badge="${k}"]`); return e && e.getBoundingClientRect().width ? { text: e.textContent, calm: e.classList.contains('calm') } : null; }, [scope, key]);
const waitBadge = (page, scope, key, text) => page.waitForFunction(([sc, k, t]) => { const e = document.querySelector(`${sc} [data-badge="${k}"]`); return t === null ? !e || e.classList.contains('calm') : e?.textContent === t && !e.classList.contains('calm'); }, [scope, key, text], { timeout: 6000 });

try {
  // ---- desktop sidebar
  reset();
  let ctx = await make(false);
  let page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`desktop: ${e.message}`));
  await page.goto(`${origin}/preview-org/`);
  await page.waitForSelector('.v2-side [data-badge], .v2-side .v2-rail-item', { timeout: 15000 });
  await page.waitForTimeout(800);
  arrive('TaskAssigned', 'Priya assigned you CB-12 Reconcile ledger', '/projects/p1/tasks/12');
  await waitBadge(page, '.v2-side', 'work', '1');
  arrive('Document', 'Kenji shared "Gateway runbook" with you', '/documents/7');
  await waitBadge(page, '.v2-side', 'library', '1');
  const invite = arrive('Meeting', 'Sprint review invite · Thu 3:00 PM', '/meet');
  await waitBadge(page, '.v2-side', 'meetings', '1');
  await page.waitForFunction(() => /^\(3\)/.test(document.title), null, { timeout: 4000 });
  assert.equal((await badgeText(page, '.v2-side', 'talk')), null, 'nothing on Messages');
  await page.screenshot({ path: path.join(out, 'desktop-1440-badges.png') });
  // Read on another device: the server says so over the live connection.
  invite.isRead = true;
  push('notification', { read: [invite.id], links: [invite.link] });
  await waitBadge(page, '.v2-side', 'meetings', null);
  await page.waitForFunction(() => /^\(2\)/.test(document.title), null, { timeout: 4000 });

  // The test notification check.
  await page.goto(`${origin}/preview-org/settings/notifications/device`);
  await page.getByTestId('push-test').waitFor({ timeout: 15000 });
  await page.getByTestId('push-test').click();
  await page.waitForFunction(() => document.querySelector('[data-step="server"]')?.getAttribute('data-state') !== 'wait', null, { timeout: 15000 });
  console.log('steps', await page.evaluate(() => [...document.querySelectorAll('[data-step]')].map((e) => e.dataset.step + '=' + e.dataset.state + ': ' + e.textContent).join(' | ')));
  assert.equal(await page.getAttribute('[data-step="permission"]', 'data-state'), 'ok');
  assert.ok(state.tested >= 1, 'the server was asked to push');
  await page.waitForFunction(() => document.querySelector('[data-step="delivery"]')?.getAttribute('data-state') === 'ok', null, { timeout: 15000 });
  assert.ok((await page.evaluate(() => window.__shown.map((n) => n.title))).includes('Test notification'));
  await page.locator('.nc-pushcheck').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(out, 'desktop-1440-push-test.png') });
  await ctx.close();

  // ---- phone tab bar
  reset();
  ctx = await make(true, 'dark');
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`phone: ${e.message}`));
  await page.goto(`${origin}/preview-org/`);
  await page.waitForSelector('.m-tabs', { timeout: 15000 });
  await page.waitForTimeout(800);
  arrive('TaskAssigned', 'Priya assigned you CB-14 Close the books', '/projects/p1/tasks/14');
  await waitBadge(page, '.m-tabs', 'work', '1');
  arrive('Document', 'Mira commented on "Release notes"', '/library/pages/3');
  // Library sits under More on a phone: More carries its number.
  await page.waitForFunction(() => [...document.querySelectorAll('.m-tabs .v2-phone-tab')].pop()?.querySelector('.v2-badge')?.textContent === '1', null, { timeout: 6000 });
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(scroll <= 0, `no horizontal scroll (${scroll})`);
  await page.screenshot({ path: path.join(out, 'phone-390-badges.png') });
  await ctx.close();
} finally { await browser.close(); }
assert.deepEqual(errors, [], errors.join('\n'));
console.log(`per-tab badges + push check ok -> ${out}`);
