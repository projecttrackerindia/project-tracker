import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Library (Apple design). Docs hub: title, the search/ask hero, collections, the Continue shelf of covers with previews and reading progress,
// All documents filtered by kind (kind, project, status, updated), Ask your docs answering with its sources, Needs your review with AI drafts, and Paste a cURL into the import.
// Vault: the security strip, All · Mine · Shared · Requests, search, an item showing its fields in one well (values masked; copied or
// revealed after the same step-up check, the reveal hiding itself), Share for 1 hour · 1 day · Once, the rest under ···, and the
// screen-share notice once. 1440 light and dark, and a 390 phone. Synthetic API only.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist');
const out = path.resolve(process.env.PM_UI_ARTIFACTS || 'test-results/enterprise-ui', 'v2-library');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const now = new Date().toISOString();
const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 4 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const projects = [{ id: '00000000-0000-0000-0000-0000000000a1', key: 'PAY', name: 'Payments' }, { id: '00000000-0000-0000-0000-0000000000a2', key: 'ACC', name: 'Account Aggregator' }];
const TYPES = { API: ['API documentation', '#0ea5e9'], BRD: ['Business requirement document', '#7c3aed'], ARCH: ['Architecture documentation', '#8b5cf6'], TECH: ['Technical documentation', '#475569'], TEST_PLAN: ['Test plan', '#f59e0b'], PAGE: ['Page', '#4f46e5'], ARTIFACT: ['Build artifact', '#f97316'] };
const types = Object.entries(TYPES).map(([code, [name, color]], i) => ({ id: `t-${code}`, code, name, description: null, icon: 'file', color, sections: [{ key: 'body', title: 'Body', kind: 'Rich', sortOrder: 0, content: '' }], sortOrder: i }));
const doc = (n, title, code, status, p, daysAgo) => ({ id: `00000000-0000-0000-0000-00000000d${String(n).padStart(3, '0')}`, key: `DOC-${n}`, number: n, title, typeId: `t-${code}`, typeCode: code, typeName: TYPES[code][0], typeColor: TYPES[code][1], typeIcon: 'file',
  projectId: p?.id ?? null, projectKey: p?.key ?? null, projectName: p?.name ?? null, teamId: null, teamName: null, owner: { id: user.id, name: 'Asha Rao' }, status, visibility: 'Workspace', classification: 'Internal', tags: [], updatedAt: day(daysAgo), createdAt: day(daysAgo + 5), linkedCount: 0 });
const few = [doc(1, 'Razorpay API', 'API', 'Published', projects[0], 1), doc(2, 'Loan despatch details API', 'API', 'InReview', projects[0], 2), doc(3, 'Account Aggregator BRD', 'BRD', 'Approved', projects[1], 3),
  doc(4, 'Payment engine DR architecture', 'ARCH', 'Draft', projects[0], 4), doc(5, 'Insurance tenure change notes', 'PAGE', 'Published', projects[1], 5), doc(6, 'cibil-sample-response build', 'ARTIFACT', 'Published', projects[1], 6)];
const many = [...few, ...Array.from({ length: 8 }, (_, i) => doc(10 + i, `Runbook ${i + 1}`, 'PAGE', 'Draft', projects[i % 2], 7 + i))];
let docSet = few;

// ---- vault
const collections = [
  { id: 'c1', name: 'My vault', description: null, kind: 'Personal', projectId: null, projectName: null, teamId: null, teamName: null, myAccess: 'Manage', items: 1, atRisk: 0, requireStepUp: false, rotateEveryDays: null, locked: false, shares: null, sealed: false, rekeyNeeded: false, keyVersion: 0, requireApproval: false, requestable: false },
  { id: 'c2', name: 'Payments servers', description: null, kind: 'Shared', projectId: null, projectName: null, teamId: null, teamName: null, myAccess: 'Manage', items: 1, atRisk: 0, requireStepUp: false, rotateEveryDays: null, locked: false, sealed: false, rekeyNeeded: false, keyVersion: 0, requireApproval: false, requestable: false,
    shares: [{ id: 's1', principalType: 'User', principalId: user.id, role: null, name: 'Asha Rao', access: 'Manage', expiresAt: null }] },
];
const summary = (o) => ({ id: o.id, collectionId: o.c, collectionName: collections.find((c) => c.id === o.c).name, kind: 'Login', title: o.title, url: o.url, usernameHint: o.hint, tags: [], class: o.cls ?? 'Secret', useOnly: false,
  owner: { id: user.id, name: user.displayName }, hasTotp: true, strength: 4, breached: false, reused: false, expiresAt: null, expired: false, rotationReason: null, valueChangedAt: day(2), lastUsedAt: null, myAccess: 'Manage', health: [] });
