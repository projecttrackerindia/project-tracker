import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { webcrypto, createHash } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

// The password vault: values are never drawn outside the edit screen (copy only), the vault covers itself when the window is left, copying clears the clipboard, confidential items ask
// for a two-step code once, use-only items can be copied but not shown, one-time codes come from the server, the editor's generator and
// strength meter, import from a CSV export, sharing, health, administration, and the phone layout in both themes. Then the sealed vault:
// keys made in the browser with a passkey (a virtual authenticator with PRF), the recovery kit, a sealed collection and item whose
// contents never reach the server readable, locking and unlocking (passkey and recovery key), and approving a new device — whose
// envelope is opened here with the new device's one-time keys and must give exactly the identity on record.
// Built frontend with a synthetic vault API only.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/vault-ui');
await fs.mkdir(out, { recursive: true });
const nginx = await fs.readFile('nginx.conf', 'utf8');
const csp = nginx.match(/set \$sec_csp "([^"]+)";/)[1];
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 4 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const now = new Date().toISOString();

// ---- a tiny vault server
const SECRETS = { i1: { password: 'Tq7#vLm2!pZx9@Rk', note: 'Branch code 0042' }, i2: { password: 'Root!Acc3ss#2026zz' }, i3: { password: 'Use0nly!Secret#9q' }, i4: { password: 'Summer@2024', totp: 'JBSWY3DPEHPK3PXP' } };
const collections = [
  { id: 'c1', name: 'My vault', description: null, kind: 'Personal', projectId: null, projectName: null, teamId: null, teamName: null, myAccess: 'Manage', items: 2, atRisk: 1, requireStepUp: false, rotateEveryDays: null, locked: false, shares: null, sealed: false, rekeyNeeded: false, keyVersion: 0 },
  { id: 'c2', name: 'Payments servers', description: 'Production and UAT', kind: 'Shared', projectId: null, projectName: null, teamId: null, teamName: null, myAccess: 'Manage', items: 2, atRisk: 0, requireStepUp: false, rotateEveryDays: 90, locked: false, sealed: false, rekeyNeeded: false, keyVersion: 0,
    shares: [{ id: 's1', principalType: 'User', principalId: user.id, role: null, name: 'Asha Rao', access: 'Manage', expiresAt: null }, { id: 's2', principalType: 'User', principalId: 'u2', role: null, name: 'Ravi Kumar', access: 'View', expiresAt: null }] },
];
const summary = (o) => ({ id: o.id, collectionId: o.c, collectionName: collections.find((c) => c.id === o.c).name, kind: o.kind ?? 'Login', title: o.title, url: o.url ?? null, usernameHint: o.hint ?? null, tags: o.tags ?? [],
  class: o.cls ?? 'Secret', useOnly: !!o.useOnly, owner: { id: user.id, name: user.displayName }, hasTotp: !!o.totp, strength: o.strength ?? 4, breached: !!o.breached, reused: false, expiresAt: null, expired: false,
  rotationReason: o.reason ?? null, valueChangedAt: now, lastUsedAt: null, myAccess: o.access ?? 'Manage', health: o.health ?? [] });
const items = [
  summary({ id: 'i1', c: 'c1', title: 'Bank portal', url: 'https://netbanking.example.in', hint: 'r***@fivestar.in', tags: ['finance'] }),
  summary({ id: 'i4', c: 'c1', title: 'Old router', hint: 'a***n', strength: 0, breached: true, totp: true, health: ['weak', 'breached'] }),
  summary({ id: 'i2', c: 'c2', title: 'AWS root account', url: 'console.aws.amazon.com', cls: 'Confidential', hint: 'o***s' }),
  summary({ id: 'i3', c: 'c2', title: 'Payments DB', kind: 'Database', useOnly: true, access: 'Manage', hint: 'p***r' }),
];
const fields = (id) => {
  const s = items.find((i) => i.id === id);
  if (s.kind === 'Database') return [{ key: 'host', label: 'Host', type: 'text', secret: false, value: 'db.payments.internal' }, { key: 'username', label: 'User name', type: 'text', secret: false, value: 'payuser' }, { key: 'password', label: 'Password', type: 'password', secret: true, value: null }];
  const f = [{ key: 'username', label: 'User name', type: 'text', secret: false, value: id === 'i1' ? 'ravi@fivestar.in' : 'admin' }, { key: 'password', label: 'Password', type: 'password', secret: true, value: null }];
  if (id === 'i4') f.push({ key: 'totp', label: 'One-time code (2FA)', type: 'totp', secret: true, value: null });
  if (id === 'i1') f.push({ key: 'note', label: 'Notes', type: 'note', secret: true, value: null });
  return f;
};
const detail = (id) => {
  const s = items.find((i) => i.id === id);
  return { item: s, fields: fields(id), links: [], versions: id === 'i1' ? [{ id: 'v1', at: now, by: { id: user.id, name: user.displayName }, reason: 'Rotated' }] : [], attachments: id === 'i1' ? [{ id: 'a1', fileName: 'recovery.txt', contentType: 'text/plain', sizeBytes: 42, at: now }] : [],
    canReveal: !s.useOnly && s.myAccess !== 'UseOnly', canCopy: true, canManage: s.myAccess === 'Manage', needsStepUp: s.class === 'Confidential', rotateEveryDays: null, createdAt: now, createdBy: { id: user.id, name: user.displayName } };
};
const policy = { stepUpAlways: false, clipboardSeconds: 5, revealSeconds: 3, sharedAdminsOnly: false };
const sealedState = { identity: null, unlocks: [], envelopes: [], items: [], events: [], pendingDevice: null };
const overview = () => ({ collections, policy, canAdmin: true, canCreateShared: true, health: { total: 4, weak: 1, reused: 0, breached: 1, expired: 0, old: 0, toRotate: 0, score: 75 }, mfaEnabled: true, identity: sealedState.identity });
const sha1hex = (s) => createHash('sha1').update(s).digest('hex').toUpperCase();
const collectionKeys = (id) => ({ collectionId: id, sealed: true, keyVersion: 1, rekeyNeeded: false, myAccess: 'Manage', pending: [],
  mine: sealedState.envelopes.filter((e) => e.collectionId === id).map((e) => ({ ...e, senderUserId: user.id, senderEd25519Public: sealedState.identity.ed25519Public })) });
