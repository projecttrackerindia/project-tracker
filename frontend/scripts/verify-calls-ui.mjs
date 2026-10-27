import { chromium } from 'playwright';
import { createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Our own video calls: the camera and microphone check before joining (with the agent's notice), the call itself on a real media server
// when one is running (LIVEKIT_TEST_URL, e.g. livekit-server --dev): two people, one of them the project agent, which everyone sees marked
// as taking notes; ending for everyone; and the screen after a call. Built frontend with synthetic API fixtures.
const lk = process.env.LIVEKIT_TEST_URL;
if (lk) process.env.CALLS_ORIGIN = `${lk} ${lk.replace(/^ws/, 'http')}`;
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/calls-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 4 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const pid = '00000000-0000-0000-0000-000000000003';
const now = Date.now(), iso = (m) => new Date(now + m * 60000).toISOString();
const room = `ui-${now}`;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const pass = (identity, name) => {
  const t = Math.floor(Date.now() / 1000), head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ iss: 'devkey', sub: identity, name, nbf: t - 10, exp: t + 3600, video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true } });
  return `${head}.${body}.${createHmac('sha256', 'secret').update(`${head}.${body}`).digest('base64url')}`;
};
let status = 'live';
const call = () => ({ id: 'c1', title: 'Atlas stand-up', kind: 'project', projectId: pid, projectKey: 'ATL', conversationId: null, status, startedAt: iso(-5), endedAt: status === 'ended' ? iso(0) : null,
  startedBy: user.id, startedByName: 'Asha Rao', agentEnabled: true, agentStatus: 'in_call_recording', canEnd: true,
  people: [{ userId: user.id, name: 'Asha Rao', role: 'host', inCall: true, joinedAt: iso(-5) }, { userId: 'u2', name: 'Ravi Kumar', role: 'member', inCall: status === 'live', joinedAt: iso(-4) }] });
// Someone else calling Asha: she is invited and not in it yet, and it started a moment ago.
let ringing = false;
const incoming = () => ({ id: 'c9', title: 'Design review', kind: 'adhoc', projectId: null, projectKey: null, conversationId: null, status: 'live', startedAt: new Date().toISOString(), endedAt: null,
  startedBy: 'u2', startedByName: 'Ravi Kumar', agentEnabled: false, agentStatus: null, canEnd: false,
  people: [{ userId: 'u2', name: 'Ravi Kumar', role: 'host', inCall: true, joinedAt: new Date().toISOString() }, { userId: user.id, name: 'Asha Rao', role: 'member', inCall: false, joinedAt: null }] });