const vItems = [summary({ id: 'i1', c: 'c1', title: 'SOPHOS VPN', url: 'https://vpn.example.test', hint: 'a***a', cls: 'Confidential' }), summary({ id: 'i2', c: 'c2', title: 'Payments DB admin', url: 'db.payments.example.test', hint: 'p***r' })];
const vDetail = (id) => ({ item: vItems.find((i) => i.id === id), links: [], versions: [], attachments: [], canReveal: true, canCopy: true, canManage: true, needsStepUp: id === 'i1', rotateEveryDays: null, createdAt: now, createdBy: { id: user.id, name: user.displayName },
  fields: [{ key: 'username', label: 'User name', type: 'text', secret: false, value: id === 'i1' ? 'asha.vpn' : 'payadmin' }, { key: 'password', label: 'Password', type: 'password', secret: true, value: null },
    { key: 'totp', label: 'One-time code (2FA)', type: 'totp', secret: true, value: null }, { key: 'note', label: 'Notes', type: 'note', secret: true, value: null }] });
const STEP = 'step-token-1';
const policy = { stepUpAlways: false, clipboardSeconds: 30, revealSeconds: 10, sharedAdminsOnly: false };
const writes = [], errors = [], checks = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const make = async (theme = 'light', opts = {}) => {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'], ...opts });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); }, theme);
  await ctx.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
    if (url.origin !== origin || ep.startsWith('/hubs/')) { await route.abort(); return; }
    if (ep.endsWith('/avatar') || ep.endsWith('/logo/file') || ep.includes('/brand/')) { await route.fulfill({ status: 404, body: '' }); return; }
    if (!ep.startsWith('/api/')) {
      const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
      await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
      return;
    }
    const body = method === 'GET' || method === 'DELETE' ? null : (() => { try { return req.postDataJSON(); } catch { return null; } })();
    if (method !== 'GET' && !ep.endsWith('/auth/refresh')) writes.push({ ep, method, body });
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status < 300 ? { data } : data) });
    const m = ep.match(/^\/api\/v1\/vault\/items\/([^/]+)(?:\/(reveal|totp|activity))?$/);
    let data = [];
    if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
    else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['org.manage', 'projects.view', 'documents.view', 'documents.edit', 'vault.use'], modules: { projects: 3, documents: 3, work: 3, ai: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3 } } };
    else if (ep === '/api/v1/me/ui/sidebar') data = { key: 'sidebar', value: null, updatedAt: null };
    else if (ep === '/api/v1/documents') { const p = url.searchParams.get('projectId'); const list = docSet.filter((d) => !p || d.projectId === p); data = { items: url.searchParams.get('scope') === 'recent' ? list.filter((d) => d.typeCode !== 'ARTIFACT').slice(0, 4) : list, nextCursor: null, total: list.length }; }
    else if (/^\/api\/v1\/documents\/[0-9a-f-]{36}$/.test(ep)) { const d = docSet.find((x) => x.id === ep.split('/').pop()); data = { item: d, revision: 1, versionLabel: '1.0', can: { edit: true, delete: true, link: true, share: true, publish: true }, publishedLabel: null, hasUnpublishedChanges: false, viewingPublished: false,
      sections: [{ key: 'body', title: 'Body', kind: 'Rich', sortOrder: 0, content: d?.typeCode === 'API' ? '<p>POST /payments/orders</p><pre>curl -X POST \\\n -H "X-Client-Id" \\\n -d \'{"amount":50000}\'</pre>' : '<p>Scope and goals.</p>' }] }; }
    else if (ep === '/api/v1/doctracker/apihome' || ep.startsWith('/api/v1/doctracker/api-home')) data = { documentId: few[0].id };
    else if (/^\/api\/v1\/documents\/[^/]+\/api$/.test(ep)) data = { definitions: [], endpoints: [] };
    else if (ep === '/api/v1/doctracker/catalog') data = { projects: projects.map((p) => ({ ...p, endpoints: [], definitions: [], documents: [], diagrams: 0 })), canCreate: true, isAdmin: true, truncated: 0 };
    else if (ep === '/api/v1/documents/proposals') data = [{ id: 'pr1', projectId: projects[0].id, projectKey: 'PAY', kind: 'api-reference', sourceType: 'api', sourceId: null, title: 'Loan despatch details API', summary: 'Three endpoints changed in UAT.',
      body: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'POST /despatch now needs a branch code.' }] }] }), targetDocumentId: null, targetTitle: null, status: 'Proposed', createdAt: now, resultDocumentId: null, action: 'create' }];
    else if (ep === '/api/v1/documents/inbox') data = { toReview: [], submitted: [], accessToDecide: [], myAccessRequests: [], waiting: 0 };
    else if (ep === '/api/v1/document-types') data = types;
    else if (ep === '/api/v1/documents/search') data = { hits: [], total: 0 };
    else if (ep === '/api/v1/documents/ai/ask') data = { answer: 'Send X-Api-Key and Content-Type on every call [1].', citations: [{ n: 1, documentId: few[0].id, key: 'DOC-1', title: 'Razorpay API', icon: null, block: 0, snippet: 'Headers' }], pagesRead: 3, model: 'synthetic', found: true };
    else if (ep === '/api/v1/documents/dashboard') data = { total: 6, byStatus: [], byType: [], mine: 6, waitingForMe: 0, updatedThisWeek: 2, notUpdatedIn90Days: 0, unpublished: 0, recent: [] };
    else if (ep === '/api/v1/vault/overview') data = { collections, policy, canAdmin: true, canCreateShared: true, health: { total: 2, weak: 0, reused: 0, breached: 0, expired: 0, old: 0, toRotate: 0, score: 100 }, mfaEnabled: true, identity: null, hasPasskeys: false };
    else if (ep === '/api/v1/vault/keys/me') data = { identity: null, unlocks: [] };
    else if (ep === '/api/v1/vault/items' && method === 'GET') { const c = url.searchParams.get('collectionId'), q = (url.searchParams.get('q') ?? '').toLowerCase(); data = url.searchParams.get('bin') ? [] : vItems.filter((i) => (!c || i.collectionId === c) && (!q || i.title.toLowerCase().includes(q))); }
    else if (m && !m[2]) data = vDetail(m[1]);
    else if (m && m[2] === 'reveal') {
      if (!body.copy && body.stepUp !== 'reveal-grant') { await json({ errors: [{ code: 'REVEAL_VERIFY_REQUIRED', message: 'Showing a value needs your password and a second check.' }], message: 'Showing a value needs your password and a second check.' }, 403); return; }
      if (m[1] === 'i1' && body.stepUp !== STEP && body.stepUp !== 'reveal-grant') { await json({ errors: [{ code: 'STEP_UP_REQUIRED', message: 'This needs a fresh two-step check.' }], message: 'This needs a fresh two-step check.' }, 403); return; }
      data = { value: 'Synthetic!Value#1', revealSeconds: 10, clipboardSeconds: 30 };
    }
    else if (m && m[2] === 'totp') data = { code: '492039', secondsLeft: 21, period: 30, digits: 6 };
    else if (m && m[2] === 'activity') data = [];
    else if (ep === '/api/v1/vault/step-up/reveal') { if (body.password !== 'Passw0rd!x' || body.code !== '123456') { await json({ errors: [{ code: 'REVEAL_SECOND_FACTOR_REQUIRED', message: 'Confirm with a two-step code.' }], message: 'Confirm with a two-step code.' }, 403); return; } data = { token: 'reveal-grant', expiresAt: new Date(Date.now() + 300e3).toISOString() }; }
    else if (ep === '/api/v1/vault/step-up') { if (body.code !== '123456') { await json({ errors: [{ code: 'MFA_CODE_INVALID', message: 'That code is not right.' }], message: 'That code is not right.' }, 422); return; } data = { token: STEP, expiresAt: new Date(Date.now() + 300e3).toISOString() }; }
    else if (ep.match(/^\/api\/v1\/vault\/collections\/[^/]+$/)) data = collections.find((c) => c.id === ep.split('/').pop());
    else if (ep === '/api/v1/vault/requests') data = { mine: [], toDecide: [{ id: 'r1', kind: 'Collection', collectionId: 'c2', collectionName: 'Payments servers', itemId: null, itemTitle: null, requester: { id: 'u2', name: 'Ravi Kumar' }, reason: 'Release tonight', access: 'View', minutes: 240, status: 'Pending', decidedBy: null, decidedAt: null, decisionNote: null, grantedUntil: null, createdAt: now, canDecide: true }] };
    else if (ep === '/api/v1/vault/requestable') data = [];
    else if (ep === '/api/v1/vault/decoys') data = [];
    else if (ep === '/api/v1/vault/links') data = [];
    else if (ep === '/api/v1/vault/devices/pending') data = [];
    else if (ep === '/api/v1/vault/recovery/to-help') data = [];
    else if (ep === '/api/v1/vault/keys/circle') data = { circle: null };
    else if (ep.endsWith('/members')) data = [{ userId: 'u2', displayName: 'Ravi Kumar', email: 'ravi@example.test', role: 'Member' }];
    else if (ep === '/api/v1/timer') data = null;
    else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
    else if (ep.includes('/unread') || ep.includes('/counts')) data = { count: 0, total: 0 };
    await json(data);
  });
  return ctx;
};
const shot = async (page, name) => { await page.waitForTimeout(250); await page.screenshot({ path: path.join(out, name) }); };

