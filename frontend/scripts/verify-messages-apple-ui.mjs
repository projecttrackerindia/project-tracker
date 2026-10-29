import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Messages, drawn as Apple Messages: iMessage-blue outgoing bubbles and selection (no green), grey incoming bubbles with a tail on the
// last of a run, centred "Today 9:39 AM" times, "Read …" under my last message, the inline "✦ N new while you were away · Summarize"
// chip (no pinned card), tapbacks (double-click → bar + compact menu, badge on the bubble), the send "swoosh", the apps sheet behind ＋,
// pinned conversations as round avatars, Details holding pinned messages, and the phone's push from list to conversation.
// 1440 light/dark and 390/412 light/dark. Synthetic API and made-up people only.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist');
const out = path.resolve(process.env.PM_UI_ARTIFACTS || 'test-results/enterprise-ui', 'messages-apple');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const ago = (m) => new Date(Date.now() - m * 60_000).toISOString();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 4 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const lena = { userId: '00000000-0000-0000-0000-000000000003', name: 'Lena Park', role: 'Member', online: true, lastReadAt: ago(0.5) };
const tomas = { userId: '00000000-0000-0000-0000-000000000004', name: 'Tomas Velde', role: 'Member', online: false, lastReadAt: ago(60) };
const meMember = { userId: user.id, name: user.displayName, role: 'Admin', online: true, lastReadAt: ago(1) };
const direct = { id: '00000000-0000-0000-0000-000000000010', type: 'Direct', name: lena.name, members: [lena, meMember], unread: 3, isMuted: false, canManage: false, otherUserId: lena.userId, projectId: null, unreadMentions: 0,
  lastMessage: { snippet: 'Here is the payload', senderName: lena.name, isMine: false, isSystem: false, at: ago(2) }, lastActivityAt: ago(2) };
const group = { id: '00000000-0000-0000-0000-000000000011', type: 'Group', name: 'Orbit Team', members: [lena, tomas, meMember], unread: 0, isMuted: false, canManage: true, otherUserId: null, projectId: null, unreadMentions: 0,
  lastMessage: { snippet: 'Deploy is green', senderName: tomas.name, isMine: false, isSystem: false, at: ago(90) }, lastActivityAt: ago(90) };
const ID = (n) => `00000000-0000-0000-0000-0000000001${String(n).padStart(2, '0')}`;
const M = (n, mine, body, mins, extra = {}) => ({ id: ID(n), conversationId: direct.id, senderId: mine ? user.id : lena.userId, senderName: mine ? user.displayName : lena.name,
  kind: 'User', replyTo: null, editedAt: null, body, createdAt: ago(mins), attachments: [], reactions: [], isDeleted: false, ...extra });
