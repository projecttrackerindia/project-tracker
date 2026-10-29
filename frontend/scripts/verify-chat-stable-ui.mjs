import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { appCsp } from './lib/csp.mjs';

// A stable conversation and live badges (owner's iPhone recording: the composer drifted down and the thread jumped while pictures and file
// previews loaded; a new message left no badge on Messages). Checks, on a 390x844 iPhone (light and dark) and at 1440:
//  - opening a chat lands on the newest message at once; while slow pictures (1.2s) and file previews load the composer never moves,
//    the view stays pinned to the bottom, and layout shift inside the thread stays <= 0.02 (PerformanceObserver 'layout-shift');
//  - scrolled up, a new message does not move what is on screen and shows a "1 new" jump pill; day labels stick; pictures open full screen
//    and step with the arrow keys; Find in conversation finds a message;
//  - a message arriving over the (mocked) live connection puts a badge on Messages in the tab bar / sidebar and "(1)" in the title with no
//    reload, a muted chat only lights a grey dot, and opening the chat (or reading it on another device) clears it.
// The live connection is a fake SignalR hub (negotiate + JSON protocol over a routed WebSocket). Synthetic API, made-up people.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist');
const out = path.resolve(process.env.PM_UI_ARTIFACTS || 'test-results/enterprise-ui', 'chat-stable');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const ago = (m) => new Date(Date.now() - m * 60_000).toISOString();
const g = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const user = { id: g(1), displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: g(2), slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 4 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const me = { userId: user.id, name: user.displayName, role: 'Member', online: true, lastReadAt: ago(1) };
const person = (n, name) => ({ userId: g(n), name, role: 'Member', online: true, lastReadAt: ago(1) });
const conv = (id, name, other, extra = {}) => ({ id, type: 'Direct', name, members: [me, other], unread: 0, isMuted: false, canManage: false, otherUserId: other.userId, projectId: null, unreadMentions: 0,
  lastMessage: { snippet: 'hello', senderName: name, isMine: false, isSystem: false, at: ago(5) }, lastActivityAt: ago(5), ...extra });
const tomas = person(11, 'Tomas Velde'), mira = person(12, 'Mira Ostrova'), kenji = person(13, 'Kenji Arlo');
let state;
const IMG = (n) => ({ id: g(900 + n), fileName: `site-photo-${n}.png`, contentType: 'image/svg+xml', sizeBytes: 182_000, isImage: true });
const reset = () => {
  let seq = 0;
  const M = (from, body, mins, attachments = []) => ({ id: g(5000 + ++seq), conversationId: g(100), senderId: from ? from.userId : user.id, senderName: from ? from.name : user.displayName,
    kind: 'User', replyTo: null, editedAt: null, body, createdAt: ago(mins), attachments, reactions: [], isDeleted: false });
  const media = [];
  for (let i = 0; i < 24; i++) media.push(M(i % 3 ? tomas : null, `Yesterday's note ${i + 1}: checked the release checklist`, 1800 - i * 10));
  media.push(M(tomas, '', 70, [IMG(1), IMG(2), IMG(3)]));
  media.push(M(null, 'Looks good. Here is the signed copy', 60, [{ id: g(950), fileName: 'release-approval.pdf', contentType: 'application/pdf', sizeBytes: 240_000, isImage: false }]));
  media.push(M(tomas, '', 50, [{ id: g(951), fileName: 'gateway-payload.json', contentType: 'application/json', sizeBytes: 9_000, isImage: false }]));
  media.push(M(tomas, '', 45, [{ id: g(952), fileName: 'gateway-trace.log', contentType: 'text/plain', sizeBytes: 10_400_000, isImage: false }]));
  media.push(M(tomas, '```\nGET /api/1.0/status\nHost: gateway.example.test\n' + Array.from({ length: 30 }, (_, i) => `X-Trace-${i}: ${'f'.repeat(24)}`).join('\n') + '\n```', 40));
  media.push(M(tomas, '', 30, [IMG(4)]));
  media.push(M(null, 'Thanks, merging after lunch', 20));
  media.push(M(tomas, 'Sounds good - the deploy window is at 3', 10));
  state = {
    convs: [conv(g(100), 'Tomas Velde', tomas), conv(g(101), 'Mira Ostrova', mira), conv(g(102), 'Kenji Arlo', kenji, { isMuted: true })],
    msgs: { [g(100)]: media, [g(101)]: [M(mira, 'Morning!', 300)].map((m) => ({ ...m, conversationId: g(101) })), [g(102)]: [] },
    writes: [], sockets: [],
  };
};
const unreadNow = () => {
  let count = 0, muted = false;
  for (const c of state.convs) { if (c.isMuted) { if (c.unread > 0) muted = true; } else count += c.unread; }
  return { count, conversations: state.convs.filter((c) => !c.isMuted && c.unread > 0).length, mutedMentions: 0, mutedActivity: muted && count === 0 ? true : muted };
};
const svg = (n) => `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${n % 2 ? 900 : 1600}"><rect width="100%" height="100%" fill="hsl(${n * 70},60%,60%)"/><text x="40" y="120" font-size="90" fill="#fff">Photo ${n}</text></svg>`;
const errors = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const RS = '\u001e';

const make = async (theme, phone) => {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block',
    ...(phone ? { viewport: { width: 390, height: 844 }, userAgent: IPHONE, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } }) });
  await ctx.addInitScript((t) => {
    localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t);
    // Layout shift inside the thread (the composer and header are outside it), summed like CLS.
    window.__shift = 0; window.__shifts = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.hadRecentInput || !window.__measure) continue;
          const inThread = (e.sources || []).some((s) => s.node && s.node.closest && s.node.closest('.chat-messages, .talk-thread'));
          if (inThread) { window.__shift += e.value; window.__shifts.push(e.value); }
        }
      }).observe({ type: 'layout-shift', buffered: false });
    } catch { /* not Chromium */ }
  }, theme);
  // The fake hub: negotiate, then the SignalR JSON handshake; the test pushes invocations through state.sockets.
  await ctx.routeWebSocket(/\/hubs\/chat/, (socket) => {
    state.sockets.push(socket);
    socket.onMessage((m) => {
      const text = String(m);
      if (text.includes('"protocol"')) socket.send(`{}${RS}`);
      // pings and invocations from the app (Typing, SetIdle) need no answer
    });
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
    if (method !== 'GET' && !ep.endsWith('/auth/refresh')) state.writes.push({ ep, method, body: req.postData() });
    let data = [];
    const convMatch = /^\/api\/v1\/chat\/conversations\/([^/]+)(\/.*)?$/.exec(ep);
    if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
    else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['org.manage', 'work.view', 'chat.view', 'projects.view', 'calendar.view', 'tasks.view'], modules: { projects: 3, work: 3, ai: 3, chat: 3, people: 3, documents: 3, calendar: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3, CHAT_ATTACHMENTS: 3 } } };
    else if (ep.startsWith('/api/v1/me/ui/')) data = { key: ep.split('/').pop(), value: null, updatedAt: null };
    else if (ep === '/api/v1/talk/conversations') data = { items: [], mail: { state: 'not-connected', account: null, email: null, provider: null }, chatAvailable: true };
    else if (ep === '/api/v1/chat/conversations') data = state.convs;
    else if (ep === '/api/v1/chat/unread') data = unreadNow();
    else if (ep === '/api/v1/chat/search') { const q = (url.searchParams.get('q') || '').toLowerCase(); data = Object.values(state.msgs).flat().filter((m) => m.body.toLowerCase().includes(q)).map((m) => ({ messageId: m.id, conversationId: m.conversationId, conversationName: 'x', senderName: m.senderName, snippet: m.body.slice(0, 80), at: m.createdAt })); }
    else if (convMatch && convMatch[2] === '/messages' && method === 'GET') data = { items: state.msgs[convMatch[1]] ?? [], hasMore: false };
    else if (convMatch && convMatch[2] === '/read' && method === 'POST') { const c = state.convs.find((x) => x.id === convMatch[1]); if (c) c.unread = 0; await route.fulfill({ status: 204, body: '' }); return; }
    else if (ep.startsWith('/api/v1/chat/files/')) {
      const id = ep.split('/').pop();
      await new Promise((r) => setTimeout(r, 1200));          // slow: what made the thread jump
      const n = Number(id.slice(-3)) - 900;
      if (n >= 1 && n <= 9) { await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg(n) }); return; }
      if (id === g(951)) { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ controlData: { success: true }, items: Array.from({ length: 20 }, (_, i) => ({ id: i })) }) }); return; }
      await route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.4' }); return;
    }
    else if (ep.endsWith('/pins')) data = [];
    else if (ep.endsWith('/files')) data = { items: [], hasMore: false };
    else if (ep === '/api/v1/chat/questions') data = [];
    else if (ep.includes('/notifications/counts')) data = { unread: 0, needsYou: 0, forInfo: 0, messages: 0, reminders: 0, meetings: 0, work: 0 };
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