try {
  // ---- Docs, 1440 light
  let ctx = await make('light'); let page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/preview-org/library`);
  await page.locator('.dx-li[data-doc="Razorpay API"]').waitFor();
  assert.equal(await page.locator('.dx-h1').innerText(), 'Library');
  assert.equal(await page.getByRole('tab', { name: 'Vault' }).count(), 0, 'Vault is its own place in the sidebar, not a Library tab');
  assert.deepEqual(await page.getByRole('tablist', { name: 'Kind' }).getByRole('tab').allInnerTexts(), ['All', 'API docs', 'Specs', 'Runbooks', 'Tests']);
  assert.ok(await page.getByRole('searchbox', { name: 'Ask your docs' }).isVisible(), 'the question field');
  assert.deepEqual(await page.locator('.dx-li[data-doc] .dx-kc').allInnerTexts(), ['API', 'API', 'BRD', 'Spec', 'Guide', 'File']);
  assert.deepEqual(await page.locator('.dx-li[data-doc] .dx-st').allInnerTexts(), ['Published', 'In review', 'Approved', 'Draft', 'Published', 'Published']);
  assert.equal(await page.locator('.dx-li[data-doc="Razorpay API"]').getAttribute('href'), `/preview-org/library/p/${projects[0].id}/d/${few[0].id}`, 'a project document opens inside its collection');
  assert.deepEqual(await page.getByTestId('collection').locator('b').allInnerTexts(), ['Payments', 'Account Aggregator']);
  // Continue: four covers (the artifact is not a book), each with its kind, a preview and a reading-progress bar.
  assert.deepEqual(await page.locator('.lb-book').evaluateAll((els) => els.map((e) => e.getAttribute('data-cover'))), ['Razorpay API', 'Loan despatch details API', 'Account Aggregator BRD', 'Payment engine DR architecture']);
  assert.deepEqual(await page.locator('.lb-book .lb-cov-k').allInnerTexts(), ['API REFERENCE', 'API REFERENCE', 'BRD', 'ARCHITECTURE']);
  await page.locator('.lb-book[data-cover="Razorpay API"] .lb-code').waitFor();
  assert.match(await page.locator('.lb-book[data-cover="Razorpay API"] .lb-req').innerText(), /POST\s*\/payments\/orders/);
  assert.equal(await page.locator('.lb-book .lb-prog').count(), 4);
  const review = page.getByTestId('needs-review');
  assert.match(await review.innerText(), /Needs your review\s*1[\s\S]*Loan despatch details API[\s\S]*API reference · AI draft/);
  assert.ok(await page.getByTestId('paste-curl').isVisible(), 'Paste a cURL');
  await shot(page, 'docs-1440-light.png');
  checks.push('docs-list');

  // Review an AI draft inline.
  await review.getByRole('button', { name: 'Review' }).click();
  await review.getByText('POST /despatch now needs a branch code.').waitFor();
  assert.ok(await review.getByRole('button', { name: 'Create page' }).isVisible());
  checks.push('needs-review');

  // Ask: the answer unfurls from the field with its sources as covers.
  const bar = page.getByRole('searchbox', { name: 'Ask your docs' });
  await bar.fill('what headers does the Razorpay API need?');
  await bar.press('Enter');
  await page.getByText('Send X-Api-Key and Content-Type on every call').waitFor();
  assert.ok(writes.some((w) => w.ep === '/api/v1/documents/ai/ask' && /headers/.test(w.body.question)));
  await page.locator('.lb-cite', { hasText: 'Razorpay API' }).waitFor();
  assert.equal(await page.locator('.lb-cite').first().getAttribute('href'), `/preview-org/library/docs/${few[0].id}#b-0`);
  assert.equal(await page.locator('.dx-li[data-doc]').count(), 6, 'asking does not filter the list');
  checks.push('ask-your-docs');
  await bar.fill('');

  // Paste a cURL opens the existing cURL import with the commands filled in.
  await page.getByTestId('paste-curl').evaluate((el) => { const dt = new DataTransfer(); dt.setData('text/plain', "curl -X POST 'https://api.example.test/v1/orders'"); el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true })); });
  await page.getByRole('dialog').getByText('Import an API').waitFor();
  assert.match(await page.getByLabel('cURL commands').inputValue(), /api\.example\.test\/v1\/orders/);
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  checks.push('paste-curl');

  // The kind control filters the list.
  docSet = many;
  await page.reload();
  await page.locator('.dx-li[data-doc]').first().waitFor();
  await page.getByRole('tablist', { name: 'Kind' }).getByRole('tab', { name: 'Specs' }).click();
  assert.deepEqual(await page.locator('.dx-li[data-doc]').evaluateAll((els) => els.map((e) => e.getAttribute('data-doc'))), ['Account Aggregator BRD', 'Payment engine DR architecture']);
  await page.getByRole('tablist', { name: 'Kind' }).getByRole('tab', { name: 'API docs' }).click();
  assert.deepEqual(await page.locator('.dx-li[data-doc]').evaluateAll((els) => els.map((e) => e.getAttribute('data-doc'))), ['Razorpay API', 'Loan despatch details API']);
  await page.getByRole('tablist', { name: 'Kind' }).getByRole('tab', { name: 'All' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.dx-li[data-doc]').length === 14);
  checks.push('kind-filter');
  await ctx.close();
  docSet = few;

  // ---- Vault, 1440 light
  ctx = await make('light'); page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/preview-org/library/vault`);
  await page.locator('.lib-vault-item[data-item="SOPHOS VPN"]').waitFor();
  assert.ok(await page.getByTestId('shield-note').isVisible(), 'the screen-share notice, the first time');
  const seg = page.getByRole('group', { name: 'Show' }).or(page.getByRole('radiogroup', { name: 'Show' })).or(page.getByRole('tablist', { name: 'Show' }));
  assert.match(await seg.first().innerText(), /All[\s\S]*Mine[\s\S]*Shared[\s\S]*Requests/);
  assert.ok(await page.getByRole('searchbox', { name: 'Search the vault' }).or(page.getByLabel('Search the vault')).first().isVisible());
  await page.locator('.lib-vault-item[data-item="SOPHOS VPN"]').click();
  await page.waitForFunction(() => location.pathname.endsWith('/library/vault/i1'));
  const panel = page.locator('.vlt2[data-item="SOPHOS VPN"]');
  await panel.waitFor();
  assert.deepEqual(await panel.locator('.vlt2-field .vlt2-label').allInnerTexts(), ['Username', 'Password', 'Verification code', 'Website', 'Notes']);
  assert.equal(await panel.locator('.vlt-tile.xl .vlt-tile-text').innerText(), 'S', 'big Passwords-style tile');
  assert.equal(await page.locator('.pw-sec').innerText().then((t) => t.replace(/\s+/g, ' ')), '2 Items 0 Reused 0 Breached');
  assert.match(await panel.locator('[data-field="username"]').innerText(), /asha\.vpn[\s\S]*Copy/);
  assert.equal(await panel.locator('[data-field="url"] a').getAttribute('href'), 'https://vpn.example.test');
  assert.equal(await panel.locator('[data-field="password"] .vlt-secret').getAttribute('data-state'), 'masked');
  assert.ok(!(await panel.innerText()).includes('Synthetic!Value#1'), 'no value is drawn');
  checks.push('item-fields');
  // Copy the password: the same step-up check, then the clipboard.
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await panel.getByRole('button', { name: 'Copy Password' }).click();
  await page.locator('.modal').getByText('Confirm it is you').waitFor();
  await page.getByLabel('Two-step code').fill('123456'); await page.getByRole('button', { name: 'Confirm' }).click();
  for (let i = 0; i < 60 && !writes.some((w) => w.ep === '/api/v1/vault/items/i1/reveal' && w.body?.stepUp === STEP); i++) await page.waitForTimeout(100);
  assert.ok(writes.some((w) => w.ep === '/api/v1/vault/items/i1/reveal' && w.body.copy === true && w.body.stepUp === STEP), `copied through the step-up check: ${JSON.stringify(writes.filter((w) => w.ep.includes('/vault/')))}`);
  await page.waitForFunction(() => navigator.clipboard.readText().then((t) => t === 'Synthetic!Value#1'));
  assert.equal(await panel.locator('[data-field="password"] .vlt-secret').getAttribute('data-state'), 'masked', 'still masked after copying');
  await panel.getByRole('button', { name: 'Show code' }).click();
  await panel.locator('[data-field="totp"] [data-state="revealed"]').waitFor();
  checks.push('copy-with-step-up');
  // Reveal: copy-only by default; the reveal sheet asks for the password AND a two-step code, then the dots turn into the value, which hides itself.
  await panel.getByRole('button', { name: 'Reveal Password' }).click();
  const rv = page.getByTestId('reveal-sheet'); await rv.waitFor();
  await rv.getByLabel('Account password').fill('Passw0rd!x'); await rv.getByLabel('Two-step code').fill('123456');
  await rv.getByRole('button', { name: 'Reveal', exact: true }).click();
  await panel.locator('[data-field="password"] .vlt-secret[data-state="revealed"]').waitFor();
  assert.ok(writes.some((w) => w.ep === '/api/v1/vault/items/i1/reveal' && w.body.copy === false && w.body.stepUp === 'reveal-grant'), 'revealed with the reveal grant');
  await page.waitForFunction(() => document.querySelector('[data-field="password"] .vlt-secret')?.textContent.replace(/•/g, '') === 'Synthetic!Value#1');
  assert.match(await panel.locator('[data-field="password"] .pw-hide').innerText(), /Hides in \d+s/);
  await panel.getByRole('button', { name: 'Hide Password' }).click();
  assert.equal(await panel.locator('[data-field="password"] .vlt-secret').getAttribute('data-state'), 'masked');
  assert.ok(!(await panel.innerText()).includes('Synthetic!Value#1'), 'hidden again');
  checks.push('reveal');
  // Share for… 1 hour / 1 day / Once: a link that ends by itself.
  const share = page.getByTestId('share-choices');
  assert.deepEqual(await share.getByRole('radio').evaluateAll((els) => els.map((e) => e.querySelector('b').textContent)), ['1 hour', '1 day', 'Once']);
  assert.equal(await share.getByRole('radio', { name: /^1 day/ }).getAttribute('aria-checked'), 'true');
  await shot(page, 'vault-item-1440-light.png');
  await share.getByRole('radio', { name: /^Once/ }).click();
  const linkDlg = page.getByRole('dialog'); await linkDlg.getByText('Send “SOPHOS VPN” once').waitFor();
  assert.equal(await linkDlg.getByRole('radio', { name: 'Once', exact: true }).getAttribute('aria-checked'), 'true');
  await page.keyboard.press('Escape'); await linkDlg.waitFor({ state: 'detached' });
  await page.locator('.lib-vault-item[data-item="Payments DB admin"]').click();
  const panel2 = page.locator('.vlt2[data-item="Payments DB admin"]'); await panel2.waitFor();
  await panel2.getByRole('button', { name: 'Item actions' }).click();
  await page.getByRole('menuitem', { name: /^Share for dates/ }).click();
  const editor = page.getByRole('dialog'); await editor.getByText('Access to Payments servers').waitFor();
  assert.ok((await editor.getByLabel('Ends on').last().inputValue()).length === 10, 'the new line ends on a date');
  await page.keyboard.press('Escape');
  checks.push('share-for');
  // ··· holds the rest.
  await page.getByRole('button', { name: 'More in the vault' }).click();
  const more = page.getByRole('menu', { name: 'More in the vault' });
  for (const name of ['New secret', 'Generator', 'Import', 'Health', 'One-time links', 'Bin', 'Seal my vault']) assert.ok(await more.getByRole('menuitem', { name: new RegExp(`^${name}`) }).isVisible(), name);
  await more.getByRole('menuitem', { name: /^Health/ }).click();
  await page.waitForFunction(() => location.search.includes('view=health'));
  checks.push('more-menu');
  // Mine and Shared, and Requests.
  await page.goto(`${origin}/preview-org/library/vault?show=shared`);
  await page.locator('.lib-vault-item').first().waitFor();
  assert.deepEqual(await page.locator('.lib-vault-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-item'))), ['Payments DB admin']);
  assert.equal(await page.getByTestId('shield-note').count(), 0, 'the screen-share notice shows only once');
  await page.goto(`${origin}/preview-org/library/vault?show=requests`);
  await page.getByText('Release tonight').waitFor();
  checks.push('segments-and-notice-once');
  assert.deepEqual(errors, []);
  await ctx.close();

  // ---- 1440 dark
  ctx = await make('dark'); page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/preview-org/library`);
  await page.locator('.dx-li[data-doc]').first().waitFor();
  assert.notEqual(await page.locator('.lb-cov').first().evaluate((e) => getComputedStyle(e).backgroundColor), 'rgb(255, 255, 255)', 'docs follow the dark theme');
  await shot(page, 'docs-1440-dark.png');
  await page.goto(`${origin}/preview-org/library/vault/i2`);
  await page.locator('.vlt2[data-item="Payments DB admin"]').waitFor();
  assert.notEqual(await page.locator('.lib-vault-detail').evaluate((e) => getComputedStyle(e).backgroundColor), 'rgb(255, 255, 255)');
  await shot(page, 'vault-item-1440-dark.png');
  checks.push('dark');
  await ctx.close();

  // ---- 390 phone
  for (const theme of ['light', 'dark']) {
    ctx = await make(theme, { hasTouch: true, isMobile: true }); page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/preview-org/library`);
    await page.locator('.dx-li[data-doc]').first().waitFor();
    await fitsPhone(page, `docs ${theme}`, assert);
    await shot(page, `docs-390-${theme}.png`);
    await page.goto(`${origin}/preview-org/library/vault`);
    await page.locator('.lib-vault-item').first().waitFor();
    await fitsPhone(page, `vault list ${theme}`, assert);
    await page.locator('.lib-vault-item[data-item="SOPHOS VPN"]').click();
    await page.locator('.vlt2[data-item="SOPHOS VPN"]').waitFor();
    assert.equal(await page.locator('.lib-vault-list').isVisible(), false, 'the item replaces the list on a phone');
    await fitsPhone(page, `vault item ${theme}`, assert);
    const wide = await page.locator('.vlt2').evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth, over: [...e.querySelectorAll('*')].filter((x) => x.getBoundingClientRect().right > e.getBoundingClientRect().right + 1).slice(0, 5).map((x) => `${x.tagName}.${x.className}:${Math.round(x.getBoundingClientRect().right)}`) }));
    assert.ok(wide.sw <= wide.cw + 1, `the item fits the phone without scrolling sideways inside it: ${JSON.stringify(wide)}`);
    await shot(page, `vault-item-390-${theme}.png`);
    await ctx.close();
  }
  checks.push('phone');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks, artifacts: out }));
} finally {
  await browser.close();
}