const STEP = 'step-token-1';
const writes = [], errors = [], checks = [];
const err = (status, code, message) => ({ status, body: { errors: [{ code, message }], message } });

const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
try {
  const make = async (theme = 'light', extra = {}) => {
    const ctx = await browser.newContext({ ...extra, timezoneId: 'Asia/Kolkata', serviceWorkers: 'block', acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); }, theme);
    await ctx.route('**/*', async (route) => {
      const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
      if (url.origin !== origin) { await route.abort(); return; }
      if (ep.endsWith('/avatar')) { await route.fulfill({ status: 404, body: '' }); return; }
      if (!ep.startsWith('/api/')) {
        const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
        await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
        return;
      }
      const body = method === 'GET' || method === 'DELETE' ? null : (() => { try { return req.postDataJSON(); } catch { return null; } })();
      let data = [], fail = null;
      const m = ep.match(/^\/api\/v1\/vault\/items\/([^/]+)(?:\/(reveal|totp|activity|restore|versions\/([^/]+)\/reveal))?$/);
      if (ep === '/api/v1/vault/overview') data = overview();
      else if (ep === '/api/v1/vault/step-up') { writes.push({ ep, body }); data = body.code === '123456' ? { token: STEP, expiresAt: new Date(Date.now() + 300e3).toISOString() } : null; if (!data) fail = err(422, 'MFA_CODE_INVALID', 'That code is not right. Try the current one.'); }
      else if (ep === '/api/v1/vault/items' && method === 'GET') {
        writes.push({ ep, q: Object.fromEntries(url.searchParams) });
        const c = url.searchParams.get('collectionId'), h = url.searchParams.get('health'), q = (url.searchParams.get('q') ?? '').toLowerCase();
        data = url.searchParams.get('bin') ? [] : items.filter((i) => (!c || i.collectionId === c) && (!h || (h === 'any' ? i.health.length : i.health.includes(h))) && (!q || i.title.toLowerCase().includes(q)));
      }
      else if (ep === '/api/v1/vault/items' && method === 'POST') { writes.push({ ep, body }); const s = summary({ id: `n${items.length}`, c: body.collectionId, title: body.title, cls: body.class }); items.push(s); data = detail(s.id); }
      else if (m && !m[2] && method === 'GET') data = detail(m[1]);
      else if (m && !m[2] && method === 'PUT') { writes.push({ ep, body }); const s = items.find((i) => i.id === m[1]); s.title = body.title; data = detail(m[1]); }
      else if (m && m[2] === 'reveal') {
        writes.push({ ep, body }); const s = items.find((i) => i.id === m[1]);
        if (s.class === 'Confidential' && body.stepUp !== STEP) fail = err(403, 'STEP_UP_REQUIRED', 'This needs a fresh two-step check. Confirm with your authenticator first.');
        else if (s.useOnly && !body.copy) fail = err(403, 'VAULT_USE_ONLY', 'This item is use-only.');
        else data = { value: SECRETS[m[1]][body.field], revealSeconds: policy.revealSeconds, clipboardSeconds: policy.clipboardSeconds };
      }
      else if (m && m[2] === 'totp') { writes.push({ ep, body }); data = { code: '492039', secondsLeft: 21, period: 30, digits: 6 }; }
      else if (m && m[2] === 'activity') data = [{ at: now, action: 'vault.revealed', by: { id: 'u2', name: 'Ravi Kumar' }, field: 'Password', ipAddress: '203.0.113.x' }, { at: now, action: 'vault.reveal_denied', by: { id: 'u3', name: 'Uma' }, field: 'password', ipAddress: null }];
      else if (m && m[3]) { writes.push({ ep, body }); data = body.stepUp === STEP ? { value: 'Old!Value#2025', revealSeconds: 3, clipboardSeconds: 5 } : null; if (!data) fail = err(403, 'STEP_UP_REQUIRED', 'Earlier values need a fresh two-step check.'); }
      else if (ep === '/api/v1/vault/check') { writes.push({ ep, body }); data = { strength: 4, breachCount: body.password === 'Summer@2024' ? 4321 : 0 }; }
      else if (ep.startsWith('/api/v1/vault/breach-range/')) { const prefix = ep.split('/').pop(); writes.push({ ep }); const h = sha1hex('Summer@2024'); data = { body: `0000000000000000000000000000000000A:0\r\n${h.startsWith(prefix) ? `${h.slice(5)}:4321` : ''}` }; }
      else if (ep === '/api/v1/vault/keys/me') data = { identity: sealedState.identity, unlocks: sealedState.unlocks };
      else if (ep === '/api/v1/vault/keys/setup') { writes.push({ ep, body }); sealedState.identity = { userId: user.id, ...Object.fromEntries(['x25519Public', 'mlKemPublic', 'ed25519Public', 'selfSignature', 'fingerprint'].map((k) => [k, body[k]])), generation: 1 };
        sealedState.unlocks = body.unlocks.map((u, i) => ({ ...u, id: `u${i}`, credentialId: u.credentialId ?? null, createdAt: now, lastUsedAt: null })); data = { identity: sealedState.identity, unlocks: sealedState.unlocks }; }
      else if (ep.match(/^\/api\/v1\/vault\/keys\/unlocks\/[^/]+\/used$/)) { writes.push({ ep }); data = null; }
      else if (ep.match(/^\/api\/v1\/vault\/collections\/[^/]+\/keys$/)) { const id = ep.split('/')[5]; if (method === 'POST') { writes.push({ ep, body }); for (const e of body.envelopes) sealedState.envelopes.push({ ...e, collectionId: id }); } data = collectionKeys(id); }
      else if (ep.match(/^\/api\/v1\/vault\/collections\/[^/]+\/sealed-items$/)) { const id = ep.split('/')[5]; data = url.searchParams.get('bin') ? [] : sealedState.items.filter((i) => i.collectionId === id); }
      else if (ep === '/api/v1/vault/sealed-items' && method === 'POST') { writes.push({ ep, body }); const row = { ...body, rotationReason: null, createdAt: now, updatedAt: null, valueChangedAt: now, deletedAt: null, myAccess: 'Manage', files: [], versions: 0, rotateEveryDays: body.rotateEveryDays ?? null, expiresAt: body.expiresAt ?? null }; sealedState.items.push(row); data = row; }
      else if (ep.match(/^\/api\/v1\/vault\/sealed-items\/[^/]+\/events$/)) { sealedState.events.push(body); data = null; }
      else if (ep === '/api/v1/vault/devices/pending') data = sealedState.pendingDevice ? [sealedState.pendingDevice.link] : [];
      else if (ep.match(/^\/api\/v1\/vault\/devices\/[^/]+\/approve$/)) { writes.push({ ep, body }); sealedState.pendingDevice.approved = body; sealedState.pendingDevice = { ...sealedState.pendingDevice, link: null }; data = null; }
      else if (ep === '/api/v1/vault/import') { writes.push({ ep, body }); data = { imported: body.rows.length, skipped: 0, weak: 1 }; }
      else if (ep.match(/^\/api\/v1\/vault\/collections\/[^/]+$/) && method === 'GET') data = collections.find((c) => c.id === ep.split('/').pop());
      else if (ep.endsWith('/shares') && method === 'PUT') { writes.push({ ep, body }); data = collections[1]; }
      else if (ep === '/api/v1/vault/collections' && method === 'POST') { writes.push({ ep, body }); data = { ...collections[1], id: `c${collections.length + 1}`, name: body.name, sealed: !!body.sealed, keyVersion: body.sealed ? 1 : 0, rekeyNeeded: false, items: 0, atRisk: 0, shares: [collections[1].shares[0]] }; collections.push(data); }
      else if (ep === '/api/v1/vault/policy') { writes.push({ ep, body }); Object.assign(policy, body); data = policy; }
      else if (ep.startsWith('/api/v1/vault/access-review/')) data = { person: { id: 'u2', name: 'Ravi Kumar' }, collections: [{ id: 'c9', name: 'Ops break-glass', access: 'View', items: 3 }], used: [{ itemId: 'i2', title: 'AWS root account', collection: 'Payments servers', times: 4, last: now }] };
      else if (ep.endsWith('/admin-access')) { writes.push({ ep, body }); data = collections[1]; if (body.stepUp !== STEP) fail = err(403, 'STEP_UP_REQUIRED', 'Confirm with your authenticator first.'); }
      else if (ep.startsWith('/api/v1/vault/attachments/') && ep.endsWith('/download')) { writes.push({ ep, body }); await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: 'recovery words here' }); return; }
      else {
        assert.ok(method === 'GET' || ep.endsWith('/auth/refresh'), `Unexpected write: ${method} ${ep}`);
        if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
        else if (ep === '/api/v1/me') data = { user: { ...user, mfaEnabled: true }, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, reportCount: 4, permissions: ['projects.view', 'projects.edit', 'tasks.view', 'org.manage', 'reports.view', 'vault.use', 'vault.admin'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 3, activity: 3, documents: 3, people: 3, reports: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3 } } };
        else if (ep === '/api/v1/me/ui/sidebar') data = { key: 'sidebar', value: null, updatedAt: null };
        else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
        else if (ep === '/api/v1/workspace/members') data = [{ userId: user.id, displayName: 'Asha Rao', email: user.email, role: 'Owner', joinedAt: now, jobRole: null }, { userId: 'u2', displayName: 'Ravi Kumar', email: 'ravi@example.test', role: 'Member', joinedAt: now, jobRole: null }, { userId: 'u4', displayName: 'Meera Iyer', email: 'meera@example.test', role: 'Manager', joinedAt: now, jobRole: null }];
        else if (ep === '/api/v1/teams') data = [{ id: 't1', name: 'Payments', description: null, memberCount: 4, projectCount: 1, lead: null }];
        else if (ep.endsWith('/projects') || ep.endsWith('/tasks')) data = { items: [], page: 1, totalPages: 0, totalItems: 0 };
        else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
        else if (ep.endsWith('/ai/status')) data = { enabled: true, configured: true, entitled: true, allowedHere: true };
        else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
        else if (ep === '/api/v1/chat/projects/unread') data = [];
        else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
        else if (ep === '/api/v1/timer') data = null;
        else if (ep === '/api/v1/agent/inbox' || ep === '/api/v1/agent/assigned') data = { items: [], pending: 0, canDecide: false };
      }
      if (fail) await route.fulfill({ status: fail.status, contentType: 'application/json', body: JSON.stringify(fail.body) });
      else await route.fulfill({ contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify({ data }) });
    });
    return ctx;
  };
  const shot = async (page, name) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(400); await page.screenshot({ path: path.join(out, name) }); };
  const waitFor = async (pred, what) => { for (let i = 0; i < 50; i++) { if (pred()) return; await new Promise((r) => setTimeout(r, 100)); } assert.fail(`waited for ${what}`); };
  const html = (page) => page.evaluate(() => document.body.innerText + document.body.innerHTML);
  const clip = (page) => page.evaluate(() => navigator.clipboard.readText());

  let ctx = await make(); let page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message)); await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/preview-org/vault`); await page.locator('.vlt-items').waitFor();
  assert.ok(await page.locator('.sidebar a, nav a').filter({ hasText: /^Vault$/ }).first().isVisible(), 'Vault in the sidebar');
  assert.deepEqual(await page.locator('.vlt-rail [data-collection]').evaluateAll((els) => els.map((e) => e.getAttribute('data-collection'))), ['My vault', 'Payments servers']);
  assert.equal(await page.locator('.vlt-item').count(), 4);
  for (const v of Object.values(SECRETS).flatMap((s) => Object.values(s))) assert.ok(!(await html(page)).includes(v), 'no secret in the list page');
  checks.push('list-without-secrets');
  await shot(page, 'list-1440.png');

  // The item view never draws a secret: masked, copy only (the edit screen is the one place a value shows).
  await page.locator('.vlt-item[data-item="Bank portal"]').click();
  await page.locator('.vlt-panel[data-item="Bank portal"]').waitFor();
  assert.equal(await page.locator('[data-field="password"] .vlt-secret').getAttribute('data-state'), 'masked');
  assert.ok(await page.getByText('ravi@fivestar.in').isVisible(), 'non-secret user name shown');
  assert.ok(!(await html(page)).includes(SECRETS.i1.password));
  assert.equal(await page.locator('.vlt-panel').getByRole('button', { name: /^(Reveal|Show) / }).count(), 0, 'no reveal button in the item view');
  assert.equal(await page.locator('.vlt-panel [data-state="revealed"]').count(), 0);
  assert.equal(writes.filter((w) => w.ep.endsWith('/reveal')).length, 0, 'opening an item fetches no value');
  assert.match(await page.locator('.vlt-copy-only').innerText(), /never shown here/);
  assert.match(await page.getByTestId('shield-note').innerText(), /browser tab cannot hide itself from screen sharing/);
  checks.push('item-view-copy-only');

  // Copy: on the clipboard, then cleared.
  await page.getByRole('button', { name: 'Copy Password' }).click();
  await waitFor(() => writes.some((w) => w.ep.endsWith('/i1/reveal') && w.body.copy), 'copy request');
  await page.waitForTimeout(300);
  assert.equal(await clip(page), SECRETS.i1.password);
  assert.ok(!(await html(page)).includes(SECRETS.i1.password), 'a copy is never shown');
  await page.waitForTimeout(5600);
  assert.equal(await clip(page), '', 'clipboard cleared after the workspace time');
  checks.push('copy-and-clear-clipboard');

  // Switching to another window (a meeting app sharing the screen) covers the vault at once; coming back uncovers it.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.getByTestId('vault-cover').waitFor();
  assert.match(await page.getByTestId('vault-cover').innerText(), /Vault hidden/);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByTestId('vault-cover').waitFor({ state: 'detached' });
  checks.push('cover-when-window-left');

  // Files: download goes by POST and records.
  await page.getByRole('tab', { name: /Files/ }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download recovery.txt' }).click()]);
  assert.equal(dl.suggestedFilename(), 'recovery.txt');
  assert.ok(writes.some((w) => w.ep === '/api/v1/vault/attachments/a1/download'));
  // History: copied, never shown; always a two-step check (asked for first, so nothing is refused for nothing).
  await page.getByRole('tab', { name: /Earlier values/ }).click();
  assert.equal(await page.locator('.vlt-history').getByRole('button', { name: /Reveal/ }).count(), 0);
  await page.locator('.vlt-history').getByRole('button', { name: 'Copy the earlier Password' }).click();
  await page.locator('.modal').getByText('Confirm it is you').waitFor();
  assert.equal(writes.filter((w) => w.ep.includes('/versions/')).length, 0, 'the code is asked for before the request');
  await page.getByLabel('Two-step code').fill('000000'); await page.getByRole('button', { name: 'Confirm' }).click();
  await page.locator('.modal .form-error').waitFor();
  await page.getByLabel('Two-step code').fill('123 456'); await page.getByRole('button', { name: 'Confirm' }).click();
  await waitFor(() => writes.some((w) => w.ep.includes('/versions/') && w.body.stepUp === STEP), 'earlier value copied');
  await page.waitForTimeout(300);
  assert.equal(await clip(page), 'Old!Value#2025');
  assert.equal(writes.filter((w) => w.ep.includes('/versions/')).at(-1).body.copy, true);
  assert.ok(!(await html(page)).includes('Old!Value#2025'), 'an earlier value is never drawn');
  await page.getByRole('tab', { name: 'Activity' }).click();
  await page.locator('.vlt-activity li.warn').waitFor();
  checks.push('files-history-activity');

  // Confidential: the check made a moment ago is reused (no second prompt).
  await page.locator('.vlt-item[data-item="AWS root account"]').click();
  await page.locator('.vlt-panel[data-item="AWS root account"]').waitFor();
  assert.ok(await page.locator('.vlt-badges').getByText('Confidential').isVisible());
  await page.getByRole('button', { name: 'Copy Password' }).click();
  await waitFor(() => writes.some((w) => w.ep.endsWith('/i2/reveal')), 'confidential copy');
  assert.equal(await page.locator('.modal').count(), 0);
  assert.equal(writes.filter((w) => w.ep.endsWith('/i2/reveal')).at(-1).body.stepUp, STEP);
  assert.equal(writes.filter((w) => w.ep.endsWith('/i2/reveal')).at(-1).body.copy, true);
  checks.push('confidential-step-up-once');

  // Use only: no reveal, only copy.
  await page.locator('.vlt-item[data-item="Payments DB"]').click();
  await page.locator('.vlt-panel[data-item="Payments DB"]').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Reveal Password' }).count(), 0);
  assert.ok(await page.getByRole('button', { name: 'Copy Password' }).isVisible());
  assert.ok(await page.locator('.vlt-badges').getByText('Use only').isVisible());
  checks.push('use-only');

  // One-time code from the server.
  await page.locator('.vlt-item[data-item="Old router"]').click();
  await page.locator('.vlt-panel[data-item="Old router"]').waitFor();
  assert.ok(await page.locator('.vlt-health-callout').isVisible(), 'health warning');
  await page.getByRole('button', { name: 'Show code' }).click();
  await page.locator('.vlt-totp').waitFor();
  assert.equal(await page.locator('.vlt-totp').innerText(), '492 039');
  assert.ok(!(await html(page)).includes(SECRETS.i4.totp), 'the seed never comes to the page');
  checks.push('totp');
  await shot(page, 'item-1440.png');

  // New item: generator, strength, breach check, a bad one-time-code key.
  await page.getByRole('button', { name: 'New item' }).click();
  await page.locator('.modal').getByText('New vault item').waitFor();
  await page.getByRole('radio', { name: 'Login' }).click();
  await page.locator('#vi-title').fill('GitHub');
  await page.locator('#vf-username').fill('asha-rao');
  await page.locator('#vf-password').fill('Summer@2024');
  assert.match(await page.locator('[data-field="password"] .vlt-meter span').innerText(), /Very weak/);
  await page.getByRole('button', { name: 'Check breaches' }).click();
  await page.locator('.vlt-check.bad').waitFor();
  await page.getByRole('button', { name: 'Generate' }).click();
  const generated = await page.getByTestId('generated').innerText();
  assert.equal(generated.length, 20);
  await page.getByRole('button', { name: 'Use this' }).click();
  assert.equal(await page.locator('#vf-password').inputValue(), generated);
  assert.match(await page.locator('[data-field="password"] .vlt-meter span').innerText(), /Strong|Good/);
  await page.locator('#vf-totp').fill('not a key');
  assert.ok(await page.locator('[data-field="totp"] .field-error').isVisible());
  await page.locator('#vf-totp').fill('JBSW Y3DP EHPK 3PXP');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await waitFor(() => writes.some((w) => w.ep === '/api/v1/vault/items' && w.body), 'create');
  const created = writes.find((w) => w.ep === '/api/v1/vault/items' && w.body).body;
  assert.equal(created.title, 'GitHub'); assert.equal(created.collectionId, 'c1'); assert.equal(created.class, 'Secret');
  assert.deepEqual(created.fields.find((f) => f.key === 'password'), { key: 'password', label: 'Password', type: 'password', secret: true, value: generated });
  assert.equal(created.fields.find((f) => f.key === 'totp').value, 'JBSW Y3DP EHPK 3PXP');
  checks.push('create-with-generator');

  // Edit: the one place a value shows — fetched only when asked for (recorded as for the edit screen), masked again when the window is
  // left; a secret left as it was is kept, not erased or re-saved.
  await page.locator('.vlt-item[data-item="Bank portal"]').click();
  await page.locator('.vlt-panel[data-item="Bank portal"]').waitFor();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.modal').getByText('Edit “Bank portal”').waitFor();
  assert.equal(await page.locator('#vf-password').inputValue(), '');
  assert.ok(!(await html(page)).includes(SECRETS.i1.password), 'not in the edit screen until asked for');
  await page.getByRole('button', { name: 'Show the current Password' }).click();
  await page.locator('#vf-password[data-state="revealed"]').waitFor();
  assert.equal(await page.locator('#vf-password').inputValue(), SECRETS.i1.password);
  assert.equal(await page.locator('#vf-password').getAttribute('type'), 'text');
  { const b = writes.filter((w) => w.ep.endsWith('/i1/reveal')).at(-1).body; assert.deepEqual([b.field, b.copy, b.forEdit], ['password', false, true]); }
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.locator('#vf-password[data-state="masked"]').waitFor();
  assert.equal(await page.locator('#vf-password').getAttribute('type'), 'password');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.locator('#vi-title').fill('Bank portal (main)');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await waitFor(() => writes.some((w) => w.ep === '/api/v1/vault/items/i1' && w.body), 'update');
  const updated = writes.find((w) => w.ep === '/api/v1/vault/items/i1').body;
  assert.deepEqual(updated.fields.find((f) => f.key === 'password'), { key: 'password', label: 'Password', type: 'password', secret: true, keep: true });
  assert.equal(updated.title, 'Bank portal (main)');
  checks.push('edit-shows-on-request-and-keeps-secret');

  // Import a Bitwarden export.
  await page.getByRole('button', { name: 'Import' }).click();
  const csv = 'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,Gmail,,,0,https://mail.google.com,asha,"G,m@il#Pass1",\n,,login,Jira,,,0,https://jira.example,asha,password1,\n';
  await page.locator('.modal input[type=file]').setInputFiles({ name: 'bitwarden.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.locator('.vlt-import-preview').waitFor();
  assert.match(await page.locator('.vlt-import-preview').innerText(), /2 items found \(Bitwarden\)/);
  assert.ok(!(await page.locator('.vlt-import-preview').innerText()).includes('G,m@il'), 'no password in the preview');
  await page.getByRole('button', { name: 'Import 2' }).click();
  await waitFor(() => writes.some((w) => w.ep === '/api/v1/vault/import'), 'import');
  const imp = writes.find((w) => w.ep === '/api/v1/vault/import').body;
  assert.equal(imp.rows.length, 2); assert.equal(imp.rows[0].password, 'G,m@il#Pass1'); assert.equal(imp.collectionId, 'c1');
  checks.push('import');

  // Sharing a collection.
  await page.locator('.vlt-rail [data-collection="Payments servers"]').click();
  await page.getByRole('button', { name: 'Access' }).click();
  await page.locator('.vlt-share-row').first().waitFor();
  assert.equal(await page.locator('.vlt-share-row').count(), 2);
  await page.getByRole('button', { name: 'Add a person' }).click();
  await page.locator('.vlt-share-row').last().getByLabel('Name').selectOption('u4');
  await page.locator('.vlt-share-row').last().getByLabel('Access').selectOption('UseOnly');
  await page.getByRole('button', { name: 'Save access' }).click();
  await waitFor(() => writes.some((w) => w.ep.endsWith('/c2/shares')), 'shares');
  const shares = writes.find((w) => w.ep.endsWith('/c2/shares')).body.shares;
  assert.deepEqual(shares.at(-1), { principalType: 'User', principalId: 'u4', access: 'UseOnly', expiresAt: null });
  assert.equal(shares.length, 3);
  checks.push('sharing');

  // Health.
  await page.locator('.vlt-rail button', { hasText: 'Health' }).click();
  await page.locator('.vlt-score').waitFor();
  await page.locator('.vlt-health-list button', { hasText: 'In a public breach' }).click();
  await waitFor(() => writes.some((w) => w.ep === '/api/v1/vault/items' && w.q?.health === 'breached'), 'health filter request');
  await page.waitForFunction(() => document.querySelectorAll('.vlt-item').length === 1);
  assert.equal(await page.locator('.vlt-item').first().getAttribute('data-item'), 'Old router');
  assert.ok(await page.locator('.vlt-chip-on', { hasText: 'In a public breach' }).isVisible());
  checks.push('health');

  // Administration: rules, review, announced access.
  await page.locator('.vlt-rail button', { hasText: 'Administration' }).click();
  await page.getByText('Vault rules').waitFor();
  await page.getByText('Two-step check for every reveal, copy and code').click();
  await page.getByRole('button', { name: 'Save rules' }).click();
  await waitFor(() => writes.some((w) => w.ep === '/api/v1/vault/policy'), 'policy');
  assert.deepEqual(writes.find((w) => w.ep === '/api/v1/vault/policy').body, { stepUpAlways: true, clipboardSeconds: 5, sharedAdminsOnly: false });
  await page.getByLabel('Person to review').selectOption('u2');
  await page.locator('.vlt-review').getByText('Ops break-glass').waitFor();
  await page.getByRole('button', { name: 'Take 24-hour access' }).click();
  await page.locator('.modal textarea').fill('Kavya is on leave and the firewall is down');
  await page.getByRole('button', { name: 'Take access' }).click();
  await waitFor(() => writes.some((w) => w.ep.endsWith('/admin-access')), 'admin access');
  assert.deepEqual(writes.find((w) => w.ep.endsWith('/admin-access')).body, { reason: 'Kavya is on leave and the firewall is down', stepUp: STEP });
  checks.push('admin');

  // ---- the sealed vault, with a passkey from a virtual authenticator that supports PRF
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } });
  assert.match(await page.getByTestId('lock-state').innerText(), /Set up sealed vault/);
  await page.getByTestId('lock-state').click();
  await page.getByRole('button', { name: 'Create my vault keys' }).click();
  await page.getByTestId('recovery-kit').waitFor();
  const kit = (await page.getByLabel('Recovery key').innerText()).trim();
  assert.match(kit, /^PTV1(-[A-Z2-9]{4}){8}$/);
  const setup = writes.find((w) => w.ep === '/api/v1/vault/keys/setup').body;
  assert.deepEqual(setup.unlocks.map((u) => u.kind), ['RecoveryKey', 'Passkey'], 'a recovery key and a passkey');
  assert.equal(Buffer.from(setup.mlKemPublic, 'base64').length, 1184, 'an ML-KEM-768 public key');
  assert.ok(!JSON.stringify(setup).includes(kit) && !JSON.stringify(setup).includes(kit.replace(/-/g, '')), 'the recovery key never leaves the page');
  assert.match(setup.fingerprint, /^\d{5}( \d{5}){11}$/);
  await page.getByText('I have saved it somewhere safe and offline.').click();
  await page.getByLabel('Last four characters').fill(kit.slice(-4));
  await page.getByRole('button', { name: 'Done — open my vault' }).click();
  await page.getByTestId('safety-code').waitFor();
  assert.equal(await page.getByTestId('safety-code').innerText(), setup.fingerprint);
  assert.match(await page.getByTestId('lock-state').innerText(), /Sealed vault open/);
  checks.push('sealed-keys-with-passkey');
  await shot(page, 'sealed-keys-1440.png');

  // A sealed collection: its key is made here and wrapped to me (hybrid X25519 + ML-KEM-768 envelope).
  await page.getByRole('button', { name: 'New collection' }).click();
  await page.locator('.modal').getByRole('radio', { name: /Sealed/ }).waitFor();
  assert.equal(await page.locator('.modal').getByRole('radio', { name: /Sealed/ }).getAttribute('aria-checked'), 'true', 'sealed is the default once keys are open');
  await page.locator('.modal').getByLabel('Name', { exact: false }).first().fill('Root secrets');
  await page.locator('.modal').getByRole('button', { name: 'Save', exact: true }).click();
  await waitFor(() => writes.some((w) => w.ep.match(/collections\/c\d+\/keys$/) && w.body), 'first key');
  const madeCol = writes.find((w) => w.ep === '/api/v1/vault/collections' && w.body?.sealed);
  assert.ok(madeCol, 'collection made sealed');
  const env = writes.find((w) => w.ep.match(/collections\/c\d+\/keys$/) && w.body).body.envelopes[0];
  assert.equal(Buffer.from(env.envelope, 'base64').length, 1 + 32 + 1088 + 1 + 12 + 32 + 16, 'version, ephemeral X25519, ML-KEM ciphertext, wrapped key');
  await page.locator('.modal').getByRole('button', { name: 'Cancel' }).click();   // the access list that opens next
  await page.locator('.vlt-rail [data-collection="Root secrets"]').click();
  await page.getByRole('button', { name: 'New item' }).first().click();
  await page.locator('#vi-title').fill('Cloud root');
  await page.locator('#vf-username').fill('root@fivestar.in');
  await page.locator('#vf-password').fill('Se@led!Root#2026x');
  assert.match(await page.locator('.modal-head p').innerText(), /encrypted on this device/);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await waitFor(() => writes.some((w) => w.ep === '/api/v1/vault/sealed-items'), 'sealed item');
  const sent = writes.find((w) => w.ep === '/api/v1/vault/sealed-items').body;
  for (const secret of ['Cloud root', 'Se@led!Root#2026x', 'root@fivestar.in']) assert.ok(!JSON.stringify(sent).includes(secret), `"${secret}" never reaches the server`);
  assert.match(sent.id, /^[0-9a-f-]{36}$/, 'the id is made in the browser (it is bound into the encryption)');
  await page.locator('.vlt-panel-sealed[data-item="Cloud root"]').waitFor();
  const revealsBefore = writes.filter((w) => w.ep.endsWith('/reveal')).length;
  assert.equal(await page.locator('.vlt-panel-sealed').getByRole('button', { name: /^(Reveal|Show) / }).count(), 0, 'no reveal in the sealed item view');
  assert.ok(!(await html(page)).includes('Se@led!Root#2026x'), 'decrypted in memory, never drawn');
  await page.locator('.vlt-panel-sealed').getByRole('button', { name: 'Copy Password' }).click();
  await page.waitForTimeout(300);
  assert.equal(await clip(page), 'Se@led!Root#2026x');
  assert.equal(writes.filter((w) => w.ep.endsWith('/reveal')).length, revealsBefore, 'decrypted here, not asked of the server');
  await waitFor(() => sealedState.events.some((e) => e.action === 'copied'), 'the copy is recorded');
  assert.ok(await page.locator('.vlt-panel-sealed .vlt-e2ee').isVisible());
  // In the edit screen it can be shown (recorded), and it masks itself again.
  await page.locator('.vlt-panel-sealed').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('#vf-password[data-state="masked"]').waitFor();
  await page.getByRole('button', { name: 'Show Password', exact: true }).click();
  await page.locator('#vf-password[data-state="revealed"]').waitFor();
  assert.equal(await page.locator('#vf-password').inputValue(), 'Se@led!Root#2026x');
  await waitFor(() => sealedState.events.some((e) => e.action === 'revealed' && /edit screen/.test(e.field)), 'the edit-screen reveal is recorded');
  await page.locator('.modal').getByRole('button', { name: 'Cancel' }).click();
  checks.push('sealed-item-never-readable-on-server');
  await shot(page, 'sealed-item-1440.png');

  // Lock: keys wiped from memory. Unlock with the passkey, then with the recovery key; a waiting device is approved after its code is checked.
  await page.getByTestId('lock-state').click();
  await page.getByRole('button', { name: 'Lock now' }).click();
  assert.match(await page.getByTestId('lock-state').innerText(), /locked/);
  await page.locator('.vlt-rail [data-collection="Root secrets"]').click();
  await page.getByTestId('unlock').waitFor();
  assert.ok(!(await html(page)).includes('Se@led!Root#2026x'));
  await page.getByRole('button', { name: 'Unlock with passkey' }).click();
  await page.locator('.vlt-item[data-item="Cloud root"]').waitFor();
  checks.push('unlock-with-passkey');

  const eph = { xPriv: x25519.utils.randomSecretKey(), kem: ml_kem768.keygen() };
  const ephPub = { x25519Public: Buffer.from(x25519.getPublicKey(eph.xPriv)).toString('base64'), mlKemPublic: Buffer.from(eph.kem.publicKey).toString('base64') };
  sealedState.pendingDevice = { link: { id: 'd1', label: 'A phone', ...ephPub, createdAt: now, expiresAt: new Date(Date.now() + 600e3).toISOString(), ipAddress: '203.0.113.20', userAgent: 'Mobile Safari', approved: false, denied: false, envelope: null, signature: null } };
  await page.getByTestId('lock-state').click();
  await page.getByRole('button', { name: 'Lock now' }).click();
  await page.locator('.vlt-rail [data-collection="Root secrets"]').click();
  await page.getByRole('button', { name: 'Use my recovery key' }).click();
  await page.getByLabel('Recovery key').fill(kit.toLowerCase());
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.getByTestId('device-approval').waitFor();
  const h = sha256(Buffer.concat([Buffer.from('pt-vault/link/v1'), x25519.getPublicKey(eph.xPriv), eph.kem.publicKey]));
  const n = ((h[0] << 24) >>> 0) + (h[1] << 16) + (h[2] << 8) + h[3], code = String(n % 100000000).padStart(8, '0');
  assert.equal(await page.locator('[data-testid="device-approval"] .vlt-link-code').innerText(), `${code.slice(0, 4)} ${code.slice(4)}`, 'the same code as the new device');
  await page.getByRole('button', { name: 'The codes match — approve' }).click();
  await waitFor(() => sealedState.pendingDevice.approved, 'approval');
  // Open the envelope as the new device would: it must hold the identity secret that gives exactly the keys on record.
  const ctxStr = `device|${ws.id}|${user.id}|d1`;
  const raw = Buffer.from(sealedState.pendingDevice.approved.envelope, 'base64');
  const ePub = raw.subarray(1, 33), kemCt = raw.subarray(33, 33 + 1088);
  const key = hkdf(sha256, Buffer.concat([x25519.getSharedSecret(eph.xPriv, ePub), ml_kem768.decapsulate(kemCt, eph.kem.secretKey)]), Buffer.concat([ePub, sha256(kemCt)]), Buffer.from(`pt-vault/wrap/v1|${ctxStr}`), 32);
  const aes = raw.subarray(33 + 1088);
  const k = await webcrypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
  const seed = new Uint8Array(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: aes.subarray(1, 13), additionalData: Buffer.from(ctxStr) }, k, aes.subarray(13)));
  const xPub = x25519.getPublicKey(hkdf(sha256, seed, undefined, Buffer.from('pt-vault/x25519/v1'), 32));
  assert.equal(Buffer.from(xPub).toString('base64'), sealedState.identity.x25519Public, 'the linked device gets the real identity');
  checks.push('recovery-unlock-and-device-link');

  // A reload starts locked: nothing of the keys survives in storage.
  await page.reload();
  await page.locator('.vlt-rail').waitFor();
  assert.match(await page.getByTestId('lock-state').innerText(), /locked/);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  assert.ok(!stored.includes(kit) && !stored.includes('Se@led!Root#2026x'));
  checks.push('reload-starts-locked');
  await shot(page, 'admin-1440.png');
  assert.deepEqual(errors, []);
  await ctx.close();

  // Dark theme and the phone.
  for (const theme of ['dark', 'light']) {
    ctx = await make(theme); page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/preview-org/vault`); await page.locator('.vlt-items').waitFor();
    await fitsPhone(page, `vault list ${theme}`, assert);
    await shot(page, `phone-list-${theme}.png`);
    await page.locator('.vlt-item[data-item^="Bank portal"]').click();
    await page.locator('.vlt-panel[data-item^="Bank portal"]').waitFor();
    assert.equal(await page.locator('.vlt-main').isVisible(), false, 'the panel replaces the list on a phone');
    assert.equal(await page.locator('[data-field="password"] .vlt-secret').getAttribute('data-state'), 'masked');
    await fitsPhone(page, `vault item ${theme}`, assert);
    await shot(page, `phone-item-${theme}.png`);
    await page.getByRole('button', { name: 'Back to the list' }).click();
    await page.locator('.vlt-items').waitFor();
    await page.getByRole('button', { name: 'New item' }).click();
    await page.locator('.modal').getByText('New vault item').waitFor();
    await fitsPhone(page, `vault editor ${theme}`, assert);
    await shot(page, `phone-editor-${theme}.png`);
    await ctx.close();
  }
  checks.push('phone-both-themes');

  // The desktop app: the window is kept out of screen sharing while the vault is open, and let go when it is left.
  ctx = await make('light', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141 ProjectTrackerDesktop/1.0.0' });
  await ctx.addInitScript(() => { window.__shield = []; window.ptDesktop = { platform: 'win32', protectContent: (on) => window.__shield.push(on), windowControl: () => {}, onMaximizeChange: () => {}, attention: () => {} }; });
  page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message)); await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/preview-org/vault`); await page.locator('.vlt-items').waitFor();
  assert.deepEqual(await page.evaluate(() => window.__shield), [true], 'shield on while the vault is open');
  assert.match(await page.getByTestId('shield-note').innerText(), /Hidden from screen sharing/);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForTimeout(200);
  assert.equal(await page.getByTestId('vault-cover').count(), 0, 'no cover needed where the system hides the window');
  await page.evaluate(() => { history.pushState({}, '', '/preview-org/projects'); dispatchEvent(new PopStateEvent('popstate')); });
  await waitFor(() => true, 'navigation');
  await page.waitForFunction(() => window.__shield.length === 2);
  assert.deepEqual(await page.evaluate(() => window.__shield), [true, false], 'shield off once the vault is left');
  await ctx.close();
  checks.push('desktop-screen-share-shield');
  assert.deepEqual(errors, []);
  console.log(`Vault UI OK: ${checks.join(', ')}`);
} finally { await browser.close(); }
