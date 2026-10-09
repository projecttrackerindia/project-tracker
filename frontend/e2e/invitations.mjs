// Development regression: register from an invitation, verify in a fresh browser context, sign in, and join.
// BASE=http://127.0.0.1:5173 CHROMIUM=/path/to/chromium node e2e/invitations.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright-core');
const BASE = process.env.BASE ?? 'http://127.0.0.1:5173';
const password = 'Zephyr!8472';
async function api(path, body, token) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(r.ok, `${path}: HTTP ${r.status}`);
  return r.status === 204 ? undefined : (await r.json()).data;
}
async function emailLink(email, path) {
  const mail = (await api('/dev/emails')).find((m) => m.to === email && m.text.includes(path));
  assert.ok(mail, `Missing ${path} email`);
  return mail.text.match(/https?:\/\/[^\s"<>]+/)[0];
}
const ownerEmail = `invite-owner-${randomUUID()}@example.com`;
await api('/auth/register', { email: ownerEmail, displayName: 'Nora Owner', password, acceptedTerms: true });
await api('/auth/verify-email', { token: new URL(await emailLink(ownerEmail, '/verify-email?')).searchParams.get('token') });
let owner = (await api('/auth/login', { email: ownerEmail, password })).accessToken;
const org = await api('/workspaces', { name: `Invitation test ${randomUUID()}` }, owner);
owner = (await api(`/workspaces/${org.id}/switch`, {}, owner)).accessToken;
await api('/billing/checkout', { planCode: 'PRO', startTrial: false, seats: 2 }, owner);
const email = `invite-person-${randomUUID()}@example.com`;
await api('/workspace/invitations', { email, role: 'Member' }, owner);
const invitation = new URL(await emailLink(email, '/invite?'));
const here = invitation.pathname + invitation.search;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--no-sandbox'] });
try {
  const registerContext = await browser.newContext();
  const page = await registerContext.newPage();
  await page.goto(BASE + here);
  await page.getByRole('link', { name: 'Create an account' }).click();
  await page.locator('input[name=displayName]').fill('Nora Candidate');
  await page.locator('input[name=email]').fill(email);
  await page.locator('input[name=password]').fill(password);
  await page.locator('input[name=confirm]').fill(password);
  await page.locator('input[name=acceptedTerms]').check();
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('heading', { name: 'Check your email' }).waitFor({ timeout: 20000 });
  // The email must carry the return path even when verification opens on another device.
  const context = await browser.newContext();
  const verified = await context.newPage();
  const verification = new URL(await emailLink(email, '/verify-email?'));
  assert.equal(verification.searchParams.get('redirect'), here);
  await verified.goto(BASE + verification.pathname + verification.search);
  await verified.getByRole('heading', { name: 'Email verified', exact: true }).waitFor();
  await verified.getByRole('link', { name: 'Go to sign in' }).click();
  assert.equal(new URL(verified.url()).searchParams.get('redirect'), here);
  await verified.locator('input[name=email]').fill(email);
  await verified.locator('input[type=password]').fill(password);
  await verified.locator('button[type=submit]').click();
  await verified.waitForURL((url) => url.pathname === '/invite', { timeout: 20000 });
  await verified.getByRole('button', { name: 'Accept invitation', exact: true }).click();
  await verified.waitForURL((url) => url.pathname === `/${org.slug}/`, { timeout: 20000 });
  console.log('PASS invitation -> registration -> verification in a new context -> login -> acceptance -> organization');
} finally { await browser.close(); }
