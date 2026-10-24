import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { cutOff } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Every settings-style page in the design-system language: Workspace settings (each section), My account (each tab), People, Teams,
// the org chart, the Notification Center (each tab), Billing and the legal pages. Each is opened at 1440 in light and dark and at 390,
// must render without a page error, must not run past a phone's edge, and is captured for review. Synthetic API fixtures only.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/settings-tour');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false, mfaEnabled: true };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 4, timeZone: null };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const perms = ['org.manage', 'access.manage', 'permissions.manage', 'members.invite', 'members.manage', 'audit.view', 'projectgroups.manage', 'workflow.manage', 'labels.manage', 'work.types.manage', 'projects.view', 'tasks.view', 'reports.view'];
const members = [
  { userId: user.id, displayName: 'Asha Rao', email: 'asha@example.test', role: 'Owner', jobTitle: 'Head of delivery', status: 'Active', joinedAt: ago(90000), lastActiveAt: ago(2) },
  { userId: 'u2', displayName: 'Ravi Kumar', email: 'ravi@example.test', role: 'Admin', jobTitle: 'Platform lead', status: 'Active', joinedAt: ago(80000), lastActiveAt: ago(12) },
  { userId: 'u3', displayName: 'Kiran Das', email: 'kiran@example.test', role: 'Member', jobTitle: 'Developer', status: 'Active', joinedAt: ago(70000), lastActiveAt: ago(60) },
  { userId: 'u4', displayName: 'Meena Iyer', email: 'meena@example.test', role: 'Guest', jobTitle: 'Auditor', status: 'Active', joinedAt: ago(60000), lastActiveAt: ago(2880) },
];
const notes = [
  { id: 'n1', type: 'TaskAssigned', title: 'You were assigned "Fix portal login"', body: 'Payments Core · due Friday', link: '/tasks/t1', isRead: false, needsYou: true, createdAt: ago(5), shownAt: ago(5) },
  { id: 'n2', type: 'Mention', title: 'Ravi mentioned you on "Release notes"', body: '"Can you check the wording before Friday?"', link: '/tasks/t2', isRead: false, needsYou: true, createdAt: ago(42), shownAt: ago(42) },
  { id: 'n3', type: 'Approval', title: 'Approve leave for Meena', body: '2 days next week', link: '/approve/a1', isRead: true, needsYou: true, createdAt: ago(1500), shownAt: ago(1500) },
];
const prefs = [
  { type: 'TaskAssigned', label: 'Task assigned to me', description: 'Someone assigns a task to you.', inApp: true, email: true, browser: true, locked: false },
  { type: 'Mention', label: 'Mentions', description: 'Someone mentions you with @.', inApp: true, email: true, browser: true, locked: false },
  { type: 'DueSoon', label: 'Due soon', description: 'Work assigned to you is due soon.', inApp: true, email: false, browser: true, locked: false },
  { type: 'Security', label: 'Security alerts', description: 'Always on.', inApp: true, email: true, browser: false, locked: true },
];
const reminderSettings = { workDays: [1, 2, 3, 4, 5], workStart: '09:00', workEnd: '18:00', defaultTime: '09:00', quietStart: '21:00', quietEnd: '08:00', briefingEnabled: true, briefingTime: '08:30', digestTime: null, autoEnabled: true, dueLeads: [1, 0], overdueSteps: [1, 3], dailyAutoLimit: 8, muteNudges: false, followDeviceTimeZone: false };

