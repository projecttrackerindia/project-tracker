import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { appCsp } from './lib/csp.mjs';

// Documentation visuals: Designs (an AI screen generated, previewed in a frame that runs nothing, kept, its state changed — diagrams kept
// untouched on every save), Architecture's Walk through (steps in travel order), and the Studio's "Describe it" (the current diagram sent,
// the answer drawn) and Simulate. 1440 light. Synthetic API only.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist');
const out = path.resolve(process.env.PM_UI_ARTIFACTS || 'test-results/enterprise-ui', 'docs-visuals');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 4 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const pid = '00000000-0000-0000-0000-0000000000a1';
const diagram = { key: 'd-1', title: 'Payout flow', kind: 'flow', data: {
  nodes: [{ id: 'a', kind: 'icon', icon: 'mobile', label: 'Customer app', x: 0, y: 0, w: 150, h: 64 }, { id: 'b', kind: 'icon', icon: 'gateway', label: 'API gateway', x: 230, y: 0, w: 150, h: 64 },
    { id: 'c', kind: 'icon', icon: 'server', label: 'Payout service', x: 460, y: 0, w: 150, h: 64, ctype: 'api', tech: '.NET 9', owner: 'Team Ledger', level: 'containers' }, { id: 'd', kind: 'icon', icon: 'bank', label: 'Bank', x: 690, y: 0, w: 150, h: 64, ctype: 'external' }],
  edges: [{ id: 'e2', source: 'b', target: 'c', label: 'gRPC', line: 'solid' }, { id: 'e1', source: 'a', target: 'b', label: 'HTTPS', line: 'solid', rps: 40 }, { id: 'e3', source: 'c', target: 'd', label: 'ISO 20022', line: 'solid', rps: 30 }] } };
