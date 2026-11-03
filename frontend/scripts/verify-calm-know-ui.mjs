import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Calm build (Desk, Quality, Insights, Reports, Activity, Library, Vault, People/Org chart, Settings, Sign-in) against the built frontend
// with synthetic fixtures only. Checks: each page renders its calm headline, the org chart moves a person through preview → confirm
// (POST /org/move), Settings shows Personal/Workspace to an owner, only Personal (no Billing) to a member, and every page fits a phone.
// Screenshots at 1440 and 1920 light, 1440 dark and 390 (phone) light + dark go to test-results/calm-know.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/calm-know');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const user = { id: id(1), displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: id(2), slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 5 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const people = [['Asha Rao', 'Owner', null, 'Chief executive'], ['Ben Ito', 'Admin', 1, 'Engineering lead'], ['Cara Lund', 'Member', 1, 'Design lead'], ['Dev Mora', 'Member', 11, 'QA engineer'], ['Eli Park', 'Member', 11, 'Data engineer']]
  .map(([n, r, m, t], i) => ({ userId: i === 0 ? user.id : id(10 + i), displayName: n, roleName: t, accessRole: r, managerId: m == null ? null : m === 1 ? user.id : id(m), teamIds: [id(90 + (i % 2))], reportCount: 0 }));
const now = Date.now(), iso = (min) => new Date(now + min * 60e3).toISOString();
const row = (n, title, prio, due, ch) => ({ kind: 'ticket', id: id(200 + n), key: `WT-${n}`, title, projectId: null, projectKey: null, projectName: null, status: 'To Do', category: 'Todo', priority: prio,
  dueDate: null, isOverdue: false, assignee: n === 1 ? null : { id: id(11), name: 'Ben Ito' }, typeName: 'Incident', updatedAt: iso(-60), slaStartAt: iso(-120), slaDueAt: iso(due), slaState: 'Running', _ch: ch });
const tickets = [row(1, 'Sign-in loops after a password reset', 'Critical', 70, 'whatsapp'), row(2, 'Export fails for large files', 'High', 180, 'email'), row(3, 'Invoice sync is late', 'Medium', 300, 'email')];
const detail = (r) => ({ ...r, description: 'Forty people cannot sign in since 10:00. The redirect address changed on Monday.', reporter: { id: id(300), name: 'Contoso Support' }, version: 1, createdAt: iso(-200),
  completedAt: null, loggedMinutes: 0, detail: { can: { edit: true } }, activity: [], channel: r._ch });
let moved = null, role = 'Owner';
const errors = [];

const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const handler = async (route) => {
  const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
  if (url.origin !== origin) { await route.abort(); return; }
  if (ep.endsWith('/avatar')) { await route.fulfill({ status: 404, body: '' }); return; }
  if (!ep.startsWith('/api/')) {
    const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
    await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
    return;
  }
  let data = [];
  if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
  else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, role, reportCount: role === 'Manager' ? 2 : 0,
    permissions: role === 'Owner' ? ['projects.view', 'tasks.view', 'work.view', 'work.create', 'org.manage', 'org.structure', 'members.invite', 'members.manage', 'audit.view', 'reports.view', 'vault.use', 'access.manage'] : ['projects.view', 'tasks.view', 'work.view'],
    modules: { projects: 3, tasks: 3, work: 3, activity: 3, documents: 3, people: 3, reports: 3, billing: 3, members: 3, audit: 3, organization: 3, teams: 3, insights: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: {} } };
  else if (ep === '/api/v1/workspace') data = { ...ws };
  else if (ep === '/api/v1/workspace/members') data = people.map((p) => ({ userId: p.userId, displayName: p.displayName, email: `${p.displayName.split(' ')[0].toLowerCase()}@example.test`, role: p.accessRole, reportsToUserId: p.managerId, jobRole: p.roleName }));
  else if (ep === '/api/v1/teams') data = [{ id: id(90), name: 'Platform', description: null, memberCount: 3, projectCount: 1, lead: null, parentTeamId: null }, { id: id(91), name: 'Design', description: null, memberCount: 2, projectCount: 0, lead: null, parentTeamId: null }];
  else if (ep === '/api/v1/org/tree') data = { people, teams: [{ id: id(90), name: 'Platform', parentTeamId: null, memberCount: 3 }, { id: id(91), name: 'Design', parentTeamId: null, memberCount: 2 }], canManage: role === 'Owner' };
  else if (ep === '/api/v1/org/move/preview' || ep === '/api/v1/org/move') {
    const b = req.postDataJSON(); if (ep.endsWith('/move')) moved = b;
    const p = people.find((x) => x.userId === b.id), to = people.find((x) => x.userId === b.newParentId);
    data = { kind: 'person', id: b.id, name: p.displayName, fromParentId: p.managerId, fromParentName: people.find((x) => x.userId === p.managerId)?.displayName ?? null, toParentId: b.newParentId, toParentName: to?.displayName ?? null, movesWith: 0, effects: [`${p.displayName} will report to ${to?.displayName}.`] };
  }
  else if (ep === '/api/v1/org') data = { roles: [], people: [], canManage: true };
  else if (ep === '/api/v1/work-items' && url.searchParams.get('status') === 'closed') data = { items: [], offset: 0, limit: 200, hasMore: false };
  else if (ep === '/api/v1/work-items') data = { items: tickets, offset: 0, limit: 200, hasMore: false };
  else if (ep.startsWith('/api/v1/work-items/')) { const t = tickets.find((r) => ep.endsWith(r.id)); data = t ? detail(t) : null; }
  else if (ep === '/api/v1/activity' || ep.endsWith('/insights/activity')) data = { items: [{ id: id(400), action: 'task.created', summary: 'added the release checklist', actor: { id: id(12), name: 'Cara Lund' }, createdAt: iso(-10) }], page: 1, totalPages: 1, totalItems: 1 };
  else if (ep.endsWith('/projects') || ep.endsWith('/tasks') || ep.endsWith('/work-tasks')) data = { items: [], page: 1, totalPages: 0, totalItems: 0 };
  else if (ep === '/api/v1/settings/health') data = { score: 90, checks: [] };
  else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
  else if (ep === '/api/v1/timer') data = null;
  else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
};
const screens = [['desk', '/desk', /tickets? need/], ['quality', '/quality', null], ['insights', '/insights', null], ['reports', '/insights?tab=reports', null], ['activity', '/activity', /happened today|Nothing new|Quiet/],
  ['library', '/library', null], ['vault', '/library/vault', null], ['people', '/people', /People\./], ['org-chart', '/people/org', /Org chart\./], ['teams', '/people/teams', /Teams\./], ['settings-owner', '/settings/profile', null]];
