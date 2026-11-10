import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// "Sign out after inactivity": the workspace policy in Settings › Security, then (with fake timers) the "Still there?" card two minutes
// before the time, the lock screen at the time in every tab, a wrong password, unlocking with the password and with a passkey (Chromium's
// virtual authenticator), unsaved input kept, and five wrong tries signing out. 1440 and 390, light and dark. Built frontend, fictional fixtures.
const origin = 'https://projecttracker-preview.test', host = new URL(origin).hostname, dist = path.resolve('dist'), out = path.resolve('test-results/idle-lock');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-0000000000a1', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false, mfaEnabled: false, hasAvatar: false };
const ws = { id: '00000000-0000-0000-0000-0000000000b2', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 4 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const PASSWORD = 'Correct-Horse-7';
const b64u = (b) => Buffer.from(b).toString('base64url');

// One passkey on the account: its private key goes into the virtual authenticator, its id into the unlock options.
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const credentialId = crypto.randomBytes(16);
const passkey = { credentialId: credentialId.toString('base64'), isResidentCredential: true, rpId: host, privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), userHandle: Buffer.from(user.id).toString('base64'), signCount: 0 };

const errors = [], checks = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });

async function scenario({ width, height, theme, label, full }) {
  const state = { minutes: 30, locked: false, failures: 0, calls: [], blocked: [], hasPasskey: true };
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block', viewport: { width, height }, isMobile: width < 500, hasTouch: width < 500 });
  await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); localStorage.setItem('pm_home_mode', 'classic'); }, theme);
  await ctx.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
    if (url.origin !== origin) { await route.abort(); return; }
    if (ep.endsWith('/avatar')) { await route.fulfill({ status: 404, body: '' }); return; }
    if (!ep.startsWith('/api/')) {
      const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
      await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
      return;
    }
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status < 400 ? { data } : { errors: [data], message: data.message }) });
    const fail = (code, message, status = 401) => json({ code, message }, status);
    if (method !== 'GET') state.calls.push(`${method} ${ep}`);
    // A locked session: the server refuses everything but the lock screen's own calls (the app should not even be sending them).
    if (state.locked && !ep.startsWith('/api/v1/auth/') && req.headers().authorization) { state.blocked.push(`${method} ${ep}`); await fail('SESSION_IDLE_LOCKED', 'You were away for a while. Unlock to carry on.'); return; }
    const policy = { minutes: state.minutes, canManage: true, choices: [15, 30, 60, 240, 0] };
    if (ep === '/api/v1/auth/refresh') return state.locked ? fail('SESSION_IDLE_LOCKED', 'Locked.') : json({ accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user });
    if (ep === '/api/v1/auth/activity') return json(policy);
    if (ep === '/api/v1/auth/lock') { state.locked = true; await route.fulfill({ status: 204, body: '' }); return; }
    if (ep === '/api/v1/auth/logout') { await route.fulfill({ status: 204, body: '' }); return; }
    if (ep === '/api/v1/auth/unlock/state') return json({ locked: state.locked, userId: user.id, displayName: user.displayName, hasAvatar: false, hasPassword: true, hasPasskey: state.hasPasskey, attemptsLeft: 5 - state.failures, idleMinutes: state.minutes });
    if (ep === '/api/v1/auth/unlock/passkey-options') return json({ challengeId: 'c-1', options: { challenge: b64u(crypto.randomBytes(32)), rpId: host, timeout: 60000, userVerification: 'required', allowCredentials: [{ id: b64u(credentialId), type: 'public-key' }] } });
    if (ep === '/api/v1/auth/unlock') {
      const b = req.postDataJSON();
      const ok = b.password === PASSWORD || (b.challengeId === 'c-1' && b.response?.rawId === b64u(credentialId) && !!b.response?.response?.signature);
      if (ok) { state.locked = false; state.failures = 0; return json({ accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user, refreshToken: null }); }
      state.failures++;
      if (state.failures >= 5) { state.locked = false; return fail('SESSION_UNLOCK_SIGNED_OUT', 'Signed out after too many wrong unlock attempts. Sign in again.'); }
      const left = 5 - state.failures;
      return fail('UNLOCK_FAILED', `Wrong password. ${left} ${left === 1 ? 'try' : 'tries'} left.`);
    }
    if (ep === '/api/v1/workspace/idle-policy' && method === 'PUT') { state.minutes = req.postDataJSON().minutes; return json({ ...policy, minutes: state.minutes }); }
    if (ep === '/api/v1/workspace/idle-policy') return json(policy);
    let data = [];
    if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['projects.view', 'tasks.view', 'org.manage', 'reports.view', 'work.view'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 3, activity: 3, documents: 3, people: 3, reports: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3, ADVANCED_SECURITY: 1 } } };
    else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
    else if (ep === '/api/v1/workspace/security') data = { requireMfa: false, ipAllowlistEnabled: false, ipRanges: [], myIp: '203.0.113.9', entitled: true, minPasswordLength: 0, sessionHours: 0, allowedSignIn: ['password', 'passkey', 'google', 'microsoft', 'github', 'apple', 'sso'], platformMinPasswordLength: 12, allowedEmailDomains: [] };
    else if (ep === '/api/v1/workspace/session-policy') data = { singleActiveSession: false, canManage: true };
    else if (ep === '/api/v1/workspace/security/members') data = { members: 1, withoutTwoStep: 0, weakPasswords: 0, oldPasswords: 0, people: [] };
    else if (ep === '/api/v1/settings/changes') data = { items: [], canUndo: true };
    else if (ep === '/api/v1/me/ui/sidebar') data = { key: 'sidebar', value: null, updatedAt: null };
    else if (ep === '/api/v1/notifications/counts') data = { unread: 0, needsYou: 0, forInfo: 0, snoozed: 0 };
    else if (ep === '/api/v1/notifications') data = { items: [], page: 1, pageSize: 20, totalPages: 0, totalItems: 0 };
    else if (ep.endsWith('/projects') || ep.endsWith('/tasks') || ep.endsWith('/work-tasks')) data = { items: [], page: 1, totalPages: 0, totalItems: 0 };
    else if (ep === '/api/v1/timer') data = null;
    else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
    else if (ep.endsWith('/ai/status')) data = { enabled: true, configured: true, entitled: true, allowedHere: true };
    else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
    else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
    else if (method !== 'GET') { await route.fulfill({ status: 204, body: '' }); return; }
    return json(data);
  });

  await ctx.clock.install({ time: new Date('2026-11-10T04:00:00Z') });
  const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  const shot = async (p, name) => { await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(450); await p.screenshot({ path: path.join(out, `${name}-${label}.png`) }); checks.push(`${name}-${label}`); };
  const fits = async (p, what = label) => { if (width < 500) await fitsPhone(p, what, assert); };

  // Settings › Security: the policy, saved at once with a tick.
  await page.goto(origin + '/preview-org/settings/security');
  const group = page.getByRole('radiogroup', { name: 'Sign out after inactivity' });
  await group.waitFor();
  assert.match(await group.getByRole('radio', { checked: true }).innerText(), /^30 min/);
  await group.scrollIntoViewIfNeeded();
  if (full) {
    await group.getByRole('radio', { name: '15 min' }).click();
    await page.getByText('✓ Saved').waitFor();
    assert.equal(state.minutes, 15);
    await group.getByRole('radio', { name: /30 min/ }).click();
    await page.waitForFunction(() => document.querySelector('[role=radio][aria-checked=true]')?.textContent?.startsWith('30'));
    assert.equal(state.minutes, 30);
  }
  await page.locator('[data-setting="security.idle"]').screenshot({ path: path.join(out, `policy-${label}.png`) }); checks.push(`policy-${label}`);
  await fits(page);

  // Something typed and not saved yet: it must survive the lock.
  const draft = page.locator('input[type=text]:visible, textarea:visible').first();
  const hasDraft = await draft.count() > 0;
  if (hasDraft) { await draft.fill('Half-written note, not saved'); }
  const second = full ? await ctx.newPage() : null;
  if (second) { await second.goto(origin + '/preview-org/settings/security'); await second.getByRole('radiogroup', { name: 'Sign out after inactivity' }).waitFor(); }
  await page.bringToFront();

  // 28 minutes later: "Still there?" with a countdown; "Stay signed in" keeps the session and tells the server.
  await ctx.clock.fastForward(28 * 60_000 + 1000);
  const warn = page.getByTestId('idle-warning');
  await warn.waitFor();
  assert.match(await warn.innerText(), /Still there\?[\s\S]*You'll be signed out in (2:00|1:5\d)/);   // the first tick may not have happened yet when it is read
  await shot(page, 'warning');
  await fits(page);
  if (full) {
    const before = state.calls.filter((c) => c.endsWith('/auth/activity')).length;
    await warn.getByRole('button', { name: 'Stay signed in' }).click();
    await warn.waitFor({ state: 'detached' });
    assert.ok(state.calls.filter((c) => c.endsWith('/auth/activity')).length > before, 'Stay signed in pings the server');
  }

  // The full time: locked here and in the other tab; the server is told; nothing else is sent while locked.
  await ctx.clock.fastForward(30 * 60_000 + 2000);
  const lock = page.getByTestId('idle-lock');
  await lock.waitFor();
  assert.ok(state.calls.includes('POST /api/v1/auth/lock'), 'the server locks too');
  await lock.getByRole('heading', { name: 'Asha Rao' }).waitFor();
  await lock.getByText('Locked after 30 min away').waitFor();
  await page.waitForFunction(() => document.getElementById('root')?.hasAttribute('inert'));
  if (second) await second.getByTestId('idle-lock').waitFor();
  await shot(page, 'lock');
  await fits(page);

  // A wrong password: said plainly, with the tries left; the field is cleared and focused again.
  await lock.getByPlaceholder('Password').fill('nope');
  await lock.getByRole('button', { name: 'Unlock', exact: true }).click();
  await lock.getByText('Wrong password. 4 tries left.').waitFor();
  await shot(page, 'lock-wrong');

  if (full) {
    // The passkey: the virtual authenticator (this device's own, user-verified) answers the challenge.
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: passkey });
    await lock.getByTestId('unlock-passkey').click();
    await lock.waitFor({ state: 'detached' });
    assert.ok(state.calls.includes('POST /api/v1/auth/unlock'));
    if (second) await second.getByTestId('idle-lock').waitFor({ state: 'detached' });
    if (hasDraft) assert.equal(await draft.inputValue(), 'Half-written note, not saved', 'unsaved input kept');
    assert.equal(state.blocked.length, 0, `requests sent while locked: ${state.blocked.join(', ')}`);
    await page.waitForFunction(() => !document.getElementById('root')?.hasAttribute('inert'));
    await shot(page, 'unlocked');

    // Lock again; this time the password unlocks.
    await ctx.clock.fastForward(31 * 60_000);
    await page.getByTestId('idle-lock').waitFor();
    await page.getByTestId('idle-lock').getByPlaceholder('Password').fill(PASSWORD);
    await page.keyboard.press('Enter');
    await page.getByTestId('idle-lock').waitFor({ state: 'detached' });
    if (hasDraft) assert.equal(await draft.inputValue(), 'Half-written note, not saved');

    // Five wrong tries: signed out, back at the sign-in page with the reason.
    await ctx.clock.fastForward(31 * 60_000);
    const l2 = page.getByTestId('idle-lock'); await l2.waitFor();
    for (let i = 1; i <= 5; i++) {
      await l2.getByPlaceholder('Password').fill(`wrong-${i}`);
      await l2.getByRole('button', { name: 'Unlock', exact: true }).click();
      if (i < 5) await l2.getByText(`Wrong password. ${5 - i} ${5 - i === 1 ? 'try' : 'tries'} left.`).waitFor();
    }
    await l2.waitFor({ state: 'detached' });
    await page.waitForURL(/login|sign-in|\/$/, { timeout: 10_000 }).catch(() => undefined);
    checks.push(`five-wrong-sign-out-${label}`);
  } else {
    await lock.getByPlaceholder('Password').fill(PASSWORD);
    await lock.getByRole('button', { name: 'Unlock', exact: true }).click();
    await lock.waitFor({ state: 'detached' });
    if (hasDraft) assert.equal(await draft.inputValue(), 'Half-written note, not saved');
  }
  await ctx.close();
}

try {
  await scenario({ width: 1440, height: 960, theme: 'light', label: '1440-light', full: true });
  await scenario({ width: 1440, height: 960, theme: 'dark', label: '1440-dark', full: false });
  await scenario({ width: 390, height: 844, theme: 'light', label: '390-light', full: true });
  await scenario({ width: 390, height: 844, theme: 'dark', label: '390-dark', full: false });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks, out }, null, 1));
} finally { await browser.close(); }
