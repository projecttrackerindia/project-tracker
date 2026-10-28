import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Read in one place, gone everywhere: opening a chat takes its notifications (the message notice, an @mention, a thread reply) out of the
// Notification Centre and off the bell, the tab title and the badge; read items are hidden by default and kept under "Read"; nothing pops
// up for the conversation the person is looking at. And the bell itself: a 36px round button with a strong glyph and a red badge that is
// never clipped, aligned with "Ask Groot…" and "+ New" at 1440 / 1280 / 1024, in light and dark and on the phone top bar.
// Built frontend with synthetic API fixtures only (made-up people and channels).
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/notification-read-sync-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 4 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const now = Date.now(), iso = (m) => new Date(now + m * 60000).toISOString();
const CONV = '11111111-1111-1111-1111-111111111111', OTHER = '55555555-5555-5555-5555-555555555555', PROJ = '33333333-3333-3333-3333-333333333333', TASK = '44444444-4444-4444-4444-444444444444';
const ROOT = '66666666-6666-6666-6666-666666666666';
const N = (id, type, category, title, mins, link, isRead, body = null, extra = {}) => ({ id, type, category, title, body, link, isRead, createdAt: iso(-mins), shownAt: iso(-mins), browser: true, needsYou: true, archived: false, actions: ['snooze'], ...extra });
const seed = () => [
  N('m1', 'Message', 'messages', 'Ravi', 2, `/chat/${CONV}`, false, '2 new messages. Latest: Deploy is green'),
  N('m2', 'Mention', 'messages', 'Ravi mentioned you in a group chat', 4, `/chat/${CONV}`, false, '@Asha can you check?'),
  N('m3', 'Message', 'messages', 'Ravi replied in a thread', 5, `/chat/${CONV}?thread=${ROOT}`, false, 'Thread reply'),
  N('o1', 'Message', 'messages', 'Meena', 7, `/chat/${OTHER}`, false, 'Another conversation'),
  N('w1', 'TaskAssigned', 'work', 'You were assigned PAY-12: Fix portal login', 30, `/projects/${PROJ}?task=${TASK}`, false, 'Payments Core'),
  N('x1', 'Comment', 'work', 'New comment on "Release notes"', 90, '/my-work', true, 'Looks good to me'),
];
let items = seed(), countOverride = null;
const counts = () => {
  if (countOverride) return countOverride;
  const u = items.filter((n) => !n.isRead), c = (k) => u.filter((n) => n.category === k).length;
  return { unread: u.length, needsYou: u.length, forInfo: 0, snoozed: 0, messages: c('messages'), reminders: c('reminders'), meetings: c('meetings'), work: c('work') };
};
const conv = () => ({ id: CONV, type: 'Direct', name: 'Ravi Kumar', members: [{ userId: '00000000-0000-0000-0000-000000000003', name: 'Ravi Kumar', role: 'Member', online: true, lastReadAt: iso(-60) }, { userId: user.id, name: user.displayName, role: 'Admin', online: true, lastReadAt: iso(-60) }],
  unread: items.some((n) => n.id === 'm1' && !n.isRead) ? 2 : 0, isMuted: false, canManage: false, otherUserId: '00000000-0000-0000-0000-000000000003', projectId: null, unreadMentions: 0, lastMessage: null, lastActivityAt: iso(-2) });
