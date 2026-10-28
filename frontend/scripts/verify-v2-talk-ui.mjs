import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Talk (v2, s-talk): chats and meetings in one list with All · Unread · Chats · Meetings (mail has its own place) and a source glyph per row, meetings and
// channels as rounded squares, the "Connect your mailbox" banner, a chat thread with members, call and ⓘ, the pinned "While you were away"
// card (now an inline chip, see verify-messages-apple-ui), actions BESIDE the bubble (Make task · Remind me · ↩ · ···), "Message …" with Draft reply, and a meeting opening in the same pane. 1440 light and dark, and a 390 phone. Synthetic API only.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist');
const out = path.resolve(process.env.PM_UI_ARTIFACTS || 'test-results/enterprise-ui', 'v2-talk');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const ago = (m) => new Date(Date.now() - m * 60_000).toISOString();
const ahead = (m) => new Date(Date.now() + m * 60_000).toISOString();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 4 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const dev = { userId: '00000000-0000-0000-0000-000000000003', name: 'Devraj Kumar', role: 'Member', online: true, lastReadAt: ago(1) };
const ravi = { userId: '00000000-0000-0000-0000-000000000004', name: 'Ravi Shah', role: 'Member', online: false, lastReadAt: ago(60) };
const meMember = { userId: user.id, name: user.displayName, role: 'Admin', online: true, lastReadAt: ago(1) };
const direct = { id: '00000000-0000-0000-0000-000000000010', type: 'Direct', name: dev.name, members: [dev, meMember], unread: 0, isMuted: false, canManage: false, otherUserId: dev.userId, projectId: null, unreadMentions: 0,
  lastMessage: { snippet: 'okay, thanks', senderName: dev.name, isMine: false, isSystem: false, at: ago(4) }, lastActivityAt: ago(4) };
const group = { id: '00000000-0000-0000-0000-000000000011', type: 'Group', name: 'MuleSoft Support', members: [dev, ravi, meMember], unread: 2, isMuted: false, canManage: true, otherUserId: null, projectId: null, unreadMentions: 0,
  lastMessage: { snippet: 'Server is back', senderName: ravi.name, isMine: false, isSystem: false, at: ago(90) }, lastActivityAt: ago(90) };
const M = (n, mine, body, mins) => ({ id: `00000000-0000-0000-0000-0000000001${String(n).padStart(2, '0')}`, conversationId: direct.id, senderId: mine ? user.id : dev.userId, senderName: mine ? user.displayName : dev.name,
  kind: 'User', replyTo: null, editedAt: null, body, createdAt: ago(mins), attachments: [], reactions: [], isDeleted: false });
const messages = [M(1, false, 'Can you send it as a mail to me?', 30), M(2, true, 'Sure, will send the receipt deed doc.', 20), M(3, false, 'okay, thanks', 4)];
const meetingId = '00000000-0000-0000-0000-0000000000b1';
const project = { id: '00000000-0000-0000-0000-0000000000a1', name: 'Atlas', key: 'ATL' };
const meeting = { kind: 'project', id: meetingId, ref: `p:${meetingId}`, title: 'Daily status call', start: ahead(20 * 60), end: ahead(20 * 60 + 30), provider: 'ours', providerName: 'Project Tracker call',
  joinUrl: `/calls/meeting/${meetingId}`, projectId: project.id, projectName: project.name, projectKey: project.key, description: null, timeZone: 'Asia/Kolkata', calendarUrl: null, isScrum: false, recurring: false,
  sessionsLeft: null, notetaker: 'transcript', isOrganizer: true, canManage: true, organizerName: user.displayName, invited: 2, accepted: 1, declined: 0, status: 'Scheduled', notes: null, live: false, myRsvp: 'Organizer' };