const screen = '<div style="padding:32px;display:flex;flex-direction:column;gap:12px"><h1 style="margin:0;font-size:28px">Paid</h1><p>₹2,400 sent to •••• 4821</p><button style="height:44px">Done</button></div>';
let store = [diagram, { key: 'g-1', title: 'Welcome', kind: 'design', data: { source: 'ai', device: 'phone', state: 'review', html: screen, group: 'Onboarding' } }];
const writes = [], errors = [], checks = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] });
await ctx.addInitScript(() => { try { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', 'light'); } catch { /* the sandboxed screen frames have no storage */ } });
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
  const json = (data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
  let data = [];
  if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
  else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['org.manage', 'projects.view', 'documents.view', 'documents.edit'], modules: { projects: 3, documents: 3, work: 3, ai: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3 } } };
  else if (ep === '/api/v1/me/ui/sidebar') data = { key: 'sidebar', value: null, updatedAt: null };
  else if (ep === '/api/v1/doctracker/catalog') data = { projects: [{ id: pid, key: 'PAY', name: 'Payments', endpoints: [{ id: 'ep1', documentId: 'x', definitionId: 'y', definition: 'Payouts', method: 'POST', path: '/payouts', summary: 'Create a payout', tag: null, deprecated: false, score: 80, gaps: [], stage: 'Live', updatedAt: null }], definitions: [], documents: [], diagrams: 1, designs: store.filter((d) => d.kind === 'design').length }], canCreate: true, isAdmin: true, truncated: 0 };
  else if (ep === '/api/v1/doctracker/architecture' && method === 'PUT') { store = body.diagrams; data = { projectId: pid, diagrams: store, notes: body.notes, canEdit: true, updatedAt: new Date().toISOString(), updatedBy: 'Asha Rao' }; }
  else if (ep === '/api/v1/doctracker/architecture') data = { projectId: pid, diagrams: store, notes: null, canEdit: true, updatedAt: null, updatedBy: null };
  else if (ep === '/api/v1/documents/ai/design') data = { html: screen.replace('Paid', 'Account linked'), title: 'Bank account linked', model: 'synthetic' };
  else if (ep === '/api/v1/documents/ai/diagram') data = { data: { nodes: [...body.current.nodes, { id: 'f', kind: 'icon', icon: 'firewall', label: 'Fraud check', x: 345, y: 140, w: 150, h: 64 }], edges: body.current.edges }, summary: 'Added a fraud check.', model: 'synthetic' };
  else if (ep === `/api/v1/projects/${pid}`) data = { project: { id: pid, key: 'PAY', name: 'Payments', owner: { id: 'u-felix', name: 'Felix Moreau' }, stats: { total: 0, done: 0, inProgress: 0, todo: 0, cancelled: 0, overdue: 0 } }, statuses: [], stages: [], members: [] };
  else if (ep === '/api/v1/chat/conversations/direct') data = { id: 'c-felix', name: 'Felix Moreau', members: [] };
  else if (ep === '/api/v1/chat/conversations/c-felix/messages') data = { id: 'm1', body: body?.body ?? '' };
  else if (ep === '/api/v1/ai/status') data = { enabled: true, configured: true, entitled: true, allowedHere: true };
  else if (ep === '/api/v1/timer') data = null;
  else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
  else if (ep.includes('/unread') || ep.includes('/counts')) data = { count: 0, total: 0 };
  else if (ep.endsWith('/projects') || ep.endsWith('/documents')) data = { items: [], page: 1, totalPages: 0, totalItems: 0 };
  await json(data);
});
const shot = async (page, name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(out, name) }); };
try {
  const page = await ctx.newPage();
  // Errors from inside the sandboxed screen frames are the test harness reaching into them (no storage, no service worker), not the app.
  page.on('pageerror', (e) => { if (!/sandboxed and lacks/.test(e.message)) errors.push(e.message); });
  await page.setViewportSize({ width: 1440, height: 900 });

  // ---- Designs: the existing one, then one generated by AI and kept; the diagram goes back unchanged with every save.
  await page.goto(`${origin}/preview-org/library/p/${pid}/designs`);
  await page.getByTestId('designs').waitFor();
  assert.match(await page.locator('.dx-title').innerText(), /What Payments looks like/);
  assert.equal(await page.locator('.dz-grid li').count(), 1);
  // s-designs: breadcrumb, state chips with counts, AI strip with Nudge (a direct chat message to the reviewer), source/state badges.
  assert.match(await page.locator('#main-content').innerText(), /Library\s*›\s*Payments\s*›\s*Designs/);
  assert.deepEqual((await page.getByTestId('dz-states').getByRole('button').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()), ['All 1', 'Draft 0', 'In review 1', 'Approved 0']);
  const strip = page.getByTestId('dz-aistrip'); await strip.waitFor();
  assert.match(await strip.innerText(), /1 design waits on Felix’s review/);
  assert.match(await page.locator('.dz-grid li').first().innerText(), /✦ AI draft[\s\S]*AI[\s\S]*In review/);
  await shot(page, 'designs-1440.png');
  await strip.getByRole('button', { name: 'Nudge Felix' }).click();
  await strip.getByRole('button', { name: 'Nudged' }).waitFor();
  const nudge = writes.find((w) => w.ep === '/api/v1/chat/conversations/c-felix/messages');
  assert.match(nudge.body.body, /1 design is waiting on your review in Payments/);
  await page.getByTestId('dz-states').getByRole('button', { name: /^Approved/ }).click();
  assert.equal(await page.locator('.dz-grid li').count(), 0);
  await page.getByTestId('dz-states').getByRole('button', { name: /^All/ }).click();
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'designs 390 scrolls sideways');
  await shot(page, 'designs-390.png'); await page.setViewportSize({ width: 1440, height: 900 });
  checks.push('design-filter-strip-nudge');
  const frame = page.locator('.dz-ai iframe').first();
  assert.equal(await frame.getAttribute('sandbox'), '', 'a generated screen runs in a frame that can run nothing');
  await page.getByRole('button', { name: 'Add a design' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Add a design' });
  await sheet.getByRole('tab', { name: 'Describe it' }).click();
  await sheet.getByLabel('Describe the screen').fill('A success screen after the bank account is linked');
  await sheet.getByRole('button', { name: 'Generate' }).click();
  await sheet.locator('.dz-preview iframe').waitFor();
  await shot(page, 'designs-generate-1440.png');
  await sheet.getByRole('button', { name: 'Keep it' }).click();
  await page.locator('.dz-grid li').nth(1).waitFor();
  const put1 = writes.filter((w) => w.ep === '/api/v1/doctracker/architecture').at(-1);
  assert.ok(put1.body.diagrams.some((d) => d.key === 'd-1' && d.kind === 'flow'), 'the diagram is kept');
  assert.ok(put1.body.diagrams.some((d) => d.kind === 'design' && d.title === 'Bank account linked' && d.data.source === 'ai'), 'the new screen is saved');
  checks.push('design-generate-keep');
  await page.locator('.dz-card').first().click();
  const viewer = page.getByRole('dialog', { name: 'Welcome' });
  await viewer.waitFor();
  await viewer.getByRole('button', { name: 'Approved' }).click();
  await page.waitForFunction(() => true);
  await shot(page, 'designs-viewer-1440.png');
  const put2 = writes.filter((w) => w.ep === '/api/v1/doctracker/architecture').at(-1);
  assert.equal(put2.body.diagrams.find((d) => d.key === 'g-1').data.state, 'approved');
  await page.keyboard.press('Escape');
  checks.push('design-state');

  // ---- Architecture: Walk through in travel order (a → b → c → d, whatever order the arrows were drawn in).
  await page.goto(`${origin}/preview-org/library/p/${pid}/architecture`);
  await page.getByTestId('architecture').waitFor();
  assert.equal(await page.locator('.dx-fig').count(), 1, 'designs are not listed as diagrams');
  await page.getByRole('button', { name: 'Walk through Payout flow' }).click();
  const walk = page.getByRole('dialog', { name: 'Walk through Payout flow' });
  await walk.waitFor();
  assert.deepEqual((await walk.locator('ol li').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()), ['01 Customer app → API gateway HTTPS', '02 API gateway → Payout service gRPC', '03 Payout service → Bank ISO 20022']);
  await walk.getByRole('button', { name: 'Next step' }).click();
  assert.equal(await walk.locator('ol button[aria-current="step"]').innerText().then((t) => t.slice(0, 2)), '02');
  await shot(page, 'walkthrough-1440.png');
  await page.keyboard.press('Escape'); await walk.waitFor({ state: 'detached' });
  checks.push('walkthrough');

  // ---- Studio: Describe it sends the current diagram and draws the answer; Simulate lights the path.
  await page.getByRole('button', { name: 'Edit Payout flow' }).click();
  const studio = page.getByRole('dialog', { name: 'Architecture Studio' });
  await studio.waitFor();
  await studio.getByLabel('Describe the system or a change').fill('Add a fraud check between the gateway and payouts');
  await studio.getByRole('button', { name: 'Draw it' }).click();
  await studio.locator('.react-flow__node').nth(4).waitFor();
  const ask = writes.find((w) => w.ep === '/api/v1/documents/ai/diagram');
  assert.equal(ask.body.current.nodes.length, 4, 'the current diagram is sent');
  assert.ok(ask.body.context.some((c) => c.includes('POST /payouts')), 'the project’s endpoints are offered by name');
  // C4: level tabs (boxes with no level show everywhere; the Containers box hides on Context), cards with TYPE + name + tech, arrows with throughput.
  assert.equal(await studio.getByRole('tab', { name: 'Containers' }).getAttribute('aria-selected'), 'true');
  assert.equal(await studio.locator('.react-flow__node:visible').count(), 5);
  assert.match(await studio.locator('.arch-c4', { hasText: 'Payout service' }).innerText(), /API[\s\S]*Payout service[\s\S]*\.NET 9/);
  assert.ok(await studio.locator('.react-flow__edge-text', { hasText: 'HTTPS · 40 rps' }).count(), 'arrows show protocol and throughput');
  await studio.getByRole('tab', { name: 'Context' }).click();
  assert.equal(await studio.locator('.react-flow__node:visible').count(), 4, 'a Containers box is hidden on Context');
  await studio.getByRole('tab', { name: 'Containers' }).click();
  for (const g of ['People & systems', 'Containers', 'Boundaries']) assert.ok(await studio.locator('.arch-palette h5', { hasText: g }).count(), g);
  // Inspector: details and connections.
  await studio.locator('.react-flow__node', { hasText: 'Payout service' }).click();
  const insp = studio.locator('.arch-inspector');
  assert.equal(await insp.getByLabel('Owner').inputValue(), 'Team Ledger');
  assert.match(await insp.locator('.arch-conn').first().innerText(), /In\s+API gateway/);
  assert.match(await insp.locator('.arch-conn').nth(1).innerText(), /Out\s+Bank/);
  // Simulate at 3×: the bank (external, 60 req/s) gets 90 req/s and is the bottleneck; the fix inserts a retry queue.
  await studio.getByRole('button', { name: 'Simulate' }).click();
  const card = studio.locator('.arch-simcard');
  await card.waitFor();
  assert.match(await card.innerText(), /At 3× traffic Bank becomes the bottleneck \(150% of capacity\) — p95 rises to ~\d+(\.\d)?s/);
  assert.equal(await studio.locator('.arch-c4.load-hot').innerText().then((t) => /Bank/.test(t)), true);
  await shot(page, 'studio-simulate-1440.png');
  await card.getByRole('button', { name: '10×' }).click();
  assert.match(await card.innerText(), /At 10× traffic/);
  await card.getByRole('button', { name: '3×' }).click();
  await card.getByRole('button', { name: 'Add retry queue?' }).click();
  await studio.locator('.arch-c4', { hasText: 'Retry queue' }).waitFor();
  assert.match(await card.innerText(), /everything holds/);
  await studio.getByRole('button', { name: 'Share' }).click();
  await page.getByText('Link copied').first().waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), page.url());
  await studio.getByRole('button', { name: 'Stop' }).click();
  assert.equal(await studio.locator('.arch-simcard').count(), 0);
  await studio.locator('.arch-prow', { hasText: 'API service' }).click();
  assert.ok(await studio.locator('.arch-c4-tag', { hasText: /^API$/ }).count() >= 2);
  await studio.getByRole('button', { name: 'Done' }).click();
  await page.waitForFunction(() => !document.querySelector('.arch-studio'));
  await page.waitForTimeout(300);
  const saved = writes.filter((w) => w.ep === '/api/v1/doctracker/architecture').at(-1)?.body.diagrams.find((d) => d.key === 'd-1')?.data;
  assert.ok(saved, 'the diagram is saved');
  assert.ok(saved.nodes.some((n) => n.ctype === 'queue' && n.tech), 'the retry queue is kept with its C4 details');
  assert.ok(saved.nodes.some((n) => n.id === 'c' && n.owner === 'Team Ledger' && n.level === 'containers'));
  assert.ok(saved.edges.some((e) => e.id === 'e1' && e.rps === 40 && e.label === 'HTTPS'), 'throughput and label are kept apart');
  checks.push('studio-describe-simulate');
  // Phone: the Studio as a full screen with the palette strip on top and the inspector as a bottom sheet.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Edit Payout flow' }).click();
  await studio.waitFor();
  await studio.locator('.react-flow__node', { hasText: 'Payout service' }).click();
  await shot(page, 'studio-390.png');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scroll on a phone');
  await studio.getByRole('button', { name: 'Cancel' }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks, artifacts: out }));
} finally {
  await browser.close();
}
