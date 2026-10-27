import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Messages: a large payload becomes a file. Pasting a long JSON (with a token in it) shows the "send it as a file?" suggestion with a smart
// name, a preview and the secrets warning; Send as file uploads a masked .json through the chat attachment API and the thread shows a rich
// file card (preview, Download / Open / Copy); Open shows the full-screen viewer (tree, search, Compare). Also: a long JSON message already in
// the history offers Open and Save as file. 1440 light and dark. Synthetic API only.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist');
const out = path.resolve(process.env.PM_UI_ARTIFACTS || 'test-results/enterprise-ui', 'chat-payload');
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
const oldJson = JSON.stringify({ request: 'CRIF score', rows: Array.from({ length: 30 }, (_, i) => ({ i, pan: `ABCDE${1000 + i}F`, score: 700 + i })) });
const messages = [M(1, false, oldJson, 30), M(2, true, 'Sure, will check the CRIF response.', 20), M(3, false, 'okay, thanks', 4)];
const files = new Map();
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
const errors = [], checks = [], writes = [];
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
    else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['org.manage', 'work.view', 'chat.view', 'projects.view', 'calendar.view'], modules: { projects: 3, work: 3, ai: 3, chat: 3, people: 3, documents: 3, calendar: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3, CHAT_ATTACHMENTS: 1 } } };
    else if (ep === '/api/v1/me/ui/sidebar') data = { key: 'sidebar', value: null, updatedAt: null };
    else if (ep === '/api/v1/talk/conversations') data = talk();
    else if (ep === '/api/v1/chat/conversations') data = [direct, group];
    else if (ep === `/api/v1/chat/conversations/${direct.id}/messages` && method === 'GET') data = { items: messages, hasMore: false };
    else if (ep === `/api/v1/chat/conversations/${direct.id}/files` && method === 'POST') {
      const raw = req.postDataBuffer()?.toString('utf8') ?? '';
      const name = /filename="([^"]+)"/.exec(raw)?.[1] ?? 'file';
      const body = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n--[^\r\n]*--\r\n$/, '');
      const id = `00000000-0000-0000-0000-0000000009${String(files.size).padStart(2, '0')}`;
      files.set(id, { id, fileName: name, contentType: 'application/json', sizeBytes: Buffer.byteLength(body), isImage: false, body });
      const { body: _b, ...att } = files.get(id); data = att;
    }
    else if (ep === `/api/v1/chat/conversations/${direct.id}/messages` && method === 'POST') {
      const b = JSON.parse(req.postData() || '{}');
      const m = { ...M(messages.length + 1, true, b.body, 0), attachments: (b.attachmentIds ?? []).map((id) => { const { body: _b, ...att } = files.get(id); return att; }) };
      messages.push(m); data = m;
    }
    else if (ep.startsWith('/api/v1/chat/files/') && files.has(ep.split('/').pop())) { await route.fulfill({ status: 200, contentType: 'application/json', body: files.get(ep.split('/').pop()).body }); return; }
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
const shot = async (page, name, file) => { await page.waitForTimeout(250); await page.screenshot({ path: file ?? path.join(out, name) }); };
const pad = process.env.PM_SHOTS || out;

