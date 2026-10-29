import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// People & Roles scrolls: with 40 people the page (and its list) move with the mouse wheel and the keyboard, and the last person can be
// reached, on a laptop-height desktop window and on a phone; Organization, Roles & access, Invitations and Teams scroll too. A sheet that
// was opened and closed leaves no scroll lock behind. Built frontend with synthetic API fixtures only (fictional people).
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/people-scroll-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const user = { id: id(1), displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false, mfaEnabled: true };
const ws = { id: id(2), slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 40 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();
const teams = [
  { id: 't-eng', name: 'Engineering', description: null, memberCount: 20, projectCount: 4, lead: null, parentTeamId: null },
  { id: 't-pay', name: 'Payments', description: null, memberCount: 20, projectCount: 2, lead: null, parentTeamId: 't-eng' },
];
const roles = [
  { id: 'r-cto', name: 'CTO', description: 'Leads engineering.', color: '#0071E3', parentRoleId: null },
  { id: 'r-dev', name: 'Developer', description: null, color: '#1A7F37', parentRoleId: 'r-cto' },
];
const FIRST = ['Aarav', 'Diya', 'Ishaan', 'Kavya', 'Rohan', 'Meera', 'Vihaan', 'Anaya', 'Arjun', 'Saanvi'];
const LAST = ['Menon', 'Pillai', 'Reddy', 'Nair', 'Joshi', 'Bhat', 'Kapoor', 'Iyer'];
const M = (n, name, role, extra = {}) => ({ userId: id(n), displayName: name, email: `${name.split(' ')[0].toLowerCase()}${n}@example.test`, role, joinedAt: iso(400 - n), jobRole: 'Developer', hasAvatar: false, status: 'Active', isActive: true, orgRoleId: 'r-dev', reportsToUserId: id(1), teamIds: [n % 2 ? 't-pay' : 't-eng'], ...extra });
const members = [M(1, 'Asha Rao', 'Owner', { jobRole: 'CTO', orgRoleId: 'r-cto', reportsToUserId: null })];
const COUNT = Number(process.env.PEOPLE_N || 40);
for (let i = 1; i < COUNT; i++) members.push(M(100 + i, `${FIRST[i % 10]} ${LAST[i % 8]} ${String(i).padStart(2, '0')}`, 'Member'));
// Sorted by name the last row is "Vihaan ..." - keep it predictable: the name that sorts last.
const lastName = [...members].map((m) => m.displayName).sort((a, b) => a.localeCompare(b)).at(-1);
const findM = (uid) => members.find((m) => m.userId === uid);
const modules = [{ id: 'projects', label: 'Projects', description: 'Projects.', levels: [0, 1, 2, 3], hints: {}, grants: { 2: ['projects.edit'] } }];
const actions = [];
const roleAccess = roles.map((r) => ({ roleId: r.id, name: r.name, color: r.color, parentRoleId: r.parentRoleId, people: 1, hasProfile: true, modules: { projects: 2 }, actions: {}, suggested: null }));
const perms = ['org.manage', 'access.manage', 'permissions.manage', 'members.invite', 'members.manage', 'org.structure', 'teams.manage', 'audit.view', 'projects.view', 'tasks.view'];
const errors = [], writes = [];
const impactFor = () => ({ kind: 'x', people: [], affected: 0, warnings: [], blocked: false });
const profile = (uid) => {
  const m = findM(uid); if (!m) return null;
  return { userId: m.userId, displayName: m.displayName, email: m.email, hasAvatar: false, role: m.role, jobRole: m.jobRole, jobRoleColor: null,
    teams: m.teamIds.map((t) => ({ id: t, name: teams.find((x) => x.id === t).name, isLead: false })), reportsTo: null,
    joinedAt: m.joinedAt, open: 4, overdue: 1, doneLast30Days: 9, doneTotal: 120, isMe: uid === user.id, canMessage: uid !== user.id, theme: null,
    status: m.status, deactivatedAt: null, orgRoleId: m.orgRoleId, reportsToUserId: m.reportsToUserId, directReports: [] };
};

const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const checks = [];
try {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
  await ctx.addInitScript(() => { localStorage.setItem('pm_alerts_prompt', '1'); if (!localStorage.getItem('pm_theme')) localStorage.setItem('pm_theme', 'light'); localStorage.setItem('pm_home_mode', 'classic'); });
  await ctx.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
    if (url.origin !== origin) { await route.abort(); return; }
    if (ep.endsWith('/avatar')) { await route.fulfill({ status: 404, body: '' }); return; }
    if (!ep.startsWith('/api/')) {
      const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
      await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
      return;
    }
    let data = [];
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    let mm;
    if (ep === '/api/v1/workspace/people/impact' && method === 'POST') data = impactFor(body);
    else if ((mm = ep.match(/^\/api\/v1\/workspace\/members\/([^/]+)\/(suspend|reactivate)$/)) && method === 'POST') {
      writes.push({ ep, method }); const m = findM(mm[1]); m.status = mm[2] === 'suspend' ? 'Suspended' : 'Active'; m.isActive = m.status === 'Active'; data = { userId: m.userId, status: m.status };
    } else if ((mm = ep.match(/^\/api\/v1\/workspace\/members\/([^/]+)$/)) && method === 'PUT') { writes.push({ ep, method, body }); findM(mm[1]).role = body.role; data = findM(mm[1]); }
    else if ((mm = ep.match(/^\/api\/v1\/org\/members\/([^/]+)\/reports-to$/)) && method === 'PUT') { writes.push({ ep, method, body }); findM(mm[1]).reportsToUserId = body.reportsToUserId; data = null; }
    else if ((mm = ep.match(/^\/api\/v1\/org\/roles\/([^/]+)\/access$/)) && method === 'PUT') { writes.push({ ep, method, body }); data = { modules, actions, roles: roleAccess, canEdit: true, planAllows: true, isOrgAdmin: true, myLevels: {} }; }
    else if (ep === '/api/v1/me/ui/sidebar') data = { key: 'sidebar', value: null, updatedAt: null };
    else {
      assert.ok(method === 'GET' || ep.endsWith('/auth/refresh'), `Unexpected write: ${method} ${ep}`);
      if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
      else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: perms, modules: { projects: 3, tasks: 3, calendar: 1, work: 3, activity: 1, documents: 3, reports: 1, billing: 3, members: 3, audit: 1, organization: 1, teams: 2 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { MAX_MEMBERS: -1, ADVANCED_PERMISSIONS: 1 } } };
      else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
      else if (ep === '/api/v1/workspace/members') data = url.searchParams.get('assignable') ? members.filter((m) => m.isActive) : members;
      else if ((mm = ep.match(/^\/api\/v1\/workspace\/members\/([^/]+)\/profile$/))) data = profile(mm[1]);
      else if (ep === '/api/v1/workspace/invitations') data = [];
      else if (ep === '/api/v1/teams') data = teams;
      else if (ep === '/api/v1/org') data = { canManage: true, roles: roles.map((r) => ({ ...r, posX: null, posY: null, peopleCount: members.filter((m) => m.orgRoleId === r.id).length, childCount: 0, isDeleted: false, deletedAt: null, hasAccess: r.id !== 'r-qa' })), people: members.slice(0, 6).map((m) => ({ userId: m.userId, displayName: m.displayName, email: m.email, accessRole: m.role, roleId: m.orgRoleId, reportsToUserId: m.reportsToUserId })) };
      else if (ep === '/api/v1/org/access') data = { modules, actions, roles: roleAccess, canEdit: true, planAllows: true, isOrgAdmin: true, myLevels: {} };
      else if (ep === '/api/v1/org/access/effective') data = { people: members.slice(0, 6).map((m) => ({ userId: m.userId, name: m.displayName, email: m.email, accessLevel: m.role, jobRole: m.jobRole, source: m.role === 'Owner' ? 'Owner' : m.role === 'Admin' ? 'Admin' : m.orgRoleId ? 'JobRole' : 'AccessLevel', modules: { projects: 2, documents: 2, members: 1 }, permissions: ['docs.edit'], projectReach: 'everything', projects: 4, teams: [] })), byJobRole: 3, byAccessLevel: 1 };
      else if (ep === '/api/v1/workspace/permissions') data = { roles: ['Owner', 'Admin', 'Manager', 'Member', 'Guest'], permissions: ['projects.create', 'tasks.delete'], locked: [], matrix: { Owner: { 'projects.create': true, 'tasks.delete': true }, Admin: { 'projects.create': true, 'tasks.delete': true }, Manager: { 'projects.create': true }, Member: {}, Guest: {} }, canEdit: true };
      else if (ep === '/api/v1/settings/changes') data = { items: [], canUndo: true };
      else if (ep === '/api/v1/workspace/security') data = { requireMfa: false, ipAllowlistEnabled: false, ipRanges: [], minPasswordLength: 10, sessionHours: 12, allowedSignIn: ['password'], entitled: true, canEdit: true };
      else if (ep === '/api/v1/workspace/security/members') data = { members: 6, withoutTwoStep: 1, weakPasswords: 0, oldPasswords: 0, people: [] };
      else if (ep === '/api/v1/notifications/counts') data = { unread: 0, needsYou: 0, forInfo: 0, snoozed: 0 };
      else if (ep === '/api/v1/notifications') data = { items: [], page: 1, pageSize: 20, totalPages: 0, totalItems: 0 };
      else if (ep.endsWith('/projects') || ep.endsWith('/tasks') || ep.endsWith('/work-tasks')) data = { items: [], page: 1, totalPages: 0, totalItems: 0 };
      else if (ep === '/api/v1/timer') data = null;
      else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
      else if (ep.endsWith('/ai/status')) data = { enabled: true, configured: true, entitled: true, allowedHere: true };
      else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
      else if (ep === '/api/v1/chat/projects/unread') data = [];
      else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  const P = (p) => `${origin}/preview-org${p}`;
  const shot = async (page, name) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(300); await page.screenshot({ path: path.join(out, name), fullPage: false }); };
  /** Every element that scrolls vertically right now, with its scrollTop (the page's own scroller included). */
  const scrollers = (page) => page.evaluate(() => {
    const list = [document.scrollingElement, ...document.querySelectorAll('body *')].filter((el) => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      return el.scrollHeight > el.clientHeight + 2 && (el === document.scrollingElement || cs.overflowY === 'auto' || cs.overflowY === 'scroll');
    });
    return list.map((el) => ({ sel: el === document.scrollingElement ? 'document' : `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).join('.')}`, top: Math.round(el.scrollTop), h: el.clientHeight, sh: el.scrollHeight }));
  });
  const total = async (page) => (await scrollers(page)).reduce((n, s) => n + s.top, 0);
  const lastVisible = (page, name) => page.evaluate((n) => {
    const row = [...document.querySelectorAll('[data-testid="person-row"]')].find((r) => r.textContent.includes(n));
    if (!row) return false;
    const r = row.getBoundingClientRect();
    // On screen and not under the floating Aura bar / bottom bar.
    const hit = document.elementFromPoint(Math.min(innerWidth - 2, r.left + 40), Math.min(innerHeight - 2, r.top + r.height / 2));
    const ok = r.top >= 0 && r.bottom <= innerHeight + 1 && !!hit && row.contains(hit);
    if (!ok && window.__probe) console.log('hidden', n, Math.round(r.top), Math.round(r.bottom), innerHeight, hit ? `${hit.tagName}.${hit.className}` : null);
    return ok;
  }, name);
  const bodyLock = (page) => page.evaluate(() => ({ body: getComputedStyle(document.body).overflow, html: getComputedStyle(document.documentElement).overflow }));

  const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  if (process.env.PROBE) { page.on('console', (m) => console.log('page:', m.text())); await page.addInitScript(() => { window.__probe = true; }); }
  for (const [w, h, tag] of (process.env.ONLY ? [[1355, 600, '1355x600']] : [[1440, 900, '1440'], [1355, 600, '1355x600'], [390, 844, '390']])) {
    await page.setViewportSize({ width: w, height: h });
    if (process.env.PROBE) console.log('size', tag);
    await page.goto(P('/people'));
    await page.getByTestId('people-list').waitFor();
    await page.getByTestId('person-row').first().waitFor();
    assert.equal(await page.getByTestId('people-count').innerText(), `${COUNT} people`);
    if (process.env.PROBE) console.log(tag, JSON.stringify(await scrollers(page)), JSON.stringify(await bodyLock(page)));
    const before = await total(page);
    // Mouse wheel over the list, then over the page header.
    // A few separate flicks, each starting over the list where it is now (as a person keeps scrolling).
    for (let round = 0; round < 4; round++) {
      const box = await page.getByTestId('people-list').boundingBox();
      const y = Math.max(box.y + 20, Math.min(box.y + box.height / 2, h - 140));
      await page.mouse.move(box.x + Math.min(box.width / 2, 200), y);
      for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 400); await page.waitForTimeout(30); }
      await page.waitForTimeout(450);
    }
    const afterWheel = await total(page);
    if (process.env.PROBE) console.log(tag, 'after wheel', JSON.stringify(await scrollers(page)));
    if (COUNT >= 20 || h < 700) assert.ok(afterWheel > before, `${tag}: the wheel scrolls People (${before} -> ${afterWheel})`);
    assert.ok(await lastVisible(page, lastName), `${tag}: the last person (${lastName}) can be reached with the wheel`);
    await shot(page, `people-bottom-${tag}.png`);
    // Back up with the wheel.
    await page.mouse.wheel(0, -20000); await page.waitForTimeout(300);
    if (afterWheel > 0) assert.ok(await total(page) < afterWheel, `${tag}: the wheel scrolls back up`);
    // The keyboard: focus a row, End / PageDown move the view.
    await page.getByTestId('person-row').first().focus();
    const k0 = await total(page), seen0 = await lastVisible(page, lastName);
    for (let i = 0; i < 6; i++) await page.keyboard.press('PageDown');
    await page.keyboard.press('End');
    await page.waitForTimeout(300);
    if (!seen0) assert.ok(await total(page) > k0, `${tag}: PageDown / End scroll People`);
    assert.ok(await lastVisible(page, lastName), `${tag}: the last person (${lastName}) can be reached with the keyboard`);
    assert.match(await page.evaluate(() => document.activeElement?.textContent ?? ''), new RegExp(lastName), `${tag}: End moves focus to the last person`);
    await page.keyboard.press('Home'); await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => document.querySelector('[data-testid="people-list"]').scrollTop), 0, `${tag}: Home goes back to the first person`);
    if (w <= 430) await fitsPhone(page, `${tag} people`, assert);
    else await shot(page, `people-top-${tag}.png`);
    checks.push(`people-scroll-${tag}`);

    // A profile sheet opened and closed leaves no scroll lock behind.
    await page.getByTestId('person-row').nth(3).click();
    await page.waitForTimeout(400);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    if (!/\/people(\?|$)/.test(new URL(page.url()).pathname)) { await page.goBack(); await page.getByTestId('people-list').waitFor(); }
    const lock = await bodyLock(page);
    assert.notEqual(lock.body, 'hidden', `${tag}: no scroll lock left on body after a sheet closed`);
    await page.evaluate(() => { window.scrollTo(0, 0); const l = document.querySelector('[data-testid="people-list"]'); if (l) l.scrollTop = 0; });
    await page.waitForTimeout(150);
    const s0 = await total(page);
    await page.mouse.move(Math.min(w / 2, 700), h - 200);
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 400); await page.waitForTimeout(40); }
    await page.waitForTimeout(200);
    if ((await scrollers(page)).length) assert.ok(await total(page) > s0, `${tag}: still scrolls after a sheet closed`);
    checks.push(`no-lock-${tag}`);

    // The other People & Roles views scroll when they are taller than the window.
    for (const tab of ['/people/org', '/people/roles', '/people/invitations', '/people/teams']) {
      await page.goto(P(tab)); await page.waitForTimeout(900);
      const s = await scrollers(page);
      const can = s.filter((x) => x.sh > x.h + 2);
      if (!can.length) continue;   // fits the window: nothing to scroll
      await page.mouse.move(Math.min(w / 2, 700), Math.round(h * 0.6));
      const t0 = await total(page);
      for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 400); await page.waitForTimeout(40); }
      await page.waitForTimeout(250);
      assert.ok(await total(page) > t0, `${tag}: ${tab} scrolls (${JSON.stringify(s)})`);
      checks.push(`${tab}-${tag}`);
    }
  }
  assert.deepEqual(errors, [], 'no page errors');
  console.log(`People scroll: ${checks.length} checks passed - ${checks.join(', ')}`);
} finally { await browser.close(); }
