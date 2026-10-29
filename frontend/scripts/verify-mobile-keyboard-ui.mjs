import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Phones with the on-screen keyboard up (owner's iPhone report): the composer docks right on top of the keyboard and the message list
// shrinks and stays on the newest message (normal, reply, edit); the tab bar and Ask bar step aside while typing; ✦ with text opens
// Improve writing / Fix grammar / Make shorter / More formal / Friendlier / Translate… (calls /chat/ai/transform, replaces the text,
// Undo), ✦ with an empty box drafts a reply; Details is a full-screen sheet that scrolls to its last member and closes with Done,
// a swipe down, or Escape (desktop has a visible ✕). Then an audit of other phone screens with a keyboard up.
// 390×844 iPhone UA (iOS model: the *visual* viewport shrinks, the layout viewport does not — faked here) and 412×915 Android UA
// (interactive-widget=resizes-content: the layout viewport shrinks — setViewportSize), light and dark. Synthetic API, made-up people.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist');
const out = path.resolve(process.env.PM_UI_ARTIFACTS || 'test-results/enterprise-ui', 'mobile-keyboard');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const ago = (m) => new Date(Date.now() - m * 60_000).toISOString();
const g = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const user = { id: g(1), displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: g(2), slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 9 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const names = ['Lena Park', 'Tomas Velde', 'Mira Holt', 'Jonas Ekberg', 'Priya Nair', 'Owen Tull', 'Sana Iqbal', 'Zed Marlow'];
const members = [{ userId: user.id, name: user.displayName, role: 'Admin', online: true, lastReadAt: ago(1) },
  ...names.map((n, i) => ({ userId: g(10 + i), name: n, role: 'Member', online: i % 2 === 0, lastReadAt: ago(5) }))];
const group = { id: g(100), type: 'Group', name: 'Orbit Support', members, unread: 0, isMuted: false, canManage: true, otherUserId: null, projectId: null, unreadMentions: 0,
  lastMessage: { snippet: 'Deploy is green', senderName: 'Tomas Velde', isMine: false, isSystem: false, at: ago(2) }, lastActivityAt: ago(2) };
let messages, seq = 0;
const M = (mine, body, mins) => ({ id: g(1000 + ++seq), conversationId: group.id, senderId: mine ? user.id : g(11), senderName: mine ? user.displayName : 'Tomas Velde',
  kind: 'User', replyTo: null, editedAt: null, body, createdAt: ago(mins), attachments: [], reactions: [], isDeleted: false });
const reset = () => { seq = 0; messages = Array.from({ length: 24 }, (_, i) => M(i % 3 === 0, `Status line ${i + 1}: the build for the staging slot ${i % 2 ? 'passed' : 'is queued'}.`, 60 - i * 2)); messages.push(M(true, 'Hi team need more preparation as part of production things', 1)); };
const errors = [], writes = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';

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
    else if (ep === '/api/v1/chat/conversations') data = [group];
    else if (ep === `/api/v1/chat/conversations/${group.id}/messages` && method === 'GET') data = { items: messages, hasMore: false };
    else if (ep === `/api/v1/chat/conversations/${group.id}/messages` && method === 'POST') { const b = JSON.parse(req.postData() || '{}'); const m = M(true, b.body, 0); messages.push(m); data = m; }
    else if (/\/chat\/messages\/[^/]+$/.test(ep) && method === 'PUT') { const id = ep.split('/').pop(); const b = JSON.parse(req.postData() || '{}'); const m = messages.find((x) => x.id === id); Object.assign(m, { body: b.body, editedAt: ago(0) }); data = m; }
    else if (ep === '/api/v1/chat/ai/transform') {
      const b = JSON.parse(req.postData() || '{}');
      const text = b.action === 'translate' ? `[${b.language}] ${b.text}` : b.action === 'fix' ? 'Hi team! We need more preparation for the production release.' : `Improved: ${b.text}`;
      data = { text, blocks: null, model: 'synthetic', inline: true };
    }
    else if (ep.endsWith('/replies')) data = { replies: ['Thanks, I will check the staging slot.'], model: 'synthetic' };
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

/** Raise a keyboard of `h` visible pixels: iOS — the visual viewport shrinks; Android — the layout viewport shrinks. */
const keyboardUp = async (page, device, h) => {
  if (device === 'iphone') await page.evaluate((hh) => { window.__vv = { height: hh, offsetTop: 0 }; window.visualViewport.dispatchEvent(new Event('resize')); }, h);
  else await page.setViewportSize({ width: page.viewportSize().width, height: h });
  await page.waitForTimeout(250);
};
const keyboardDown = async (page, device, full) => {
  if (device === 'iphone') await page.evaluate(() => { window.__vv = null; window.visualViewport.dispatchEvent(new Event('resize')); });
  else await page.setViewportSize({ width: page.viewportSize().width, height: full });
  await page.waitForTimeout(250);
};
const visibleBottom = (page) => page.evaluate(() => window.visualViewport.height + window.visualViewport.offsetTop);
const isShown = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].some((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0'; }), sel);
const shot = async (page, name) => { await page.waitForTimeout(300); await page.screenshot({ path: path.join(out, name) }); return path.join(out, name); };
const shots = [];

/** The composer sits directly on the keyboard and the list is on its newest message. */
const assertDocked = async (page, what) => {
  const vb = await visibleBottom(page);
  const c = await page.locator('.talk-thread .composer').boundingBox();
  assert.ok(Math.abs(c.y + c.height - vb) <= 2, `${what}: composer bottom ${Math.round(c.y + c.height)} == visible bottom ${vb}`);
  const gap = await page.locator('.talk-thread .chat-messages').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  assert.ok(gap <= 4, `${what}: message list on its newest message (gap ${gap})`);
  assert.equal(await page.evaluate(() => window.scrollY), 0, `${what}: the page itself did not scroll`);
  assert.equal(await isShown(page, '.m-tabs'), false, `${what}: tab bar hidden while composing`);
  assert.equal(await isShown(page, '.v2-ask'), false, `${what}: Ask bar hidden while composing`);
  const fs16 = await page.locator('.composer-editable').evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  assert.ok(fs16 >= 16, `${what}: composer font ≥16px (no iOS zoom), got ${fs16}`);
};

const phoneRun = async (device, theme) => {
  reset();
  const full = device === 'iphone' ? 844 : 915, kb = device === 'iphone' ? 450 : 470, tag = `${device === 'iphone' ? 390 : 412}-${theme}`;
  const ctx = await make(theme, device); const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  await page.goto(`${origin}/preview-org/messages/${group.id}`);
  await page.locator('.talk-thread .composer-editable').waitFor();
  await page.waitForTimeout(500);
  await fitsPhone(page, `${tag} thread`, assert);
  if (device === 'android') assert.match(await page.locator('meta[name="viewport"]').getAttribute('content'), /interactive-widget=resizes-content/);

  // 1. Normal composing with the keyboard up.
  await page.locator('.composer-editable').click();
  await page.keyboard.type('Checking the release window');
  await keyboardUp(page, device, kb);
  await assertDocked(page, `${tag} compose`);
  shots.push(await shot(page, `compose-keyboard-${tag}.png`));

  // 2. ✦ with text: the menu sits above the keyboard, Improve writing calls transform and replaces; Undo restores.
  await page.getByRole('button', { name: 'Rewrite or translate with AI' }).click();
  const menu = page.getByRole('menu', { name: 'Rewrite with AI' });
  await menu.waitFor();
  assert.deepEqual((await menu.getByRole('menuitem').allInnerTexts()).map((t) => t.trim()), ['Improve writing', 'Fix grammar', 'Make shorter', 'More formal', 'Friendlier', 'Translate…']);
  const mb = await menu.boundingBox(), vb = await visibleBottom(page);
  assert.ok(mb.y + mb.height <= vb + 2 && mb.y >= 0, `${tag}: ✦ menu fully above the keyboard (${Math.round(mb.y + mb.height)} ≤ ${vb})`);
  shots.push(await shot(page, `ai-menu-${tag}.png`));
  await menu.getByRole('menuitem', { name: 'Improve writing' }).click();
  await page.waitForFunction(() => document.querySelector('.composer-editable')?.textContent?.startsWith('Improved: Checking'));
  const tw = writes.filter((w) => w.ep === '/api/v1/chat/ai/transform').at(-1);
  assert.equal(JSON.parse(tw.body).action, 'rewrite');
  await page.locator('.toast-root').getByRole('button', { name: 'Undo' }).click();
  await page.waitForFunction(() => document.querySelector('.composer-editable')?.textContent === 'Checking the release window');
  // Translate… opens the languages.
  await page.getByRole('button', { name: 'Rewrite or translate with AI' }).click();
  await menu.getByRole('menuitem', { name: 'Translate…' }).click();
  await menu.getByRole('menuitem', { name: 'Translate to Hindi' }).click();
  await page.waitForFunction(() => document.querySelector('.composer-editable')?.textContent?.startsWith('[hi] '));
  await assertDocked(page, `${tag} after ✦`);

  // 3. Empty box: ✦ drafts a reply.
  await page.locator('.composer-editable').evaluate((e) => { e.innerHTML = ''; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.getByRole('button', { name: 'Groot drafts a reply' }).click();
  await page.waitForFunction(() => document.querySelector('.composer-editable')?.textContent?.includes('staging slot'));
  await page.locator('.composer-editable').evaluate((e) => { e.innerHTML = ''; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await keyboardDown(page, device, full);

  // 4. Edit my last message (long-press sheet on phones) with the keyboard up; ✦ Fix grammar works in edit mode.
  const mine = page.locator(`[data-msg="${messages.at(-1).id}"] .bubble`);
  await mine.dblclick();
  const edit = page.getByRole('menuitem', { name: /^Edit$/ }).or(page.getByRole('button', { name: /^Edit$/ })).first();
  await edit.click();
  await page.getByText('Editing message').waitFor();
  await page.locator('.composer-editable').click();
  await keyboardUp(page, device, kb);
  await assertDocked(page, `${tag} edit`);
  await page.getByRole('button', { name: 'Rewrite or translate with AI' }).click();
  await menu.getByRole('menuitem', { name: 'Fix grammar' }).click();
  await page.waitForFunction(() => document.querySelector('.composer-editable')?.textContent?.startsWith('Hi team! We need'));
  assert.equal(JSON.parse(writes.filter((w) => w.ep === '/api/v1/chat/ai/transform').at(-1).body).action, 'fix');
  await assertDocked(page, `${tag} edit after ✦`);
  shots.push(await shot(page, `edit-keyboard-${tag}.png`));
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Editing message').waitFor({ state: 'detached' });
  await keyboardDown(page, device, full);

  // 5. Reply with the keyboard up.
  const theirs = page.locator(`[data-msg="${messages.at(-2).id}"] .bubble`);
  await theirs.dblclick();
  const reply = page.getByRole('menuitem', { name: /^Reply$/ }).or(page.getByRole('button', { name: /^Reply$/ })).first();
  if (await reply.count()) {
    await reply.click();
    await page.getByText(/^Replying to/).waitFor();
    await page.locator('.composer-editable').click();
    await keyboardUp(page, device, kb);
    await assertDocked(page, `${tag} reply`);
    await page.keyboard.press('Escape');
    await keyboardDown(page, device, full);
  } else await page.keyboard.press('Escape');
  await page.locator('.composer-editable').evaluate((e) => e.blur());
  await page.waitForTimeout(200);

  // 6. Details: a full-screen sheet above the tab bar, scrolls to the last member, closes with Done and with a swipe down.
  await page.getByRole('button', { name: `Details for ${group.name}` }).click();
  const info = page.getByRole('dialog', { name: 'Conversation details' });
  await info.waitFor();
  await page.waitForTimeout(400);
  const ib = await info.boundingBox(), vp = page.viewportSize();
  assert.ok(ib.x <= 0.5 && ib.y <= 0.5 && Math.abs(ib.width - vp.width) <= 1 && Math.abs(ib.y + ib.height - vp.height) <= 1, `${tag}: Details covers the screen`);
  assert.equal(await isShown(page, '.m-tabs'), false, `${tag}: tab bar hidden under Details`);
  assert.ok(await info.getByRole('button', { name: 'Done, close details' }).isVisible(), 'Done button');
  const body = info.locator('.chat-info-body');
  assert.equal(await body.evaluate((e) => getComputedStyle(e).overscrollBehaviorY), 'contain');
  await body.evaluate((e) => { e.scrollTop = e.scrollHeight; });
  const last = info.getByRole('button', { name: `${names.at(-1)}'s profile` });
  await page.waitForTimeout(150);
  const lb = await last.boundingBox();
  assert.ok(lb.y + lb.height <= vp.height - 1 && lb.y >= ib.y, `${tag}: last member reachable (${Math.round(lb.y + lb.height)} ≤ ${vp.height})`);
  assert.ok(await info.getByRole('button', { name: 'Leave group' }).isVisible(), `${tag}: Leave group at the end is visible`);
  shots.push(await shot(page, `details-end-${tag}.png`));
  await info.getByRole('button', { name: 'Done, close details' }).click();
  await info.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: `Details for ${group.name}` }).click();
  await info.waitFor();
  await page.waitForTimeout(400);
  shots.push(await shot(page, `details-top-${tag}.png`));
  const head = await info.locator('.chat-info-head').boundingBox();
  const cdp = await ctx.newCDPSession(page);
  const tp = (y) => [{ x: vp.width / 2, y }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(head.y + 20) });
  for (let y = head.y + 40; y < head.y + 260; y += 40) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(y) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await info.waitFor({ state: 'detached' });
  assert.equal(await isShown(page, '.m-tabs'), false, `${tag}: a conversation stays full screen (no tab bar) after Details closes`);
  await ctx.close();
};

/** Other phone screens: focus their fields with a keyboard up; nothing hidden under it or the tab bar, no sideways scroll. */
const audit = async (device, theme) => {
  const full = device === 'iphone' ? 844 : 915, kb = device === 'iphone' ? 450 : 470, tag = `${device === 'iphone' ? 390 : 412}-${theme}`;
  const ctx = await make(theme, device); const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${tag} audit: ${e.message}`));
  for (const [name, to] of [['today', '/'], ['work', '/work'], ['desk', '/desk'], ['mail', '/mail'], ['library', '/library'], ['settings', '/settings'], ['new', '/work?new=1']]) {
    await page.goto(`${origin}/preview-org${to}`);
    await page.waitForTimeout(1300);
    await fitsPhone(page, `${tag} ${name}`, assert);
    const fields = page.locator('input[type="text"]:visible, input:not([type]):visible, input[type="search"]:visible, input[type="email"]:visible, textarea:visible, [contenteditable="true"]:visible');
    const n = await fields.count();
    for (const i of [...new Set([0, n - 1])].filter((x) => x >= 0 && x < n)) {
      const f = fields.nth(i);
      await f.focus().catch(() => {});
      if (!(await f.evaluate((e) => e === document.activeElement))) continue;
      await keyboardUp(page, device, kb);
      await f.evaluate((e) => e.scrollIntoView({ block: 'nearest' }));
      await page.waitForTimeout(150);
      const r = await f.evaluate((e) => { const b = e.getBoundingClientRect(); const vv = window.visualViewport; const cx = Math.min(b.left + b.width / 2, innerWidth - 2), cy = Math.min(b.top + Math.min(b.height, 30) / 2, vv.height + vv.offsetTop - 2);
        const hit = document.elementFromPoint(cx, cy); return { top: b.top, bottom: b.top + Math.min(b.height, 44), vb: vv.height + vv.offsetTop, fs: parseFloat(getComputedStyle(e).fontSize), covered: !!hit && !(e === hit || e.contains(hit) || hit.contains(e) || hit.closest('label') === e.closest('label')) && !!hit.closest('.m-tabs, .v2-ask'), what: hit?.className?.toString().slice(0, 60) }; });
      assert.ok(r.bottom <= r.vb + 1, `${tag} ${name}: field ${i} above the keyboard (${Math.round(r.bottom)} ≤ ${r.vb})`);
      assert.equal(r.covered, false, `${tag} ${name}: field ${i} not covered by the tab/Ask bar (${r.what})`);
      assert.ok(r.fs >= 16, `${tag} ${name}: field ${i} font ≥16px (${r.fs})`);
      assert.equal(await isShown(page, '.m-tabs'), false, `${tag} ${name}: tab bar hidden while typing`);
      if (theme === 'light' && i === 0) shots.push(await shot(page, `audit-${name}-${tag}.png`));
      await f.evaluate((e) => e.blur()).catch(() => {});
      await keyboardDown(page, device, full);
    }
    await page.keyboard.press('Escape').catch(() => {});
  }
  await ctx.close();
};

try {
  for (const device of ['iphone', 'android']) for (const theme of ['light', 'dark']) { await phoneRun(device, theme); await audit(device, theme); }

  // Desktop: Details keeps a visible ✕, and Escape closes it.
  reset();
  const ctx = await make('light', 'desktop'); const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`1440: ${e.message}`));
  await page.goto(`${origin}/preview-org/messages/${group.id}`);
  await page.locator('.talk-thread .composer-editable').waitFor();
  await page.getByRole('button', { name: 'Details', exact: true }).first().click();
  const info = page.locator('aside[aria-label="Conversation details"]');
  await info.waitFor();
  assert.ok(await info.getByRole('button', { name: 'Close details' }).isVisible(), 'desktop ✕ visible');
  shots.push(await shot(page, 'details-1440-light.png'));
  await page.keyboard.press('Escape');
  await info.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Details', exact: true }).first().click();
  await info.getByRole('button', { name: 'Close details' }).click();
  await info.waitFor({ state: 'detached' });
  await ctx.close();
  assert.deepEqual(errors, [], 'no page errors');
  console.log(`mobile keyboard UI: OK\n${shots.join('\n')}`);
} finally { await browser.close(); }