try {
  for (const theme of ['light', 'dark']) {
    const ctx = await make(theme); const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${origin}/preview-org/messages/${direct.id}`);
    await page.locator('.talk-head').waitFor();

    if (theme === 'light') {
      // A long JSON already in the history keeps its folded code block, now with Open and Save as file.
      const old = page.locator('.msg-code').first();
      await old.waitFor();
      assert.ok(await old.getByRole('button', { name: 'Save as file' }).isVisible(), 'Save as file on an old long JSON message');
      await old.getByRole('button', { name: 'Open' }).click();
      await page.getByTestId('payload-viewer').waitFor();
      assert.ok(await page.getByRole('tree', { name: 'JSON' }).isVisible(), 'the old message opens in the JSON tree');
      await page.keyboard.press('Escape');
      await page.getByTestId('payload-viewer').waitFor({ state: 'detached' });
      checks.push('history-json-viewer');
    }

    // Paste a long JSON with a bearer token into the composer.
    const payload = JSON.stringify({ headers: { Authorization: 'Bearer sk-live-SECRET-123456' }, customer: { id: 42, name: 'Asha', password: 'hunter2-secret' }, items: Array.from({ length: 60 }, (_, i) => ({ i, sku: `SKU-${i}`, qty: i % 4, status: i % 9 ? 'OK' : 'FAILED' })) });
    const box = page.getByRole('textbox', { name: 'Write a message' });
    await box.click();
    await box.pressSequentially('CRIF response from UAT');
    await page.evaluate((t) => {
      const el = document.querySelector('[aria-label="Write a message"]');
      const dt = new DataTransfer(); dt.setData('text/plain', t);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, payload);
    const card = page.getByTestId('payload-suggest');
    await card.waitFor();
    const say = await card.innerText();
    assert.match(say, /This looks like JSON \(\d+ KB, [\d,]+ lines\)/, say);
    assert.match(say, /Contains possible secrets/, 'the secrets warning');
    assert.match(await card.getByLabel('File name').inputValue(), /^payload-Devraj-Kumar-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
    assert.ok(!(await card.innerText()).includes('sk-live-SECRET'), 'the preview masks the token');
    assert.equal((await box.innerText()).trim(), '', 'the JSON did not go into the box');
    await card.getByLabel('File name').fill('crif-uat-response');
    if (theme === 'light') await shot(page, 'suggest.png', path.join(pad, 'msg-suggest.png'));
    await card.getByLabel('File name').press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    const fileCard = page.getByTestId('payload-card').last();
    await fileCard.waitFor();
    await fileCard.locator('.pl-card-preview').waitFor();
    assert.match(await fileCard.innerText(), /crif-uat-response\.json/);
    await fileCard.locator('.pl-card-meta em', { hasText: 'lines' }).waitFor();   // the line count shows once the file is read
    const sent = [...files.values()].at(-1);
    assert.ok(!sent.body.includes('sk-live-SECRET') && !sent.body.includes('hunter2'), 'secrets were masked in the uploaded file');
    assert.ok(sent.body.startsWith('{\n  "headers"'), 'the JSON was pretty-printed');
    assert.equal(messages.at(-1).body, 'CRIF response from UAT', 'what was typed went as the caption');
    for (const b of ['Download', 'Open', 'Copy']) assert.ok(await fileCard.getByRole('button', { name: b, exact: true }).isVisible(), b);
    await page.waitForTimeout(300);
    await shot(page, `filecard-${theme}.png`, theme === 'light' ? path.join(pad, 'msg-filecard.png') : undefined);
    checks.push(`send-as-file-${theme}`);

    // The viewer: tree, search, copy a path, compare.
    await fileCard.getByTestId('payload-open').click();
    const viewer = page.getByTestId('payload-viewer');
    await viewer.waitFor();
    await viewer.getByRole('textbox', { name: 'Search' }).fill('FAILED');
    await page.waitForTimeout(150);
    assert.ok(await viewer.locator('.pl-tree .hit').count() > 0, 'search highlights matches');
    await viewer.getByRole('button', { name: 'Compare' }).click();
    await viewer.getByRole('textbox', { name: 'The other JSON' }).fill(JSON.stringify({ customer: { id: 43 } }));
    assert.match(await viewer.getByTestId('payload-diff').innerText(), /\$\.customer\.id/);
    await shot(page, `viewer-${theme}.png`, theme === 'light' ? path.join(pad, 'msg-viewer.png') : undefined);
    await page.keyboard.press('Escape');
    await viewer.waitFor({ state: 'detached' });
    checks.push(`viewer-${theme}`);
    await ctx.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks, writes: writes.length, artifacts: out }));
} finally {
  await browser.close();
}
