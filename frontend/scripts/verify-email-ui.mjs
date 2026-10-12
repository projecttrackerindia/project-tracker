import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Production assets and CSP; all mail, AI, grants and receipts are synthetic.
// No external request is allowed. Unexpected writes fail the check.
const dist = path.resolve('dist');
const origin = 'https://projecttracker-preview.test';
const csp = (await fs.readFile('nginx.conf', 'utf8')).match(/set \$sec_csp "([^"]+)";/)[1];
const artifacts = path.resolve(process.env.PM_UI_ARTIFACTS || 'test-results/enterprise-ui', 'email');
await fs.mkdir(artifacts, { recursive: true });
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Alex Morgan', email: 'preview@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const workspace = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Design Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 2 };
const google = { connected: true, googleEmail: 'alex@gmail.example.test', connectedAt: '2026-10-12T08:00:00Z', lastError: null, calendarAccess: true, mailEnabled: true, mailSendAccess: true, inboxEnabled: true, inboxAccess: true };
const microsoft = { enabled: true, configured: true, connected: true, email: 'alex@outlook.example.test', connectedAt: '2026-10-12T08:00:00Z', mailSendAccess: true, inboxEnabled: true, inboxAccess: true, calendarsEnabled: false, calendarAccess: false };
const initial = { id: '00000000-0000-0000-0000-000000000010', recipient: 'morgan@example.test', subject: 'Delivery review · next steps', body: 'Hi Morgan,\n\nThe integration review is scheduled for Friday, 16 October. Please share the outstanding blockers before the review.\n\nThank you,\nAlex', provider: 'google', status: 'draft', version: 1, providerMessageId: null, acceptedAt: null };
const initialMicrosoft = { ...initial, id: '00000000-0000-0000-0000-000000000011', subject: 'Outlook delivery review', provider: 'microsoft' };
let drafts = new Map([initial, initialMicrosoft].map(d => [d.id, structuredClone(d)]));
let sends = 0; let rewrites = 0; let writes = 0; let reconciliations = 0; let rewriteMode = 'success'; let historyDenied = false;
const receipts = new Map();
let historyReads = 0; let holdNextHistory = false; let holdNextRewrite = false;
let heldHistory; let heldRewrite; let notifyHistory; let notifyRewrite;
const historyHeld = new Promise(resolve => { notifyHistory = resolve; });
const rewriteHeld = new Promise(resolve => { notifyRewrite = resolve; });
let sendMode = 'accepted'; let threadDenied = false; let googleError = false; let draftListDenied = false;
let heldRead; let holdNextRead = false;
let notifyHeldRead;
const readHeld = new Promise(resolve => { notifyHeldRead = resolve; });
const errors = []; const checks = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
let page;
try {
  const context = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
  await context.addInitScript(() => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', 'light'); });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { await route.abort(); return; }
    if (!url.pathname.startsWith('/api/')) {
      const file = path.resolve(dist, url.pathname.startsWith('/assets/') ? url.pathname.slice(1) : 'index.html');
      assert.ok(file.startsWith(dist + path.sep));
      const type = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream';
      await route.fulfill({ status: 200, contentType: type, body: await fs.readFile(file), headers: path.extname(file) === '.html' ? { 'content-security-policy': csp } : {} }); return;
    }
    const endpoint = url.pathname; const method = route.request().method();
    const reply = data => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
    const fail = (status, message) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ message, errors: [{ code: 'SYNTHETIC_ERROR', message }] }) });
    if (endpoint.includes('/email-drafts/') && !endpoint.endsWith('/options')) {
      const id = endpoint.split('/')[5]; let d = drafts.get(id); assert.ok(d, 'Unknown synthetic draft');
      const receiptPath = endpoint.split('/')[6] === 'rewrites';
      const receiptResult = r => ({ ...r, draftChanged: r.draft ? r.draft.version !== d.version || d.status !== 'draft' : false });
      if (receiptPath && method === 'GET') {
        historyReads++;
        if (!endpoint.split('/')[7] && holdNextHistory) {
          holdNextHistory = false; heldHistory = { deny: () => fail(403, 'Private rewrite access was revoked.') }; notifyHistory(); return;
        }
        if (historyDenied) { await fail(403, 'Private rewrite access was revoked.'); return; }
        const operation = endpoint.split('/')[7];
        if (operation) { assert.ok(receipts.has(operation), 'Unknown rewrite operation'); await reply(receiptResult(receipts.get(operation))); }
        else await reply([...receipts.values()].filter(r => r.draftId === id).map(r => ({ ...receiptResult(r), draft: null })));
        return;
      }
      if (endpoint.endsWith('/reconcile')) {
        assert.equal(method, 'POST'); assert.equal(d.status, 'unknown'); assert.ok(d.canReconcile); reconciliations++; writes++;
        d = { ...d, status: 'accepted', reconciledAt: '2026-10-12T09:00:00Z', acceptedAt: '2026-10-12T09:00:00Z', providerMessageId: 'synthetic-sent-id', version: d.version + 1 }; drafts.set(id, d); await reply(d); return;
      }
      if (method === 'GET') {
        if (holdNextRead) { holdNextRead = false; heldRead = { release: () => reply(structuredClone(d)) }; notifyHeldRead(); return; }
        await reply(d); return;
      }
      writes++;
      const body = route.request().postDataJSON();
      assert.ok(d.status === 'draft', 'Receipts must never be sent or rewritten'); assert.equal(body.version, d.version);
      if (endpoint.endsWith('/send')) {
        assert.equal(method, 'POST'); assert.equal(body.confirmed, true); assert.equal(body.senderEmail, d.provider === 'google' ? google.googleEmail : microsoft.email);
        sends++; d = { ...d, status: sendMode === 'accepted' ? 'accepted' : 'unknown', version: d.version + 2, confirmedSenderEmail: body.senderEmail, canReconcile: true, acceptedAt: sendMode === 'accepted' ? '2026-10-12T08:00:00Z' : null };
        drafts.set(id, d);
        if (sendMode === 'lost') { await route.abort('failed'); return; }
      } else if (receiptPath) {
        assert.equal(method, 'POST'); assert.equal(body.confirmed, true); assert.equal(body.credits, 2); assert.match(body.operationId, /^[0-9a-f-]{36}$/);
        rewrites++; d = { ...d, body: 'Hi Morgan,\n\nPlease share the outstanding blockers before our review on Friday, 16 October.\n\nThank you,\nAlex', version: d.version + 1 }; drafts.set(id, d);
        const receipt = { operationId: body.operationId, draftId: id, sourceVersion: body.version, style: body.style, status: 'completed', credits: 2, model: 'synthetic-model', createdAt: '2026-10-12T08:00:00Z', expiresAt: '2026-10-13T08:00:00Z', draft: structuredClone(d), draftChanged: false };
        receipts.set(body.operationId, receipt);
        if (holdNextRewrite) { holdNextRewrite = false; heldRewrite = { release: () => reply(receipt) }; notifyRewrite(); return; }
        if (rewriteMode === 'lost') await route.abort('failed'); else await reply(receipt);
        return;
      } else { assert.equal(method, 'PUT'); d = { ...d, ...body, version: d.version + 1 }; drafts.set(id, d); }
      await reply(d); return;
    }
    if (endpoint.endsWith('/integrations/microsoft/disconnect')) {
      assert.equal(method, 'POST'); writes++; microsoft.connected = false; microsoft.connectedAt = null; microsoft.mailSendAccess = false; await reply(null); return;
    }
    assert.ok(endpoint.endsWith('/auth/refresh') || method === 'GET', `Unexpected write: ${endpoint}`);
    let data = [];
    if (endpoint.endsWith('/auth/refresh')) data = { accessToken: 'synthetic-preview-token', expiresAt: '2099-01-01T00:00:00Z', user };
    else if (endpoint === '/api/v1/me') data = { user, workspaces: [workspace], fingerprint: 'preview', pendingConsent: [], current: { ...workspace, permissions: ['work.view', 'org.manage'], modules: { work: 3, projects: 3, ai: 3, people: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3 } } };
    else if (endpoint.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
    else if (endpoint.endsWith('/integrations/google/status')) { if (googleError) { await fail(503, 'Synthetic status unavailable'); return; } data = google; }
    else if (endpoint.endsWith('/integrations/microsoft/status')) data = microsoft;
    else if (endpoint === '/api/v1/me/email-drafts/options') data = { available: true, credits: 2, maxBodyCharacters: 6000 };
    else if (endpoint === '/api/v1/me/email-drafts') { if (draftListDenied) { await fail(403, 'Private draft access was revoked.'); return; } data = [...drafts.values()].map(d => ({ ...d, body: '' })); }
    else if (endpoint === '/api/v1/me/inbox/summaries/options') data = { available: false, credits: 1, maxSourceCharacters: 18000, retentionHours: 24 };
    else if (endpoint === '/api/v1/me/inbox' || endpoint === '/api/v1/me/inbox/thread') {
      if (threadDenied && endpoint.endsWith('/thread')) { await fail(403, 'Mailbox access was revoked.'); return; }
      const provider = url.searchParams.get('provider');
      const message = { id: 'mail1', threadId: 'thread1', subject: 'Private delivery evidence', sender: 'reviewer@example.test', receivedAt: '2026-10-12T08:00:00Z', unread: true, body: 'Private evidence that must disappear after revocation.', bodyTruncated: false, hasAttachments: false };
      data = endpoint.endsWith('/thread') ? { provider, account: provider === 'google' ? google.googleEmail : microsoft.email, threadId: 'thread1', messages: [message], truncated: false, sourceHash: 'a'.repeat(64), accessContext: 'a'.repeat(64) } : { provider, messages: [message], cursor: null };
    }
    else if (endpoint.includes('/unread') || endpoint.includes('/counts')) data = { count: 0, total: 0 };
    else if (endpoint === '/api/v1/timer') data = null;
    else if (endpoint.endsWith('/workspace/logo')) data = { hasLogo: false };
    await reply(data);
  });
  async function open(width = 1440, theme = 'light') {
    await page?.close(); page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.setViewportSize({ width, height: 1050 });
    await page.addInitScript(t => localStorage.setItem('pm_theme', t), theme);
    await page.goto(origin + '/account/integrations');
    await page.locator('.email-draft-item').first().waitFor({ state: 'visible' });
    await page.evaluate(() => document.fonts.ready);
  }
  const studio = () => page.locator('.personal-email-studio');
  async function choose(id = initial.id) { const d = drafts.get(id); await studio().getByRole('button', { name: new RegExp(d.subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click(); await page.waitForFunction(value => document.querySelector('[aria-label="Message"]')?.value === value, d.body); }
  async function capture(name) {
    // Let transient notifications leave naturally so they do not obscure review images.
    await page.locator('.toast-root .toast').first().waitFor({ state: 'detached', timeout: 15000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, name + ' must fit its viewport');
    if (page.viewportSize().width <= 600) {
      await studio().locator('.email-compose').evaluate(el => el.scrollIntoView({ block: 'start' }));
      await page.evaluate(() => scrollBy(0, -80));
      await page.screenshot({ path: path.join(artifacts, name + '.png'), animations: 'disabled' });
      await studio().locator('.email-compose-actions').evaluate(el => el.scrollIntoView({ block: 'center' }));
      await page.screenshot({ path: path.join(artifacts, name + '-actions.png'), animations: 'disabled' });
    } else {
      // Give the complete card room below the real fixed app chrome, without hiding it.
      const height = Math.ceil((await studio().boundingBox()).height) + 160;
      await page.setViewportSize({ width: page.viewportSize().width, height: Math.max(1050, height) });
      await studio().evaluate(el => el.scrollIntoView({ block: 'start' })); await page.evaluate(() => scrollBy(0, -110));
      await studio().screenshot({ path: path.join(artifacts, name + '.png'), animations: 'disabled' });
    }
    checks.push(name);
  }
  await open(); await page.screenshot({ path: path.join(artifacts, 'personal-accounts-overview.png'), animations: 'disabled' }); await choose(); await capture('email-compose-desktop');
  await studio().getByRole('button', { name: 'Review and send', exact: true }).click();
  const dialog = () => page.getByRole('dialog');
  await dialog().waitFor({ state: 'visible' }); assert.equal(sends, 0); assert.match(await dialog().innerText(), /From: alex@gmail.example.test/);
  await dialog().getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal(sends, 0); checks.push('cancelled-review-never-sends');
  await studio().getByLabel('Subject', { exact: true }).fill('Updated delivery review');
  assert.equal(await studio().getByRole('button', { name: 'Review and send', exact: true }).isDisabled(), true);
  await studio().getByRole('button', { name: 'Save draft', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.email-save-state')?.textContent === 'Saved · v2'); checks.push('dirty-draft-requires-versioned-save');
  await studio().getByRole('button', { name: /Rewrite with AI/ }).click(); await dialog().waitFor({ state: 'visible' }); assert.equal(rewrites, 0); assert.match(await dialog().innerText(), /2 AI credits/);
  await dialog().getByRole('button', { name: 'Generate draft', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.email-save-state')?.textContent === 'Saved · v3'); assert.equal(rewrites, 1); assert.equal(sends, 0); checks.push('rewrite-confirms-disclosure-and-exact-price');
  await studio().getByRole('button', { name: 'Review and send', exact: true }).click(); await dialog().getByRole('button', { name: 'Confirm and send', exact: true }).click();
  await studio().getByRole('heading', { name: 'Send receipt', exact: true }).waitFor(); assert.equal(sends, 1); assert.equal(await studio().getByLabel('Message', { exact: true }).isDisabled(), true);
  assert.equal(await studio().getByRole('button', { name: 'Review and send', exact: true }).count(), 0); assert.match(await studio().innerText(), /Recipient delivery is not verified/); assert.match(await studio().innerText(), /Asia\/Kolkata/); await capture('email-accepted-receipt'); checks.push('accepted-receipt-readonly-no-duplicate-send');
  // A lost AI response recovers the saved result through GET, never a second generation.
  drafts.set(initial.id, structuredClone(initial)); rewriteMode = 'lost'; await open(); await choose();
  await studio().getByRole('button', { name: /Rewrite with AI/ }).click(); await dialog().getByRole('button', { name: 'Generate draft', exact: true }).click();
  await studio().getByRole('alert').waitFor(); assert.equal(rewrites, 2); assert.equal(await studio().getByRole('button', { name: /Rewrite with AI/ }).isDisabled(), true);
  const rewriteWrites = writes;
  await studio().getByRole('button', { name: 'Check rewrite result', exact: true }).click();
  await studio().getByText('Rewrite receipt verified', { exact: true }).waitFor();
  assert.equal(writes, rewriteWrites); assert.equal(rewrites, 2); assert.equal(sends, 1); await capture('email-rewrite-recovered'); checks.push('lost-rewrite-response-recovers-without-new-inference-or-charge');
  await studio().getByLabel('Message', { exact: true }).fill('Newer unsaved wording that must remain.');
  await studio().getByRole('button', { name: 'Check rewrite result', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.personal-email-studio')?.getAttribute('aria-busy') === 'false');
  assert.equal(await studio().getByLabel('Message', { exact: true }).inputValue(), 'Newer unsaved wording that must remain.');
  await studio().getByText(/Review earlier wording/).click(); assert.match(await studio().innerText(), /will not replace them/); checks.push('saved-rewrite-never-replaces-unsaved-edits');
  await open(); await choose();
  await studio().locator('.email-rewrite-item').last().click(); await studio().getByText('Rewrite receipt verified', { exact: true }).waitFor(); assert.equal(rewrites, 2); checks.push('rewrite-history-recovers-across-page-reload');
  // The result renders before its follow-up library/history refresh finishes.
  // Revoke only after that operation settles, so the next explicit check tests denial.
  await page.waitForFunction(() => document.querySelector('.personal-email-studio')?.getAttribute('aria-busy') === 'false');
  historyDenied = true; await studio().getByRole('button', { name: 'Check rewrite result', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Message"]')?.value === ''); assert.equal(await studio().getByText('Rewrite receipt verified', { exact: true }).count(), 0); checks.push('denied-rewrite-retires-private-draft-and-result'); historyDenied = false; rewriteMode = 'success';
  // A non-abortable mutation can finish after a denied background read and a
  // successful library reload. That old response must remain retired.
  await open(); holdNextHistory = true; await choose(); await historyHeld;
  holdNextRewrite = true;
  await studio().getByRole('button', { name: /Rewrite with AI/ }).click(); await dialog().getByRole('button', { name: 'Generate draft', exact: true }).click(); await rewriteHeld;
  await heldHistory.deny();
  await page.waitForFunction(() => document.querySelector('[aria-label="Message"]')?.value === '');
  await studio().getByRole('button', { name: 'Reload', exact: true }).click(); await studio().locator('.email-draft-item').first().waitFor();
  const readsBeforeRetiredResult = historyReads;
  await heldRewrite.release();
  await page.waitForFunction(() => document.querySelector('.personal-email-studio')?.getAttribute('aria-busy') === 'false');
  assert.equal(await studio().getByLabel('Message', { exact: true }).inputValue(), '');
  assert.equal(await studio().getByText('Rewrite receipt verified', { exact: true }).count(), 0);
  assert.equal(historyReads, readsBeforeRetiredResult, 'A retired mutation must not select private content or refresh its receipts');
  await choose(); checks.push('late-rewrite-retired-after-denial-and-access-recovery');
  // Unknown provider outcomes survive reload and cannot be sent or deleted.
  drafts.set(initial.id, { ...initial, status: 'unknown', canReconcile: true, version: 2, confirmedSenderEmail: google.googleEmail });
  await open(); await choose(); assert.equal(await studio().getByRole('button', { name: 'Remove', exact: true }).count(), 0); assert.equal(await studio().getByRole('button', { name: 'Review and send', exact: true }).count(), 0);
  const beforeReload = writes; await studio().getByRole('button', { name: 'Reload saved record', exact: true }).click(); await page.waitForFunction(() => document.querySelector('.personal-email-studio')?.getAttribute('aria-busy') === 'false'); assert.equal(writes, beforeReload); await capture('email-unknown-recovery'); checks.push('unknown-receipt-readonly-recovery-never-replays');
  drafts.set(initial.id, structuredClone(initial)); sendMode = 'lost'; await open(); await choose();
  await studio().getByRole('button', { name: 'Review and send', exact: true }).click(); await dialog().getByRole('button', { name: 'Confirm and send', exact: true }).click();
  await studio().getByRole('heading', { name: 'Send status', exact: true }).waitFor(); assert.equal(sends, 2); assert.match(await studio().innerText(), /Automatic retry and deletion are blocked/); checks.push('lost-send-response-recovers-durable-status-without-retry');
  await studio().getByRole('button', { name: 'Check provider Sent', exact: true }).click();
  await studio().getByText('Sent copy verified', { exact: true }).waitFor(); assert.equal(reconciliations, 1); assert.equal(sends, 2); assert.match(await studio().innerText(), /Recipient delivery is not verified/); await capture('email-sent-copy-verified'); checks.push('unknown-send-reconciles-without-dispatch-or-delivery-claim');
  // A confirmation retired by SPA navigation must not initiate its old write.
  drafts.set(initial.id, structuredClone(initial)); sendMode = 'accepted'; await open(); await choose();
  await studio().getByRole('button', { name: 'Review and send', exact: true }).click(); await dialog().waitFor({ state: 'visible' });
  await page.evaluate(() => { history.pushState(null, '', '/account/profile'); dispatchEvent(new PopStateEvent('popstate')); });
  await studio().waitFor({ state: 'detached' }); await dialog().getByRole('button', { name: 'Confirm and send', exact: true }).click(); assert.equal(sends, 2); checks.push('retired-confirmation-never-dispatches');
  // A late draft read cannot refill the editor after disconnecting its grant.
  await open(); holdNextRead = true; await studio().getByRole('button', { name: /Outlook delivery review/ }).click();
  await page.waitForFunction(() => document.querySelector('.personal-email-studio')?.getAttribute('aria-busy') === 'true');
  await readHeld; assert.ok(heldRead); await page.getByRole('button', { name: 'Disconnect Microsoft', exact: true }).click(); await dialog().getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.personal-email-studio')?.getAttribute('aria-busy') === 'false');
  await heldRead.release().catch(() => undefined); heldRead = null;
  assert.equal(await studio().getByLabel('Message', { exact: true }).inputValue(), ''); checks.push('late-draft-response-retired-after-grant-disconnect');
  microsoft.connected = true; microsoft.mailSendAccess = true; microsoft.connectedAt = '2026-10-12T09:00:00Z';
  await open(); await choose(initialMicrosoft.id);
  await studio().getByRole('button', { name: 'Review and send', exact: true }).click(); await dialog().waitFor({ state: 'visible' });
  microsoft.connectedAt = '2026-10-12T10:00:00Z';
  await page.evaluate(() => { history.pushState(null, '', '/account/integrations?microsoft=connected'); dispatchEvent(new PopStateEvent('popstate')); });
  await page.waitForFunction(() => document.querySelector('[aria-label="Message"]')?.value === '');
  await dialog().getByRole('button', { name: 'Confirm and send', exact: true }).click(); assert.equal(sends, 2); checks.push('same-address-reconnect-retires-send-confirmation');
  await open(); const inbox = page.locator('.personal-inbox');
  await inbox.getByLabel('Inbox provider').selectOption('microsoft');
  await inbox.getByRole('button', { name: 'Load inbox', exact: true }).click(); await inbox.getByRole('button', { name: /Private delivery evidence/ }).click();
  await inbox.getByText('Private evidence that must disappear after revocation.', { exact: true }).waitFor();
  microsoft.connectedAt = '2026-10-12T11:00:00Z';
  await page.evaluate(() => { history.pushState(null, '', '/account/integrations?microsoft=connected'); dispatchEvent(new PopStateEvent('popstate')); });
  await inbox.locator('.inbox-thread-message').waitFor({ state: 'detached' }); assert.equal(await inbox.locator('.inbox-message').count(), 0); checks.push('same-address-outlook-reconnect-retires-inbox');
  await inbox.getByRole('button', { name: 'Load inbox', exact: true }).click(); await inbox.getByRole('button', { name: /Private delivery evidence/ }).click();
  await inbox.getByText('Private evidence that must disappear after revocation.', { exact: true }).waitFor(); threadDenied = true;
  await inbox.getByRole('button', { name: /Private delivery evidence/ }).click(); await inbox.getByRole('alert').waitFor(); assert.equal(await inbox.locator('.inbox-message').count(), 0); assert.equal(await inbox.locator('.inbox-thread-message').count(), 0); checks.push('denied-thread-retires-mailbox-metadata-and-content'); threadDenied = false;
  await open(); await choose(); draftListDenied = true;
  await studio().getByRole('button', { name: 'Refresh saved drafts', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Message"]')?.value === '');
  assert.equal(await studio().locator('.email-draft-item').count(), 0); assert.equal(await studio().getByLabel('Message', { exact: true }).isDisabled(), true);
  draftListDenied = false; await studio().getByRole('button', { name: 'Reload', exact: true }).click(); await studio().locator('.email-draft-item').first().waitFor(); checks.push('denied-draft-library-retires-selected-private-content');
  googleError = true; await open(); await page.getByRole('button', { name: 'Retry Google check', exact: true }).waitFor(); await choose();
  assert.equal(await studio().getByRole('button', { name: 'Review and send', exact: true }).isDisabled(), true); assert.match(await studio().innerText(), /Could not verify the sending account/);
  googleError = false; await studio().getByRole('button', { name: 'Retry connection check', exact: true }).click(); await page.getByRole('button', { name: 'Retry Google check', exact: true }).waitFor({ state: 'detached' }); checks.push('failed-provider-status-is-explicit-and-retryable');
  for (const width of [320, 390, 768]) { await open(width); await choose(); await capture('email-compose-' + width); }
  await open(1440, 'dark'); await choose(); await capture('email-compose-dark');
  await page.emulateMedia({ reducedMotion: 'reduce' }); assert.ok(await studio().locator('.email-draft-item').first().evaluate(el => parseFloat(getComputedStyle(el).transitionDuration) <= .001)); checks.push('email-reduced-motion');
  assert.deepEqual(errors, []); checks.push('no-browser-runtime-errors');
  await fs.writeFile(path.join(artifacts, 'results.json'), JSON.stringify({ checks, sends, rewrites, reconciliations, externalCalls: 0, pageErrors: errors }, null, 2));
  console.log(JSON.stringify({ checks: checks.length, syntheticSends: sends, syntheticRewrites: rewrites, pageErrors: errors, artifacts }, null, 2));
} catch (e) {
  await fs.writeFile(path.join(artifacts, 'failure.json'), JSON.stringify({ message: e.message, checks, pageErrors: errors }, null, 2));
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => undefined);
  throw e;
} finally { await browser.close(); }