const msg = (i, body, mins) => ({ id: `00000000-0000-0000-0000-0000000001${String(i).padStart(2, '0')}`, conversationId: CONV, senderId: '00000000-0000-0000-0000-000000000003', senderName: 'Ravi Kumar', kind: 'User', replyTo: null, editedAt: null, body, createdAt: iso(-mins), attachments: [], reactions: [], isDeleted: false });
const writes = [], errors = [], checks = [];
let readDelay = 0;
// Checked in today: the green attendance pill sits between the bell and + New (as on the owner's account).
let attendanceOn = false;
const todayIso = new Date().toISOString().slice(0, 10);
const attendance = () => ({ date: todayIso, timeZone: 'Asia/Kolkata', localTime: '12:57', workStart: '09:30', workEnd: '18:30', workingDay: true, onLeave: false, holiday: null, shouldPrompt: false,
  record: { id: 'a1', userId: user.id, userName: user.displayName, date: todayIso, mode: 'Office', place: null, note: null, source: 'web', autoClosed: false, minutes: 0, checkInAt: new Date(Date.now() - 38 * 60000).toISOString(), checkInLocal: '12:57', checkOutAt: null, checkOutLocal: null },
  recentPlaces: [], canViewTeam: false, policy: { enabled: true, hoursSource: 'workspace', workDays: '1,2,3,4,5', workStart: '09:30', workEnd: '18:30', checkInGraceMinutes: 30, checkOutGraceMinutes: 30, autoClose: true, autoCloseAfterHours: 4, allowedModes: ['Office', 'Home', 'ClientSite'], requireClientPlace: true, promptAtSignIn: false, timeZone: 'Asia/Kolkata' } });
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
try {
  const make = async (theme = 'light') => {
    const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
    await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); localStorage.setItem('pm_home_mode', 'classic'); }, theme);
    await ctx.route('**/*', async (route) => {
      const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
      if (url.origin !== origin || ep.startsWith('/hubs/')) { await route.abort(); return; }
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
      let m;
      if ((m = /^\/api\/v1\/notifications\/(\w+)\/(read|unread)$/.exec(ep)) && method === 'POST') { writes.push({ method, ep }); items = items.map((n) => (n.id === m[1] ? { ...n, isRead: m[2] === 'read' } : n)); await route.fulfill({ status: 204, body: '' }); return; }
      if ((m = /^\/api\/v1\/chat\/conversations\/([0-9a-f-]+)\/read$/.exec(ep)) && method === 'POST') {
        // The server: every notification of mine about that conversation (message, mention, thread reply) is read.
        writes.push({ method, ep, at: Date.now() });
        if (readDelay) await new Promise((r) => setTimeout(r, readDelay));
        items = items.map((n) => (n.link && n.link.includes(`/chat/${m[1]}`) ? { ...n, isRead: true } : n));
        await route.fulfill({ status: 204, body: '' }); return;
      }
      assert.ok(method === 'GET' || ep.endsWith('/auth/refresh'), `Unexpected write: ${method} ${ep}`);
      if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
      else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['projects.view', 'tasks.view', 'org.manage', 'reports.view', 'work.view', 'chat.view'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 3, chat: 3, activity: 3, documents: 3, people: 3, reports: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3 } } };
      else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
      else if (ep === '/api/v1/notifications/counts') data = counts();
      else if (ep === '/api/v1/me/attendance/today') data = attendanceOn ? attendance() : { ...attendance(), record: null, policy: { ...attendance().policy, enabled: false } };
      else if (ep === '/api/v1/notifications') {
        const p = url.searchParams, cat = p.get('category');
        let list = cat ? items.filter((n) => n.category === cat) : items;
        if (p.get('unreadOnly') === 'true') list = list.filter((n) => !n.isRead);
        if (p.get('archived') === 'true' || p.get('lane') === 'snoozed') list = [];
        data = { items: list, page: 1, pageSize: 50, totalPages: 1, totalItems: list.length };
      } else if (ep === '/api/v1/chat/conversations') data = [conv()];
      else if (ep === `/api/v1/chat/conversations/${CONV}/messages`) data = { items: [msg(1, 'Deploy is green', 3), msg(2, 'Can you check the logs?', 2)], hasMore: false };
      else if (ep === '/api/v1/chat/questions') data = [];
      else if (ep === '/api/v1/calls/live') data = [];
      else if (ep === '/api/v1/calls/status') data = { available: true, maxParticipants: 50 };
      else if (ep === '/api/v1/me/notification-preferences') data = [];
      else if (ep === '/api/v1/push/status') data = { publicKey: 'BAAA', devices: 1 };
      else if (ep === '/api/v1/reminders/counts') data = { now: 0, today: 0, upcoming: 0, completed: 0 };
      else if (ep === '/api/v1/reminders') data = { open: [], completed: [], sent: [], counts: { now: 0, today: 0, upcoming: 0, completed: 0 }, limits: { open: 500, recurring: 100, openUsed: 0, recurringUsed: 0 } };
      else if (ep.endsWith('/projects') || ep.endsWith('/tasks') || ep.endsWith('/work-tasks')) data = { items: [], page: 1, totalPages: 0, totalItems: 0 };
      else if (ep === '/api/v1/timer') data = null;
      else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
      else if (ep.endsWith('/ai/status')) data = { enabled: true, configured: true, entitled: true, allowedHere: true };
      else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
      else if (ep === '/api/v1/chat/projects/unread') data = [];
      else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
    });
    return ctx;
  };
  const shot = async (page, name, clip) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(350); await page.screenshot({ path: path.join(out, name), ...(clip ? { clip } : {}) }); };
  const waitFor = async (test, what) => { for (let i = 0; i < 60 && !writes.some(test); i++) await new Promise((r) => setTimeout(r, 100)); const w = writes.find(test); assert.ok(w, `expected a call: ${what}`); return w; };
  const card = (page, id) => page.locator(`.ncx-card[data-id="${id}"]`);
  const badge = (page, sel = '.v2-tb') => page.locator(`${sel} .ncx-badge`);

  // WCAG contrast of the bell glyph against what is behind it (the toolbar / top bar, resolved through translucent layers to the page).
  const glyphContrast = (page, sel) => page.evaluate((s) => {
    const parse = (c) => { const srgb = c.startsWith('color('); const m = c.replace(/^color\(srgb/, '').match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0]; const k = srgb ? 255 : 1; return { r: m[0] * k, g: m[1] * k, b: m[2] * k, a: m.length > 3 ? m[3] : 1 }; };
    const over = (top, base) => ({ r: top.r * top.a + base.r * (1 - top.a), g: top.g * top.a + base.g * (1 - top.a), b: top.b * top.a + base.b * (1 - top.a), a: 1 });
    const el = document.querySelector(s);
    const layers = []; for (let e = el; e; e = e.parentElement) { const bg = parse(getComputedStyle(e).backgroundColor); if (bg.a > 0) layers.push(bg); }
    let base = { r: 255, g: 255, b: 255, a: 1 }; const docBg = parse(getComputedStyle(document.body).backgroundColor); if (docBg.a > 0) base = over(docBg, base);
    for (const l of layers.reverse()) base = over(l, base);
    const fg = parse(getComputedStyle(el.querySelector('svg')).color);
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const [a, b] = [lum(fg), lum(base)].sort((x, y) => y - x);
    return { ratio: (a + 0.05) / (b + 0.05), stroke: el.querySelector('svg').getAttribute('stroke-width'), size: Number(el.querySelector('svg').getAttribute('width')) };
  }, sel);

  const bellVisual = async (page, width, theme) => {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(250);
    const wide = width >= 1100;
    const sel = wide ? '.v2-tb [data-ncx-bell]' : '[data-ncx-bell].float';
    const bell = page.locator(sel);
    await bell.waitFor();
    await bell.locator('.ncx-badge').waitFor();
    const bb = await bell.boundingBox(), xb = await bell.locator('.ncx-badge').boundingBox();
    const vw = await page.evaluate(() => document.documentElement.clientWidth);
    assert.ok(Math.abs(bb.width - (wide ? 36 : 40)) < 0.6 && Math.abs(bb.height - bb.width) < 0.6, `round bell ${bb.width}x${bb.height} @${width}`);
    assert.ok(xb.y >= 0 && xb.x >= 0 && xb.x + xb.width <= vw && xb.height >= 17.5, `badge fully inside the viewport @${width}: ${JSON.stringify(xb)}`);
    assert.ok(xb.x > bb.x + bb.width / 2 && xb.y < bb.y + bb.height / 2, 'badge at the top-right');
    const st = await bell.locator('.ncx-badge').evaluate((e) => { const c = getComputedStyle(e); return { bg: c.backgroundColor, size: c.fontSize, weight: c.fontWeight, color: c.color, ring: c.boxShadow }; });
    assert.equal(st.bg, 'rgb(255, 59, 48)'); assert.equal(st.size, '11px'); assert.equal(st.weight, '600'); assert.equal(st.color, 'rgb(255, 255, 255)');
    assert.match(st.ring, /2px/, 'ringed in the bar colour');
    const g = await glyphContrast(page, sel);
    assert.ok(g.ratio >= 7, `bell glyph contrast ${g.ratio.toFixed(2)} @${width} ${theme}`);
    assert.equal(g.stroke, '1.75'); assert.ok(Math.abs(g.size - 20) < 0.6, `20px glyph (${g.size})`);
    if (wide) {
      const ask = await page.locator('.v2-tb-ask').boundingBox(), nw = await page.locator('.v2-tb-new').boundingBox();
      const pill = await page.locator('.v2-tb [data-testid="att-pill"]').boundingBox();
      assert.ok(pill, 'attendance pill present');
      const mid = (r) => r.y + r.height / 2;
      assert.ok(Math.abs(mid(bb) - mid(nw)) <= 1 && Math.abs(mid(bb) - mid(ask)) <= 1 && Math.abs(mid(bb) - mid(pill)) <= 1, `bell centred with Ask, the attendance pill and + New @${width}`);
      assert.ok(bb.x > ask.x + ask.width && bb.x + bb.width <= pill.x && pill.x + pill.width <= nw.x, 'Ask, bell, attendance pill, + New in order');
      assert.ok(xb.x + xb.width <= pill.x - 2, `badge clear of the attendance pill @${width}`);
      assert.ok(pill.x - (bb.x + bb.width) >= 6, 'breathing room between the bell and the pill');
      const tb = await page.locator('.v2-tb').boundingBox();
      await shot(page, `bell-${theme}-${width}.png`, { x: Math.max(0, tb.x + tb.width - 520), y: 0, width: Math.min(520, tb.width), height: 60 });
    } else await shot(page, `bell-${theme}-${width}.png`, { x: width - 220, y: 0, width: 220, height: 70 });
    checks.push(`bell-${theme}-${width}`);
  };

  // ------------------------------------------------------------------ desktop: read sync
  let ctx = await make();
  let page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(origin + '/preview-org/work');
  await badge(page).waitFor();
  assert.equal(await badge(page).innerText(), '5');
  await page.waitForFunction(() => document.title.startsWith('(5) '));

  // The centre lists only unread; the one read comment is under a collapsed "Read".
  await page.locator('.v2-tb [data-ncx-bell]').click();
  await card(page, 'm1').waitFor();
  assert.equal(await card(page, 'x1').count(), 0, 'read hidden by default');
  assert.equal(await page.locator('.ncx-read-toggle').getAttribute('aria-expanded'), 'false');
  await shot(page, 'centre-light-before.png');
  await page.locator('.ncx-read-toggle').click();
  await card(page, 'x1').waitFor();
  await page.locator('.ncx-read-toggle').click();
  checks.push('unread-only', 'read-collapsed');

  // Open the chat from its notification: the message notice, the @mention and the thread reply all leave the unread list, the bell drops to
  // 2 and the title follows; only one notification-read call was made (for m1) - the rest came with reading the conversation.
  readDelay = 1500;
  await page.locator('.ncx-more-from').first().click();
  await card(page, 'm1').locator('.ncx-open').click();
  await page.waitForFunction((c) => location.pathname.endsWith(`/messages/${c}`), CONV);
  await waitFor((w) => w.ep === `/api/v1/chat/conversations/${CONV}/read`, 'conversation read');
  await page.waitForFunction(() => document.querySelector('.v2-tb .ncx-badge')?.textContent === '2', null, { timeout: 8000 });
  await page.waitForFunction(() => document.title.startsWith('(2) '));
  assert.ok(!writes.some((w) => /notifications\/(m2|m3)\/read/.test(w.ep)), 'm2 and m3 were read by reading the conversation, not one by one');
  await page.locator('.v2-tb [data-ncx-bell]').click();
  await card(page, 'o1').waitFor();
  for (const id of ['m1', 'm2', 'm3']) assert.equal(await page.locator(`.ncx-sec:not(.ncx-read) .ncx-card[data-id="${id}"]`).count(), 0, `${id} left the unread list`);
  assert.match(await page.locator('.ncx-read-toggle').innerText(), /Read\s*4/);
  await page.locator('.ncx-read-toggle').click();
  await page.locator('.ncx-read .ncx-card[data-id="x1"]').waitFor();
  assert.ok(await page.locator('.ncx-read .ncx-card').count() >= 2, 'the chat notices are under Read');
  await shot(page, 'centre-light-after-chat.png');
  await page.keyboard.press('Escape');
  checks.push('open-chat-clears-its-notices', 'badge-decrements', 'title-decrements', 'read-visible-under-read');

  // A new notification about the conversation on screen: no banner; one about another conversation: a banner.
  readDelay = 0;
  await page.bringToFront();
  items = [N('m9', 'Message', 'messages', 'Ravi', 0, `/chat/${CONV}`, false, 'One more thing', { createdAt: new Date(Date.now() + 4000).toISOString() }), ...items];
  await page.evaluate(() => window.dispatchEvent(new Event('pm:check-notifications')));
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('.ncx-banner').count(), 0, 'no banner for the conversation being read');
  items = [N('o9', 'Message', 'messages', 'Meena', 0, `/chat/${OTHER}`, false, 'Elsewhere', { createdAt: new Date(Date.now() + 4000).toISOString() }), ...items];
  await page.evaluate(() => window.dispatchEvent(new Event('pm:check-notifications')));
  await page.locator('.ncx-banner').waitFor();
  assert.match(await page.locator('.ncx-banner').innerText(), /Meena/);
  checks.push('no-banner-for-open-conversation');
  await ctx.close();

  // ------------------------------------------------------------------ the bell: light and dark, 1440 / 1280 / 1024
  attendanceOn = true;
  for (const theme of ['light', 'dark']) {
    items = seed();
    ctx = await make(theme);
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(origin + '/preview-org/work');
    for (const w of [1440, 1280, 1024]) await bellVisual(page, w, theme);
    // 99+ cap, still inside the viewport and clear of + New.
    await page.setViewportSize({ width: 1280, height: 900 });
    countOverride = { unread: 140, needsYou: 140, forInfo: 0, snoozed: 0, messages: 140, reminders: 0, meetings: 0, work: 0 };
    await page.evaluate(() => window.dispatchEvent(new Event('pm:check-notifications')));
    await page.waitForFunction(() => document.querySelector('.v2-tb .ncx-badge')?.textContent === '99+', null, { timeout: 8000 });
    const xb = await badge(page).boundingBox(), nw = await page.locator('.v2-tb [data-testid="att-pill"]').boundingBox();
    assert.ok(xb.x + xb.width <= nw.x - 2, '99+ clear of the attendance pill');
    await shot(page, `bell-${theme}-99plus.png`, { x: 1280 - 520, y: 0, width: 520, height: 60 });
    countOverride = null;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => window.dispatchEvent(new Event('pm:check-notifications')));
    await page.locator('.v2-tb [data-ncx-bell]').click();
    await card(page, 'm1').waitFor();
    await shot(page, `centre-${theme}.png`);
    checks.push(`99plus-${theme}`);
    await ctx.close();
  }

  // ------------------------------------------------------------------ phone top bar (light and dark)
  for (const theme of ['light', 'dark']) {
    items = seed();
    ctx = await make(theme);
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(origin + '/preview-org/work');
    const pb = page.locator('.m-top [data-ncx-bell]');
    await pb.waitFor();
    await page.locator('.m-top .ncx-badge').waitFor();
    assert.equal(await page.locator('.m-top .ncx-badge').innerText(), '5');
    const bb = await pb.boundingBox(), xb = await page.locator('.m-top .ncx-badge').boundingBox();
    assert.ok(bb.width >= 36 && bb.height >= 36, 'phone bell is a comfortable tap target');
    assert.ok(xb.x + xb.width <= 390 && xb.y >= 0, 'phone badge inside the viewport');
    const g = await glyphContrast(page, '.m-top [data-ncx-bell]');
    assert.ok(g.ratio >= 7, `phone bell glyph contrast ${g.ratio.toFixed(2)} ${theme}`);
    await fitsPhone(page, 'phone top bar', assert);
    await shot(page, `phone-topbar-${theme}.png`, { x: 0, y: 0, width: 390, height: 120 });
    await pb.click();
    await page.locator('.ncx-pop.phone').waitFor();
    await page.waitForTimeout(400);
    await card(page, 'm1').waitFor();
    assert.equal(await card(page, 'x1').count(), 0, 'phone: read hidden by default');
    await fitsPhone(page, 'centre sheet', assert);
    await shot(page, `phone-centre-${theme}.png`);
    checks.push(`phone-${theme}`);
    await ctx.close();
  }

  assert.deepEqual(errors, [], 'no page errors');
  console.log('notification read sync ui ok:', checks.join(', '));
} finally { await browser.close(); }