/** A live event from the fake hub to every open connection. */
const push = (target, payload) => { for (const s of state.sockets) s.send(JSON.stringify({ type: 1, target, arguments: [payload] }) + RS); };
const arrive = (convId, from, body) => {
  const c = state.convs.find((x) => x.id === convId);
  const m = { id: g(7000 + Math.floor(Math.random() * 9000)), conversationId: convId, senderId: from.userId, senderName: from.name, kind: 'User', replyTo: null, editedAt: null, body, createdAt: new Date().toISOString(), attachments: [], reactions: [], isDeleted: false };
  state.msgs[convId].push(m); c.unread += 1; c.lastMessage = { snippet: body, senderName: from.name, isMine: false, isSystem: false, at: m.createdAt }; c.lastActivityAt = m.createdAt;
  push('message', { conversationId: convId, message: m, projectId: null, mentioned: [] });
  return m;
};
const hubUp = async (page) => { for (let i = 0; i < 60 && state.sockets.length === 0; i++) await page.waitForTimeout(100); assert.ok(state.sockets.length > 0, 'the live connection opened'); await page.waitForTimeout(300); };
const badge = (page, scope) => page.evaluate((sc) => { const e = document.querySelector(`${sc} [data-badge="talk"]`); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? { text: e.textContent, dot: e.classList.contains('v2-badge-dot') } : null; }, scope);

