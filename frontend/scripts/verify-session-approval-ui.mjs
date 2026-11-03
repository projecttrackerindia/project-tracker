import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// "Single active session" with approve-on-other-device, in two browser contexts that share one fake server: a laptop already signed in and a phone
// signing in. The phone waits with a code; the laptop gets the approval sheet (device, app, place, IP, time, the same code), allows it, and is then
// signed out with the reason. Built frontend with synthetic API fixtures only (fictional people and addresses).
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/session-approval-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false, mfaEnabled: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 4 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const now = Date.now(), iso = (m) => new Date(now + m * 60000).toISOString();
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const approvalId = '11111111-1111-1111-1111-111111111111';
const state = { requested: false, decision: null, redeemed: false, writes: [] };
const prompt = () => ({ id: approvalId, device: 'Chrome on Android', app: 'phone', location: 'Kolkata region', ipAddress: '203.0.113.24', method: 'password', code: 47,
  createdAt: iso(0), expiresAt: new Date(Date.now() + 110_000).toISOString(), token: 'd.signed.token' });
const errors = [], checks = [];
const ctxData = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['projects.view', 'tasks.view', 'org.manage', 'reports.view', 'work.view'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 3, activity: 3, documents: 3, people: 3, reports: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3, ADVANCED_SECURITY: 1 } } };
const fail = (status, code, message) => ({ status, contentType: 'application/json', body: JSON.stringify({ message, errors: [{ code, message }] }) });

async function serve(ctx, who) {
  await ctx.addInitScript(() => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', 'light'); localStorage.setItem('pm_home_mode', 'classic'); });
  await ctx.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
    if (url.origin !== origin) { await route.abort(); return; }
    if (ep.endsWith('/avatar')) { await route.fulfill({ status: 404, body: '' }); return; }
    if (!ep.startsWith('/api/')) {
      const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
      await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
      return;
    }
    const signedIn = who === 'laptop' ? !state.redeemed : state.redeemed;
    let data = [];
    if (ep === '/api/v1/auth/refresh') {
      if (signedIn) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
      else if (who === 'laptop') { await route.fulfill(fail(401, 'SESSION_REPLACED', 'Signed out because you signed in on Chrome on Android.')); return; }
      else { await route.fulfill(fail(401, 'INVALID_REFRESH_TOKEN', 'Refresh token missing.')); return; }
    } else if (ep === '/api/v1/auth/login' && method === 'POST') {
      const b = req.postDataJSON(); state.writes.push({ ep, b, zone: req.headers()['x-client-zone'] }); state.requested = true;
      data = { approvalRequired: true, approvalId, code: 47, device: 'Chrome on Android', app: 'phone', location: 'Kolkata region', ipAddress: '203.0.113.24', expiresAt: new Date(Date.now() + 120_000).toISOString(), secret: null };
    } else if (ep === `/api/v1/auth/session-approval/${approvalId}/status`) {
      if (state.decision === 'allow' && !state.redeemed) { state.redeemed = true; data = { status: 'approved', code: 47, device: 'Chrome on Android', auth: { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user, refreshToken: null } }; }
      else data = { status: state.decision === 'reject' ? 'rejected' : 'pending', code: 47, device: 'Chrome on Android', expiresAt: prompt().expiresAt, canEmail: false, canCode: false, emailSent: false };
    } else if (ep === `/api/v1/auth/session-approval/${approvalId}/decide` && method === 'POST') {
      assert.equal(who, 'laptop', 'only the signed-in device answers');
      const b = req.postDataJSON(); state.writes.push({ ep, b }); state.decision = b.decision; data = { outcome: b.decision === 'allow' ? 'allowed' : 'rejected' };
    } else if (!signedIn && who === 'laptop' && ep !== '/api/v1/auth/logout') { await route.fulfill(fail(401, 'SESSION_REVOKED', 'Your session has ended. Please sign in again.')); return; }
    else if (ep === '/api/v1/me/session-policy' && method === 'PUT') { const b = req.postDataJSON(); state.writes.push({ ep, b }); data = { singleSession: b.singleSession, effective: true, requiredBy: [] }; }
    else {
      assert.ok(method === 'GET' || ep.endsWith('/auth/logout'), `Unexpected write: ${method} ${ep}`);
      if (ep === '/api/v1/me') data = ctxData;
      else if (ep === '/api/v1/me/session-policy') data = { singleSession: true, effective: true, requiredBy: [] };
      else if (ep === '/api/v1/me/session-approvals/pending') data = who === 'laptop' && state.requested && !state.decision ? [prompt()] : [];
      else if (ep === '/api/v1/me/session-approvals') data = [{ id: 'h1', createdAt: iso(-60 * 26), device: 'Safari on iOS', app: 'phone', location: 'Hyderabad region', ipAddress: '198.51.100.9', outcome: 'allowed', decidedVia: 'session', decidedAt: iso(-60 * 26) }, { id: 'h2', createdAt: iso(-60 * 50), device: 'Firefox on Linux', app: 'web', location: null, ipAddress: '192.0.2.44', outcome: 'rejected', decidedVia: 'session', decidedAt: iso(-60 * 50) }];
      else if (ep === '/api/v1/me/sessions') data = [{ id: 's1', createdAt: iso(-30), lastSeenAt: iso(-1), ipAddress: '49.37.12.9', userAgent: 'Chrome', device: 'Chrome on Windows', location: null, isCurrent: true, authMethod: 'password' }];
      else if (ep === '/api/v1/me/sign-ins') data = [];
      else if (ep === '/api/v1/me/mfa') data = { enabled: false, recoveryCodesLeft: 0 };
      else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
      else if (ep === '/api/v1/workspace/security') data = { requireMfa: false, ipAllowlistEnabled: false, ipRanges: [], myIp: '49.37.12.9', entitled: true, minPasswordLength: 0, sessionHours: 0, allowedSignIn: ['password'], platformMinPasswordLength: 12 };
      else if (ep === '/api/v1/workspace/session-policy') data = { singleActiveSession: true, canManage: true };
      else if (ep === '/api/v1/notifications/counts') data = { unread: 0, needsYou: 0, forInfo: 0, snoozed: 0 };
      else if (ep === '/api/v1/notifications') data = { items: [], page: 1, pageSize: 20, totalPages: 0, totalItems: 0 };
      else if (ep.endsWith('/projects') || ep.endsWith('/tasks') || ep.endsWith('/work-tasks')) data = { items: [], page: 1, totalPages: 0, totalItems: 0 };
      else if (ep === '/api/v1/timer') data = null;
      else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
      else if (ep.endsWith('/ai/status')) data = { enabled: true, configured: true, entitled: true, allowedHere: true };
      else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
      else if (ep === '/api/v1/auth/providers') data = { providers: [] };
      else if (ep === '/api/v1/auth/password-policy') data = { minLength: 12 };
      else if (ep === '/api/v1/me/ui/sidebar') data = { key: 'sidebar', value: null, updatedAt: null };
      else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
  });
}