const code = '```json\n{\n  "orderId": "A-1009",\n  "status": "shipped"\n}\n```';
let messages;
const reset = () => {
  messages = [
    M(1, false, 'Morning! Did the release notes go out?', 70),
    M(2, false, 'I can review them before lunch.', 69),
    M(3, true, 'Yes, sent them an hour ago.', 40, { reactions: [{ emoji: '👍', count: 1, mine: false, names: [lena.name] }] }),
    M(4, true, 'Shall we move the demo to Thursday?', 39),
    M(5, false, 'Thursday works for me.', 6, { replyTo: { id: ID(4), senderName: user.displayName, snippet: 'Shall we move the demo to Thursday?', isDeleted: false } }),
    M(6, false, 'Here is the payload', 3),
    M(7, false, code, 2),
    M(8, true, 'Got it, thanks!', 1),
  ];
};
reset();
const talkRow = (o) => ({ sub: null, last: null, unread: 0, group: false, account: null, messageId: null, meetingRef: null, sessionStart: null, live: false, upcoming: false, joinUrl: null, ...o });
const talk = () => ({
  items: [
    talkRow({ id: direct.id, kind: 'chat', title: lena.name, last: 'Here is the payload', at: ago(2), unread: 3, avatar: { initials: 'LP', userId: lena.userId, hasAvatar: false, square: false } }),
    talkRow({ id: group.id, kind: 'chat', title: group.name, sub: 'Group', last: 'Tomas: Deploy is green', at: ago(90), group: true, avatar: { initials: 'OT', userId: null, hasAvatar: false, square: false } }),
  ],
  mail: { state: 'not-connected', account: null, email: null, provider: null }, chatAvailable: true,
});
const errors = [], checks = [], writes = [];
let serverConv = null, myTheme = null;
const profileOf = (id) => {
  const me = id === user.id, who = me ? user : { id: lena.userId, displayName: lena.name, email: 'lena@example.test' };
  return { userId: who.id, displayName: who.displayName, email: who.email, hasAvatar: false, role: me ? 'Admin' : 'Member', jobRole: me ? 'Delivery lead' : 'Developer', jobRoleColor: null,
    teams: [{ id: 't1', name: 'Orbit Platform', isLead: me }], reportsTo: me ? null : { id: user.id, name: user.displayName }, joinedAt: '2025-03-14T00:00:00Z',
    open: 6, overdue: me ? 0 : 2, doneLast30Days: 11, doneTotal: 148, isMe: me, canMessage: !me, theme: me ? myTheme : null, certificationBadges: [] };
};
/** The app's deterministic default theme (FNV-1a of the id over ten palettes), recomputed here. */
const THEMES = ['indigo', 'sunset', 'ocean', 'mint', 'graphite', 'rose', 'aurora', 'sand', 'berry', 'sky'];
const defaultTheme = (id) => { let h = 0x811c9dc5; for (const ch of id.toLowerCase()) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return THEMES[h % THEMES.length]; };
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const make = async (theme = 'light', opts = {}) => {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block', ...opts });
  await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); }, theme);
  await ctx.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
    if (url.origin !== origin || ep.startsWith('/hubs/')) { await route.abort(); return; }
    if (ep.endsWith('/avatar') || ep.endsWith('/logo/file')) { await route.fulfill({ status: 404, body: '' }); return; }
    if (!ep.startsWith('/api/')) {
      const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
      await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
      return;
    }
    const json = (data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
    if (method !== 'GET' && !ep.endsWith('/auth/refresh')) writes.push({ ep, method, body: req.postData() });
    let data = [];
    if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
    else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['org.manage', 'work.view', 'chat.view', 'projects.view', 'calendar.view'], modules: { projects: 3, work: 3, ai: 3, chat: 3, people: 3, documents: 3, calendar: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3, CHAT_ATTACHMENTS: 3 } } };
    else if (ep === '/api/v1/me/ui/sidebar') data = { key: 'sidebar', value: null, updatedAt: null };
    else if (ep === '/api/v1/me/ui/conversations') { if (method === 'PUT') serverConv = JSON.parse(req.postData() || '{}').value; data = { key: 'conversations', value: serverConv, updatedAt: null }; }
    else if (ep === '/api/v1/me/ui/profile') { if (method === 'PUT') myTheme = JSON.parse(req.postData() || '{}').value?.theme ?? null; data = { key: 'profile', value: myTheme ? { theme: myTheme } : null, updatedAt: null }; }
    else if (/^\/api\/v1\/workspace\/members\/[^/]+\/profile$/.test(ep)) data = profileOf(ep.split('/')[5]);
    else if (ep === '/api/v1/talk/conversations') data = talk();
    else if (ep === '/api/v1/chat/conversations') data = [direct, group];
    else if (ep === `/api/v1/chat/conversations/${direct.id}/messages` && method === 'GET') data = { items: messages, hasMore: false };
    else if (ep === `/api/v1/chat/conversations/${direct.id}/messages` && method === 'POST') {
      const b = JSON.parse(req.postData() || '{}'); const m = M(50 + messages.length, true, b.body, 0); messages.push(m); data = m;
    }
    else if (ep.endsWith('/messages') && method === 'GET') data = { items: [], hasMore: false };
    else if (/\/chat\/messages\/[^/]+\/reaction$/.test(ep)) {
      const mid = ep.split('/')[5]; const m = messages.find((x) => x.id === mid); const emoji = JSON.parse(req.postData() || '{}').emoji;
      m.reactions = [...(m.reactions ?? []).filter((r) => r.emoji !== emoji), { emoji, count: 1, mine: true, names: [user.displayName] }]; data = m;
    }
    else if (ep === '/api/v1/chat/ai/catch-up') data = { summary: 'Lena moved the demo to Thursday and shared the order payload.', decisions: [{ text: 'Demo moves to Thursday', owner: null }], questions: [], actions: [], conversations: 1, messages: 3, model: 'synthetic' };
    else if (ep.endsWith('/replies')) data = { replies: ['Thanks, see you Thursday.'], model: 'synthetic' };
    else if (ep.endsWith('/pins')) data = [M(4, true, 'Shall we move the demo to Thursday?', 39, { pinnedAt: ago(30), pinnedBy: lena.name })];
    else if (ep.endsWith('/files')) data = { items: [], hasMore: false };
    else if (ep === '/api/v1/chat/questions') data = [];
    else if (ep.includes('/unread') || ep.includes('/counts')) data = { count: 0, total: 0 };
    else if (ep === '/api/v1/calls/status') data = { available: true, maxParticipants: 50 };
    else if (ep === '/api/v1/calls/live') data = [];
    else if (ep === '/api/v1/timer') data = null;
    else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
    await json(data);
  });
  return ctx;
};
const shot = async (page, name) => { await page.waitForTimeout(450); await page.screenshot({ path: path.join(out, name) }); };
const bg = (loc) => loc.evaluate((e) => getComputedStyle(e).backgroundColor);
/** Every visible element in Messages painted green (hue 100–150, saturated), except a person's presence dot. */
const greens = (page) => page.evaluate(() => {
  const hits = [];
  const isGreen = (c) => { const m = /rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/.exec(c); if (!m || (m[4] !== undefined && Number(m[4]) < .05)) return false;
    const [r, g, b] = [m[1], m[2], m[3]].map(Number); return g > 120 && g > r + 40 && g > b + 30; };
  for (const el of document.querySelectorAll('.talk-shell *, .aura-dock-wrap *')) {
    if (el.closest('.s-presence, .presence-dot, .talk-src, .a-poll')) continue;
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); if (!r.width || cs.visibility === 'hidden') continue;
    for (const c of [cs.backgroundColor, cs.borderTopColor, cs.outlineColor, cs.boxShadow]) if (isGreen(c) && !(c === cs.borderTopColor && cs.borderTopWidth === '0px') && !(c === cs.outlineColor && cs.outlineStyle === 'none')) hits.push(`${el.className}: ${c}`);
  }
  return hits.slice(0, 8);
});