const phoneRun = async (theme) => {
  reset();
  const tag = `390-${theme}`;
  const ctx = await make(theme, true); const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  await page.goto(`${origin}/preview-org/messages`);
  await page.locator('.talk-row').first().waitFor();
  await hubUp(page);
  assert.equal(await badge(page, '.m-tabs'), null, `${tag}: no badge before anything arrives`);

  // ---- badges: a message arrives live -> tab bar badge and title, no reload
  arrive(g(101), mira, 'Can you look at the staging logs?');
  await page.waitForFunction(() => document.querySelector('.m-tabs [data-badge="talk"]')?.textContent === '1', null, { timeout: 4000 });
  assert.match(await page.title(), /^\(1\) /, `${tag}: the tab title counts it`);
  await page.waitForTimeout(700);   // the list's reorder animation settles
  await page.screenshot({ path: path.join(out, `${tag}-badge.png`) });
  // a muted chat: no number, only the grey dot (here added to an existing number it stays 1)
  arrive(g(102), kenji, 'fyi, lunch is here');
  await page.waitForTimeout(700);
  assert.equal((await badge(page, '.m-tabs'))?.text, '1', `${tag}: a muted chat adds nothing to the number`);
  // opening the chat reads it: the badge clears
  await page.locator('.talk-row', { hasText: 'Mira Ostrova' }).first().click();
  await page.locator('.talk-thread .composer-editable').waitFor();
  await page.waitForFunction(() => !document.title.startsWith('(1)'), null, { timeout: 4000 });
  assert.ok(state.writes.some((w) => w.ep.endsWith(`${g(101)}/read`)), `${tag}: opening marks it read`);
  await page.getByRole('button', { name: /back to conversations/i }).click();
  await page.locator('.talk-row').first().waitFor();
  await page.waitForTimeout(500);
  const after = await badge(page, '.m-tabs');
  assert.ok(after?.dot, `${tag}: only the muted chat's grey dot is left (${JSON.stringify(after)})`);
  await page.screenshot({ path: path.join(out, `${tag}-dot.png`) });
  // reading the muted chat on another device clears the dot here
  state.convs.find((c) => c.id === g(102)).unread = 0;
  push('read', { conversationId: g(102), userId: user.id, at: new Date().toISOString() });
  await page.waitForFunction(() => !document.querySelector('.m-tabs [data-badge="talk"]'), null, { timeout: 4000 });

  // ---- a stable conversation: open, slow pictures and previews, the composer never moves, CLS
  await page.evaluate(() => { window.__measure = true; window.__shift = 0; window.__shifts = []; });
  await page.locator('.talk-row', { hasText: 'Tomas Velde' }).first().click();
  const composer = page.locator('.talk-thread .composer');
  await composer.waitFor();
  await page.locator('.talk-thread [data-msg]').first().waitFor();
  const rects = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 2600) {
    rects.push(await page.evaluate(() => {
      const c = document.querySelector('.talk-thread .composer').getBoundingClientRect();
      const l = document.querySelector('.talk-thread .chat-messages');
      return { top: Math.round(c.top), bottom: Math.round(c.bottom), gap: Math.round(l.scrollHeight - l.scrollTop - l.clientHeight) };
    }));
    await page.waitForTimeout(80);
  }
  await page.locator('.chat-img.ready').first().waitFor({ timeout: 4000 });
  const grid = await page.locator('.chat-img-grid.n3').evaluate((e) => Math.round(e.getBoundingClientRect().width));
  assert.ok(grid >= 200, `${tag}: the picture grid has its width (${grid})`);
  const tops = new Set(rects.map((r) => r.top)), bottoms = new Set(rects.map((r) => r.bottom));
  assert.equal(tops.size, 1, `${tag}: the composer never moves while the thread loads (${[...tops]})`);
  assert.equal(bottoms.size, 1, `${tag}: the composer's bottom stays put (${[...bottoms]})`);
  assert.ok(rects.every((r) => r.gap <= 4), `${tag}: pinned to the newest message the whole time (${rects.map((r) => r.gap)})`);
  const vh = 844;
  assert.ok(rects[0].bottom <= vh && rects[0].bottom >= vh - 40, `${tag}: composer at the bottom of the screen (${rects[0].bottom})`);
  const shift = await page.evaluate(() => window.__shift);
  assert.ok(shift <= 0.02, `${tag}: layout shift in the thread ${shift.toFixed(4)} <= 0.02`);
  await page.evaluate(() => { window.__measure = false; });
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), true, `${tag}: no sideways scroll`);
  await page.screenshot({ path: path.join(out, `${tag}-thread.png`) });

  // ---- scrolled up: a new message does not move the view, a "1 new" pill appears; the day label sticks
  await page.evaluate(() => { const l = document.querySelector('.talk-thread .chat-messages'); l.scrollTop = l.scrollHeight - l.clientHeight - 900; l.dispatchEvent(new Event('scroll')); });
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => { const l = document.querySelector('.talk-thread .chat-messages'); const row = [...l.querySelectorAll('[data-msg]')].find((r) => r.getBoundingClientRect().top > l.getBoundingClientRect().top + 40); return { id: row.dataset.msg, top: Math.round(row.getBoundingClientRect().top) }; });
  arrive(g(100), tomas, 'One more thing about the window');
  const pill = page.locator('[data-testid="jump-latest"]');
  await pill.filter({ hasText: '1 new' }).waitFor({ timeout: 4000 });
  const still = await page.evaluate((id) => Math.round(document.querySelector(`[data-msg="${id}"]`).getBoundingClientRect().top), before.id);
  assert.ok(Math.abs(still - before.top) <= 1, `${tag}: what I was reading did not move (${before.top} -> ${still})`);
  const stuck = await page.evaluate(() => { const l = document.querySelector(".talk-thread .chat-messages").getBoundingClientRect().top; const ds = [...document.querySelectorAll(".day-sep.sticky")].map((d) => Math.round(d.getBoundingClientRect().top - l)); return ds.some((t) => t >= 0 && t <= 20); });   // 12px list padding + 6px
  assert.ok(stuck, `${tag}: a day label sticks to the top`);
  await page.screenshot({ path: path.join(out, `${tag}-pill.png`) });
  await pill.click();
  await page.waitForFunction(() => { const l = document.querySelector('.talk-thread .chat-messages'); return l.scrollHeight - l.scrollTop - l.clientHeight < 4; }, null, { timeout: 3000 });
  await ctx.close();
};

