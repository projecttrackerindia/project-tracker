import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// People & Roles: the directory (search, filters, sort, a virtual list of 1,200 people), a profile with its actions (change access level,
// suspend) each behind an impact preview and a confirmation, the organization tree (keyboard, search that opens the path, vacant job roles,
// people in several teams, the Teams view), Roles & access (unused and high-privilege badges, editing a job role with an impact preview),
// the old addresses that now land here, a phone and dark mode. Built frontend with synthetic API fixtures only.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/people-roles-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const user = { id: id(1), displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false, mfaEnabled: true };
const ws = { id: id(2), slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 1206 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();
const teams = [
  { id: 't-eng', name: 'Engineering', description: null, memberCount: 3, projectCount: 4, lead: null, parentTeamId: null },
  { id: 't-pay', name: 'Payments', description: null, memberCount: 2, projectCount: 2, lead: null, parentTeamId: 't-eng' },
  { id: 't-plat', name: 'Platform', description: null, memberCount: 2, projectCount: 2, lead: null, parentTeamId: 't-eng' },
];
const roles = [
  { id: 'r-cto', name: 'CTO', description: 'Leads engineering.', color: '#0071E3', parentRoleId: null },
  { id: 'r-eng', name: 'Engineering manager', description: null, color: '#5E5CE6', parentRoleId: 'r-cto' },
  { id: 'r-dev', name: 'Developer', description: null, color: '#1A7F37', parentRoleId: 'r-eng' },
  { id: 'r-qa', name: 'QA lead', description: 'Owns test plans.', color: '#FF9500', parentRoleId: 'r-eng' },   // vacant
];
const M = (n, name, role, extra = {}) => ({ userId: id(n), displayName: name, email: `${name.split(' ')[0].toLowerCase()}${n}@example.test`, role, joinedAt: iso(400 - n % 300), jobRole: null, hasAvatar: false, status: 'Active', isActive: true, orgRoleId: null, reportsToUserId: null, teamIds: [], ...extra });
let members = [
  M(1, 'Asha Rao', 'Owner', { jobRole: 'CTO', orgRoleId: 'r-cto', teamIds: ['t-eng'] }),
  M(10, 'Ravi Kumar', 'Admin', { reportsToUserId: id(1), teamIds: ['t-eng'] }),
  M(11, 'Meena Iyer', 'Manager', { jobRole: 'Engineering manager', orgRoleId: 'r-eng', reportsToUserId: id(1), teamIds: ['t-eng'] }),
  M(12, 'Anita Das', 'Member', { jobRole: 'Developer', orgRoleId: 'r-dev', reportsToUserId: id(11), teamIds: ['t-pay', 't-plat'] }),
  M(13, 'Kiran Shah', 'Member', { jobRole: 'Developer', orgRoleId: 'r-dev', reportsToUserId: id(11), teamIds: ['t-pay'], status: 'Suspended', isActive: false }),
  M(14, 'External Auditor', 'Guest'),
];
for (let i = 0; i < 1200; i++) members.push(M(1000 + i, `Person ${String(i).padStart(4, '0')}`, i % 9 === 0 ? 'Manager' : 'Member', { reportsToUserId: id(11), teamIds: i % 2 ? ['t-plat'] : [] }));
const findM = (uid) => members.find((m) => m.userId === uid);
const modules = [
  { id: 'projects', label: 'Projects', description: 'Projects.', levels: [0, 1, 2, 3], hints: {}, grants: { 2: ['projects.edit'], 3: ['projects.edit', 'projects.delete'] } },
  { id: 'documents', label: 'Documents', description: 'Docs.', levels: [0, 1, 2, 3], hints: {}, grants: { 2: ['docs.edit'] } },
  { id: 'members', label: 'Members', description: 'People.', levels: [0, 1, 2, 3], hints: {}, grants: { 3: ['members.manage'] } },
];
const actions = [{ key: 'tasks.delete', label: 'Delete tasks', description: 'Remove tasks.', delegable: false }, { key: 'access.manage', label: 'Manage job-role access', description: 'Edit access.', delegable: true }];
const roleAccess = [
  { roleId: 'r-cto', name: 'CTO', color: '#0071E3', parentRoleId: null, people: 1, hasProfile: true, modules: { projects: 3, documents: 3, members: 3 }, actions: { 'access.manage': true }, suggested: null },
  { roleId: 'r-eng', name: 'Engineering manager', color: '#5E5CE6', parentRoleId: 'r-cto', people: 1, hasProfile: true, modules: { projects: 3, documents: 2, members: 1 }, actions: {}, suggested: null },
  { roleId: 'r-dev', name: 'Developer', color: '#1A7F37', parentRoleId: 'r-eng', people: 2, hasProfile: true, modules: { projects: 2, documents: 2, members: 1 }, actions: {}, suggested: null },
  { roleId: 'r-qa', name: 'QA lead', color: '#FF9500', parentRoleId: 'r-eng', people: 0, hasProfile: false, modules: { projects: 1, documents: 1, members: 1 }, actions: {}, suggested: null },
];
const perms = ['org.manage', 'access.manage', 'permissions.manage', 'members.invite', 'members.manage', 'org.structure', 'teams.manage', 'audit.view', 'projects.view', 'tasks.view'];
const writes = [], errors = [], impacts = [], checks = []; const _push = checks.push.bind(checks); checks.push = (...a) => { if (process.env.STEP_LOG) console.log('step', ...a); return _push(...a); };
const impactFor = (b) => {
  impacts.push(b);
  const who = findM(b.userId)?.displayName ?? 'Anita Das';
  if (b.kind === 'suspend' || b.kind === 'remove') return { kind: b.kind, people: [{ userId: b.userId, name: who, modules: [], gained: [], lost: [], losesWorkspace: true }], affected: 1, warnings: ['They are signed out of this workspace. Their history, assignments and reporting lines stay.'], blocked: false };
  if (b.kind === 'accessLevel') return { kind: b.kind, people: [{ userId: b.userId, name: who, modules: [{ module: 'documents', label: 'Documents', from: 2, to: 1 }], gained: [], lost: ['docs.edit'], losesWorkspace: false }], affected: 1, warnings: [], blocked: false };
  if (b.kind === 'roleAccess') return { kind: b.kind, people: [{ userId: id(12), name: 'Anita Das', modules: [{ module: 'documents', label: 'Documents', from: 2, to: 0 }], gained: [], lost: ['docs.edit'], losesWorkspace: false }], affected: 1, warnings: [], blocked: false };
  return { kind: b.kind, people: [], affected: 0, warnings: [], blocked: false };
};
const profile = (uid) => {
  const m = findM(uid); if (!m) return null;
  const boss = m.reportsToUserId ? findM(m.reportsToUserId) : null;
  return { userId: m.userId, displayName: m.displayName, email: m.email, hasAvatar: false, role: m.role, jobRole: m.jobRole, jobRoleColor: null,
    teams: m.teamIds.map((t) => ({ id: t, name: teams.find((x) => x.id === t).name, isLead: false })), reportsTo: boss ? { id: boss.userId, name: boss.displayName } : null,
    joinedAt: m.joinedAt, open: 4, overdue: 1, doneLast30Days: 9, doneTotal: 120, isMe: uid === user.id, canMessage: uid !== user.id && m.status === 'Active', theme: null,
    status: m.status, deactivatedAt: m.status === 'Suspended' ? iso(3) : null, orgRoleId: m.orgRoleId, reportsToUserId: m.reportsToUserId,
    directReports: members.filter((x) => x.reportsToUserId === uid).slice(0, 5).map((x) => ({ id: x.userId, name: x.displayName })) };
};

const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
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
  const shot = async (page, name) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(350); await page.screenshot({ path: path.join(out, name), fullPage: false }); };
  const waitWrite = async (test) => { for (let i = 0; i < 50 && !writes.some(test); i++) await new Promise((r) => setTimeout(r, 100)); return writes.find(test); };
  const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message)); await page.setViewportSize({ width: 1440, height: 960 });
  const P = (p) => `${origin}/preview-org${p}`;

  // ---------------------------------------------------------------- directory
  await page.goto(P('/people'));
  await page.getByTestId('people-list').waitFor();
  assert.match(await page.locator('h1, .page-head h2').first().innerText(), /People & Roles/);
  assert.equal(await page.getByTestId('people-count').innerText(), '1206 people');
  const drawn = await page.getByTestId('person-row').count();
  assert.ok(drawn > 5 && drawn < 80, `virtual list draws only what is in view (${drawn})`);
  await page.getByTestId('people-list').evaluate((el) => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
  await page.getByText('Person 1199').waitFor();
  checks.push('virtual-1200');
  await shot(page, 'directory-1440.png');
  await page.getByTestId('people-search').fill('anita');
  await page.waitForFunction(() => document.querySelector('[data-testid="people-count"]')?.textContent === '1 of 1206');
  await page.getByTestId('people-search').fill('');
  await page.getByRole('combobox', { name: 'Status' }).click(); await page.getByRole('option', { name: /Suspended/ }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="people-count"]')?.textContent === '1 of 1206');
  await page.getByTestId('badge-suspended').first().waitFor({ timeout: 5000 }).catch(async (e) => { await page.screenshot({ path: path.join(out, 'debug.png') }); throw e; });
  await page.waitForURL(/status=suspended/);
  await page.goto(P('/people?team=t-pay&level=Member'));
  await page.waitForFunction(() => document.querySelector('[data-testid="people-count"]')?.textContent === '2 of 1206');
  await page.goto(P(`/people?manager=${id(11)}&sort=level`));
  await page.waitForFunction(() => document.querySelector('[data-testid="people-count"]')?.textContent === '1202 of 1206');
  checks.push('directory-search', 'directory-filters', 'directory-sort');

  // ---------------------------------------------------------------- profile + actions
  await page.goto(P('/people?q=Anita'));
  await page.getByTestId('person-row').first().click();
  await page.waitForURL(new RegExp(`/people/${id(12)}$`));
  await page.getByTestId('person-hero').waitFor();
  assert.match(await page.getByTestId('person-page').innerText(), /Anita Das[\s\S]*Developer[\s\S]*Engineering/);
  assert.ok(await page.getByTestId('manager-link').isVisible());
  assert.ok(await page.getByTestId('effective-summary').isVisible());
  await shot(page, 'profile-1440.png');
  await page.getByTestId('change-level').click();
  await page.getByRole('radio', { name: /Guest/ }).check();
  await page.getByTestId('impact-preview').getByText('They will lose Edit on Documents (keeps View).').waitFor();
  assert.ok(impacts.some((b) => b.kind === 'accessLevel' && b.role === 'Guest' && b.userId === id(12)));
  await shot(page, 'profile-impact-1440.png');
  await page.getByTestId('impact-confirm').click();
  assert.ok(await waitWrite((w) => w.method === 'PUT' && w.ep.endsWith(`/workspace/members/${id(12)}`) && w.body.role === 'Guest'));
  await page.getByTestId('suspend').click();
  await page.getByText('They will lose access to this workspace.').waitFor();
  assert.equal(writes.filter((w) => w.ep.endsWith('/suspend')).length, 0, 'nothing happens before confirming');
  await page.getByTestId('impact-confirm').click();
  assert.ok(await waitWrite((w) => w.ep.endsWith(`/members/${id(12)}/suspend`)));
  await page.getByTestId('reactivate').waitFor();
  assert.match(await page.getByTestId('profile-status').innerText(), /Suspended/);
  checks.push('profile', 'impact-preview', 'confirm-level', 'confirm-suspend');
  // reset Anita for later checks
  findM(id(12)).status = 'Active'; findM(id(12)).isActive = true; findM(id(12)).role = 'Member';

  // ---------------------------------------------------------------- organization tree
  await page.goto(P('/people/org'));
  const tree = page.getByRole('tree', { name: 'Reporting lines' }); await tree.waitFor();
  const first = tree.getByRole('treeitem').first();
  assert.match(await first.innerText(), /Asha Rao/);
  assert.equal(await first.getAttribute('aria-expanded'), 'true');
  await first.focus();
  await page.keyboard.press('ArrowDown');
  const focused = async () => { await page.waitForTimeout(120); return page.evaluate(() => document.activeElement?.getAttribute('data-key')); };
  assert.ok((await focused())?.startsWith('p:'));
  // Meena is the second child (alphabetical: Meena, Ravi); open her with ArrowRight and step into her reports.
  await page.keyboard.press('ArrowRight');
  const meena = tree.locator(`[data-key="p:${id(11)}"]`);
  assert.equal(await meena.getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('ArrowRight');
  assert.equal(await focused(), `p:${id(12)}`, 'ArrowRight on an open node goes to its first child');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await focused(), `p:${id(11)}`, 'ArrowLeft goes back to the parent');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await meena.getAttribute('aria-expanded'), 'false');
  checks.push('tree-keyboard');
  // Search jumps to a match and opens the path to it.
  await page.getByTestId('tree-search').fill('Kiran');
  const kiran = tree.locator(`[data-key="p:${id(13)}"]`); await kiran.waitFor();
  assert.equal(await meena.getAttribute('aria-expanded'), 'true');
  assert.match(await kiran.getAttribute('class'), /focus/);
  assert.match(await kiran.innerText(), /Suspended/);
  await page.getByTestId('tree-search').fill('');
  checks.push('tree-search');
  // A vacant job role under the person holding its parent role; people in several teams show each team.
  await page.getByTestId('tree-search').fill('QA lead');   // under Meena, after her 1,200 reports: search scrolls it into view
  const vacant = tree.locator('[data-key="v:r-qa"]'); await vacant.waitFor();
  assert.equal(await vacant.getAttribute('aria-level'), '3', 'vacant QA lead hangs under the Engineering manager (Meena)');
  await page.getByTestId('tree-search').fill('');
  assert.match(await vacant.innerText(), /Vacant · QA lead/);
  await page.getByTestId('tree-search').fill('Anita');
  await tree.locator(`[data-key="p:${id(12)}"]`).waitFor();
  assert.equal(await tree.locator(`[data-key="p:${id(12)}"] [data-testid="team-chips"] .pr-chip`).count(), 2);
  assert.match(await tree.locator(`[data-key="p:${id(12)}"] [data-testid="team-chips"]`).innerText(), /Payments[\s\S]*Platform/);
  await page.getByTestId('tree-search').fill('');
  await tree.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
  assert.match(await first.innerText(), /Owner/);
  await shot(page, 'org-tree-1440.png');
  checks.push('tree-vacant', 'tree-multi-team', 'tree-badges');
  // 1,200 people under Meena: still only rows in view are drawn.
  assert.ok(await tree.getByRole('treeitem').count() < 90);
  // Teams view.
  await page.getByRole('tab', { name: 'Teams' }).or(page.getByRole('button', { name: 'Teams', exact: true })).first().click();
  const teamsTree = page.getByRole('tree', { name: 'Teams and departments' }); await teamsTree.waitFor();
  assert.match(await teamsTree.innerText(), /Engineering[\s\S]*Payments|Engineering[\s\S]*Platform/);
  await teamsTree.locator('[data-key="t:t-pay"]').waitFor();
  assert.ok(page.url().includes('view=teams'));
  await shot(page, 'org-teams-1440.png');
  assert.ok(await page.getByRole('tab', { name: 'Canvas' }).or(page.getByRole('button', { name: 'Canvas', exact: true })).first().isVisible());
  checks.push('tree-teams-view', 'canvas-available');

  // Drag a person onto someone else: a confirmation, then the change.
  await page.goto(P('/people/org'));
  await tree.waitFor();
  await tree.locator(`[data-key="p:${id(10)}"]`).dragTo(tree.locator(`[data-key="p:${id(11)}"]`));
  await page.getByTestId('drag-impact').waitFor();
  assert.match(await page.getByTestId('drag-impact').innerText(), /Ravi Kumar will report to Meena Iyer instead of Asha Rao/);
  await page.getByTestId('impact-confirm').click();
  assert.ok(await waitWrite((w) => w.ep.endsWith(`/org/members/${id(10)}/reports-to`) && w.body.reportsToUserId === id(11)));
  checks.push('tree-drag-confirm');

  // ---------------------------------------------------------------- roles & access
  await page.goto(P('/people/roles'));
  await page.getByTestId('role-row-job').first().waitFor();
  assert.equal(await page.getByTestId('role-row-level').count(), 5);
  const qa = page.getByTestId('role-row-job').filter({ hasText: 'QA lead' });
  assert.ok(await qa.getByTestId('badge-unused').isVisible());
  assert.ok(await page.getByTestId('role-row-job').filter({ hasText: 'CTO' }).getByTestId('badge-high').isVisible());
  await page.getByTestId('roles-search').fill('dev');
  assert.equal(await page.getByTestId('role-row-job').count(), 1);
  await page.getByTestId('roles-search').fill('');
  await page.getByTestId('role-row-job').filter({ hasText: 'Developer' }).click();
  await page.waitForURL(/\/people\/roles\/job\/r-dev$/);
  await page.getByTestId('role-detail').waitFor();
  await shot(page, 'roles-1440.png');
  await page.getByRole('group', { name: 'Documents level' }).or(page.getByRole('tablist', { name: 'Documents level' })).first().getByText('None', { exact: true }).click();
  await page.getByTestId('review-changes').click();
  await page.getByText('They will lose Edit on Documents.').waitFor();
  assert.ok(impacts.some((b) => b.kind === 'roleAccess' && b.roleId === 'r-dev' && b.modules.documents === 0));
  await shot(page, 'roles-impact-1440.png');
  await page.getByTestId('impact-confirm').click();
  assert.ok(await waitWrite((w) => w.ep.endsWith('/org/roles/r-dev/access') && w.body.modules.documents === 0));
  await page.getByRole('tab', { name: /Members/ }).or(page.getByRole('button', { name: /Members/ })).first().click();
  assert.match(await page.getByTestId('role-members').innerText(), /Anita Das[\s\S]*Kiran Shah/);
  await page.getByRole('tab', { name: 'Effective access' }).or(page.getByRole('button', { name: 'Effective access', exact: true })).first().click();
  await page.getByPlaceholder('Find a person or job role…').fill('Meena');
  await page.getByText('Meena Iyer').first().waitFor();
  checks.push('roles-list', 'roles-badges', 'roles-detail', 'roles-impact', 'effective-access');

  // ---------------------------------------------------------------- old addresses
  for (const [from, to] of [['/settings/security/access', /\/people\/roles$/], ['/settings/access?view=people', /\/people\/roles\?tab=effective$/], ['/people/org-chart', /\/people\/org\?view=canvas$/], ['/organization', /\/people\/org\?view=canvas$/]]) {
    await page.goto(P(from)); await page.waitForURL(to);
  }
  await page.goto(P('/settings/security')); await page.getByTestId('roles-moved').waitFor();
  assert.match(await page.getByTestId('roles-moved').innerText(), /Roles & access moved to People & Roles/);
  checks.push('redirects', 'moved-card');

  // ---------------------------------------------------------------- dark
  await page.evaluate(() => localStorage.setItem('pm_theme', 'dark'));
  for (const [p, n, t] of [['/people', 'directory', 'people-list'], [`/people/${id(12)}`, 'profile', 'person-hero'], ['/people/org', 'org-tree', 'org-tree'], ['/people/roles/job/r-dev', 'roles', 'role-detail']]) {
    await page.goto(P(p)); await page.getByTestId(t).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark');
    await shot(page, `${n}-dark-1440.png`);
  }
  checks.push('dark');

  // ---------------------------------------------------------------- phone
  await page.evaluate(() => localStorage.setItem('pm_theme', 'light'));
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [p, n, t] of [['/people', 'directory', 'people-list'], [`/people/${id(12)}`, 'profile', 'person-hero'], ['/people/org', 'org-tree', 'org-tree'], ['/people/roles', 'roles-list', 'role-row-job'], ['/people/roles/job/r-dev', 'roles', 'role-detail']]) {
    await page.goto(P(p)); await page.getByTestId(t).first().waitFor(); await page.waitForTimeout(300);
    await fitsPhone(page, n, assert); await shot(page, `${n}-390.png`);
  }
  // A dialog on a phone is a bottom sheet.
  await page.goto(P(`/people/${id(12)}`)); await page.getByTestId('suspend').click();
  await page.getByTestId('impact-preview').getByText('They will lose access to this workspace.').waitFor();
  const sheet = await page.locator('.modal').boundingBox();
  assert.ok(sheet && Math.round(sheet.y + sheet.height) >= 840, 'dialog sits at the bottom of the phone screen');
  await fitsPhone(page, 'suspend sheet', assert); await shot(page, 'profile-sheet-390.png');
  checks.push('phone');

  assert.deepEqual(errors, []);
  console.log('people & roles ui ok:', checks.join(', '));
} finally { await browser.close(); }