try {
  // ---- 1440 light
  let ctx = await make('light'); let page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/preview-org/messages`);
  await page.locator('.talk-row[data-row="Lena Park"]').waitFor();
  assert.equal(await page.locator('.talk-seg .talk-chip').count(), 3, 'a compact segmented filter: All · Unread · Chats (meetings have their own place)');
  assert.equal(await page.locator('.talk-row[data-row="Lena Park"] .talk-dot').count(), 1, 'the blue unread dot');
  assert.equal(await bg(page.locator('.talk-row[data-row="Lena Park"] .talk-dot')), 'rgb(10, 132, 255)');
  assert.equal(await page.locator('.v2-tb-new, .v2-rail-new').count(), 0, 'no + New in Messages');
  await page.getByTestId('aura-dock').waitFor();   // Aura's dock on the list (a conversation hides it)
  checks.push('list');

  // Right-click a row: Pin · Mute · Mark as read · Hide. Pinning puts it in the round avatars on top (one row, only when pinned).
  assert.equal(await page.locator('.talk-pins').count(), 0, 'no pinned strip when nothing is pinned');
  await page.locator('.talk-row[data-row="Orbit Team"]').click({ button: 'right' });
  const rowMenu = page.getByRole('menu', { name: 'Orbit Team actions' });
  assert.deepEqual((await rowMenu.getByRole('menuitem').allInnerTexts()).map((t) => t.trim()), ['Pin', 'Mute', 'Hide']);
  await rowMenu.getByRole('menuitem', { name: 'Pin' }).click();
  await page.locator('.talk-pin[data-pin="Orbit Team"]').waitFor();
  const pinBox = await page.locator('.talk-pins').boundingBox();
  assert.ok(pinBox.height < 110, `pinned avatars take one small row (${pinBox.height})`);
  await page.locator('.talk-row[data-row="Orbit Team"]').waitFor({ state: 'detached' });   // a pinned chat leaves the list (after its exit animation)
  await new Promise((r) => setTimeout(r, 200));
  const pinWrite = writes.filter((w) => w.ep === '/api/v1/me/ui/conversations' && w.method === 'PUT').at(-1);
  assert.ok(pinWrite, 'the pin is saved with the account (/me/ui/conversations)');
  assert.deepEqual(JSON.parse(pinWrite.body).value[ws.id].pinned, [group.id]);
  checks.push('pin-and-row-menu', 'pin-synced');

  await page.locator('.talk-row[data-row="Lena Park"]').click();
  await page.locator('.talk-head').waitFor();
  await page.locator(`[data-msg="${ID(8)}"]`).waitFor();
  await page.waitForTimeout(400);   // the selection highlight fades in
  // Selection and bubbles are blue; theirs grey; nothing green anywhere.
  assert.equal(await bg(page.locator('.talk-row.active')), 'rgb(10, 132, 255)', 'selected row is Apple blue');
  assert.equal(await bg(page.locator(`[data-msg="${ID(8)}"] .bubble`)), 'rgb(0, 122, 255)', 'my bubble is iMessage blue');
  assert.equal(await page.locator(`[data-msg="${ID(8)}"] .bubble`).evaluate((e) => getComputedStyle(e).color), 'rgb(255, 255, 255)');
  assert.equal(await bg(page.locator(`[data-msg="${ID(6)}"] .bubble`)), 'rgb(233, 233, 235)', 'their bubble is grey');
  assert.equal(await page.locator(`[data-msg="${ID(8)}"] .bubble`).evaluate((e) => parseFloat(getComputedStyle(e).borderTopLeftRadius)), 18);
  assert.equal(await page.locator(`[data-msg="${ID(8)}"] .bubble`).evaluate((e) => getComputedStyle(e, '::before').content), '""', 'a tail on the last bubble of a run');
  assert.equal(await page.locator(`[data-msg="${ID(1)}"] .bubble`).evaluate((e) => getComputedStyle(e, '::before').content), 'none', 'no tail inside a run');
  assert.ok(await page.locator(`[data-msg="${ID(2)}"]`).evaluate((e) => e.classList.contains('grouped')), 'a run is grouped (2px)');
  assert.equal(await page.locator(`[data-msg="${ID(1)}"] .avatar`).count(), 0, 'no avatar inside a run');
  assert.equal(await page.locator(`[data-msg="${ID(2)}"] .avatar`).count(), 1, 'the avatar sits on the last incoming bubble');
  const codeBg = await bg(page.locator(`[data-msg="${ID(7)}"] .msg-code`));
  assert.equal(codeBg, 'rgb(28, 28, 30)', 'code sits on a neutral dark card');
  assert.deepEqual(await greens(page), [], 'no green in Messages');
  checks.push('blue-not-green');

  // Times between messages, the receipt, the inline reply.
  assert.ok((await page.locator('.day-sep.talk-time').count()) >= 2, 'a centred time after a 15-minute gap');
  assert.match(await page.locator('.day-sep.talk-time').first().innerText(), /^Today \d/);
  assert.match(await page.getByTestId('receipt').innerText(), /^Read \d/);
  assert.equal(await page.getByTestId('receipt').count(), 1, 'one receipt, under my last message');
  await page.locator(`[data-msg="${ID(5)}"] .reply-quote`).click();
  await page.waitForFunction((id) => document.querySelector(`[data-msg="${id}"]`)?.classList.contains('flash'), ID(4));
  checks.push('times-receipt-reply');

  // No pinned card: the summary is a slim chip at the first unread message.
  assert.equal(await page.getByTestId('summary-strip').count(), 0, 'no pinned "while you were away" card');
  assert.equal(await page.locator('.talk-pane').getByText('Pinned', { exact: true }).count(), 0, 'no "Pinned" label in the thread');
  const chip = page.getByTestId('away-chip');
  assert.match(await chip.innerText(), /3 new while you were away/);
  const order = await page.evaluate((id) => { const c = document.querySelector('[data-testid="away-chip"]'), m = document.querySelector(`[data-msg="${id}"]`); return !!(c.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING); }, ID(5));
  assert.ok(order, 'the chip sits right before the first unread message');
  assert.ok((await chip.boundingBox()).height <= 34, 'slim');
  await chip.getByRole('button', { name: /Summarize/ }).click();
  await chip.getByText('Demo moves to Thursday').waitFor();
  await shot(page, 'thread-1440-light.png');
  await chip.getByRole('button', { name: /Hide/ }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="away-chip"] .talk-away-body'));
  await chip.getByRole('button', { name: 'Dismiss the summary' }).click();
  await chip.waitFor({ state: 'detached' });
  checks.push('inline-summary-chip');

  // Tapback: double-click → the bar above (❤️ 👍 👎 😂 ‼️ ❓ +) and the compact menu below; the badge lands on the bubble's corner.
  const theirs = page.locator(`[data-msg="${ID(6)}"]`);
  await theirs.locator('.bubble').dblclick();
  const bar = theirs.locator('.tapback-bar');
  await bar.waitFor();
  assert.deepEqual(await bar.locator('button').evaluateAll((els) => els.map((e) => e.textContent || e.getAttribute('aria-label'))), ['❤️', '👍', '👎', '😂', '‼️', '❓', 'More tapbacks']);
  const menu = page.getByRole('menu', { name: 'More actions' });
  await menu.waitFor();
  for (const name of ['Copy text', 'Pin to the conversation', 'Save for later']) assert.ok(await menu.getByRole('menuitem', { name }).isVisible(), name);
  const bb = await theirs.locator('.bubble').boundingBox(), tb = await bar.boundingBox(), mb = await menu.boundingBox();
  assert.ok(tb.y + tb.height <= bb.y + 1, 'the bar sits above the bubble');
  assert.ok(mb.y >= bb.y + bb.height - 1, 'the menu sits below the bubble');
  await page.waitForTimeout(300);
  await shot(page, 'tapback-1440-light.png');
  await bar.getByRole('button', { name: 'Tapback ❤️' }).click();
  await theirs.locator('.tapback', { hasText: '❤️' }).waitFor();
  assert.ok(writes.some((w) => w.ep.endsWith(`/messages/${ID(6)}/reaction`) && w.method === 'PUT'), 'the tapback is saved');
  const badge = await theirs.locator('.tapback').boundingBox(), bub = await theirs.locator('.bubble').boundingBox();
  assert.ok(badge.y < bub.y && badge.x + badge.width > bub.x + bub.width - 4, 'the badge sits on the top-right corner');
  checks.push('tapback');

  // Composer: ＋ apps sheet, the send arrow only with text, and the new bubble "swooshes" up.
  assert.equal(await page.locator('.composer-editable').getAttribute('data-placeholder'), 'Message Lena Park');
  assert.equal(await page.locator('.talk-composer .send-btn:not(.mic)').count(), 0, 'no send arrow while empty');
  await page.getByRole('button', { name: /^Apps/ }).click();
  const apps = page.getByRole('menu', { name: 'Apps' });
  for (const name of ['Attach a file', 'Photo', 'Draft reply', 'Poll', 'Meeting']) assert.ok(await apps.getByRole('menuitem', { name }).isVisible(), name);
  await shot(page, 'apps-1440-light.png');
  await page.keyboard.press('Escape');
  await page.locator('.composer-editable').click();
  await page.keyboard.type('See you Thursday');
  const send = page.locator('.talk-composer .send-btn.talk-send');
  await send.waitFor();
  await page.waitForTimeout(400);
  assert.equal(await bg(send), 'rgb(10, 132, 255)', 'a blue send arrow');
  await send.click();
  const sent = page.locator('.msg.mine.fresh').last();
  await sent.waitFor();
  assert.equal(await sent.locator('.bubble-wrap').evaluate((e) => getComputedStyle(e).animationName), 'talkSwoosh', 'the new bubble swooshes in');
  checks.push('composer-send-animation');

  // Details: pinned messages (with a count) live here now.
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  const info = page.getByTestId('info-pinned');
  await info.getByText('Pinned · 1').waitFor();
  await info.getByText('Shall we move the demo to Thursday?').waitFor();
  await shot(page, 'details-1440-light.png');
  checks.push('details-pinned');
  assert.deepEqual(errors, []);
  await ctx.close();

  // ---- The person card: from a message avatar; cover, avatar over the banner, three stats, theme per id; my own card has a theme picker.
  for (const theme of ['light', 'dark']) {
    reset(); myTheme = null;
    ctx = await make(theme); page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${origin}/preview-org/messages/${direct.id}`);
    await page.locator(`[data-msg="${ID(2)}"] .msg-av-btn`).click();
    const card = page.getByTestId('profile-card');
    await card.getByText('Lena Park').waitFor();
    await page.waitForTimeout(500);
    const cb = await card.boundingBox(), ban = await card.getByTestId('profile-banner').boundingBox(), av = await card.getByTestId('profile-avatar').boundingBox();
    assert.ok(Math.abs(cb.width - 340) <= 2, `card ~340 wide (${cb.width})`);
    assert.ok(Math.abs(ban.height - 120) <= 2, 'a 120px cover banner');
    assert.ok(av.y < ban.y + ban.height && av.y + av.height > ban.y + ban.height && av.x < ban.x + ban.width / 3, 'the avatar overlaps the banner bottom-left');
    assert.equal(await card.getByTestId('profile-stats').locator(':scope > div').count(), 3, 'three stats');
    assert.match(await card.innerText(), /148 done in total/);
    assert.match(await card.getByTestId('profile-pill').innerText(), /Orbit Platform/);
    assert.equal(await card.getAttribute('data-theme-id'), defaultTheme(lena.userId), 'the theme is deterministic per person');
    assert.equal(await card.getByTestId('profile-theme').count(), 0, 'no theme picker on someone else\'s card');
    assert.ok(await card.getByRole('button', { name: 'Message' }).isVisible());
    await shot(page, `profile-1440-${theme}.png`);
    if (theme === 'light') {
      await card.getByRole('button', { name: 'Asha Rao' }).click();   // Reports to → their card (my own)
      await card.getByTestId('profile-theme').waitFor();
      assert.equal(await card.getAttribute('data-theme-id'), defaultTheme(user.id));
      await card.getByRole('radio', { name: 'Ocean' }).click();
      await page.waitForFunction(() => document.querySelector('[data-testid="profile-card"]')?.getAttribute('data-theme-id') === 'ocean');
      const tw = writes.filter((w) => w.ep === '/api/v1/me/ui/profile').at(-1);
      assert.deepEqual(JSON.parse(tw.body), { value: { theme: 'ocean' } }, 'my card theme is saved at /me/ui/profile');
      await shot(page, 'profile-own-1440-light.png');
    }
    await page.keyboard.press('Escape');
    await card.waitFor({ state: 'detached' });
    await ctx.close();
  }
  checks.push('profile-card');

  // ---- Pin and Hide come from the account: a pinned chat on another device shows here; a hidden one stays hidden until something newer arrives.
  reset();
  serverConv = { [ws.id]: { pinned: [direct.id], hidden: { [group.id]: new Date(Date.now() + 3600_000).toISOString() } } };
  ctx = await make('light'); page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/preview-org/messages`);
  await page.locator('.talk-pin[data-pin="Lena Park"]').waitFor();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.talk-row[data-row="Orbit Team"]').count(), 0, 'hidden on another device: hidden here');
  await ctx.close();
  serverConv = { [ws.id]: { pinned: [], hidden: { [group.id]: ago(500) } } };
  ctx = await make('light'); page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/preview-org/messages`);
  await page.locator('.talk-row[data-row="Orbit Team"]').waitFor();   // a newer message arrived since it was hidden
  await page.locator('.talk-row[data-row="Orbit Team"]').click({ button: 'right' });
  await page.getByRole('menu', { name: 'Orbit Team actions' }).getByRole('menuitem', { name: 'Hide' }).click();
  await page.locator('.talk-row[data-row="Orbit Team"]').waitFor({ state: 'detached' });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(JSON.parse(writes.filter((w) => w.ep === '/api/v1/me/ui/conversations').at(-1).body).value[ws.id].hidden[group.id], 'hide is saved with the account');
  await ctx.close();
  serverConv = null;
  checks.push('hide-synced');

  // The dismissed chip stays dismissed for those messages.
  // ---- 1440 dark
  reset();
  ctx = await make('dark'); page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/preview-org/messages/${direct.id}`);
  await page.locator(`[data-msg="${ID(8)}"]`).waitFor();
  await page.waitForTimeout(400);
  assert.equal(await bg(page.locator(`[data-msg="${ID(8)}"] .bubble`)), 'rgb(10, 132, 255)', 'dark: blue bubble');
  assert.equal(await bg(page.locator(`[data-msg="${ID(6)}"] .bubble`)), 'rgb(38, 37, 42)', 'dark: grey bubble');
  assert.equal(await bg(page.locator('.talk-row.active')), 'rgb(10, 132, 255)');
  assert.deepEqual(await greens(page), [], 'dark: no green');
  await page.getByTestId('away-chip').getByRole('button', { name: 'Dismiss the summary' }).click();
  await page.reload();
  await page.locator(`[data-msg="${ID(8)}"]`).waitFor();
  await page.waitForTimeout(300);
  assert.equal(await page.getByTestId('away-chip').count(), 0, 'a dismissed summary does not come back for the same messages');
  await shot(page, 'thread-1440-dark.png');
  checks.push('dark');
  await ctx.close();

  // ---- phones: the list with a large title, the iOS push into the conversation, a back chevron, the composer at the bottom
  for (const width of [390, 412]) for (const theme of ['light', 'dark']) {
    reset();
    ctx = await make(theme, { hasTouch: true, isMobile: true }); page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width, height: 860 });
    await page.goto(`${origin}/preview-org/messages`);
    await page.locator('.talk-row[data-row="Lena Park"]').waitFor();
    assert.ok(await page.locator('.talk-large').isVisible(), 'large title "Messages"');
    await fitsPhone(page, `list ${width} ${theme}`, assert);
    await shot(page, `list-${width}-${theme}.png`);
    await page.locator('.talk-row[data-row="Lena Park"]').click();
    await page.locator('.talk-head').waitFor();
    assert.equal(await page.locator('.talk-pane').evaluate((e) => getComputedStyle(e).animationName), 'talkPush', 'the conversation pushes in');
    assert.equal(await page.locator('.talk-list').isVisible(), false);
    const head = await page.locator('.talk-who').boundingBox();
    assert.ok(Math.abs(head.x + head.width / 2 - width / 2) < 40, 'the person is centred');
    assert.ok(await page.locator('.talk-head .chat-back').isVisible(), 'back chevron');
    await page.locator(`[data-msg="${ID(8)}"]`).waitFor();
    assert.equal(await bg(page.locator(`[data-msg="${ID(8)}"] .bubble`)), theme === 'dark' ? 'rgb(10, 132, 255)' : 'rgb(0, 122, 255)');
    const comp = await page.locator('.composer-row').boundingBox();
    const bottomBar = await page.locator('.m-tabbar, .m-tabs, nav.m-bottom').first().boundingBox().catch(() => null);
    assert.ok(comp.y + comp.height <= 860, 'composer on screen');
    if (bottomBar) assert.ok(comp.y + comp.height <= bottomBar.y + 1, 'composer above the tab bar');
    await fitsPhone(page, `thread ${width} ${theme}`, assert);
    await shot(page, `thread-${width}-${theme}.png`);
    if (width === 390) {
      await page.locator(`[data-msg="${ID(2)}"] .msg-av-btn`).click();
      const sheet = page.getByTestId('profile-card');
      await sheet.getByText('Lena Park').waitFor();
      await page.waitForTimeout(600);
      const sb = await sheet.boundingBox();
      assert.ok(Math.abs(sb.y + sb.height - 860) <= 2 && sb.width >= width - 1, 'a bottom sheet on a phone');
      await fitsPhone(page, `profile ${width} ${theme}`, assert);
      await shot(page, `profile-${width}-${theme}.png`);
      await page.getByRole('button', { name: 'Close profile' }).click();
      await sheet.waitFor({ state: 'detached' });
    }
    await page.locator('.talk-head .chat-back').click();
    await page.locator('.talk-list').waitFor();
    await ctx.close();
  }
  checks.push('phone-push');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks, writes: writes.length, artifacts: out }));
} finally {
  await browser.close();
}