const ROUTES = [
  ['settings', '/settings'], ['general', '/settings/general'], ['project-groups', '/settings/project-groups'], ['timeline-templates', '/settings/timeline-templates'],
  ['labels', '/settings/labels'], ['priorities', '/settings/priorities'], ['custom-fields', '/settings/custom-fields'], ['work-types', '/settings/work-types'],
  ['automation', '/settings/automation'], ['access', '/settings/access'], ['visibility', '/settings/visibility'], ['security', '/settings/security'], ['sso', '/settings/sso'],
  // (the audit log, the assistant settings, the profile, connected accounts and /connect have checks of their own with richer fixtures)
  ['data', '/settings/data'], ['notification-defaults', '/settings/notifications'], ['escalation', '/settings/reminders'],
  ['slack', '/settings/slack'], ['whatsapp', '/settings/whatsapp'], ['email', '/settings/email'], ['git', '/settings/git'], ['webhooks', '/settings/webhooks'],
  ['api-keys', '/settings/api-keys'], ['connected-apps', '/settings/connected-apps'], ['billing', '/settings/billing'],
  ['account-security', '/account/security'], ['account-mobile', '/account/mobile'],
  ['people', '/people'], ['people-invitations', '/people/invitations'], ['teams', '/people/teams'], ['org-chart', '/people/org-chart'],
  ['notifications', '/notifications'], ['notification-delivery', '/notifications/preferences'], ['notification-device', '/notifications/devices'], ['notification-schedule', '/notifications/schedule'],
];
const only = process.env.TOUR_ONLY ? process.env.TOUR_ONLY.split(',') : null;
const errors = [], problems = [], shots = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
try {
  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
    await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); localStorage.setItem('pm_home_mode', 'classic'); }, theme);
    await ctx.route('**/*', async (route) => {
      const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
      if (url.origin !== origin) { await route.abort(); return; }
      if (ep.endsWith('/avatar') || ep.endsWith('/logo/file')) { await route.fulfill({ status: 404, body: '' }); return; }
      if (!ep.startsWith('/api/')) {
        const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
        await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
        return;
      }
      let data = [];
      if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
      else if (method !== 'GET') data = null;
      else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: perms, modules: { projects: 3, tasks: 3, work: 3, ai: 3, activity: 3, documents: 3, members: 3, organization: 3, teams: 3, audit: 3, reports: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3 } } };
      else if (ep === '/api/v1/me/ui/sidebar') data = { key: 'sidebar', value: null, updatedAt: null };
      else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false, description: 'Delivery and payments platform team.' };
      else if (ep === '/api/v1/workspace/members') data = members;
      else if (ep === '/api/v1/settings/health') data = { score: 75, done: 6, total: 8, open: 2, checks: [{ id: 'two-step', title: 'Two-step sign-in is not required', detail: '2 of 4 members sign in with a password alone.', severity: 'high', ok: false, dismissed: false, dismissReason: null, fix: { label: 'Require two-step', to: '/settings/security' }, action: null, actionLabel: null, canDismiss: true }, { id: 'audit-chain', title: 'The audit trail is intact', detail: 'Checked every night.', severity: 'high', ok: true, dismissed: false, dismissReason: null, fix: null, action: null, actionLabel: null, canDismiss: false }] };
      else if (ep === '/api/v1/settings/changes' || ep === '/api/v1/settings/changes/recent') data = { items: [], canUndo: true };
      else if (ep === '/api/v1/workspace/security') data = { requireMfa: false, ipAllowlistEnabled: false, ipRanges: [], myIp: '203.0.113.9', entitled: true, minPasswordLength: 0, sessionHours: 0, allowedSignIn: ['password', 'passkey', 'google', 'microsoft'], platformMinPasswordLength: 8 };
      else if (ep === '/api/v1/workspace/security/members') data = { members: 4, withoutTwoStep: 2, weakPasswords: 0, oldPasswords: 0, people: [] };
      else if (ep === '/api/v1/workspace/data-policy') data = { activityRetentionDays: null, notificationRetentionDays: null, chatRetentionDays: null, auditRetentionDays: null, planActivityDays: 365, lastPurgedAt: null, canManage: true };
      else if (ep === '/api/v1/workspace/logo') data = { hasLogo: false };
      else if (ep.endsWith('/ai/status')) data = { enabled: true, configured: true, entitled: true, allowedHere: true, model: 'gemini-2.5-flash', provider: 'Gemini' };
      else if (ep === '/api/v1/billing') data = {
        plan: { code: 'BUSINESS', name: 'Business', status: 'Active', trialEnd: null, periodEnd: '2026-11-24T05:00:00Z', cancelAtPeriodEnd: false, downgraded: false },
        usage: [{ key: 'MAX_MEMBERS', label: 'Members', used: 4, limit: -1 }, { key: 'STORAGE_LIMIT_MB', label: 'Storage (MB)', used: 820, limit: 5120 }],
        invoices: [{ id: 'i1', number: 'INV-1042', planCode: 'BUSINESS', amount: 3996, currency: 'INR', status: 'Paid', description: 'Business, 4 users, monthly', issuedAt: ago(30 * 1440) }],
        trialAvailable: false, canManage: true, paymentProvider: 'upi', payment: null, seats: { perSeat: true, purchased: 4, inUse: 4, period: 'monthly', renewal: null }, policy: null, upi: null,
        plans: [
          { id: 'p0', code: 'FREE', name: 'Free', description: 'One person', priceMonthly: 0, currency: 'INR', features: { PROJECT_LIMIT: 3, TASK_LIMIT: 100, MAX_MEMBERS: 1, MAX_TEAMS: 1, STORAGE_LIMIT_MB: 100, MAX_FILE_SIZE_MB: 10, ACTIVITY_RETENTION_DAYS: 30, AI_MONTHLY_CREDITS: 20, AI_MODEL_TIER: 1, AI_ASSISTANT: 1 }, isCurrent: false, sortOrder: 0 },
          { id: 'p1', code: 'PRO', name: 'Pro', description: 'Small teams', priceMonthly: 449, currency: 'INR', features: { PROJECT_LIMIT: -1, TASK_LIMIT: -1, MAX_MEMBERS: -1, MAX_TEAMS: 5, STORAGE_LIMIT_MB: 2048, MAX_FILE_SIZE_MB: 50, ACTIVITY_RETENTION_DAYS: 365, AI_MONTHLY_CREDITS: 100, AI_MODEL_TIER: 2, AI_ASSISTANT: 2 }, isCurrent: false, sortOrder: 1, perSeat: true },
          { id: 'p2', code: 'BUSINESS', name: 'Business', description: 'For organisations', priceMonthly: 999, currency: 'INR', features: { PROJECT_LIMIT: -1, TASK_LIMIT: -1, MAX_MEMBERS: -1, MAX_TEAMS: -1, STORAGE_LIMIT_MB: 5120, MAX_FILE_SIZE_MB: 100, ACTIVITY_RETENTION_DAYS: -1, AI_MONTHLY_CREDITS: 200, AI_MODEL_TIER: 2, AI_ASSISTANT: 2, ADVANCED_REPORTS: 1 }, isCurrent: true, sortOrder: 2, perSeat: true },
        ] };
      else if (ep === '/api/v1/notifications/counts') data = { unread: 2, needsYou: 3, forInfo: 0, snoozed: 0 };
      else if (ep === '/api/v1/notifications/unread-count') data = { count: 2 };
      else if (ep === '/api/v1/notifications') data = { items: notes, page: 1, pageSize: 20, totalPages: 1, totalItems: notes.length };
      else if (ep === '/api/v1/me/notification-preferences' || ep === '/api/v1/me/notifications/preferences') data = prefs;
      else if (ep.includes('reminders/settings')) data = reminderSettings;
      else if (ep === '/api/v1/push/status' || ep.endsWith('/push/status')) data = { devices: 1 };
      else if (ep === '/api/v1/reminders/policy') data = { available: true, canManage: true, escalationEnabled: true, steps: '1d:assignee,3d:lead,7d:owner', sentLast30Days: 42, doneLast30Days: 31, escalatedLast30Days: 3 };
      else if (ep === '/api/v1/workspace/sso') data = { entitled: true, canManage: true, connection: null, domains: [{ id: 'd1', domain: 'example.test', txtName: '_pt-verify.example.test', txtValue: 'pt-verify=4f2a9c', verified: false, verifiedAt: null, lastCheckedAt: ago(30) }], scimTokens: [], serviceProvider: { oidcRedirectUri: 'https://projecttracker-preview.test/api/v1/sso/oidc/callback', samlEntityId: 'https://projecttracker-preview.test/saml', samlAcsUrl: 'https://projecttracker-preview.test/api/v1/sso/saml/acs', samlMetadataUrl: 'https://projecttracker-preview.test/api/v1/sso/saml/metadata', scimBaseUrl: 'https://projecttracker-preview.test/scim/v2' } };
      else if (ep === '/api/v1/work-types') data = [{ id: 'wt1', name: 'Support request', description: 'Questions and problems from customers.', order: 1, isActive: true, taskCount: 12 }, { id: 'wt2', name: 'Access request', description: 'New accounts and permission changes.', order: 2, isActive: true, taskCount: 4 }];
      else if (ep === '/api/v1/work/sla') data = { entitled: true, canManage: true, defaults: [{ priority: 'Critical', responseMinutes: 30, resolutionMinutes: 240 }, { priority: 'High', responseMinutes: 120, resolutionMinutes: 1440 }, { priority: 'Medium', responseMinutes: 480, resolutionMinutes: 4320 }, { priority: 'Low', responseMinutes: null, resolutionMinutes: null }], overrides: [] };
      else if (ep === '/api/v1/org/access/effective') data = { people: members.map((m) => ({ userId: m.userId, name: m.displayName, email: m.email, accessLevel: m.role, jobRole: m.jobTitle, source: m.role === 'Owner' ? 'Owner' : m.role === 'Admin' ? 'Admin' : 'AccessLevel', modules: { projects: 3, tasks: 3 }, permissions: [], projectReach: m.role === 'Guest' ? 'added' : 'everything', projects: m.role === 'Guest' ? 1 : 6, teams: m.role === 'Guest' ? [] : ['Payments'] })), byJobRole: 0, byAccessLevel: 4 };
      else if (ep === '/api/v1/org/access') data = {
        canEdit: true, planAllows: true, isOrgAdmin: true, myLevels: { projects: 3, tasks: 3 },
        modules: [{ id: 'projects', label: 'Projects', description: 'Projects and their plans.', levels: [0, 1, 2, 3], hints: { 0: 'No access', 1: 'View', 2: 'Edit', 3: 'Manage' }, grants: {} },
          { id: 'tasks', label: 'Tasks', description: 'Tasks on projects.', levels: [0, 1, 2, 3], hints: { 0: 'No access', 1: 'View', 2: 'Edit', 3: 'Manage' }, grants: {} }],
        actions: [{ key: 'members.invite', label: 'Invite people', description: 'Send invitations to the workspace.', delegable: true }],
        roles: [{ roleId: 'r2', name: 'Platform lead', color: '#5E5CE6', parentRoleId: null, people: 1, hasProfile: true, modules: { projects: 3, tasks: 3 }, actions: { 'members.invite': true }, suggested: null },
          { roleId: 'r3', name: 'Developer', color: '#1A7F37', parentRoleId: 'r2', people: 1, hasProfile: false, modules: { projects: 1, tasks: 2 }, actions: {}, suggested: null }] };
      else if (ep === '/api/v1/org') data = { canManage: true, roles: [{ id: 'r1', name: 'Head of delivery', description: null, color: '#0071E3', parentRoleId: null, posX: null, posY: null, peopleCount: 1, childCount: 2, isDeleted: false, deletedAt: null, hasAccess: false }, { id: 'r2', name: 'Platform lead', description: null, color: '#5E5CE6', parentRoleId: 'r1', posX: null, posY: null, peopleCount: 1, childCount: 0, isDeleted: false, deletedAt: null, hasAccess: false }, { id: 'r3', name: 'Developer', description: null, color: '#1A7F37', parentRoleId: 'r1', posX: null, posY: null, peopleCount: 1, childCount: 0, isDeleted: false, deletedAt: null, hasAccess: false }], people: members.map((m, i) => ({ userId: m.userId, displayName: m.displayName, email: m.email, accessRole: m.role, roleId: ['r1', 'r2', 'r3', null][i], reportsToUserId: i ? user.id : null })) };
      else if (ep === '/api/v1/settings/notification-defaults') data = { kinds: prefs.map((k) => ({ type: k.type, label: k.label, description: k.description, locked: k.locked, needsYou: true, platform: { inApp: k.inApp, email: k.email, browser: k.browser }, workspace: { inApp: k.inApp, email: k.email, browser: k.browser }, changed: false, following: 4, choseOwn: 0 })), quietCustom: false, quietStart: null, quietEnd: null, digestCustom: false, digestTime: null, members: 4, membersWithOwnSchedule: 1, platformQuiet: '21:00–08:00', canEdit: true, updatedAt: null };
      else if (ep === '/api/v1/timer') data = null;
      else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
      else if (ep === '/api/v1/chat/projects/unread') data = [];
      else if (ep.endsWith('/projects') || ep.endsWith('/tasks') || ep.endsWith('/work-tasks')) data = { items: [], page: 1, totalPages: 0, totalItems: 0 };
      else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
    });
    const page = await ctx.newPage();
    let current = '';
    page.on('pageerror', (e) => errors.push(`${theme} ${current}: ${e.message}`));
    if (process.env.TOUR_DEBUG) page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load')) console.log(current, m.text().slice(0, 300)); });
    if (process.env.TOUR_DEBUG) page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/') && r.method() === 'GET') console.log(current, 'GET', u.pathname); });
    for (const [name, url] of ROUTES) {
      if (only && !only.includes(name)) continue;
      current = name;
      for (const [w, h, tag] of theme === 'light' ? [[1440, 1000, '1440'], [390, 844, '390']] : [[1440, 1000, 'dark-1440']]) {
        await page.setViewportSize({ width: w, height: h });
        await page.goto(`${origin}/preview-org${url}`);
        try { await page.locator('.content').waitFor({ timeout: 15000 }); } catch (e) { await page.screenshot({ path: path.join(out, 'debug.png') }); console.log('errors', errors, await page.evaluate(() => document.body.innerText.slice(0, 400))); throw e; }
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(700);
        if (await page.locator('text=Could not load this page').count() || await page.getByText('Something went wrong', { exact: true }).count()) problems.push(`${tag} ${name}: error state`);
        if (w === 390) { const cut = await cutOff(page); if (cut.length) problems.push(`390 ${name}: cut off ${JSON.stringify(cut.slice(0, 3))}`); }
        const file = `${name}-${tag}.png`;
        await page.screenshot({ path: path.join(out, file), fullPage: true });
        shots.push(file);
      }
    }
    await ctx.close();
  }
} finally { await browser.close(); }
console.log(JSON.stringify({ shots: shots.length, problems, errors: errors.slice(0, 20) }, null, 1));
if (process.env.TOUR_STRICT) { assert.deepEqual(errors, []); assert.deepEqual(problems, []); }
