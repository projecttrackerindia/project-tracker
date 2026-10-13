import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Serve the production bundle with production CSP. Every API is synthetic;
// unexpected writes and AI/provider calls fail the check.
const dist = path.resolve('dist');
const origin = 'https://projecttracker-preview.test';
const csp = (await fs.readFile('nginx.conf', 'utf8')).match(/set \$sec_csp "([^"]+)";/)[1];
const artifacts = path.resolve(process.env.PM_UI_ARTIFACTS || 'test-results/enterprise-ui', 'workspace');
await fs.mkdir(artifacts, { recursive: true });
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Alex Morgan', email: 'preview@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const workspace = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Design Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 2 };
let included = true;
let role = 'Owner';
let slackError = false;
let slack = { configured: false, eligible: true, connected: false, teamId: null, teamName: null, connectedAt: null, lastError: null, interactiveEnabled: false };
let usage = { month: '2026-10', creditsUsed: 223, creditsLimit: 1000, creditsLeft: 777, unlimited: false, maxTier: 'deep', attachments: true, actions: true, tiers: ['quick', 'standard', 'deep'].map((id, i) => ({ id, label: id, model: 'synthetic', credits: i + 1, allowed: true, description: 'Preview response mode' })), attachmentTypes: [], maxFiles: 3, maxImageMb: 2, maxDocumentMb: 2, requestLimits: { perMinute: 20, perHour: 300, perDay: 1500 } };
let hookReads = 0;
let hookError = false;
const errors = [];
const checks = [];
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
    const endpoint = url.pathname;
    assert.ok(endpoint.endsWith('/auth/refresh') || route.request().method() === 'GET', `Unexpected write: ${endpoint}`);
    let data = [];
    if (endpoint.endsWith('/auth/refresh')) data = { accessToken: 'synthetic-preview-token', expiresAt: '2099-01-01T00:00:00Z', user };
    else if (endpoint === '/api/v1/me') data = { user, workspaces: [{ ...workspace, role }], fingerprint: 'preview', pendingConsent: [], current: { ...workspace, role, permissions: ['org.manage', 'work.view', 'work.create', 'reports.view'], modules: { projects: 3, work: 3, ai: 3, activity: 3, reports: 3, documents: 3, people: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { API_ACCESS: included ? 1 : 0, AI_ASSISTANT: 3 } } };
    else if (endpoint.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
    else if (endpoint.endsWith('/webhooks/events')) data = ['task.created', 'task.updated', 'audit.logged'];
    else if (endpoint.endsWith('/webhooks')) {
      hookReads++;
      if (hookError) { await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic webhook list unavailable.', errors: [] }) }); return; }
      data = [];
    }
    else if (endpoint.endsWith('/integrations/slack/status')) {
      if (slackError) { await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic connection unavailable.', errors: [] }) }); return; }
      data = slack;
    }
    else if (endpoint.endsWith('/ai/status')) data = { enabled: true, configured: true, entitled: true, allowedHere: true, model: 'synthetic', provider: 'Gemini' };
    else if (endpoint.endsWith('/ai/usage')) data = usage;
    else if (endpoint.endsWith('/ai/starters')) data = { greeting: 'Welcome', starters: [] };
    else if (endpoint.includes('/unread') || endpoint.includes('/counts')) data = { count: 0, total: 0 };
    else if (endpoint === '/api/v1/timer') data = null;
    else if (endpoint.endsWith('/workspace/logo')) data = { hasLogo: false };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  async function open(url, selector, width = 1440, height = 1050) {
    await page?.close(); page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.setViewportSize({ width, height }); await page.goto(origin + url);
    await page.locator(selector).waitFor({ state: 'visible' }); await page.evaluate(() => document.fonts.ready);
  }
  async function capture(name) {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false, `${name} must fit its viewport`);
    await page.screenshot({ path: path.join(artifacts, name + '.png'), fullPage: page.viewportSize().width > 600, animations: 'disabled' });
    checks.push(name);
  }
  await open('/preview-org/settings/webhooks', '.integration-studio');
  await capture('integrations-light-desktop');
  const guides = page.getByRole('navigation', { name: 'Integration setup guides' });
  await guides.getByRole('button', { name: /Microsoft Teams/ }).focus(); await page.keyboard.press('Enter');
  assert.ok(page.url().endsWith('?guide=teams'));
  await page.getByRole('heading', { name: 'Microsoft Teams channel notifications', exact: true }).waitFor();
  assert.match(await page.locator('#integration-selected-guide').innerText(), /Anyone/);
  await page.getByRole('button', { name: 'Connect Teams channel', exact: true }).click();
  assert.equal(await page.getByRole('radio', { name: /A Microsoft Teams channel/ }).getAttribute('aria-checked'), 'true');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await guides.getByRole('button', { name: /Webhooks/ }).click();
  await page.getByRole('heading', { name: 'Signed event delivery', exact: true }).waitFor();
  assert.match(await page.locator('#integration-selected-guide').innerText(), /X-PM-Signature/);
  await page.getByRole('button', { name: 'Create webhook', exact: true }).click();
  assert.equal(await page.getByRole('radio', { name: /Your own system/ }).getAttribute('aria-checked'), 'true');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.goBack(); assert.ok(page.url().endsWith('?guide=teams'));
  await page.reload(); await page.getByRole('heading', { name: 'Microsoft Teams channel notifications', exact: true }).waitFor(); assert.match(await page.locator('#integration-guide-heading').innerText(), /Teams/);
  checks.push('provider-keyboard-selection-modal-format-back-reload');
  await open('/preview-org/settings/webhooks?guide=slack', '.integration-studio', 390, 844);
  await capture('integrations-light-mobile');
  await page.locator('.integration-slack-install > summary').click();
  assert.match(await page.locator('.integration-slack-install').innerText(), /not yet enabled/);
  await capture('slack-installation-mobile');
  await open('/preview-org/settings/webhooks?guide=teams', '.integration-studio');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; }); await capture('integrations-dark-desktop');
  included = false; const priorReads = hookReads;
  await open('/preview-org/settings/webhooks', '.integration-studio');
  assert.equal(await page.getByRole('button', { name: 'Connect Slack channel', exact: true }).count(), 0);
  assert.equal(await page.getByRole('link', { name: /Review plans for webhooks/ }).count(), 1);
  assert.equal(hookReads, priorReads); checks.push('plan-denied-no-webhook-fetch-or-create'); included = true;
  hookError = true; await open('/preview-org/settings/webhooks', '.integration-studio');
  await page.getByText('Synthetic webhook list unavailable.', { exact: true }).waitFor();
  assert.equal(await page.getByText('No webhooks', { exact: true }).count(), 0);
  hookError = false; await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByText('No webhooks', { exact: true }).waitFor(); checks.push('saved-connections-error-and-retry');
  await open('/preview-org/settings/slack', '.slack-connection-panel');
  await page.getByText('Awaiting platform setup', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Connect Slack workspace', exact: true }).isDisabled(), true);
  await capture('slack-awaiting-setup');
  slack = { ...slack, configured: true, eligible: false };
  await open('/preview-org/settings/slack', '.slack-connection-panel');
  await page.getByText('Plan upgrade required', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Connect Slack workspace', exact: true }).isDisabled(), true);
  slack = { ...slack, eligible: true, connected: true, teamId: 'T_PREVIEW', teamName: 'Design Team' };
  await open('/preview-org/settings/slack', '.slack-connection-panel');
  await page.getByText('Connected', { exact: true }).waitFor(); await capture('slack-connected-desktop');
  slackError = true; await open('/preview-org/settings/slack', '.slack-connection-panel');
  await page.getByRole('button', { name: 'Try again', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Disconnect workspace', exact: true }).count(), 0);
  slackError = false; await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByText('Connected', { exact: true }).waitFor(); checks.push('slack-gates-status-error-recovery');
  await open('/preview-org/ai', '.ai-credit-button'); await capture('orbit-light-desktop');
  const modes = page.getByRole('radiogroup', { name: 'How much thinking' });
  await modes.getByRole('radio', { name: 'Auto', exact: true }).focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await modes.getByRole('radio', { name: 'Quick', exact: true }).getAttribute('aria-checked'), 'true');
  await page.keyboard.press('End'); assert.equal(await modes.getByRole('radio', { name: 'Deep', exact: true }).getAttribute('aria-checked'), 'true');
  await page.keyboard.press('Home'); assert.equal(await modes.getByRole('radio', { name: 'Auto', exact: true }).getAttribute('aria-checked'), 'true');
  assert.equal(await modes.locator('[tabindex="0"]').count(), 1);
  const summary = page.locator('.ai-credit-button'); await summary.click();
  assert.equal(await page.getByRole('meter', { name: 'Organization credits remaining' }).getAttribute('aria-valuenow'), '77.7');
  await page.keyboard.press('Escape'); assert.equal(await page.locator('.ai-credit-control').getAttribute('open'), null);
  assert.equal(await summary.evaluate(el => el === document.activeElement), true);
  await summary.click(); await page.locator('.ai-head-title').click();
  assert.equal(await page.locator('.ai-credit-control').getAttribute('open'), null);
  assert.doesNotMatch(await page.locator('.ai-head').innerText(), /20\/min|300\/hour|1500\/day/);
  assert.notEqual(await page.locator('a[href$="/agent-tracker"] svg').first().innerHTML(), await page.locator('a[href$="/activity"] svg').first().innerHTML());
  checks.push('mode-keyboard-usage-dismissal-hidden-rate-caps-distinct-icons');
  await open('/preview-org/ai', '.ai-credit-button', 390, 844); await capture('orbit-light-mobile');
  await page.locator('.ai-credit-button').click(); await capture('orbit-usage-mobile');
  const panel = await page.locator('.ai-credit-panel').boundingBox(); assert.ok(panel.x >= 0 && panel.x + panel.width <= 391);
  await open('/preview-org/settings/webhooks?guide=teams', '.integration-studio', 768, 1024); await capture('integrations-tablet');
  await open('/preview-org/ai', '.ai-credit-button', 320, 740); await capture('orbit-small-mobile');
  usage = { ...usage, creditsLeft: 50, tiers: usage.tiers.map(t => ({ ...t, allowed: t.id !== 'deep' })) };
  await open('/preview-org/ai', '.ai-credit-button');
  const restrictedModes = page.getByRole('radiogroup', { name: 'How much thinking' });
  await restrictedModes.getByRole('radio', { name: 'Auto', exact: true }).focus(); await page.keyboard.press('End');
  assert.equal(await restrictedModes.getByRole('radio', { name: 'Standard', exact: true }).getAttribute('aria-checked'), 'true');
  assert.equal(await page.locator('.ai-credit-control.low').count(), 1); checks.push('keyboard-skips-plan-locked-modes-low-balance');
  usage = { ...usage, unlimited: true };
  await open('/preview-org/ai', '.ai-credit-button'); await page.locator('.ai-credit-button').click();
  assert.match((await page.locator('.ai-credit-panel > strong').innerText()).replace(/\s/g, ''), /^Unlimitedonyourplan$/);
  assert.equal(await page.locator('.ai-credit-panel [role=meter]').count(), 0); checks.push('unlimited-balance');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.agent-mark.animated .agent-star').first().evaluate(el => getComputedStyle(el).animationName), 'none');
  assert.ok(await page.locator('.ai-credit-ring .ring').evaluate(el => getComputedStyle(el).transitionDuration.split(',').every(value => parseFloat(value) <= .001)), 'Reduced motion must suppress visible ring transitions');
  checks.push('reduced-motion');
  usage = { ...usage, unlimited: false, creditsLeft: 777 };
  await open('/preview-org/ai', '.ai-credit-button'); await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; }); await capture('orbit-dark-desktop');
  role = 'Member'; const readsBefore = hookReads;
  await open('/preview-org/settings/webhooks', '.sidebar');
  assert.equal(await page.locator('.integration-studio').count(), 0); assert.equal(hookReads, readsBefore); checks.push('member-no-administration');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(artifacts, 'results.json'), JSON.stringify({ checks, pageErrors: errors }, null, 2));
  console.log(JSON.stringify({ checks: checks.length, pageErrors: errors, artifacts }));
} catch (e) {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }); await fs.writeFile(path.join(artifacts, 'failure.json'), JSON.stringify({ error: String(e), pageErrors: errors, body: await page.locator('body').innerText() }, null, 2)); }
  throw e;
} finally { await browser.close(); }
