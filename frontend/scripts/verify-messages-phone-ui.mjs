import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { cutOff } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Messages on a phone (owner's iPhone recording): a chat with a very long link, a code block with a long line and a JSON file card must
// never make the page scroll sideways (the "shake" on open, the list left shifted on Back); an open conversation is a full-screen view
// (its own sticky header under the status bar, no app top bar, no tab bar) with the composer clear of the home indicator; the list keeps
// the tab bar; Back leaves the list at scrollX 0. 390x844 iPhone with touch, light and dark. Synthetic API, made-up people.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist');
const out = path.resolve(process.env.PM_UI_ARTIFACTS || 'test-results/enterprise-ui', 'messages-phone');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const ago = (m) => new Date(Date.now() - m * 60_000).toISOString();
const g = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const user = { id: g(1), displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: g(2), slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 3 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const members = [{ userId: user.id, name: user.displayName, role: 'Admin', online: true, lastReadAt: ago(1) }, { userId: g(11), name: 'Tomas Velde', role: 'Member', online: true, lastReadAt: ago(1) }];
const group = { id: g(100), type: 'Group', name: 'Orbit Support', members, unread: 0, isMuted: false, canManage: true, otherUserId: null, projectId: null, unreadMentions: 0,
  lastMessage: { snippet: 'payload attached', senderName: 'Tomas Velde', isMine: false, isSystem: false, at: ago(2) }, lastActivityAt: ago(2) };
// More conversations for the swipe checks: one whose last message is a raw payload (its preview must read "Code snippet"), and enough to scroll.
const direct = (n, name, snippet, mins, isMine = false) => ({ id: g(200 + n), type: 'Direct', name, members: [members[0], { userId: g(300 + n), name, role: 'Member', online: false, lastReadAt: ago(1) }],
  unread: 0, isMuted: false, canManage: false, otherUserId: g(300 + n), projectId: null, unreadMentions: 0, lastMessage: { snippet, senderName: name, isMine, isSystem: false, at: ago(mins) }, lastActivityAt: ago(mins) });
const others = [direct(1, 'Mira Ostrova', '{ payload=org.example.runtime.core.internal.streaming.bytes.ManagedCursorStreamProvider@8fc0 }', 5),
  direct(2, 'Kenji Arlo', 'Sent a file: release-notes-v4.pdf', 40, true),
  direct(3, 'Lena Brook', 'see https://docs.example.test/guides/deploy?tab=2', 90),
  ...['Omar Fell', 'Priya Lune', 'Sven Holt', 'Dara Quill', 'Ines Varga', 'Theo Marsh', 'Yuki Pell', 'Ravi Stone', 'Nora Vale'].map((nm, i) => direct(10 + i, nm, `Status update number ${i + 1}, all good here`, 200 + i * 60))];
const payload = JSON.stringify({ application: 's-orbit-external-api', port: 8816, endpoint: '/api/external/orbitBox/AttendancePunchesApiWithAVeryLongSegmentName/' + 'x'.repeat(160), items: Array.from({ length: 8 }, (_, i) => ({ id: i, note: 'n'.repeat(90) })) });
const longUrl = 'https://uat-api.orbit.example.test/dbx/system/1.0/orbitBox/getCheckInStatusWithAnExtremelyLongPathSegment/' + 'a'.repeat(140) + '?token=' + 'Z'.repeat(80);
const code = '```\nApplication: s-orbit-external-api\nPort: 8816\nEndpoint: api/external/orbitBox/AttendancePunchesApi' + 'Q'.repeat(150) + '\n```';
let messages, seq = 0;
const M = (mine, body, mins, attachments = []) => ({ id: g(1000 + ++seq), conversationId: group.id, senderId: mine ? user.id : g(11), senderName: mine ? user.displayName : 'Tomas Velde',
  kind: 'User', replyTo: null, editedAt: null, body, createdAt: ago(mins), attachments, reactions: [], isDeleted: false });
const reset = () => { seq = 0; messages = [M(false, 'Morning, the meeting link is below', 30), M(true, longUrl, 28), M(true, `CIBIL meeting link ${longUrl}`, 27), M(false, code, 20),
  M(false, '', 10, [{ id: g(900), fileName: 'orbit-payload.json', contentType: 'application/json', sizeBytes: payload.length, isImage: false }]), M(true, 'send it as mail', 2)]; };
const errors = [], writes = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID = IPHONE;

const make = async (theme, device) => {
  const phone = device === 'iphone' ? { viewport: { width: 390, height: 844 }, userAgent: IPHONE, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
    : device === 'android' ? { viewport: { width: 412, height: 915 }, userAgent: ANDROID, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } };
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block', ...phone });
  await ctx.addInitScript((t) => {
    localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t);
    // A visualViewport the test can shrink the way iOS does (height and offsetTop change, innerHeight does not).
    const real = window.visualViewport; if (!real) return;
    const fake = new EventTarget(); window.__vv = null;
    for (const k of ['width', 'scale', 'offsetLeft', 'pageLeft', 'pageTop']) Object.defineProperty(fake, k, { get: () => real[k] });
    Object.defineProperty(fake, 'height', { get: () => window.__vv?.height ?? real.height });
    Object.defineProperty(fake, 'offsetTop', { get: () => window.__vv?.offsetTop ?? real.offsetTop });
    real.addEventListener('resize', () => fake.dispatchEvent(new Event('resize'))); real.addEventListener('scroll', () => fake.dispatchEvent(new Event('scroll')));
    Object.defineProperty(window, 'visualViewport', { get: () => fake, configurable: true });
  }, theme);
  await ctx.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
    if (url.origin !== origin || ep.startsWith('/hubs/')) { await route.abort(); return; }
    if (ep.endsWith('/avatar') || ep.endsWith('/logo/file')) { await route.fulfill({ status: 404, body: '' }); return; }
    if (!ep.startsWith('/api/')) {
      const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
      await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file).catch(() => ''), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
      return;
    }
    const json = (data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
    if (method !== 'GET' && !ep.endsWith('/auth/refresh')) writes.push({ ep, method, body: req.postData() });
    let data = [];
    if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
    else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['org.manage', 'work.view', 'work.edit', 'work.create', 'chat.view', 'projects.view', 'calendar.view', 'tasks.view', 'tasks.create'], modules: { projects: 3, work: 3, ai: 3, chat: 3, people: 3, documents: 3, calendar: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3, CHAT_ATTACHMENTS: 3 } } };
    else if (ep.startsWith('/api/v1/me/ui/')) data = { key: ep.split('/').pop(), value: null, updatedAt: null };
    else if (ep === '/api/v1/talk/conversations') data = { items: [{ id: group.id, kind: 'chat', title: group.name, sub: 'Group', last: 'Tomas: Deploy is green', at: ago(2), unread: 0, group: true, account: null, messageId: null, meetingRef: null, sessionStart: null, live: false, upcoming: false, joinUrl: null, avatar: { initials: 'OS', userId: null, hasAvatar: false, square: false } }], mail: { state: 'not-connected', account: null, email: null, provider: null }, chatAvailable: true };
    else if (ep === '/api/v1/chat/conversations') data = [group, ...others];
    else if (ep === `/api/v1/chat/conversations/${group.id}/messages` && method === 'GET') data = { items: messages, hasMore: false };
    else if (ep === `/api/v1/chat/conversations/${group.id}/messages` && method === 'POST') { const b = JSON.parse(req.postData() || '{}'); const m = M(true, b.body, 0); messages.push(m); data = m; }
    else if (/\/chat\/messages\/[^/]+$/.test(ep) && method === 'PUT') { const id = ep.split('/').pop(); const b = JSON.parse(req.postData() || '{}'); const m = messages.find((x) => x.id === id); Object.assign(m, { body: b.body, editedAt: ago(0) }); data = m; }
    else if (ep === '/api/v1/chat/ai/transform') {
      const b = JSON.parse(req.postData() || '{}');
      const text = b.action === 'translate' ? `[${b.language}] ${b.text}` : b.action === 'fix' ? 'Hi team! We need more preparation for the production release.' : `Improved: ${b.text}`;
      data = { text, blocks: null, model: 'synthetic', inline: true };
    }
    else if (ep.endsWith('/replies')) data = { replies: ['Thanks, I will check the staging slot.'], model: 'synthetic' };
    else if (ep.startsWith('/api/v1/chat/files/')) { await route.fulfill({ status: 200, contentType: 'application/json', body: payload }); return; }
    else if (ep.endsWith('/pins')) data = [];
    else if (ep.endsWith('/files')) data = { items: [], hasMore: false };
    else if (ep.endsWith('/messages') && method === 'GET') data = { items: [], hasMore: false };
    else if (ep === '/api/v1/chat/questions') data = [];
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