const desktopRun = async () => {
  reset();
  const tag = '1440-light';
  const ctx = await make('light', false); const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  await page.goto(`${origin}/preview-org/messages`);
  await page.locator('.talk-row').first().waitFor();
  await hubUp(page);
  arrive(g(101), mira, 'Staging is back');
  arrive(g(101), mira, 'and the logs look clean');
  await page.waitForFunction(() => document.querySelector('.v2-side [data-badge="talk"]')?.textContent === '2', null, { timeout: 4000 });
  assert.match(await page.title(), /^\(2\) /);
  await page.screenshot({ path: path.join(out, `${tag}-badge.png`) });
  await page.locator('.talk-row', { hasText: 'Tomas Velde' }).first().click();
  await page.locator('.chat-img.ready').first().waitFor({ timeout: 5000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(out, `${tag}-thread.png`) });
  // full-screen pictures, arrow keys step through them
  await page.locator('.chat-img-grid.n3 .chat-img').first().click();
  const viewer = page.locator('[data-testid="image-viewer"]');
  await viewer.waitFor();
  await page.keyboard.press('ArrowRight');
  await viewer.filter({ hasText: '2 of 3' }).waitFor();
  await page.screenshot({ path: path.join(out, `${tag}-viewer.png`) });
  await page.keyboard.press('Escape');
  await viewer.waitFor({ state: 'detached' });
  // uniform file cards: the PDF has Open and Download, the 10 MB log is compact
  assert.equal(await page.locator('[data-testid="file-card"]').first().evaluate((e) => Math.round(e.getBoundingClientRect().height)), 56);
  assert.ok(await page.getByRole('button', { name: 'Open release-approval.pdf' }).isVisible());
  // Find in conversation
  await page.getByRole('button', { name: 'Conversation actions' }).click();
  await page.getByRole('menuitem', { name: /Find in conversation/ }).click();
  await page.getByRole('searchbox', { name: 'Find in conversation' }).or(page.getByLabel('Find in conversation')).first().fill('note 3');
  await page.locator('.chat-find-n', { hasText: /of/ }).waitFor({ timeout: 3000 });
  await page.screenshot({ path: path.join(out, `${tag}-find.png`) });
  // opening Mira's chat clears the sidebar badge
  await page.keyboard.press('Escape');
  await page.locator('.talk-row', { hasText: 'Mira Ostrova' }).first().click();
  await page.waitForFunction(() => !document.querySelector('.v2-side [data-badge="talk"]'), null, { timeout: 4000 });
  await ctx.close();
};

try {
  await phoneRun('light');
  await phoneRun('dark');
  await desktopRun();
} finally { await browser.close(); }
assert.deepEqual(errors, [], errors.join('\n'));
console.log(`chat stable + live badges ok -> ${out}`);