const open = async (theme, w, h) => {
  const c = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block', viewport: { width: w, height: h }, isMobile: w < 500, hasTouch: w < 500 });
  await c.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); localStorage.setItem('pm_home_mode', 'classic'); }, theme);
  await c.route('**/*', handler);
  const page = await c.newPage(); page.on('pageerror', (e) => errors.push(String(e)));
  return { c, page };
};
const go = async (page, url) => { await page.goto(`${origin}/preview-org${url}`); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(700); };
try {
  for (const [theme, w, h, suffix] of [['light', 1440, 900, '1440-light'], ['light', 1920, 1080, '1920-light'], ['dark', 1440, 900, '1440-dark'], ['light', 390, 844, '390-light'], ['dark', 390, 844, '390-dark']]) {
    const { c, page } = await open(theme, w, h);
    for (const [name, url, headline] of screens) {
      await go(page, url);
      if (headline) assert.match(await page.locator('.calm-hero-title').first().innerText(), headline, `${name}: calm headline`);
      if (w < 500) await fitsPhone(page, `${name} ${suffix}`, assert).catch((e) => { throw new Error(`${name} ${suffix}: ${e.message.split('\n').slice(0, 6).join(' ')}`); });
      const file = path.join(out, `${name}-${suffix}.png`); await page.screenshot({ path: file }); console.log(file);
    }
    await c.close();
  }

  // Org chart: change manager → impact sheet → confirm posts the move.
  { const { c, page } = await open('light', 1440, 900);
    await go(page, '/people/org');
    await page.getByRole('button', { name: /^Dev Mora/ }).click();
    await page.getByRole('button', { name: 'Change manager' }).click();
    await page.locator('.co-pick').getByRole('button', { name: /Cara Lund/ }).click();
    await page.getByTestId('org-impact').waitFor();
    await page.screenshot({ path: path.join(out, 'org-move-confirm-1440-light.png') });
    await page.getByRole('button', { name: /^Move Dev/ }).click();
    await page.waitForTimeout(300);
    assert.deepEqual(moved, { kind: 'person', id: id(13), newParentId: id(12) }, 'org move posted');
    await c.close(); }

  // Settings by role: a member sees Personal only (no Workspace, no Billing).
  { role = 'Member'; const { c, page } = await open('light', 1440, 900);
    await go(page, '/settings/profile');
    const nav = page.getByTestId('settings-nav');
    assert.equal(await nav.getByRole('group', { name: 'Workspace' }).count(), 0, 'member: no Workspace group');
    assert.equal(await nav.getByRole('link', { name: 'Billing' }).count(), 0, 'member: no Billing');
    await page.screenshot({ path: path.join(out, 'settings-member-1440-light.png') });
    await go(page, '/settings/billing');
    assert.match(page.url(), /\/settings\/profile/, 'member: billing redirects');
    role = 'Manager'; await go(page, '/settings/profile');
    assert.equal(await page.getByTestId('settings-nav').getByRole('group', { name: 'My teams' }).count(), 1, 'manager: My teams');
    await page.screenshot({ path: path.join(out, 'settings-manager-1440-light.png') });
    role = 'Owner'; await c.close(); }

  // Sign-in, signed out.
  for (const [w, h, suffix] of [[1440, 900, '1440-light'], [390, 844, '390-light']]) {
    const so = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', isMobile: w < 500 });
    await so.route('**/*', async (route) => { if (new URL(route.request().url()).pathname.startsWith('/api/')) { await route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }); return; } await handler(route); });
    const sp = await so.newPage(); await sp.goto(`${origin}/login`); await sp.waitForTimeout(1200);
    assert.match(await sp.locator('.auth-title').innerText(), /Welcome back\.\s*Sign in to ProjectTracker\./);
    if (w < 500) await fitsPhone(sp, 'sign-in', assert);
    await sp.screenshot({ path: path.join(out, `sign-in-${suffix}.png`) }); await so.close();
  }
  assert.deepEqual(errors, [], 'no page errors');
  console.log('calm-know UI checks passed');
} finally { await browser.close(); }
