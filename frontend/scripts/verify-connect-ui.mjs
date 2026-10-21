import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Connected apps: the consent page an assistant (Claude, ChatGPT) sends people to, read-only versus changes, the return to the app, a
// refusal for an unregistered return address, and Settings › Connected apps with disconnect. Built frontend with synthetic API fixtures only.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/connect-ui');
await fs.mkdir(out, { recursive: true });
const csp = (await fs.readFile('nginx.conf', 'utf8')).match(/set \$sec_csp "([^"]+)";/)[1];
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'FREE', memberCount: 4 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const redirect = 'https://claude.ai/api/mcp/auth_callback';
let apps = [{ id: 'g1', clientName: 'Claude', clientId: 'ptc_1', person: 'Asha Rao', mine: true, scope: 'mcp:read mcp:write', createdAt: new Date(Date.now() - 86400000).toISOString(), lastUsedAt: new Date().toISOString() }];
const writes = [], errors = [], checks = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
try {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
  await ctx.addInitScript(() => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', 'light'); });
  await ctx.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
    if (url.origin !== origin) { await route.abort(); return; }
    if (ep.endsWith('/avatar')) { await route.fulfill({ status: 404, body: '' }); return; }
    if (!ep.startsWith('/api/')) { const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } }); return; }
    const json = (d, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ data: d }) });
    if (ep === '/api/v1/oauth/consent' && method === 'POST') { const b = req.postDataJSON(); writes.push(b); await json({ redirect: `${b.redirectUri}?${b.approve ? 'code=abc' : 'error=access_denied'}&state=${b.state}` }); return; }
    if (ep.startsWith('/api/v1/connected-apps/') && method === 'DELETE') { apps = []; writes.push({ ep }); await route.fulfill({ status: 204, body: '' }); return; }
    let data = [];
    if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
    else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['projects.view', 'org.manage'], modules: { projects: 3, tasks: 3, documents: 3, work: 3 }, plan: { code: 'FREE', name: 'Free', status: 'Active' }, entitlements: {} } };
    else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
    else if (ep === '/api/v1/oauth/client') data = { clientId: url.searchParams.get('clientId'), name: 'Claude', clientUri: null, logoUri: null, known: true, redirectAllowed: url.searchParams.get('redirectUri') === redirect };
    else if (ep === '/api/v1/connected-apps') data = apps;
    else if (ep === '/api/v1/timer') data = null;
    else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
    else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
    await json(data);
  });
  const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const q = new URLSearchParams({ response_type: 'code', client_id: 'ptc_1', redirect_uri: redirect, state: 'st1', code_challenge: 'c'.repeat(43), code_challenge_method: 'S256', scope: 'mcp:read' });

  // Consent: read only by default when that is what was asked; choose changes; allow returns to the app with the code.
  await page.goto(`${origin}/preview-org/connect?${q}`);
  await page.getByRole('heading', { name: /Claude wants to work in ProjectTracker/ }).waitFor();
  assert.equal(await page.getByRole('radio', { name: /Read only/ }).getAttribute('aria-checked'), 'true');
  await page.screenshot({ path: path.join(out, 'consent-1280.png') });
  await page.getByRole('radio', { name: /Read and make changes/ }).click();
  const back = page.waitForRequest((r) => r.url().startsWith('https://claude.ai/'));
  await page.getByRole('button', { name: 'Allow and connect' }).click();
  assert.ok((await back).url().includes('code=abc'));
  assert.equal(writes[0].scope, 'mcp:read mcp:write'); assert.equal(writes[0].approve, true); assert.equal(writes[0].state, 'st1');
  checks.push('consent');

  // An address the app did not register is refused without a way forward.
  q.set('redirect_uri', 'https://evil.example/cb');
  await page.goto(`${origin}/preview-org/connect?${q}`);
  await page.getByText('This connection cannot continue').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Allow and connect' }).count(), 0);
  checks.push('bad-redirect');

  // Settings › Connected apps: the address to add, the list, disconnect.
  await page.goto(`${origin}/preview-org/settings/connected-apps`);
  await page.locator('.cn-url code', { hasText: '/api/v1/mcp' }).waitFor();
  await page.locator('.cn-list li', { hasText: 'Claude' }).waitFor();
  await page.screenshot({ path: path.join(out, 'settings-1280.png') });
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click();
  await page.getByText('No apps connected').waitFor();
  checks.push('settings');

  // Phone width: the consent card fits.
  await page.setViewportSize({ width: 390, height: 844 });
  q.set('redirect_uri', redirect);
  await page.goto(`${origin}/preview-org/connect?${q}`);
  await page.getByRole('button', { name: 'Allow and connect' }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: path.join(out, 'consent-390.png') });
  checks.push('phone');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors }));
} finally { await browser.close(); }
