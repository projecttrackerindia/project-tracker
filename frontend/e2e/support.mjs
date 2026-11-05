import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';

// These journeys change seeded demo data. Never point them at a production account or host.
export const BASE = process.env.BASE ?? 'http://127.0.0.1:5173';
export const API = process.env.API ?? BASE;
for (const url of [BASE, API]) assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname), 'Seeded smoke tests require a local disposable server');
export const unique = (name) => `${name} ${Date.now()}`;
export const rich = (text) => JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

export async function account(email = 'demo@example.com') {
  const response = await fetch(`${API}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Demo@12345' }) });
  assert.ok(response.ok, `Demo sign-in: HTTP ${response.status}`);
  const login = (await response.json()).data;
  const headers = { Authorization: `Bearer ${login.accessToken}` };
  const raw = (path, method = 'GET', body) => fetch(`${API}/api/v1${path}`, { method, headers: body instanceof FormData ? headers : { ...headers, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
  const api = async (path, method = 'GET', body) => {
    const r = await raw(path, method, body);
    assert.ok(r.ok, `${method} ${path}: HTTP ${r.status}`);
    return r.status === 204 ? null : (await r.json()).data;
  };
  const context = await api('/me');
  return { email, user: context.user, slug: context.current.slug, planCode: context.current.plan?.code, api, raw };
}

export async function start(email = 'demo@example.com', options = {}) {
  const auth = await account(email);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true, ...options });
  await ctx.addInitScript(() => localStorage.setItem('pm_alerts_prompt', '1'));
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${BASE}/login`);
  await page.getByRole('textbox', { name: /email/i }).fill(email);
  await page.locator('input[type=password]').fill('Demo@12345');
  await page.locator('button[type=submit]').click();
  await page.locator('.v2-shell').waitFor({ timeout: 30000 });
  await dismissStartup(page);
  return { ...auth, browser, ctx, page, errors, async finish() { try { if (process.env.SHOTS) { await fs.mkdir(process.env.SHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.SHOTS, path.basename(process.argv[1], '.mjs') + '.png') }).catch(() => undefined); } assert.deepEqual(errors, [], 'No browser script errors'); } finally { await browser.close(); } } };
}

export async function dismissStartup(page) {
  const dialog = page.getByRole('dialog', { name: 'Check in', exact: true });
  await dialog.waitFor({ state: 'visible', timeout: 1000 }).catch(() => undefined);
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Not now', exact: true }).click();
}
export async function go(session, path = '') {
  // The shell is the readiness signal; the window load event can wait on slow lazy chunks and media that the journeys never use.
  await session.page.goto(`${BASE}/${session.slug}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await session.page.locator('.v2-shell').waitFor({ timeout: 60000 });
  await dismissStartup(session.page);
}
export async function business(session) {
  if (session.planCode === 'BUSINESS') return;
  await session.api('/billing/checkout', 'POST', { planCode: 'BUSINESS', startTrial: false, seats: 10 });
}
export async function createDoc(session, code = 'BRD', title = unique('Smoke document'), extra = {}) {
  const types = await session.api('/document-types');
  const type = types.find((t) => t.code === code);
  assert.ok(type, `${code} document type is seeded`);
  return session.api('/documents', 'POST', { title, typeId: type.id, projectId: null, visibility: 'Organization', classification: 'Internal', tags: [], ...extra });
}
export async function reader(session, doc) {
  await go(session, `/library/docs/${doc.item.id}`);
  await session.page.getByTestId('doc-reader').waitFor();
  await session.page.getByRole('heading', { name: doc.item.title, exact: true }).waitFor();
}
export async function saveText(session, doc, text) {
  const latest = await session.api(`/documents/${doc.item.id}`);
  const section = latest.sections.find((s) => s.kind === 'RichText');
  assert.ok(section, 'A rich-text section is available');
  return session.api(`/documents/${doc.item.id}/sections`, 'PUT', { revision: latest.revision, sections: [{ key: section.key, content: rich(text) }] });
}
export async function publish(session, doc, summary) {
  const latest = await session.api(`/documents/${doc.item.id}`);
  return session.api(`/documents/${doc.item.id}/publish`, 'POST', { changeSummary: summary, major: false, revision: latest.revision });
}
export async function waitFor(check, message, ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const result = await check(); if (result) return result; await new Promise((r) => setTimeout(r, 100)); }
  assert.fail(message);
}