const isShown = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].some((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0'; }), sel);
const noSideways = async (page, what) => {
  const w = await page.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, iw: innerWidth, x: scrollX }));
  assert.ok(w.sw <= w.iw, `${what}: scrollWidth ${w.sw} <= ${w.iw}`);
  assert.equal(w.x, 0, `${what}: scrollX 0`);
  assert.deepEqual(await cutOff(page), [], `${what}: nothing cut off at the right edge`);
};
const shots = [];
const run = async (theme) => {
  reset();
  const tag = `390-${theme}`;
  const ctx = await make(theme, 'iphone'); const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  await page.goto(`${origin}/preview-org/messages`);
  await page.locator('.talk-list .talk-row').first().waitFor();
  await page.waitForTimeout(500);
  await noSideways(page, `${tag} list`);
  assert.equal(await isShown(page, '.m-tabs'), true, `${tag}: tab bar on the list`);
  await page.locator('.talk-row', { hasText: 'Orbit Support' }).first().click();
  await page.locator('.talk-thread .composer-editable').waitFor();
  // Sample during the push: the page must never become wider than the screen.
  for (let i = 0; i < 6; i++) { const sw = await page.evaluate(() => document.scrollingElement.scrollWidth - innerWidth); assert.ok(sw <= 0, `${tag}: no sideways scroll during the push (${sw})`); await page.waitForTimeout(70); }
  await page.locator('.talk-thread .msg-code').first().waitFor();
  await page.locator('.talk-thread [data-testid="payload-card"], .talk-thread .chat-file').first().waitFor();
  await page.waitForTimeout(600);
  await noSideways(page, `${tag} thread`);
  assert.equal(await isShown(page, '.m-tabs'), false, `${tag}: no tab bar in a conversation`);
  assert.equal(await isShown(page, '.m-top'), false, `${tag}: no app top bar over the conversation header`);
  const head = await page.locator('.talk-thread .talk-head').boundingBox();
  assert.ok(head && head.y >= -0.5 && head.y <= 2, `${tag}: conversation header at the top (${head?.y})`);
  assert.equal(await page.locator('.talk-thread .talk-head').evaluate((e) => getComputedStyle(e).position), 'sticky');
  assert.ok(await page.getByRole('button', { name: /back/i }).first().isVisible(), `${tag}: Back visible`);
  const vh = page.viewportSize().height;
  const c = await page.locator('.talk-thread .composer').boundingBox();
  const safe = await page.evaluate(() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;height:env(safe-area-inset-bottom,0px)'; document.body.append(d); const h = d.offsetHeight; d.remove(); return h; });
  assert.ok(c.y + c.height >= vh - safe - 1 && c.y + c.height <= vh + 1, `${tag}: composer at the bottom (${Math.round(c.y + c.height)} vs ${vh}, safe ${safe})`);
  const pad = await page.locator('.talk-thread .composer').evaluate((e) => getComputedStyle(e).paddingBottom);
  assert.ok(parseFloat(pad) >= 8, `${tag}: composer padded off the home indicator (${pad})`);
  // Code and file cards fit their bubble and scroll inside it.
  for (const sel of ['.talk-thread .msg-code', '.talk-thread [data-testid="payload-card"], .talk-thread .chat-file']) {
    const b = await page.locator(sel).first().boundingBox();
    assert.ok(b.x >= 0 && b.x + b.width <= 390 + 0.5, `${tag}: ${sel} inside the screen (${Math.round(b.x)}..${Math.round(b.x + b.width)})`);
  }
  shots.push(path.join(out, `thread-${tag}.png`)); await page.screenshot({ path: shots.at(-1) });
  await page.locator('.talk-thread .chat-back').first().click();
  await page.locator('.talk-list .talk-row').first().waitFor();
  await page.waitForTimeout(700);
  await noSideways(page, `${tag} back to list`);
  const row = await page.locator('.talk-row', { hasText: 'Orbit Support' }).first().boundingBox();
  assert.ok(row.x >= -0.5, `${tag}: list rows not shifted left (${row.x})`);
  assert.equal(await isShown(page, '.m-tabs'), true, `${tag}: tab bar back on the list`);
  shots.push(path.join(out, `list-${tag}.png`)); await page.screenshot({ path: shots.at(-1) });
  await ctx.close();
};
// Real touch input through CDP: a finger down, moved in steps over `ms`, then up.
const touch = async (page, x, y, dx, dy, { steps = 12, ms = 240, hold = false } = {}) => {
  const cdp = await page.context().newCDPSession(page);
  const pt = (px, py) => [{ x: px, y: py, id: 1, radiusX: 6, radiusY: 6, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(x, y) });
  for (let i = 1; i <= steps; i++) { await page.waitForTimeout(ms / steps); await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(x + (dx * i) / steps, y + (dy * i) / steps) }); }
  const up = async () => { await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach(); };
  if (hold) return up;
  await up();
};
const rowBox = (page, name) => page.locator(`.talk-row[data-row="${name}"]`).boundingBox();
const states = (page) => page.$$eval('[data-swipe-row]', (els) => els.map((e) => ({ name: e.querySelector('.talk-row')?.getAttribute('data-row'), s: e.getAttribute('data-swipe'), tx: new DOMMatrix(getComputedStyle(e.querySelector('.talk-row')).transform).m41 })));
const openRows = async (page) => (await states(page)).filter((r) => r.s !== 'closed' || Math.abs(r.tx) > 0.5);
const swipeChecks = async () => {
  reset();
  const ctx = await make('light', 'iphone'); const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`swipe: ${e.message}`));
  await page.goto(`${origin}/preview-org/messages`);
  await page.locator('.talk-row[data-row="Mira Ostrova"]').waitFor();
  await page.waitForTimeout(500);
  // Readable previews.
  const prev = async (n) => (await page.locator(`.talk-row[data-row="${n}"] .talk-preview`).innerText()).trim();
  assert.equal(await prev('Mira Ostrova'), 'Code snippet', 'a JSON/payload message previews as "Code snippet"');
  assert.equal(await prev('Kenji Arlo'), 'You: 📎 release-notes-v4.pdf', 'a file previews as 📎 name with You:');
  assert.equal(await prev('Lena Brook'), 'see docs.example.test', 'a link previews as its domain');
  const at = async (n) => { const b = await rowBox(page, n); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  const settle = () => page.waitForTimeout(450);
  // 1. A short, slow swipe snaps back closed.
  let p = await at('Mira Ostrova');
  await touch(page, p.x, p.y, -34, 0, { ms: 500 }); await settle();
  assert.deepEqual(await openRows(page), [], 'a partial swipe snaps back');
  // 2. A real swipe opens the row fully (two buttons, 148px), never at a partial offset.
  await touch(page, p.x, p.y, -110, 0, { ms: 260 }); await settle();
  let o = await openRows(page);
  assert.equal(o.length, 1, 'one row open'); assert.equal(o[0].name, 'Mira Ostrova'); assert.equal(o[0].s, 'r'); assert.ok(Math.abs(o[0].tx + 148) < 1, `fully open at -148 (${o[0].tx})`);
  shots.push(path.join(out, 'swipe-open-390.png')); await page.screenshot({ path: shots.at(-1) });
  // 3. Swiping another row closes the first.
  const q = await at('Lena Brook');
  await touch(page, q.x, q.y, -110, 0, { ms: 260 }); await settle();
  o = await openRows(page);
  assert.deepEqual(o.map((r) => r.name), ['Lena Brook'], 'opening a second row closes the first');
  // A tap elsewhere closes it.
  await page.locator('.talk-large').tap(); await settle();
  assert.deepEqual(await openRows(page), [], 'a tap elsewhere closes the open row');
  // 4. A mostly vertical drag over rows scrolls the list and never slides a row sideways (sampled mid-gesture).
  const k = await at('Omar Fell');
  const up = await touch(page, k.x, k.y, 20, -220, { ms: 300, hold: true });
  const mid = (await states(page)).filter((r) => Math.abs(r.tx) > 0.5);
  await up(); await settle();
  assert.deepEqual(mid, [], 'no row moves sideways while scrolling vertically');
  assert.deepEqual(await openRows(page), [], 'no row open after a vertical scroll');
  await page.locator('.talk-scroll').evaluate((e) => { e.scrollTop = 0; }); await settle();
  // 5. A filter switch resets open rows; Unread shows its own empty state at once with no ghost rows.
  p = await at('Mira Ostrova');
  await touch(page, p.x, p.y, -110, 0, { ms: 260 }); await settle();
  assert.equal((await openRows(page)).length, 1);
  await page.getByRole('button', { name: /^Unread/ }).tap();
  await page.waitForTimeout(40);
  assert.equal(await page.locator('.talk-list .talk-row').count(), 0, 'no outgoing rows stacked over the Unread empty state');
  const empty = page.locator('[data-testid="talk-empty"]');
  assert.match(await empty.innerText(), /No unread messages/); assert.doesNotMatch(await empty.innerText(), /No conversations yet/);
  assert.ok(await empty.getByRole('button', { name: 'Show all' }).isVisible(), 'Unread empty state offers Show all');
  shots.push(path.join(out, 'unread-empty-390.png')); await page.screenshot({ path: shots.at(-1) });
  await empty.getByRole('button', { name: 'Show all' }).tap();
  await page.locator('.talk-row[data-row="Mira Ostrova"]').waitFor(); await settle();
  assert.deepEqual(await openRows(page), [], 'back on All, nothing is left open');
  // 6. Open a row, then open a chat and come back: everything closed.
  await touch(page, p.x, p.y, 110, 0, { ms: 260 }); await settle();
  o = await openRows(page); assert.equal(o[0]?.s, 'l', 'swipe right opens the leading actions');
  await page.locator('.talk-row[data-row="Orbit Support"]').tap(); await settle();
  await page.locator('.talk-row[data-row="Orbit Support"]').tap();
  await page.locator('.talk-thread .composer-editable').waitFor();
  await page.locator('.talk-thread .chat-back').first().tap();
  await page.locator('.talk-row[data-row="Mira Ostrova"]').waitFor(); await settle();
  assert.deepEqual(await openRows(page), [], 'after a chat and Back, no row is open');
  await noSideways(page, 'swipe list');
  // 7. A full swipe left hides the row, with Undo.
  p = await at('Lena Brook');
  await touch(page, p.x, p.y, -330, 0, { ms: 300 }); await settle();
  assert.equal(await page.locator('.talk-row[data-row="Lena Brook"]').count(), 0, 'a full swipe runs Hide');
  const undo = page.getByRole('button', { name: 'Undo' }).first();
  await undo.waitFor(); await undo.tap();
  await page.locator('.talk-row[data-row="Lena Brook"]').waitFor({ timeout: 3000 }); await settle();
  assert.deepEqual(await openRows(page), [], 'no row left at a partial offset');
  await ctx.close();
};
const desktopList = async () => {
  reset();
  const ctx = await make('light', 'desktop'); const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`1440: ${e.message}`));
  await page.goto(`${origin}/preview-org/messages`);
  await page.locator('.talk-row[data-row="Mira Ostrova"]').waitFor(); await page.waitForTimeout(500);
  const list = await page.locator('.talk-list').boundingBox();
  assert.ok(list.width >= 300 && list.width <= 340, `desktop list column keeps its width (${list.width})`);
  assert.equal(await page.locator('.talk-row[data-row="Mira Ostrova"] .talk-preview').innerText(), 'Code snippet');
  assert.equal(await page.locator('.talk-scroll').evaluate((e) => e.scrollWidth <= e.clientWidth), true, 'list never scrolls sideways');
  for (const pr of await page.$$('.talk-preview')) { const b = await pr.boundingBox(); assert.ok(b.x + b.width <= list.x + list.width + 0.5, 'preview inside the list column'); }
  await page.locator('.talk-row[data-row="Kenji Arlo"]').hover();
  assert.ok(await page.getByRole('button', { name: 'Hide Kenji Arlo' }).isVisible(), 'desktop hover shows row actions');
  shots.push(path.join(out, 'list-1440.png')); await page.screenshot({ path: shots.at(-1) });
  await ctx.close();
};
try {
  await swipeChecks();
  await desktopList();
  for (const theme of ['light', 'dark']) await run(theme);
  assert.deepEqual(errors, [], 'no page errors');
  console.log(`messages phone UI: OK\n${shots.join('\n')}`);
} finally { await browser.close(); }
