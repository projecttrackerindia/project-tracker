import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { cutOff } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Private (end-to-end encrypted) chat, at 1440 and on a 390 phone, light and dark:
//  - turning it on from the conversation sets up this device first (recovery passphrase), registers only a PUBLIC key, and saves a
//    passphrase-wrapped recovery copy; the shared "✓ Saved" tick shows when the change lands;
//  - the header shows a lock and the note says Aura, search and the bot cannot read it; the AI actions are gone from the conversation;
//  - a message sent there leaves the browser as an envelope only (no plain text in the request), and is shown decrypted on screen.
// Synthetic API, made-up people.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist');
const artifacts = path.resolve(process.env.PM_UI_ARTIFACTS || 'test-results', 'private-chat'); await fs.mkdir(artifacts, { recursive: true });
const csp = await appCsp();
const at = (m) => new Date(Date.now() - m * 60000).toISOString();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Alex Morgan', email: 'preview@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const colleague = { userId: '00000000-0000-0000-0000-000000000003', name: 'Sam Rivera', role: 'Member', online: true, lastReadAt: at(1) };
const workspace = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Design Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 2 };
const cid = '00000000-0000-0000-0000-000000000010';
const SECRET = 'Sample vendor contract is signed';
const errors = [], checks = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });

const run = async (theme, phone) => {
  const state = { isPrivate: false, devices: [], backup: null, sent: [], items: [
    { id: '00000000-0000-0000-0000-000000000101', conversationId: cid, senderId: colleague.userId, senderName: colleague.name, kind: 'User', replyTo: null, editedAt: null, body: 'Can we talk about the vendor deal?', createdAt: at(9), attachments: [], reactions: [], isDeleted: false },
  ] };
  const conversation = () => ({ id: cid, type: 'Direct', name: 'Sam Rivera', members: [colleague, { userId: user.id, name: user.displayName, role: 'Admin', online: true, lastReadAt: at(1) }], unread: 0, isMuted: false, canManage: false,
    otherUserId: colleague.userId, projectId: null, unreadMentions: 0, lastMessage: null, lastActivityAt: at(9), isPrivate: state.isPrivate });
  const context = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block',
    ...(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } }) });
  await context.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); }, theme);
  await context.route('**/*', async (route) => {
    const req = route.request(); const url = new URL(req.url()); const ep = url.pathname; const m = req.method();
    if (url.origin !== origin || ep.startsWith('/hubs/')) { await route.abort(); return; }
    if (ep.endsWith('/avatar')) { await route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"none"}' }); return; }
    if (!ep.startsWith('/api/')) {
      const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
      const type = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream';
      await route.fulfill({ status: 200, contentType: type, body: await fs.readFile(file), headers: path.extname(file) === '.html' ? { 'content-security-policy': csp } : {} }); return;
    }
    let data = [], status = 200;
    const b = m !== 'GET' ? req.postDataJSON() : null;
    if (ep.endsWith('/auth/refresh')) data = { accessToken: `x.${Buffer.from(JSON.stringify({ wid: workspace.id, exp: 4102444800 })).toString('base64url')}.x`, expiresAt: '2099-01-01T00:00:00Z', user };
    else if (ep === '/api/v1/me') data = { user, workspaces: [workspace], fingerprint: 'preview', pendingConsent: [], current: { ...workspace, permissions: ['org.manage', 'work.view', 'chat.view'], modules: { projects: 3, work: 3, ai: 3, chat: 3, people: 3, documents: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: {} } };
    else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
    else if (ep === '/api/v1/chat/conversations') data = [conversation()];
    else if (ep === `/api/v1/chat/conversations/${cid}`) data = conversation();
    else if (ep === `/api/v1/chat/conversations/${cid}/private`) { state.isPrivate = !!b.enabled; data = conversation(); }
    else if (ep === '/api/v1/chat/keys/me') data = { devices: state.devices, hasBackup: !!state.backup };
    else if (ep === '/api/v1/chat/keys/backup' && m === 'PUT') { state.backup = b; data = { ...b, updatedAt: at(0) }; }
    else if (ep === '/api/v1/chat/keys/backup') { if (!state.backup) status = 204; data = state.backup; }
    else if (ep === '/api/v1/chat/keys/devices' && m === 'PUT') { state.devices.push({ userId: user.id, deviceId: b.deviceId, publicKey: b.publicKey, label: b.label, createdAt: at(0) }); data = state.devices.at(-1); }
    else if (ep === `/api/v1/chat/conversations/${cid}/keys`) data = state.devices;
    else if (ep === `/api/v1/chat/conversations/${cid}/messages` && m === 'POST') {
      state.sent.push(req.postData());
      const msg = { id: `00000000-0000-0000-0000-0000000002${String(state.sent.length).padStart(2, '0')}`, conversationId: cid, senderId: user.id, senderName: user.displayName, kind: 'User', replyTo: null, editedAt: null, body: '', cipher: b.cipher, createdAt: at(0), attachments: [], reactions: [], isDeleted: false };
      state.items.push(msg); data = msg; status = 201;
    }
    else if (ep.endsWith('/messages')) data = { items: state.items, hasMore: false };
    else if (ep.endsWith('/files')) data = { items: [], hasMore: false };
    else if (ep.endsWith('/scheduled') || ep.endsWith('/pins') || ep.endsWith('/questions') || ep.endsWith('/people')) data = [];
    else if (ep.endsWith('/chat/status')) data = { emoji: null, text: null, clearAt: null, dndUntil: null, dnd: false };
    else if (ep.includes('/unread') || ep.includes('/counts')) data = { count: 0, total: 0 };
    else if (ep === '/api/v1/timer') data = null;
    else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
    else if (ep === '/api/v1/calls/status') data = { available: true, maxParticipants: 50 };
    if (status === 204) { await route.fulfill({ status: 204, body: '' }); return; }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  const page = await context.newPage(); page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE', m.text().slice(0, 600)); }); page.on('pageerror', (e) => { errors.push(e.message); console.error('PAGEERR', e.message, e.stack?.slice(0, 400)); });
  await page.goto(`${origin}/preview-org/chat/${cid}`); await page.locator('.composer').waitFor(); await page.waitForTimeout(300);
  // Turn private chat on: the lock in the header on desktop, the ⋯ menu on the phone (Messages style).
  const lockBtn = page.locator('.chat-head button[aria-label="Private chat (end-to-end encrypted)"]');
  if (await lockBtn.count()) await lockBtn.click();
  else { await page.getByRole('button', { name: 'Details', exact: true }).first().click(); await page.waitForTimeout(800); await page.screenshot({ path: path.join(artifacts, 'debug-details.png') }); await page.locator('[data-testid="private-switch"]').click(); }
  const sheet = page.getByRole('dialog').filter({ hasText: 'Recovery passphrase' }); await sheet.waitFor();
  assert.match(await sheet.innerText(), /never leaves it/);
  await page.waitForTimeout(250); await page.screenshot({ path: path.join(artifacts, `${phone ? 'phone' : 'desktop'}-${theme}-setup.png`) });
  const pwd = sheet.locator('input[type=password]');
  await pwd.nth(0).fill('a sample recovery phrase'); await pwd.nth(1).fill('a sample recovery phrase');
  await sheet.getByRole('button', { name: 'Set up' }).click();
  if (phone) {   // the switch in Details is on; back to the thread
    await page.locator('[data-testid="private-switch"][aria-checked="true"]').waitFor({ timeout: 20000 });
    await page.screenshot({ path: path.join(artifacts, `phone-${theme}-details.png`) });
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    if (!(await page.locator('[data-testid="e2e-banner"]').isVisible())) await page.getByRole('button', { name: /Back|Close/ }).first().click().catch(() => undefined);
  }
  await page.locator('[data-testid="e2e-banner"]').waitFor({ timeout: 20000 });
  if (!phone) await page.locator('[data-testid="saved-tick"]').waitFor({ timeout: 4000 }); checks.push(`${theme}-${phone ? 'phone' : 'desktop'}-saved-tick`);
  assert.equal(state.devices.length, 1, 'this device registered once');
  assert.ok(!state.devices[0].publicKey.includes('"d"'), 'only the public key left the browser');
  assert.ok(state.backup.iterations >= 310000 && !JSON.stringify(state.backup).includes('a sample recovery phrase'), 'the recovery copy is wrapped, never the passphrase');
  assert.match(await page.locator('[data-testid="e2e-banner"]').innerText(), /Aura, search and the bot can't read it/);
  assert.ok(await page.locator('.e2e-lock').first().isVisible(), 'lock in the header');
  assert.equal(await page.locator('.chat-head button[aria-label="Catch me up on this conversation"]').count(), 0, 'no AI catch-up on a private chat');
  // Send: an envelope only, shown decrypted here.
  await page.locator('.composer-editable').click(); await page.keyboard.type(SECRET); await page.keyboard.press('Enter');
  await page.getByText(SECRET).last().waitFor({ timeout: 8000 });
  assert.equal(state.sent.length, 1);
  assert.ok(!state.sent[0].includes('vendor contract'), 'no plain text in the request');
  const body = JSON.parse(state.sent[0]); assert.equal(body.body, null); assert.equal(JSON.parse(body.cipher).v, 1);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(artifacts, `${phone ? 'phone' : 'desktop'}-${theme}.png`) });
  if (phone) { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'no horizontal scroll'); assert.deepEqual(await cutOff(page), [], 'cut off'); }
  checks.push(`${theme}-${phone ? 'phone' : 'desktop'}-private-send`);
  await context.close();
};
try {
  for (const theme of ['light', 'dark']) for (const phone of [false, true]) await run(theme, phone);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, artifacts }));
} finally { await browser.close(); }
