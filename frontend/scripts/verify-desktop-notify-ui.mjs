import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// The Notification Centre: the bell just left of + New with an Apple-style badge (and the tab title), the popover with its filters, stacks by
// source (expand / clear), a click that opens the target and marks it read, inline reply through the chat API, snooze / delete / mark all
// read / clear all through their endpoints, Join on a meeting about to start, a live banner with quick reply, Settings › Sounds & alerts
// (mute, Do Not Disturb, per-category sound / banner / badge / push, sound previews), the phone sheet and dark mode.
// Built frontend with synthetic API fixtures only (made-up people and channels).
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/desktop-notify');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 4 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const now = Date.now(), iso = (m) => new Date(now + m * 60000).toISOString();
const CONV = '11111111-1111-1111-1111-111111111111', MEET = '22222222-2222-2222-2222-222222222222', PROJ = '33333333-3333-3333-3333-333333333333', TASK = '44444444-4444-4444-4444-444444444444';
const N = (id, type, category, title, mins, link, isRead, body = null, extra = {}) => ({ id, type, category, title, body, link, isRead, createdAt: iso(-mins), shownAt: iso(-mins), browser: true, needsYou: true, archived: false, actions: ['snooze'], ...extra });
const seed = () => [
  N('m1', 'Message', 'messages', 'Ravi in #MuleSoft Support', 2, `/chat/${CONV}`, false, 'Deploy to UAT is green, can you check the logs?', { actions: ['reply', 'snooze'] }),
  N('m2', 'Message', 'messages', 'Meena in #MuleSoft Support', 6, `/chat/${CONV}`, false, 'The token flow is fixed.', { actions: ['reply', 'snooze'] }),
  N('m3', 'Mention', 'messages', 'Kiran in #MuleSoft Support', 9, `/chat/${CONV}`, true, '@Asha please review the RAML', { actions: ['reply', 'snooze'] }),
  N('r1', 'Reminder', 'reminders', 'Call the vendor about the EMI file', 12, '/work?reminder=r1', false, null, { reason: 'You set this for 15:30' }),
  N('k1', 'Reminder', 'meetings', 'Starts in 10 minutes: Weekly sync', 5, `/calls/meeting/w/${MEET}`, false, '4:30 PM (Asia/Kolkata) · Project Tracker call', { startsAt: iso(5), joinLink: `/calls/meeting/w/${MEET}` }),
  N('w1', 'TaskAssigned', 'work', 'You were assigned PAY-12: Fix portal login', 30, `/projects/${PROJ}?task=${TASK}`, false, 'Payments Core · due Friday', { actions: ['done', 'reply', 'snooze'] }),
  N('w2', 'Comment', 'work', 'New comment on "Release notes" <img src=x onerror="window.ncxUnsafe=1">', 60 * 30, '/my-work', true, 'Looks good to me'),
];
let items = seed();
const counts = () => {
  const u = items.filter((n) => !n.isRead), c = (k) => u.filter((n) => n.category === k).length;
  return { unread: u.length, needsYou: u.length, forInfo: 0, snoozed: 0, messages: c('messages'), reminders: c('reminders'), meetings: c('meetings'), work: c('work') };
};
let prefs = [
  { type: 'Message', label: 'Messages', description: 'Chat', inApp: true, email: false, browser: true, locked: false },
  { type: 'Mention', label: 'Mentions', description: 'Mentions', inApp: true, email: true, browser: true, locked: false },
  { type: 'TaskAssigned', label: 'Assigned to me', description: 'Assigned', inApp: true, email: true, browser: false, locked: false },
  { type: 'Reminder', label: 'Your reminders', description: 'Reminders', inApp: true, email: false, browser: true, locked: false },
  { type: 'Meeting', label: 'Meetings', description: 'Meetings', inApp: true, email: true, browser: true, locked: false },
];
const writes = [], errors = [], checks = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
try {
  const make = async (theme = 'light', desktop = false) => {
    const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block', ...(desktop ? { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 ProjectTrackerDesktop/1.4.0' } : {}) });
    // The Windows / macOS app: the page hands system notifications to the main process (preload's ptDesktop.notify).
    if (desktop) await ctx.addInitScript(() => { window.ptDesktop = { notify: (n) => window.__shown.push({ title: n.title, body: n.body, tag: n.tag, native: true }), setBadge() {}, badge() {}, attention() {}, closeNotifications() {} }; });
    // A browser where the person granted notifications: every system notification the page shows is recorded.
    await ctx.addInitScript(() => {
      window.__shown = [];
      class FakeNotification { constructor(title, o) { window.__shown.push({ title, body: o?.body, tag: o?.tag }); } close() {} }
      FakeNotification.permission = 'granted';
      FakeNotification.requestPermission = async () => 'granted';
      window.Notification = FakeNotification;
    });
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
      let data = [];
      const p = url.searchParams;
      let m;
      if ((m = /^\/api\/v1\/notifications\/(\w+)\/(read|unread)$/.exec(ep)) && method === 'POST') { writes.push({ method, ep }); items = items.map((n) => (n.id === m[1] ? { ...n, isRead: m[2] === 'read' } : n)); await route.fulfill({ status: 204, body: '' }); return; }
      if ((m = /^\/api\/v1\/notifications\/(\w+)\/snooze$/.exec(ep)) && method === 'POST') { writes.push({ method, ep, b: req.postDataJSON() }); items = items.filter((n) => n.id !== m[1]); await route.fulfill({ status: 204, body: '' }); return; }
      if ((m = /^\/api\/v1\/notifications\/(\w+)$/.exec(ep)) && method === 'DELETE') { writes.push({ method, ep }); items = items.filter((n) => n.id !== m[1]); await route.fulfill({ status: 204, body: '' }); return; }
      if (ep.startsWith('/api/v1/calls/') && method !== 'GET') { await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ title: 'Not here' }) }); return; }   // the call screen Join opens
      if (ep === '/api/v1/notifications/clear' && method === 'POST') {
        const b = req.postDataJSON(); writes.push({ method, ep, b });
        const before = items.length;
        items = b.ids ? items.filter((n) => !b.ids.includes(n.id)) : b.category ? items.filter((n) => n.category !== b.category) : [];
        data = { cleared: before - items.length };
      } else if (ep === '/api/v1/notifications/read-all' && method === 'POST') { writes.push({ method, ep, q: url.search }); items = items.map((n) => ({ ...n, isRead: true })); data = null; }
      else if ((m = /^\/api\/v1\/notifications\/(\w+)\/act$/.exec(ep)) && method === 'POST') { const b = req.postDataJSON(); writes.push({ method, ep, b }); data = { message: 'Done.', archived: false }; }
      else if ((m = /^\/api\/v1\/chat\/conversations\/([0-9a-f-]+)\/messages$/.exec(ep)) && method === 'POST') { const b = req.postDataJSON(); writes.push({ method, ep, b }); data = { id: 'msg-new', conversationId: m[1], body: b.body, createdAt: iso(0) }; }
      else if (ep === '/api/v1/me/notification-preferences' && method === 'PUT') { const b = req.postDataJSON(); writes.push({ method, ep, b }); prefs = prefs.map((x) => { const c = b.items.find((i) => i.type === x.type); return c ? { ...x, ...c } : x; }); data = prefs; }
      else if (ep === '/api/v1/me/ui/sidebar') data = { key: 'sidebar', value: null, updatedAt: null };
      else {
        assert.ok(method === 'GET' || ep.endsWith('/auth/refresh'), `Unexpected write: ${method} ${ep}`);
        if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
        else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['projects.view', 'tasks.view', 'org.manage', 'reports.view', 'work.view'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 3, activity: 3, documents: 3, people: 3, reports: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3 } } };
        else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
        else if (ep === '/api/v1/notifications/counts') data = counts();
        else if (ep === '/api/v1/notifications') {
          const cat = p.get('category');
          let list = cat ? items.filter((n) => n.category === cat) : items;
          if (p.get('unreadOnly') === 'true') list = list.filter((n) => !n.isRead);
          if (p.get('archived') === 'true' || p.get('lane') === 'snoozed') list = [];
          writes.push({ method, ep, q: url.search, read: true });
          data = { items: list, page: 1, pageSize: 50, totalPages: 1, totalItems: list.length };
        } else if (ep === '/api/v1/me/notification-preferences') data = prefs;
        else if (ep === '/api/v1/push/status') data = { publicKey: 'BAAA', devices: 1 };
        else if (ep === '/api/v1/reminders/settings') data = { workDays: [1, 2, 3, 4, 5], workStart: '09:00', workEnd: '18:00', quietStart: '21:00', quietEnd: '08:00', defaultTime: '09:00', autoEnabled: true, dueLeads: [1, 0], overdueSteps: [1, 3, 7], dailyAutoLimit: 12, briefingEnabled: true, briefingTime: '08:30', followDeviceTimeZone: false, muteNudges: false, timeZone: 'Asia/Kolkata', digestTime: null };
        else if (ep === '/api/v1/reminders') data = { open: [], completed: [], sent: [], counts: { now: 0, today: 0, upcoming: 0, completed: 0 }, limits: { open: 500, recurring: 100, openUsed: 0, recurringUsed: 0 } };
        else if (ep === '/api/v1/reminders/counts') data = { now: 0, today: 0, upcoming: 0, completed: 0 };
        else if (ep.endsWith('/projects') || ep.endsWith('/tasks') || ep.endsWith('/work-tasks')) data = { items: [], page: 1, totalPages: 0, totalItems: 0 };
        else if (ep === '/api/v1/timer') data = null;
        else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
        else if (ep.endsWith('/ai/status')) data = { enabled: true, configured: true, entitled: true, allowedHere: true };
        else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
        else if (ep === '/api/v1/chat/projects/unread') data = [];
        else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
    });
    return ctx;
  };

  const run = async (prefsJson, label, reload = false, away = false, desktop = false) => {
    items = seed();
    const ctx = await make('light', desktop);
    if (prefsJson) await ctx.addInitScript((v) => { for (const k of Object.keys(localStorage)) if (k.startsWith('pm_alert')) localStorage.removeItem(k); localStorage.setItem('pm_alert_prefs_v1', v); }, prefsJson);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(origin + '/preview-org/work');
    await page.locator('.v2-tb [data-ncx-bell]').waitFor();
    await page.waitForTimeout(1500);
    // A second start on this device (warm start from the saved copy, session check in the background).
    if (reload) { await page.reload(); await page.locator('.v2-tb [data-ncx-bell]').waitFor(); await page.waitForTimeout(1500); }
    const before = await page.evaluate(() => window.__shown.length);
    // The person is in another app: the tab is hidden and has no focus.
    if (away) await page.evaluate(() => { Object.defineProperty(document, 'hidden', { get: () => true }); Object.defineProperty(document, 'visibilityState', { get: () => 'hidden' }); document.hasFocus = () => false; document.dispatchEvent(new Event('visibilitychange')); });
    // A new notification arrives (the live connection says so: CHECK_NOTIFICATIONS).
    items = [{ ...seed()[0], id: 'fresh1', title: 'Neha in #Release', body: 'Fresh one', createdAt: new Date().toISOString(), shownAt: new Date().toISOString() }, ...items];
    await page.evaluate(() => window.dispatchEvent(new Event('pm:check-notifications')));
    await page.waitForTimeout(2500);
    const shown = await page.evaluate(() => window.__shown);
    await ctx.close();
    console.log(label, JSON.stringify(shown.slice(before)));
    return shown.slice(before);
  };
  const normal = await run(null, 'default');
  const warm = await run(null, 'warm start', true);
  const away = await run(null, 'in another app', false, true);
  assert.ok(away.some((n) => n.title === 'Neha in #Release'), 'also while the person is in another app');
  const app = await run(null, 'desktop app', false, true, true);
  assert.ok(app.some((n) => n.native && n.title === 'Neha in #Release'), 'the desktop app shows a native notification');
  checks.push('desktop app native notification');
  assert.ok(warm.some((n) => n.title === 'Neha in #Release'), 'also after a warm start');
  assert.ok(normal.some((n) => n.title === 'Neha in #Release'), 'a live notification shows a system notification when permission is granted');
  checks.push('desktop notification shown');
  {
    const muted = await run(JSON.stringify({ dnd: true }), 'dnd');
    assert.equal(muted.length, 0, 'Do not disturb suppresses it');
    checks.push('suppressed by DND');
    const mutedAll = await run(JSON.stringify({ mutedUntil: -1 }), 'mute all');
    assert.equal(mutedAll.length, 0, 'Mute all suppresses it');
    const quietSound = await run(JSON.stringify({ cats: { messages: { sound: false, banner: true, badge: true } } }), 'sound off');
    assert.ok(quietSound.some((n) => n.title === 'Neha in #Release'), 'a category with its sound off still shows the system notification');
    checks.push('suppressed only by mute / DND');
  }
  assert.deepEqual(errors, []);
  console.log('OK', checks);
} finally { await browser.close(); }
