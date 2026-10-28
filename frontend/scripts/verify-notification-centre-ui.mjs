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
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/notification-centre-ui');
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
  N('r1', 'Reminder', 'reminders', 'Call the vendor about the EMI file', 12, '/work?reminder=r1', false, null),
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
  const make = async (theme = 'light') => {
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
  const shot = async (page, name) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(350); await page.screenshot({ path: path.join(out, name) }); };
  const waitFor = async (test, what) => { for (let i = 0; i < 50 && !writes.some(test); i++) await new Promise((r) => setTimeout(r, 100)); const w = writes.find(test); assert.ok(w, `expected a call: ${what}`); return w; };
  const bell = (page) => page.locator('.v2-tb [data-ncx-bell]');
  const pop = (page) => page.locator('.ncx-pop');
  const card = (page, id) => page.locator(`.ncx-card[data-id="${id}"]`);

  // ------------------------------------------------------------------ desktop
  let ctx = await make();
  let page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(origin + '/preview-org/work');
  await bell(page).waitFor();

  // The bell sits just left of + New, with the unread count (5) in a red pill; the tab title carries the same number.
  const order = await page.evaluate(() => { const b = document.querySelector('.v2-tb [data-ncx-bell]'); return b?.nextElementSibling?.classList.contains('v2-tb-new') ?? false; });
  assert.ok(order, 'the bell is immediately before + New');
  const bb = await bell(page).boundingBox(), nb = await page.locator('.v2-tb-new').boundingBox();
  assert.ok(bb.x + bb.width <= nb.x && nb.x - (bb.x + bb.width) < 20, 'bell is just left of + New');
  await page.locator('.v2-tb .ncx-badge').waitFor();
  assert.equal(await page.locator('.v2-tb .ncx-badge').innerText(), '5');
  await page.waitForFunction(() => document.title.startsWith('(5) '));
  checks.push('bell-before-new', 'badge-and-title');

  // Open: a ~400px popover; All shows the stack of three from #MuleSoft Support collapsed to one card with "2 more".
  await bell(page).click();
  await pop(page).waitFor();
  await card(page, 'm1').waitFor();
  const pb = await pop(page).boundingBox();
  assert.ok(pb.width >= 380 && pb.width <= 420, `panel width ${pb.width}`);
  assert.equal(await page.locator('.ncx-seg [role=tab]').count(), 5);
  assert.match(await page.locator('.ncx-seg [aria-selected=true]').innerText(), /^All/);
  assert.equal(await card(page, 'm2').count(), 0, 'stacked behind m1');
  assert.match(await page.locator('.ncx-more-from').first().innerText(), /2 more from #MuleSoft Support/);
  assert.match(await card(page, 'w2').innerText(), /<img src=x/);
  assert.equal(await page.evaluate(() => window.ncxUnsafe), undefined, 'notification text is text');
  assert.ok(await page.locator('.ncx-sec h3', { hasText: 'Today' }).count());
  assert.ok(await page.locator('.ncx-sec h3', { hasText: 'Earlier' }).count());
  await shot(page, 'centre-desktop.png');
  await page.locator('.ncx-more-from').first().click();
  await card(page, 'm2').waitFor();
  assert.equal(await page.locator('.ncx-stack.open .ncx-card').count(), 3);
  checks.push('panel', 'stacks-expand');
  await shot(page, 'centre-stack-open.png');

  // Inline reply: sent through the chat API to the conversation, then the notification is marked read.
  await card(page, 'm2').getByRole('button', { name: 'Reply', exact: true }).click();
  await card(page, 'm2').getByRole('textbox', { name: 'Reply' }).fill('Checking the logs now');
  await card(page, 'm2').getByRole('button', { name: 'Send reply' }).click();
  const sent = await waitFor((w) => w.method === 'POST' && w.ep === `/api/v1/chat/conversations/${CONV}/messages`, 'chat send');
  assert.equal(sent.b.body, 'Checking the logs now');
  await waitFor((w) => w.ep === '/api/v1/notifications/m2/read', 'mark read after reply');
  checks.push('inline-reply');

  // Clear a stack: one call with its ids.
  await page.locator('.ncx-stack.open .ncx-pill.x').click();
  const cleared = await waitFor((w) => w.ep === '/api/v1/notifications/clear' && w.b?.ids, 'clear stack');
  assert.deepEqual([...cleared.b.ids].sort(), ['m1', 'm2', 'm3']);
  await page.waitForFunction(() => !document.querySelector('.ncx-card[data-id="m1"]'));
  checks.push('clear-stack');

  // Snooze from the hover actions: 15 minutes.
  await card(page, 'w1').hover();
  await card(page, 'w1').getByRole('button', { name: 'Snooze', exact: true }).first().click();
  await card(page, 'w1').getByRole('menuitem', { name: '15 minutes' }).click();
  const sn = await waitFor((w) => w.ep === '/api/v1/notifications/w1/snooze', 'snooze');
  const mins = (Date.parse(sn.b.until) - Date.now()) / 60000;
  assert.ok(mins > 13 && mins < 16, `snoozed ~15 min (${mins})`);
  checks.push('snooze');

  // Delete from the hover actions.
  await card(page, 'w2').hover();
  await card(page, 'w2').getByRole('button', { name: 'Delete' }).click();
  await waitFor((w) => w.method === 'DELETE' && w.ep === '/api/v1/notifications/w2', 'delete');
  checks.push('delete');

  // Filters: Meetings asks the server for that category; the meeting starting in 5 minutes offers Join, which opens the call.
  await page.locator('.ncx-seg [role=tab]', { hasText: 'Meetings' }).click();
  await waitFor((w) => w.read && /category=meetings/.test(w.q), 'meetings filter');
  await card(page, 'k1').waitFor();
  assert.equal(await page.locator('.ncx-card').count(), 1);
  await shot(page, 'centre-meetings.png');
  await card(page, 'k1').getByRole('button', { name: 'Join' }).click();
  await page.waitForFunction((m) => location.pathname.endsWith(`/calls/meeting/w/${m}`), MEET);
  await waitFor((w) => w.ep === '/api/v1/notifications/k1/read', 'join marks read');
  checks.push('filters', 'meeting-join');

  // Click a card: opens its target and marks it read. Reminders filter, then the card itself.
  await page.goto(origin + '/preview-org/work');
  await bell(page).click();
  await page.locator('.ncx-seg [role=tab]', { hasText: 'Reminders' }).click();
  await card(page, 'r1').waitFor();
  assert.ok(await card(page, 'r1').getByRole('button', { name: 'Done' }).count(), 'reminder offers Done');
  await card(page, 'r1').locator('.ncx-open').click();
  await waitFor((w) => w.ep === '/api/v1/notifications/r1/read', 'open marks read');
  await page.waitForFunction(() => new URLSearchParams(location.search).get('reminder') === 'r1');
  assert.equal(await pop(page).count(), 0, 'the panel closes when it opens something');
  checks.push('click-navigates');

  // Mark all read, then Clear all (with a confirmation).
  items = seed();
  await page.evaluate(() => window.dispatchEvent(new Event('pm:check-notifications')));
  await bell(page).click();
  await card(page, 'm1').waitFor();
  await page.getByRole('button', { name: 'Mark all read' }).click();
  await waitFor((w) => w.ep === '/api/v1/notifications/read-all', 'mark all read');
  await page.waitForFunction(() => !document.querySelector('.v2-tb .ncx-badge'));
  await page.waitForFunction(() => !/^\(\d+\)/.test(document.title));
  await page.getByRole('button', { name: 'Clear all' }).click();
  await page.locator('.modal .btn-danger', { hasText: 'Clear' }).click();
  const all = await waitFor((w) => w.ep === '/api/v1/notifications/clear' && !w.b?.ids && !w.b?.category, 'clear all');
  assert.deepEqual(all.b, {});
  await page.locator('.ncx-empty', { hasText: 'all caught up' }).waitFor();
  await shot(page, 'centre-empty.png');
  checks.push('mark-all-read', 'clear-all', 'empty-state');
  await page.keyboard.press('Escape');
  assert.equal(await pop(page).count(), 0);

  // A new message while the app is open: an Apple-style banner with quick reply, and the badge counts it.
  items = [N('m9', 'Message', 'messages', 'Dev in #Integrations', 0, `/chat/${CONV}`, false, 'Can you approve the Darwinbox mapping?', { actions: ['reply', 'snooze'], createdAt: new Date(Date.now() + 5000).toISOString() })];
  await page.evaluate(() => window.dispatchEvent(new Event('pm:check-notifications')));
  await page.locator('.ncx-banner').waitFor();
  await page.locator('.v2-tb .ncx-badge', { hasText: '1' }).waitFor();
  await shot(page, 'banner-desktop.png');
  await page.locator('.ncx-banner').getByRole('button', { name: 'Reply', exact: true }).click();
  await page.locator('.ncx-banner').getByRole('textbox', { name: 'Reply' }).fill('Approved');
  await page.locator('.ncx-banner').getByRole('button', { name: 'Send reply' }).click();
  const bannerSent = await waitFor((w) => w.method === 'POST' && w.ep.endsWith('/messages') && w.b?.body === 'Approved', 'banner reply');
  assert.ok(bannerSent);
  checks.push('live-banner-reply');

  // Settings › Notifications › This device: Sounds & alerts.
  items = seed();
  await page.goto(origin + '/preview-org/settings/notifications/device');
  const panel = page.locator('.ncx-settings');
  await panel.waitFor();
  await panel.scrollIntoViewIfNeeded();
  await shot(page, 'settings-desktop.png');
  await panel.getByRole('radio', { name: '1 hour' }).click();
  let stored = await page.evaluate(() => JSON.parse(localStorage.getItem('pm_alert_prefs_v1')));
  assert.ok(stored.mutedUntil > Date.now() + 50 * 60000 && stored.mutedUntil < Date.now() + 61 * 60000, 'muted for an hour');
  assert.match(await panel.innerText(), /Muted until/);
  await panel.getByRole('radio', { name: 'Off', exact: true }).click();
  await panel.getByRole('switch', { name: 'Do Not Disturb' }).click();
  stored = await page.evaluate(() => JSON.parse(localStorage.getItem('pm_alert_prefs_v1')));
  assert.equal(stored.dnd, true);
  await panel.getByRole('switch', { name: 'Do Not Disturb' }).click();
  await panel.getByRole('switch', { name: 'Sound for Work' }).click();
  stored = await page.evaluate(() => JSON.parse(localStorage.getItem('pm_alert_prefs_v1')));
  assert.equal(stored.cats.work.sound, true, 'work sound was off by default and is now on');
  // Badge off for messages: the bell drops the two unread messages (5 → 3).
  await page.locator('.v2-tb .ncx-badge', { hasText: '5' }).waitFor();
  await panel.getByRole('switch', { name: 'Badge for Messages' }).click();
  await page.locator('.v2-tb .ncx-badge', { hasText: '3' }).waitFor();
  await page.waitForFunction(() => document.title.startsWith('(3) '));
  // Push for Work: the account's preferences turn the browser channel on for work kinds.
  await panel.getByRole('switch', { name: 'Push for Work' }).click();
  const put = await waitFor((w) => w.method === 'PUT' && w.ep === '/api/v1/me/notification-preferences', 'push toggle');
  assert.equal(put.b.items.find((i) => i.type === 'TaskAssigned').browser, true);
  assert.equal(put.b.items.find((i) => i.type === 'Message').browser, true, 'other categories unchanged');
  for (const s of ['Message', 'Mention', 'Meeting starting', 'Reminder', 'Critical ticket / incident', 'Reply sent']) await panel.getByRole('button', { name: `Play the ${s} sound` }).click();
  checks.push('settings-mute-dnd', 'settings-sound-banner-badge', 'settings-push', 'sound-previews');
  await ctx.close();

  // ------------------------------------------------------------------ dark mode (desktop)
  items = seed();
  ctx = await make('dark');
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(origin + '/preview-org/work');
  await bell(page).click();
  await card(page, 'm1').waitFor();
  const bg = await page.locator('.ncx-card-body').first().evaluate((e) => getComputedStyle(e).backgroundColor);
  assert.notEqual(bg, 'rgb(255, 255, 255)', 'cards are dark in dark mode');
  await shot(page, 'centre-dark.png');
  checks.push('dark');
  await ctx.close();

  // ------------------------------------------------------------------ phone
  items = seed();
  ctx = await make();
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + '/preview-org/work');
  const phoneBell = page.locator('.m-top [data-ncx-bell]');
  await phoneBell.waitFor();
  assert.equal(await page.locator('.m-top .ncx-badge').innerText(), '5');
  await shot(page, 'phone-topbar.png');
  await phoneBell.click();
  await page.locator('.ncx-pop.phone').waitFor();
  await page.waitForTimeout(400);   // the sheet slides up
  await card(page, 'm1').waitFor();
  const sb = await page.locator('.ncx-pop.phone').boundingBox();
  const vw = await page.evaluate(() => document.documentElement.clientWidth);   // the layout viewport (headless Chromium draws a classic scrollbar)
  assert.ok(sb.width >= vw - 12 && sb.x <= 1 && sb.height > 700, `full-width, full-height sheet (${sb.width}x${sb.height} of ${vw})`);
  await fitsPhone(page, 'notification centre sheet', assert);
  await shot(page, 'centre-phone.png');
  // Swipe left reveals Read · Snooze · Delete.
  const body = card(page, 'w1').locator('.ncx-card-body');
  const b = await body.boundingBox();
  await body.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: b.x + b.width - 20, clientY: b.y + 20, pointerId: 7, isPrimary: true, button: 0 });
  for (let i = 1; i <= 8; i++) await body.dispatchEvent('pointermove', { pointerType: 'touch', clientX: b.x + b.width - 20 - i * 18, clientY: b.y + 22, pointerId: 7, isPrimary: true });
  await body.dispatchEvent('pointerup', { pointerType: 'touch', clientX: b.x + b.width - 164, clientY: b.y + 22, pointerId: 7, isPrimary: true });
  await page.locator('.ncx-card.swiped[data-id="w1"]').waitFor();
  await shot(page, 'centre-phone-swipe.png');
  await card(page, 'w1').locator('.ncx-swipe-acts .delete').click();
  await waitFor((w) => w.method === 'DELETE' && w.ep === '/api/v1/notifications/w1', 'swipe delete');
  checks.push('phone-sheet', 'phone-swipe');
  await page.locator('.ncx-done').click();
  assert.equal(await page.locator('.ncx-pop').count(), 0);
  await page.goto(origin + '/preview-org/settings/notifications/device');
  await page.locator('.ncx-settings').waitFor();
  await page.locator('.ncx-settings').scrollIntoViewIfNeeded();
  await fitsPhone(page, 'sounds & alerts settings', assert);
  await shot(page, 'settings-phone.png');
  checks.push('phone-settings');
  await ctx.close();

  assert.deepEqual(errors, [], 'no page errors');
  console.log('notification centre ui ok:', checks.join(', '));
} finally { await browser.close(); }