const avatar = (initials, square = false, userId = null) => ({ initials, userId, hasAvatar: false, square });
const talkRow = (o) => ({ sub: null, last: null, unread: 0, group: false, account: null, messageId: null, meetingRef: null, sessionStart: null, live: false, upcoming: false, joinUrl: null, ...o });
const talk = () => ({
  items: [
    talkRow({ id: direct.id, kind: 'chat', title: dev.name, last: 'okay, thanks', at: ago(4), avatar: avatar('DK', false, dev.userId) }),
    talkRow({ id: `meet:${meeting.ref}`, kind: 'meeting', title: meeting.title, sub: 'Meeting · Atlas · Notes and actions by AI', last: 'Project Tracker call', at: meeting.start, avatar: avatar('DS', true),
      meetingRef: meeting.ref, sessionStart: meeting.start, upcoming: true, joinUrl: meeting.joinUrl }),
    talkRow({ id: group.id, kind: 'chat', title: group.name, sub: 'Group', last: 'Ravi: Server is back', at: ago(90), unread: 2, group: true, avatar: avatar('MS') }),
  ],
  mail: { state: 'not-connected', account: null, email: null, provider: null }, chatAvailable: true,
});
const errors = [], checks = [], writes = [], talkFilters = [];
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
    if (method !== 'GET' && !ep.endsWith('/auth/refresh')) writes.push({ ep, method });
    let data = [];
    if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
    else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['org.manage', 'work.view', 'chat.view', 'projects.view', 'calendar.view'], modules: { projects: 3, work: 3, ai: 3, chat: 3, people: 3, documents: 3, calendar: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3 } } };
    else if (ep === '/api/v1/me/ui/sidebar') data = { key: 'sidebar', value: null, updatedAt: null };
    else if (ep === '/api/v1/talk/conversations') { talkFilters.push(url.searchParams.get('f')); data = talk(); }
    else if (ep === '/api/v1/chat/conversations') data = [direct, group];
    else if (ep === `/api/v1/chat/conversations/${direct.id}/messages` && method === 'GET') data = { items: messages, hasMore: false };
    else if (ep.endsWith('/messages') && method === 'GET') data = { items: [], hasMore: false };
    else if (ep === '/api/v1/chat/ai/catch-up') data = { summary: 'He agreed to the plan and asked for the doc by mail.', decisions: [], questions: [], actions: [], conversations: 1, messages: 3, model: 'synthetic' };
    else if (ep.endsWith('/replies')) data = { replies: ['Sending the doc by mail now.'], model: 'synthetic' };
    else if (ep.endsWith('/pins')) data = [];
    else if (ep === '/api/v1/chat/questions') data = [];
    else if (ep.includes('/unread') || ep.includes('/counts')) data = { count: 0, total: 0 };
    else if (ep === '/api/v1/calls/status') data = { available: true, maxParticipants: 50 };
    else if (ep === '/api/v1/calls/live') data = [];
    else if (ep === '/api/v1/integrations/google/status') data = { connected: false, inboxEnabled: true };
    else if (ep === '/api/v1/integrations/microsoft/status') data = { enabled: true, configured: true, connected: false };
    else if (ep === '/api/v1/me/mailbox/accounts') data = { imap: [], presets: [{ id: 'rediff', name: 'Rediffmail', domain: 'rediffmail.com' }], company: { provider: 'rediff', name: 'Rediffmail', domains: ['northwind.example'], incoming: 'imap', incomingHost: 'imap.example.test', incomingPort: 993, smtpHost: 'smtp.example.test', smtpPort: 465, custom: false }, canManageCompany: false, myEmail: user.email };
    else if (ep === '/api/v1/meet') data = { items: [meeting], from: url.searchParams.get('from'), to: url.searchParams.get('to'), truncated: false };
    else if (ep === `/api/v1/meetings/${meetingId}`) data = { id: meetingId, projectId: project.id, title: meeting.title, description: 'Blockers and today', startTime: meeting.start, endTime: meeting.end, timeZone: 'Asia/Kolkata', status: 'Scheduled',
      meetUri: meeting.joinUrl, organizerUserId: user.id, organizerName: user.displayName, provider: 'ours', providerName: 'Project Tracker call', notetaker: 'transcript', recurrenceRule: null, isScrum: false,
      participants: [{ userId: user.id, name: user.displayName, email: user.email, role: 'Organizer', rsvpStatus: 'Accepted' }, { userId: dev.userId, name: dev.name, email: 'dev@example.test', role: 'Attendee', rsvpStatus: 'NeedsAction' }] };
    else if (ep === '/api/v1/timer') data = null;
    else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
    await json(data);
  });
  return ctx;
};
const shot = async (page, name) => { await page.waitForTimeout(250); await page.screenshot({ path: path.join(out, name) }); };