const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
try {
  const shot = async (page, name) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(400); await page.screenshot({ path: path.join(out, name), fullPage: false }); };
  const laptopCtx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block', viewport: { width: 1440, height: 960 } });
  const phoneCtx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block', viewport: { width: 390, height: 844 }, userAgent: PHONE_UA, hasTouch: true });
  await serve(laptopCtx, 'laptop'); await serve(phoneCtx, 'phone');
  const laptop = await laptopCtx.newPage(), phone = await phoneCtx.newPage();
  for (const p of [laptop, phone]) p.on('pageerror', (e) => errors.push(e.message));

  // The laptop's settings: "Single active session" is on, with the approval history.
  await laptop.goto(origin + '/preview-org/settings/security/account');
  await laptop.getByRole('switch', { name: 'Single active session' }).waitFor();
  assert.equal(await laptop.getByRole('switch', { name: 'Single active session' }).getAttribute('aria-checked'), 'true');
  const history = laptop.getByRole('list', { name: 'Approval history' }); await history.waitFor();
  assert.equal(await history.getByRole('listitem').count(), 2);
  await history.getByText('Rejected').waitFor();
  await laptop.getByText('Approval history').scrollIntoViewIfNeeded();
  await shot(laptop, 'settings-1440.png');
  checks.push('settings');

  // The phone signs in with the right password and waits, naming itself and showing the code.
  await phone.goto(origin + '/login');
  await phone.locator('#email').fill(user.email); await phone.locator('#password').fill('Fictional-pass-2026');
  await phone.getByRole('button', { name: 'Sign in', exact: true }).click();
  await phone.getByRole('heading', { name: 'Waiting for approval' }).waitFor();
  await phone.getByText('Chrome on Android').waitFor();
  assert.ok(await phone.getByLabel('Code 47').isVisible());
  assert.match(state.writes.find((w) => w.ep === '/api/v1/auth/login').zone, /^Asia\/(Kolkata|Calcutta)$/);   // the device's zone travels with the sign-in
  await fitsPhone(phone, 'waiting screen', assert);
  await shot(phone, 'waiting-390.png');
  checks.push('waiting');

  // The laptop is asked: device, app, place, address, time and the same code.
  await laptop.reload();
  const sheet = laptop.getByRole('alertdialog', { name: 'Sign-in on a new device' }); await sheet.waitFor({ timeout: 15000 });
  for (const t of ['Chrome on Android', 'Phone', 'Kolkata region', '203.0.113.24']) assert.ok(await sheet.getByText(t, { exact: true }).first().isVisible(), t);
  assert.ok(await sheet.getByLabel('Code 47').isVisible());
  assert.ok(await sheet.getByRole('button', { name: "This wasn't me — secure my account" }).isVisible());
  await shot(laptop, 'prompt-1440.png');
  await laptop.setViewportSize({ width: 390, height: 844 }); await laptop.waitForTimeout(400);
  await fitsPhone(laptop, 'approval sheet', assert);
  const box = await sheet.boundingBox(); assert.ok(box && Math.abs(box.y + box.height - 844) < 2, 'a bottom sheet on a phone');
  await shot(laptop, 'prompt-390.png');
  checks.push('prompt');

  // Allow: the phone is signed in; the laptop is signed out and told why.
  await sheet.getByRole('button', { name: 'Allow', exact: true }).click();
  assert.deepEqual(state.writes.find((w) => w.ep.endsWith('/decide')).b, { token: 'd.signed.token', decision: 'allow' });
  await phone.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
  checks.push('allowed');
  await laptop.getByText('Signed out because you signed in on Chrome on Android.').waitFor({ timeout: 20000 });
  assert.ok(new URL(laptop.url()).pathname.startsWith('/login'));
  await fitsPhone(laptop, 'signed-out notice', assert);
  await shot(laptop, 'signed-out-390.png');
  checks.push('signed-out');

  assert.deepEqual(errors, []);
  console.log('session approval ui ok:', checks.join(', '));
  await laptopCtx.close(); await phoneCtx.close();
} finally { await browser.close(); }