const writes = [], errors = [], checks = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true,
  // The test media server listens on this machine while the page pretends to be a public site: the browser's guard against public pages
  // reaching into a private network would stop that, which never arises with the real, public calls server.
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-accept-this-tab-capture', '--auto-select-tab-capture-source-by-title=Preview', '--auto-select-desktop-capture-source=Entire screen', ...(lk ? ['--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests'] : [])] });
try {
  const make = async (identity, name) => {
    const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block', permissions: ['camera', 'microphone'] });
    await ctx.addInitScript(() => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', 'light'); localStorage.setItem('pt_call_debug', '1'); });
    await ctx.route('**/*', async (route) => {
      const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
      if (lk && url.host === new URL(lk.replace(/^ws/, 'http')).host) { await route.continue(); return; }   // the media server itself
      if (url.origin !== origin) { await route.abort(); return; }
      if (ep.endsWith('/avatar')) { await route.fulfill({ status: 404, body: '' }); return; }
      if (!ep.startsWith('/api/')) {
        const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
        await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
        return;
      }
      let data = [];
      if (ep === '/api/v1/calls/c1/join' && method === 'POST') { writes.push(ep); data = { callId: 'c1', url: lk ?? 'wss://calls.invalid', token: pass(identity, name), room, identity, title: 'Atlas stand-up', agentEnabled: true, expiresAt: iso(360) }; }
      else if (ep === '/api/v1/calls/c1/end' && method === 'POST') { writes.push(ep); status = 'ended'; data = call(); }
      else if (ep === '/api/v1/calls/c9/decline' && method === 'POST') { writes.push(ep); data = null; }
      else if (ep === '/api/v1/me/ui/sidebar') data = { key: 'sidebar', value: null, updatedAt: null };
      else {
        assert.ok(method === 'GET' || ep.endsWith('/auth/refresh'), `Unexpected write: ${method} ${ep}`);
        if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
        else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['projects.view', 'projects.edit', 'tasks.view', 'tasks.edit', 'org.manage'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 3, activity: 3, documents: 3, people: 3, reports: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3 } } };
        else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
        else if (ep === '/api/v1/calls/status') data = { available: true, maxParticipants: 50 };
        else if (ep === '/api/v1/calls/live') data = ringing ? [incoming()] : [];
        else if (ep === '/api/v1/calls/c9') data = incoming();
        else if (ep === '/api/v1/calls/c1') data = call();
        else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
        else if (ep.endsWith('/ai/status')) data = { enabled: true, configured: true, entitled: true, allowedHere: true };
        else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
        else if (ep === '/api/v1/chat/projects/unread') data = [];
        else if (ep === '/api/v1/timer') data = null;
        else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
    });
    return ctx;
  };
  const shot = async (page, name) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(400); await page.screenshot({ path: path.join(out, name) }); };

  // Asha, named as the server names her: she started the call, so she is its host.
  const ctx = await make(`user:${user.id.replace(/-/g, '')}`, 'Asha Rao'); const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message)); if (process.env.DEBUG_CALL) page.on('console', (m) => console.error('[page]', m.type(), m.text().replace(/access_token=[^&' ]+/g, 'access_token=…').slice(0, 600)));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/preview-org/calls/c1`);
  await page.locator('[data-testid="call-prejoin"]').waitFor();
  assert.match(await page.locator('.call-prejoin-intro').innerText(), /Atlas stand-up/);
  assert.match(await page.locator('.call-agent-note').innerText(), /agent is in this call taking notes/);   // people know before they join
  await page.locator('.lk-prejoin').waitFor();
  await shot(page, 'prejoin-1440.png'); checks.push('prejoin');

  // On a phone the check and the join button fit the screen.
  const phone = await ctx.newPage(); await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(`${origin}/preview-org/calls/c1`); await phone.locator('.lk-prejoin').waitFor();
  await fitsPhone(phone, 'pre-join on a phone', assert);
  const joinBtn = phone.locator('.lk-prejoin button.lk-join-button');
  await joinBtn.scrollIntoViewIfNeeded();
  const box = await joinBtn.boundingBox(); assert.ok(box && box.y >= 0 && box.y + box.height <= 844, 'the join button can be reached on a phone');
  assert.equal(await phone.evaluate(() => { const b = document.querySelector('.lk-join-button').getBoundingClientRect(); const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return !!top?.closest('.lk-join-button'); }), true, 'nothing covers the join button');
  await shot(phone, 'prejoin-390.png'); await phone.close(); checks.push('phone');

  if (lk) {
    // In the call, on a real media server: Asha with her camera, and the project agent, which (like the real one) has no camera or microphone.
    await page.locator('.lk-prejoin button.lk-join-button').click();
    await page.locator('[data-testid="call-stage"]').waitFor({ timeout: 20_000 });
    const agentCtx = await make('agent:session1', 'Tracker Agent'); const agent = await agentCtx.newPage();
    if (process.env.DEBUG_CALL) agent.on('console', (m) => console.error('[agent]', m.type(), m.text().replace(/access_token=[^&' ]+/g, 'access_token=…').slice(0, 300)));
    await agent.goto(`${origin}/preview-org/calls/c1`); await agent.locator('.lk-prejoin').waitFor();
    const on = agent.locator('.lk-prejoin button[aria-pressed="true"]');
    for (let i = 0; i < 2 && await on.count(); i++) { await on.first().click(); await agent.waitForTimeout(300); }   // camera and microphone off
    assert.equal(await on.count(), 0);
    await agent.locator('.lk-prejoin button.lk-join-button').click(); await agent.locator('[data-testid="call-stage"]').waitFor({ timeout: 20_000 });
    try { await page.locator('[data-testid="call-agent-badge"]').waitFor({ timeout: 20_000 }); }
    catch (e) { await page.screenshot({ path: path.join(out, 'debug-a.png') }); throw e; }
    assert.match(await page.locator('[data-testid="call-agent-badge"]').innerText(), /Tracker Agent is taking notes/);
    const tiles = page.locator('.cs .lk-participant-tile');
    await page.waitForFunction(() => document.querySelectorAll('.cs .lk-participant-tile').length === 2);
    // Asha first, on camera; the agent's own tile: no blank video, its mark and "Taking notes".
    assert.match(await tiles.nth(0).locator('.cs-name').innerText(), /Asha Rao \(You\)/);
    await tiles.nth(0).locator('video').waitFor();
    assert.equal(await tiles.nth(1).locator('video').count(), 0, 'the agent shows no empty video');
    assert.equal(await tiles.nth(1).locator('.cs-avatar.agent').count(), 1);
    assert.match(await page.locator('[data-testid="call-agent-tile"]').innerText(), /Tracker Agent\s*Taking notes/);
    await page.mouse.move(5, 5); await shot(page, 'in-call-1440.png'); checks.push('in-call-with-agent');
    // Camera off: the tile shows the person's initials in a coloured circle. Microphone off: the button turns red and the others see it by the name.
    await page.locator('[data-testid="call-camera"]').click();
    await tiles.nth(0).locator('.cs-avatar:not(.agent)').waitFor();
    assert.equal((await tiles.nth(0).locator('.cs-avatar').innerText()).trim(), 'AR');
    await page.locator('[data-testid="call-mic"]').click();
    assert.equal(await page.locator('[data-testid="call-mic"]').getAttribute('data-lk-enabled'), 'false');
    await page.mouse.move(5, 5);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="call-mic"]').closest('.cs-pair')).backgroundColor === 'rgb(255, 69, 58)', null, { timeout: 3000 });   // a muted microphone is red
    await agent.locator('.cs .lk-participant-tile .cs-muted').first().waitFor({ timeout: 10_000 });   // the other side sees Asha muted
    await shot(page, 'in-call-camera-off-1440.png'); checks.push('camera-and-mic-off');
    // Messages in the call: the panel opens beside the people, and what Asha writes reaches the agent.
    await page.locator('[data-testid="call-chat"]').click();
    await page.locator('.cs-chat .lk-chat-form-input').fill('Agent, note that PAY-12 moves to Friday.');
    await page.locator('.cs-chat .lk-chat-form-input').press('Enter');
    await agent.locator('.cs-btn.chat[data-lk-unread-msgs="1"]').waitFor({ timeout: 10_000 });
    await shot(page, 'in-call-chat-1440.png'); checks.push('call-chat');
    // Hands: Asha raises hers and the other side sees it on her tile and in the list; then the agent's goes up too, second in line;
    // Asha, the host, lowers them all.
    await page.locator('[data-testid="call-raise-hand"]').click();
    await agent.locator('[data-testid="call-hand"]').waitFor({ timeout: 10_000 });
    assert.match(await agent.locator('[data-testid="call-hands"]').innerText(), /Asha Rao raised a hand/);
    assert.match(await page.locator('[data-testid="call-hands"]').innerText(), /Your hand is raised/);
    await agent.locator('[data-testid="call-raise-hand"]').click();
    await page.locator('[data-testid="call-hands"]').getByText('2 raised hands').waitFor({ timeout: 10_000 });
    await page.locator('.cs-hands-head').click();
    assert.deepEqual(await page.locator('.cs-hands li span').allInnerTexts(), ['You', 'Tracker Agent']);   // in the order they went up
    assert.deepEqual(await page.locator('[data-testid="call-hand"] b').allInnerTexts(), ['1', '2']);
    await page.mouse.move(5, 5); await shot(page, 'hands-1440.png');
    await page.locator('.cs-hands-all').click();
    await agent.locator('[data-testid="call-hands"]').waitFor({ state: 'detached', timeout: 10_000 });
    await page.locator('[data-testid="call-hands"]').waitFor({ state: 'detached', timeout: 10_000 });
    assert.equal(await agent.locator('[data-testid="call-raise-hand"]').getAttribute('aria-pressed'), 'false');
    checks.push('raise-and-lower-hands');
    // Reactions: the bar of emoji; one sent floats up for everyone with who sent it.
    await page.locator('[data-testid="call-react"]').click();
    await page.locator('.cs-react-bar').waitFor();
    await page.getByRole('menuitem', { name: 'React 🎉' }).click();
    await agent.locator('[data-testid="call-reaction"]').filter({ hasText: 'Asha Rao' }).waitFor({ timeout: 10_000 });
    assert.match(await agent.locator('[data-testid="call-reaction"]').first().innerText(), /🎉\s*Asha Rao/);
    await page.locator('[data-testid="call-reaction"]').filter({ hasText: 'You' }).waitFor();
    await page.waitForTimeout(700); await page.screenshot({ path: path.join(out, 'reaction-1440.png') });
    await page.keyboard.press('Escape'); await page.locator('.cs-react-bar').waitFor({ state: 'detached' });
    await agent.locator('[data-testid="call-reaction"]').first().waitFor({ state: 'detached', timeout: 8000 });   // and then it is gone
    checks.push('reactions');
    // Presenting: the shared screen takes the stage, everyone moves to a strip beside it, and the others see who is presenting.
    await page.locator('[data-testid="call-chat"]').click();   // close the messages first
    await page.locator('.cs-btn.share').click();
    await agent.locator('.cs-share .cs-name').waitFor({ timeout: 15_000 });
    assert.match(await agent.locator('.cs-share .cs-name').innerText(), /Asha Rao is presenting/);
    assert.equal(await agent.locator('.cs-strip .lk-participant-tile').count(), 2);
    assert.equal(await page.locator('.cs-btn.share').getAttribute('data-lk-enabled'), 'true');
    await shot(agent, 'presenting-1440.png');
    // The presenter sees a card, not their own screen inside their screen, and stops from it.
    await page.locator('[data-testid="call-you-present"]').waitFor();
    await shot(page, 'you-present-1440.png');
    await page.locator('[data-testid="call-you-present"]').getByRole('button', { name: 'Stop presenting' }).click();
    checks.push('present-screen');
    try { await agent.locator('.cs .lk-grid-layout').waitFor({ timeout: 45_000 }); }
    catch (e) { await agent.screenshot({ path: path.join(out, 'debug-b.png') }); await page.screenshot({ path: path.join(out, 'debug-a.png') }); console.error(await agent.evaluate(() => [...window.__ptRoom.remoteParticipants.values()].map((p) => [p.identity, [...p.trackPublications.values()].map((t) => `${t.source}:${t.isSubscribed}:${t.isMuted}:${!!t.track}`)])), await page.locator('.cs-btn.share').getAttribute('data-lk-enabled'), await agent.locator('.cs').innerHTML().then((h) => h.slice(0, 300))); throw e; }
    // On a phone the call fits: the tiles above, the round controls below, nothing cut off - and resizing does not hang up.
    await agent.setViewportSize({ width: 390, height: 844 }); await agent.waitForTimeout(500);
    await agent.locator('[data-testid="call-stage"]').waitFor();
    await fitsPhone(agent, 'a call on a phone', assert);
    await agent.locator('[data-testid="call-react"]').click(); await agent.locator('.cs-react-bar').waitFor();
    await fitsPhone(agent, 'the reactions on a phone', assert);
    await shot(agent, 'reactions-390.png');
    await agent.keyboard.press('Escape');
    const bar = await agent.locator('.cs-bar').boundingBox(); assert.ok(bar && bar.y + bar.height <= 844);
    await shot(agent, 'in-call-390.png'); checks.push('phone-in-call');
    // The host ends it for everyone.
    await page.locator('[data-testid="call-end-all"]').click();
    await page.getByRole('dialog').getByRole('button', { name: 'End call' }).click();
    await page.locator('[data-testid="call-over"]').waitFor();
    assert.ok(writes.includes('/api/v1/calls/c1/end'));
    await agentCtx.close(); checks.push('end-for-everyone');
  } else {
    status = 'ended';
    await page.goto(`${origin}/preview-org/calls/c1`);
    await page.locator('[data-testid="call-over"]').waitFor();
  }
  assert.match(await page.locator('[data-testid="call-over"]').innerText(), /This call has ended/);
  assert.match(await page.locator('[data-testid="call-over"]').innerText(), /Agent/);   // where the notes will be
  await shot(page, 'ended-1440.png'); checks.push('ended');

  // An incoming call rings on any page: the card with who is calling, Answer and Decline. (Here it is found by the safety-net check of
  // live calls; the live connection brings the same card at once.) Declining tells the server and the card goes.
  ringing = true;
  await page.goto(`${origin}/preview-org/`);
  const card = page.locator('[data-testid="incoming-call"]');
  await card.waitFor({ timeout: 15_000 });
  assert.match(await card.innerText(), /Ravi Kumar is calling/);
  assert.match(await card.innerText(), /Design review/);
  await shot(page, 'incoming-1440.png');
  await page.locator('[data-testid="incoming-call-decline"]').click();
  await card.waitFor({ state: 'detached' });
  assert.ok(writes.includes('/api/v1/calls/c9/decline'), 'declining tells the server');
  checks.push('incoming-call-decline');
  // On a phone (another tab, so it rings afresh): the card fits, and Answer opens the call.
  const ringPhone = await ctx.newPage(); ringPhone.on('pageerror', (e) => errors.push(e.message)); await ringPhone.setViewportSize({ width: 390, height: 844 });
  await ringPhone.goto(`${origin}/preview-org/`);
  await ringPhone.locator('[data-testid="incoming-call"]').waitFor({ timeout: 15_000 });
  await fitsPhone(ringPhone, 'the incoming call on a phone', assert);
  await shot(ringPhone, 'incoming-390.png');
  await ringPhone.locator('[data-testid="incoming-call-answer"]').click();
  await ringPhone.waitForURL(/\/preview-org\/calls\/c9$/);
  await ringPhone.locator('[data-testid="incoming-call"]').waitFor({ state: 'detached' });
  await ringPhone.close(); ringing = false; checks.push('incoming-call-answer');
  await ctx.close();
} finally { await browser.close(); }
const serious = errors.filter((e) => !/WebSocket|wss:\/\/calls\.invalid|could not establish|ConnectionError/i.test(e));
console.log(JSON.stringify({ checks, live: !!lk, errors: serious }));
if (serious.length) process.exit(1);