try {
  // ---- 1440, light
  let ctx = await make('light'); let page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/preview-org/talk`);
  await page.locator('.talk-list').waitFor();
  assert.ok(new URL(page.url()).pathname.endsWith('/preview-org/messages'), `the old /talk address lands on /messages: ${page.url()}`);
  assert.equal(await page.locator('.talk-shell h1.sr-only').innerText(), 'Messages');
  checks.push('talk-renamed-messages');
  await page.locator('.talk-row[data-row="Daily status call"]').waitFor();
  assert.deepEqual(await page.locator('.talk-filters .talk-chip').allInnerTexts(), ['All', 'Unread 1', 'Chats', 'Meetings']);
  assert.ok(await page.getByRole('textbox', { name: 'Search Messages' }).isVisible(), 'search at the top of the list');
  assert.equal(await page.locator('.talk-row.k-meeting .talk-src').count(), await page.locator('.talk-row.k-meeting').count(), 'a ▶ badge on every meeting');
  assert.equal(await page.locator('.talk-row.k-meeting .talk-src.s-presence').count(), 0, 'presence only on people');
  assert.equal(await page.locator('.talk-row[data-row="MuleSoft Support"] .talk-dot').count(), 1, 'an unread dot');
  // the meeting is a rounded square, people are round
  const radius = async (sel) => page.locator(sel).first().evaluate((e) => parseFloat(getComputedStyle(e).borderTopLeftRadius));
  const sq = await radius('.talk-row[data-row="Daily status call"] .talk-av');
  assert.ok(sq > 4 && sq < 20, `meeting avatar is a rounded square (${sq}px)`);
  assert.ok(await radius('.talk-row[data-row="Devraj Kumar"] .talk-av') >= 19, 'a person is round');
  const ch = await radius('.talk-row[data-row="MuleSoft Support"] .talk-av');
  assert.ok(ch > 4 && ch < 20, `a group is a rounded square with # (${ch}px)`);
  assert.equal(await page.getByTestId('connect-mailbox').count(), 0, 'no mail in Talk: it has its own place');
  assert.equal(await page.locator('.talk-src').filter({ hasText: /^[MR]$/ }).count(), 0, 'no mail rows');
  checks.push('one-list');
  await shot(page, 'list-1440-light.png');

  await page.locator('.talk-filters .talk-chip', { hasText: 'Meetings' }).click();
  await page.waitForFunction(() => location.search.includes('f=meetings'));
  await page.waitForFunction(() => document.querySelectorAll('.talk-rows .talk-row').length === 1);   // the others glide out
  assert.deepEqual(await page.locator('.talk-rows .talk-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-row'))), ['Daily status call']);
  // Mail moved out of Talk: the old Mail filter address opens Mail, and Talk asks only for chats and meetings.
  assert.ok(talkFilters.length > 0 && talkFilters.every((f) => f === 'talk'), `Talk asks for f=talk: ${talkFilters}`);
  await page.goto(`${origin}/preview-org/talk?f=mail`);
  await page.waitForURL(/\/mail$/);
  await page.goto(`${origin}/preview-org/talk`);
  await page.locator('.talk-row[data-row="Daily status call"]').waitFor();
  checks.push('no-mail');
  await page.locator('.talk-filters .talk-chip', { hasText: 'All' }).click();
  checks.push('filters');

  // A chat: the v2 header, the summary strip, the composer.
  await page.locator('.talk-row[data-row="Devraj Kumar"]').click();
  await page.waitForFunction((id) => location.pathname.endsWith(`/messages/${id}`), direct.id);
  await page.locator('.talk-head').waitFor();
  assert.ok(await page.locator('.talk-head').getByRole('button', { name: 'Call' }).isVisible(), 'Call in the thread header');
  assert.ok(await page.getByRole('button', { name: 'Conversation actions' }).isVisible(), 'ⓘ (details and more) in the thread header');
  assert.equal(await page.locator('.composer-editable').getAttribute('data-placeholder'), 'Message Devraj Kumar');
  // No pinned card over the thread any more: with nothing unread there is no "while you were away" at all (the chip, its expand
  // and dismiss are checked with unread messages in verify-messages-apple-ui); the summary stays one tap away in ··· → Catch me up.
  assert.equal(await page.getByTestId('summary-strip').count(), 0, 'no pinned summary card');
  assert.equal(await page.getByTestId('away-chip').count(), 0, 'no summary chip without unread messages');
  await page.getByRole('button', { name: 'Conversation actions' }).click();
  await page.getByRole('menuitem', { name: /Catch me up/ }).click();
  await page.getByText('He agreed to the plan and asked for the doc by mail.').waitFor();
  await page.keyboard.press('Escape');
  checks.push('while-you-were-away');
  assert.match((await page.getByRole('button', { name: 'Groot drafts a reply' }).innerText()).trim(), /Draft/);
  await page.getByRole('button', { name: 'Groot drafts a reply' }).click();
  await page.waitForFunction(() => document.querySelector('.composer-editable')?.textContent?.includes('Sending the doc by mail now.'));
  checks.push('composer-draft');

  // Hover: Make task · Remind me · ↩ · ··· beside the bubble, never over it.
  const theirs = page.locator(`[data-msg="${messages[0].id}"]`);
  await theirs.locator('.bubble').hover();
  const acts = theirs.locator('.msg-actions');
  await acts.waitFor();
  assert.deepEqual((await acts.locator('button').allInnerTexts()).map((t) => t.trim()), ['Make task', 'Remind me', '', '']);
  assert.ok(await acts.getByRole('button', { name: 'Reply' }).isVisible(), '↩ is Reply');
  const b = await theirs.locator('.bubble').boundingBox(), a = await acts.boundingBox();
  assert.ok(a.x >= b.x + b.width, `actions sit to the right of their bubble (${a.x} vs ${b.x + b.width})`);
  await acts.getByRole('button', { name: 'More actions' }).click();
  const menu = page.getByRole('menu', { name: 'More actions' });   // the menu floats in a portal, outside the row
  for (const name of ['Save for later', 'Copy text', 'Pin to the conversation']) assert.ok(await menu.getByRole('menuitem', { name }).isVisible(), name);
  assert.equal(await menu.getByRole('menuitem', { name: /React/ }).count(), 6, 'reactions live under ···');
  await shot(page, 'thread-1440-light.png');
  await page.keyboard.press('Escape'); await page.mouse.click(5, 5);
  const mine = page.locator(`[data-msg="${messages[1].id}"]`);
  await page.mouse.move(5, 5); await mine.locator('.bubble').hover();
  const b2 = await mine.locator('.bubble').boundingBox(), a2 = await mine.locator('.msg-actions').boundingBox();
  assert.ok(a2.x + a2.width <= b2.x, 'my message: actions sit to the left of the bubble');
  await mine.getByRole('button', { name: 'More actions' }).click();
  assert.ok(await page.getByRole('menu', { name: 'More actions' }).getByRole('menuitem', { name: 'Delete' }).isVisible(), 'delete is under ··· for my own message');
  await page.mouse.click(5, 5);
  checks.push('actions-beside-bubble');

  // A meeting opens in the same pane.
  await page.locator('.talk-row[data-row="Daily status call"]').click();
  await page.locator('.mt-inline').waitFor();
  await page.locator('.mt-inline-title h2', { hasText: 'Daily status call' }).waitFor();
  await page.locator('.mt-inline').getByText('Blockers and today').waitFor();
  await shot(page, 'meeting-1440-light.png');
  checks.push('meeting-in-pane');
  assert.deepEqual(errors, []);
  await ctx.close();

  // ---- the last message is a long JSON payload: it renders as a folded code block, its hover actions sit on the bubble's top edge
  // inside the visible list, and its ··· menu opens upward, fully inside the window and above the composer.
  const payload = { serviceCode: 'CAS10001', monitoringDate: '08102020', addresses: Array.from({ length: 6 }, (_, i) => ({ index: `A0${i}`, line1: 'KONGU VIBROSTREET TNAGAR', line2: '', stateCode: '33', pinCode: '600054', addressCategory: '01', residenceCode: '01' })), enquiryAccounts: [{ index: 'I01', accountNumber: '' }] };
  messages.push(M(4, true, JSON.stringify(payload, null, 4), 1));
  ctx = await make(); page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1173, height: 564 });
  await page.goto(`${origin}/preview-org/messages/${direct.id}`);
  const last = page.locator(`[data-msg="${messages[3].id}"]`);
  await last.locator('.msg-code').waitFor();
  const code = await last.locator('.msg-code').evaluate((e) => ({ bg: getComputedStyle(e).backgroundColor, font: getComputedStyle(e.querySelector('pre')).fontFamily, h: e.querySelector('.msg-code-body').getBoundingClientRect().height }));
  assert.match(code.font, /mono|Menlo|Consolas/i, 'code is monospace');
  assert.notEqual(code.bg, await last.locator('.bubble').evaluate((e) => getComputedStyle(e).backgroundColor), 'code sits on a neutral ground, not the blue bubble');
  assert.ok(code.h <= 330, `long code folds (${code.h})`);
  assert.ok(await last.getByRole('button', { name: /Show more/ }).isVisible(), 'Show more');
  assert.ok(await last.getByRole('button', { name: 'Copy code' }).isVisible(), 'Copy');
  const col = await last.locator('.msg-col').boundingBox(), pane = await page.locator('.chat-messages').boundingBox();
  assert.ok(col.width <= pane.width * 0.66, `bubble stays within ~64% (${col.width} of ${pane.width})`);
  await last.getByRole('button', { name: /Show more/ }).click();
  await page.locator('.chat-messages').evaluate((e) => { e.scrollTop = e.scrollHeight; });
  await page.evaluate(() => (document.activeElement)?.blur?.());   // Show more keeps focus (and so the actions) on the row
  await page.mouse.move(5, 5); await last.locator('.bubble').hover({ position: { x: 40, y: 20 } });
  const list = await page.locator('.chat-messages').boundingBox(), composer = await page.locator('.composer-row').boundingBox();
  const lb = await last.locator('.bubble').boundingBox(), la = await last.locator('.msg-actions').boundingBox();
  // Beside the bubble's top edge on its outer side; in a pane too narrow for that, just above the bubble, or tucked inside its visible top.
  const mode = await last.locator('.msg-actions').evaluate((e) => (e.classList.contains('inside') ? 'inside' : e.classList.contains('above') ? 'above' : 'beside'));
  if (mode === 'beside') assert.ok(la.x + la.width <= lb.x, 'actions on the outer (left) side of my bubble');
  else assert.ok(la.x >= lb.x - 1 && la.x + la.width <= lb.x + lb.width + 1, `actions over my bubble's width (${mode})`);
  if (mode === 'above') assert.ok(Math.abs(la.y + la.height + 4 - lb.y) <= 2, 'actions sit right above the bubble top');
  else assert.ok(la.y >= Math.max(lb.y, list.y) - 1 && la.y + la.height <= Math.min(lb.y + lb.height, list.y + list.height) + 1, `actions inside the visible part of the bubble (${la.y} in ${lb.y}..${lb.y + lb.height})`);
  assert.ok(la.y >= list.y - 1 && la.x >= list.x - 1 && la.x + la.width <= list.x + list.width + 1, 'actions not clipped by the pane');
  assert.ok(la.y + la.height <= composer.y, 'actions above the composer');
  await last.getByRole('button', { name: 'More actions' }).click();
  const pop = page.getByRole('menu', { name: 'More actions' });
  await pop.waitFor();
  const mb = await pop.boundingBox(), vp = page.viewportSize();
  assert.ok(mb.x >= 0 && mb.y >= 0 && mb.x + mb.width <= vp.width && mb.y + mb.height <= vp.height, `menu inside the window (${JSON.stringify(mb)})`);
  assert.ok(mb.y + mb.height <= composer.y, `menu above the composer (${mb.y + mb.height} vs ${composer.y})`);
  await pop.getByRole('menuitem').first().waitFor();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'menuitem', 'arrow keys move into the menu');
  await shot(page, 'talk-menu-fixed.png');
  await page.keyboard.press('Escape');
  await pop.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'More actions', 'focus returns to ···');
  messages.pop();
  checks.push('menu-fits-above-composer');
  assert.deepEqual(errors, []);
  await ctx.close();

  // ---- 1440, dark
  ctx = await make('dark'); page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/preview-org/messages/${direct.id}`);
  await page.locator('.talk-head').waitFor();
  const bg = await page.locator('.talk-list').evaluate((e) => getComputedStyle(e).backgroundColor);
  assert.notEqual(bg, 'rgb(255, 255, 255)', 'the list card follows the dark theme');
  await shot(page, 'thread-1440-dark.png');
  checks.push('dark');
  await ctx.close();

  // ---- 390 phone
  for (const theme of ['light', 'dark']) {
    ctx = await make(theme, { hasTouch: true, isMobile: true }); page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/preview-org/messages`);
    await page.locator('.talk-row[data-row="Devraj Kumar"]').waitFor();
    assert.equal(await page.locator('.talk-pane').isVisible(), false, 'the phone shows the list first');
    await fitsPhone(page, `talk list ${theme}`, assert);
    await shot(page, `list-390-${theme}.png`);
    await page.locator('.talk-row[data-row="Devraj Kumar"]').click();
    await page.locator('.talk-head').waitFor();
    assert.equal(await page.locator('.talk-list').isVisible(), false, 'the thread replaces the list');
    assert.ok(await page.locator('.talk-head .chat-back').isVisible(), 'a way back to the list');
    assert.equal(await page.locator('.msg-actions').evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height > 0).length), 0, 'no hover actions on a phone');
    await fitsPhone(page, `talk thread ${theme}`, assert);
    await shot(page, `thread-390-${theme}.png`);
    await page.locator('.talk-head .chat-back').click();
    await page.locator('.talk-list').waitFor();
    await ctx.close();
  }
  checks.push('phone');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks, writes: writes.length, artifacts: out }));
} finally {
  await browser.close();
}
