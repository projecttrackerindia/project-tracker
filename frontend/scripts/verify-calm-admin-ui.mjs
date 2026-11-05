import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';
import { darkPopups } from './lib/popups.mjs';

// Round 4: Platform admin rebuilt on the calm kit — overview (Aura line, tiles, subscriptions, Manage › rows), Organizations (pill filters
// that ask the server, calm rows, New organization) and Users (calm rows). 1440, 1920 and 390, light and dark; fictional fixtures; read only.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/calm-round4b');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const g = (n) => `70000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const user = { id: g(1), displayName: 'Nia Admin', email: 'nia@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: true };
const ws = { id: g(2), slug: 'northwind', name: 'Northwind', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 8 };
const ago = (d) => new Date(Date.now() - d * 864e5).toISOString();
const stats = { deletedTenants: 1, users: 412, activeUsers: 377, tenants: 64, organizations: 41, personalWorkspaces: 23, suspendedTenants: 2, activeSessions: 58, subscriptions: [{ planCode: 'FREE', count: 30 }, { planCode: 'TEAM', count: 21 }, { planCode: 'BUSINESS', count: 13 }] };
const T = [['Contoso', 'Organization', 'Active', 'BUSINESS', 24], ['Fabrikam', 'Organization', 'Suspended', 'TEAM', 9], ['Tailspin', 'Organization', 'Active', 'TEAM', 14], ['Lee Personal', 'Personal', 'Active', 'FREE', 1], ['Old Litware', 'Organization', 'Active', 'FREE', 3]];
const tenants = T.map(([name, type, status, planCode, memberCount], i) => ({ id: g(100 + i), name, slug: name.toLowerCase().replace(/\s/g, '-'), type, status, ownerEmail: `owner${i}@example.test`, planCode, subscriptionStatus: i === 2 ? 'Trialing' : 'Active', periodEnd: null, memberCount, createdAt: ago(200 - i * 30), isDeleted: i === 4, deletedAt: i === 4 ? ago(3) : null }));
const users = [['Ama Kofi', true], ['Tom Nguyen', true], ['Lena Park', false], ['Dev Okafor', true]].map(([n, act], i) => ({ id: g(200 + i), email: `${n.split(' ')[0].toLowerCase()}@example.test`, displayName: n, emailVerified: i !== 2, isActive: act, isPlatformAdmin: i === 0, createdAt: ago(300 - i), lastLoginAt: i === 2 ? null : ago(i), workspaces: 2,
  memberships: [{ tenantId: tenants[i % 3].id, tenantName: tenants[i % 3].name, type: 'Organization', role: 'Member', planCode: 'TEAM', joinedAt: ago(100), isDeleted: false }] }));
const seen = [], errors = [], checks = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const make = async (theme) => {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
  await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); }, theme);
  await ctx.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
    if (url.origin !== origin) { await route.abort(); return; }
    if (ep.endsWith('/avatar') || ep.endsWith('/thumbnail')) { await route.fulfill({ status: 404, body: '' }); return; }
    if (!ep.startsWith('/api/')) {
      const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
      await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
      return;
    }
    assert.ok(method === 'GET' || ep.endsWith('/auth/refresh'), `Unexpected write: ${method} ${ep}`);
    const sp = url.searchParams; let data = [];
    if (ep.endsWith('/auth/refresh')) data = { accessToken: `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`, expiresAt: '2099-01-01T00:00:00Z', user };
    else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['projects.view', 'tasks.view', 'org.manage', 'work.view'], modules: { projects: 3, tasks: 3, work: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: {} } };
    else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
    else if (ep === '/api/v1/admin/stats') data = stats;
    else if (ep === '/api/v1/admin/go-live') data = { failing: 0, checks: [] };
    else if (ep === '/api/v1/admin/tenants') { seen.push(`tenants ${sp.get('type') ?? ''} ${sp.get('status') ?? ''}`); const items = tenants.filter((t) => (!sp.get('type') || t.type === sp.get('type')) && (!sp.get('status') || (sp.get('status') === 'Deleted' ? t.isDeleted : t.status === sp.get('status') && !t.isDeleted))); data = { items, page: 1, pageSize: 20, totalItems: items.length, totalPages: 1 }; }
    else if (ep === '/api/v1/admin/users') data = { items: users, page: 1, pageSize: 20, totalItems: users.length, totalPages: 1 };
    else if (ep === '/api/v1/timer') data = null;
    else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
    else if (ep.endsWith('/ai/status')) data = { enabled: false, configured: false, entitled: false, allowedHere: false };
    else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
    else if (ep.startsWith('/api/v1/me/ui/')) data = { value: null };
    else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  return ctx;
};
try {
  for (const theme of ['light', 'dark']) for (const [w, h] of [[1440, 900], [1920, 1080], [390, 844]]) {
    const tag = `${w}-${theme}`; const ctx = await make(theme); const page = await ctx.newPage(); await page.setViewportSize({ width: w, height: h });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${origin}/northwind/admin`);
    await page.getByTestId('adm-tiles').waitFor(); await page.locator('.aura-line').waitFor();
    assert.match(await page.getByTestId('adm-tiles').innerText(), /412[\s\S]*41[\s\S]*58/);
    assert.equal(await page.locator('main table').count(), 0, 'no tables on the overview');
    if (w < 500) await fitsPhone(page, `admin overview ${tag}`, assert);
    await page.waitForTimeout(400); await page.screenshot({ path: path.join(out, `admin-overview-${tag}.png`) });
    await page.locator('a', { hasText: 'Organizations' }).filter({ has: page.locator('text=organizations ·') }).first().click();
    await page.locator('.adm-row').first().waitFor();
    assert.equal(await page.locator('.adm-row').count(), 5);
    await page.getByRole('group', { name: 'Status' }).getByRole('button', { name: 'Suspended' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.adm-row').length === 1);
    assert.ok(seen.some((s) => s.endsWith(' Suspended')), 'status filter asks the server');
    await page.getByRole('group', { name: 'Status' }).getByRole('button', { name: 'Any' }).click(); await page.waitForTimeout(300);
    assert.equal(await page.locator('main select:visible').count(), 0, 'no native selects');
    if (w < 500) await fitsPhone(page, `admin tenants ${tag}`, assert);
    await page.screenshot({ path: path.join(out, `admin-tenants-${tag}.png`) });
    await page.goto(`${origin}/northwind/admin/users`); await page.locator('.adm-row').first().waitFor();
    assert.equal(await page.locator('.adm-row').count(), 4);
    if (w < 500) await fitsPhone(page, `admin users ${tag}`, assert);
    await page.waitForTimeout(300); await page.screenshot({ path: path.join(out, `admin-users-${tag}.png`) });
    if (theme === 'dark' && w === 1440) checks.push(`admin dark: ${await darkPopups(page, 'admin dark', assert)} popups, none white`);
    checks.push(`admin ${tag}`);
    await ctx.close();
  }
} finally { await browser.close(); }
assert.deepEqual(errors, [], 'no page errors');
console.log(`OK calm admin: ${checks.join(', ')}`);
