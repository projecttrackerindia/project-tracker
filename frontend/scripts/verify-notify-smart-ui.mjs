import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';
import { shimSelect } from './lib/select-shim.mjs';

// Round 5 notify-smart: a burst about one project is one named group in the Notification Centre ("3 updates on …") with Mute; Settings ›
// Notifications › Smart (grouping, window, daily summary, urgent / normal per kind, mutes) saves through its endpoints; Report a problem from
// the account menu sends the route, version, errors and a screenshot; What's new shows once after a release; Settings › General › Feature
// flags switches a feature for the workspace and adds an exception. 1440 and 390, light and dark. Synthetic fixtures only (made-up names).
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/notify-smart');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 4 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const now = Date.now(), iso = (m) => new Date(now + m * 60000).toISOString();
const PROJ = '33333333-3333-3333-3333-333333333333';
const G = { groupKey: `project:${PROJ.replace(/-/g, '')}`, groupLabel: 'CIBIL Integration', priority: 'normal' };
const N = (id, type, title, mins, extra = {}) => ({ id, type, category: 'work', title, body: 'Fictional change', link: `/projects/${PROJ}?task=${id}`, isRead: false, createdAt: iso(-mins), shownAt: iso(-mins),
  browser: false, needsYou: false, archived: false, actions: ['snooze'], ...G, ...extra });
const items = [
  N('a1', 'TaskUpdated', 'CIB-4 moved to Review', 2), N('a2', 'Comment', 'New comment on CIB-7', 9), N('a3', 'TaskUpdated', 'CIB-2 due date changed', 20),
  { ...N('u1', 'Approval', 'Approve the UAT deployment', 4), category: 'work', priority: 'urgent', groupKey: null, groupLabel: null, link: '/approvals?open=u1', needsYou: true },
];
const KIND = (type, label, priority, locked = false) => ({ type, label, priority, defaultPriority: priority, locked });
let smart = { grouping: true, groupWindowMinutes: 60, kinds: [KIND('Approval', 'Approvals', 'urgent'), KIND('Mention', 'Mentions', 'urgent'), KIND('Security', 'Security alerts', 'urgent', true),
  KIND('TaskUpdated', 'Task updated', 'normal'), KIND('Comment', 'Comments', 'normal'), KIND('Message', 'Messages', 'normal')],
  mutes: [{ id: 'mu1', scope: 'thread', targetId: '55555555-5555-5555-5555-555555555555', label: 'Vendor onboarding thread', until: null, createdAt: iso(-600) }] };
let settings = { workDays: [1, 2, 3, 4, 5], workStart: '09:00', workEnd: '18:00', quietStart: null, quietEnd: null, defaultTime: '09:00', autoEnabled: true, dueLeads: [1, 0], overdueSteps: [1, 3, 7],
  dailyAutoLimit: 12, briefingEnabled: true, briefingTime: '08:30', followDeviceTimeZone: false, muteNudges: false, timeZone: 'Asia/Kolkata', digestTime: null };
let flags = [
  { key: 'smart-grouping', label: 'Grouped notifications', description: 'Bursts show as one group.', default: true, workspace: null, effective: true, overrides: [] },
  { key: 'shake-to-report', label: 'Shake to report', description: 'On a phone, shaking opens Report a problem.', default: false, workspace: null, effective: false, overrides: [] },
];
const writes = [], errors = [], checks = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
await shimSelect(browser);
try {
  const make = async (theme = 'light', seen = '2026.11.2') => {
    const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
    await ctx.addInitScript(([t, s]) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); localStorage.setItem('pm_home_mode', 'classic'); if (s && !localStorage.getItem('pt_whats_new_seen')) localStorage.setItem('pt_whats_new_seen', s); }, [theme, seen]);
    await ctx.route('**/*', async (route) => {
      const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
      if (url.origin !== origin) { await route.abort(); return; }
      if (ep.endsWith('/avatar')) { await route.fulfill({ status: 404, body: '' }); return; }
      if (!ep.startsWith('/api/')) {
        const file = path.resolve(dist, ep.startsWith('/assets/') || /^\/favicon|^\/icons\//.test(ep) ? ep.slice(1) : 'index.html');
        assert.ok(file.startsWith(dist + path.sep));
        const body = await fs.readFile(file).catch(() => null);
        if (!body) { await route.fulfill({ status: 404, body: '' }); return; }
        await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream', body, headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
        return;
      }
      let data = [];
      let m;
      if (ep === '/api/v1/notifications/smart' && method === 'PUT') {
        const b = req.postDataJSON(); writes.push({ method, ep, b });
        smart = { ...smart, ...(b.grouping !== undefined ? { grouping: b.grouping } : {}), ...(b.groupWindowMinutes ? { groupWindowMinutes: b.groupWindowMinutes } : {}),
          kinds: smart.kinds.map((k) => { const p = (b.priorities ?? []).find((x) => x.type === k.type); return p ? { ...k, priority: p.priority } : k; }) };
        data = smart;
      } else if ((m = /^\/api\/v1\/notifications\/(\w+)\/mute$/.exec(ep)) && method === 'POST') {
        writes.push({ method, ep, b: req.postDataJSON() }); data = { id: 'mu2', scope: 'project', targetId: PROJ, label: 'CIBIL Integration', until: null, createdAt: iso(0) };
        smart = { ...smart, mutes: [data, ...smart.mutes] };
      } else if ((m = /^\/api\/v1\/notifications\/mutes\/(\w+)$/.exec(ep)) && method === 'DELETE') {
        writes.push({ method, ep }); smart = { ...smart, mutes: smart.mutes.filter((x) => x.id !== m[1]) }; await route.fulfill({ status: 204, body: '' }); return;
      } else if (ep === '/api/v1/reminders/settings' && method === 'PUT') { const b = req.postDataJSON(); writes.push({ method, ep, b }); settings = { ...settings, ...b }; data = settings; }
      else if (ep === '/api/v1/problem-reports' && method === 'POST') { const b = req.postDataJSON(); writes.push({ method, ep, b }); await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ data: { id: 'p1', reference: 'PR-1A2B3C', emailed: true } }) }); return; }
      else if ((m = /^\/api\/v1\/feature-flags\/([\w-]+)$/.exec(ep)) && method === 'PUT') {
        const b = req.postDataJSON(); writes.push({ method, ep, b });
        flags = flags.map((f) => f.key !== m[1] ? f : b.scope === 'workspace' ? { ...f, workspace: b.enabled, effective: b.enabled ?? f.default }
          : { ...f, overrides: b.enabled === null ? f.overrides.filter((o) => o.targetId !== b.targetId) : [...f.overrides, { scope: b.scope, targetId: b.targetId, name: 'Fictional pilot team', enabled: b.enabled }] });
        data = flags;
      } else if ((m = /^\/api\/v1\/notifications\/(\w+)\/(read|unread)$/.exec(ep)) && method === 'POST') { await route.fulfill({ status: 204, body: '' }); return; }
      else if (ep === '/api/v1/me/ui/sidebar') data = { key: 'sidebar', value: null, updatedAt: null };
      else {
        assert.ok(method === 'GET' || ep.endsWith('/auth/refresh'), `Unexpected write: ${method} ${ep}`);
        if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
        else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['projects.view', 'tasks.view', 'org.manage', 'reports.view', 'work.view'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 3, activity: 3, documents: 3, people: 3, reports: 3, billing: 3, members: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3 } } };
        else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
        else if (ep === '/api/v1/notifications/counts') data = { unread: 4, needsYou: 1, forInfo: 3, snoozed: 0, messages: 0, reminders: 0, meetings: 0, work: 4 };
        else if (ep === '/api/v1/notifications') data = { items: url.searchParams.get('archived') === 'true' || url.searchParams.get('lane') === 'snoozed' ? [] : items, page: 1, pageSize: 50, totalPages: 1, totalItems: items.length };
        else if (ep === '/api/v1/notifications/smart') data = smart;
        else if (ep === '/api/v1/feature-flags/mine') data = { flags: { 'smart-grouping': true, 'whats-new': true, 'report-problem': true, 'shake-to-report': false } };
        else if (ep === '/api/v1/feature-flags') data = flags;
        else if (ep === '/api/v1/teams') data = [{ id: '66666666-6666-6666-6666-666666666666', name: 'Fictional pilot team', description: null, memberCount: 3, projectCount: 1, lead: null }];
        else if (ep === '/api/v1/workspace/members') data = [{ userId: user.id, displayName: 'Asha Rao', email: user.email, role: 'Owner', joinedAt: iso(-9999), jobRole: null, isActive: true }];
        else if (ep === '/api/v1/me/notification-preferences') data = [];
        else if (ep === '/api/v1/push/status') data = { publicKey: 'BAAA', devices: 1 };
        else if (ep === '/api/v1/reminders/settings') data = settings;
        else if (ep === '/api/v1/reminders') data = { open: [], completed: [], sent: [], counts: { now: 0, today: 0, upcoming: 0, completed: 0 }, limits: { open: 500, recurring: 100, openUsed: 0, recurringUsed: 0 } };
        else if (ep === '/api/v1/reminders/counts') data = { now: 0, today: 0, upcoming: 0, completed: 0 };
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
    return ctx;
  };
  const shot = async (page, name) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(450); await page.screenshot({ path: path.join(out, name) }); };
  const waitFor = async (test, what) => { for (let i = 0; i < 60 && !writes.some(test); i++) await new Promise((r) => setTimeout(r, 100)); const w = writes.find(test); assert.ok(w, `expected a call: ${what}`); return w; };

  for (const theme of ['light', 'dark']) {
    // ---------------------------------------------------------------- desktop 1440
    let ctx = await make(theme);
    let page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(origin + '/preview-org/work');
    await page.locator('.v2-tb [data-ncx-bell]').click();
    await page.locator('.ncx-pop').waitFor();
    await page.locator('.ncx-group-title').first().waitFor();
    assert.equal(await page.locator('.ncx-group-title').first().innerText(), '3 updates on CIBIL Integration');
    await shot(page, `centre-group-1440-${theme}.png`);
    if (theme === 'light') {
      await page.locator('.ncx-stack.named .ncx-more-from').click();
      await page.locator('.ncx-stack-head', { hasText: '3 updates on CIBIL Integration' }).getByRole('button', { name: 'Mute' }).click();
      const mute = await waitFor((w) => w.ep === '/api/v1/notifications/a1/mute', 'mute the group');
      assert.equal(mute.b.scope, 'project');
      checks.push('named-group', 'mute-from-group');
    }
    await page.keyboard.press('Escape');

    await page.goto(origin + '/preview-org/settings/notifications/smart');
    await page.locator('[data-setting="notifications.smart"]').waitFor();
    await page.getByText('Urgent · rings and pops up').waitFor();
    await shot(page, `smart-1440-${theme}.png`);
    if (theme === 'light') {
      await page.getByLabel('Messages priority').selectOption('urgent');
      const pr = await waitFor((w) => w.method === 'PUT' && w.ep === '/api/v1/notifications/smart' && w.b.priorities, 'priority saved');
      assert.deepEqual(pr.b.priorities, [{ type: 'Message', priority: 'urgent' }]);
      await page.locator('.smart-saved.on').waitFor();
      await page.getByLabel('Grouping window').selectOption('30');
      await waitFor((w) => w.method === 'PUT' && w.b.groupWindowMinutes === 30, 'window saved');
      await page.getByRole('switch', { name: 'One daily summary' }).click();
      const dg = await waitFor((w) => w.method === 'PUT' && w.ep === '/api/v1/reminders/settings', 'daily summary on');
      assert.equal(dg.b.digestTime, '18:00');
      await page.locator('.sg-row', { hasText: 'Vendor onboarding thread' }).getByRole('button', { name: 'Unmute' }).click();
      await waitFor((w) => w.method === 'DELETE' && w.ep === '/api/v1/notifications/mutes/mu1', 'unmute');
      checks.push('priority-tuning', 'grouping-window', 'daily-summary', 'unmute');

      // Report a problem, from the account menu.
      await page.locator('.acct-row:visible, .acct-icon:visible').first().click();
      await page.locator('.acct-menu').waitFor();
      assert.equal(await page.getByRole('menuitem', { name: 'What’s new' }).count(), 1, 'What’s new in the account menu');
      await page.getByRole('menuitem', { name: 'Report a problem' }).click();
      await page.getByRole('dialog', { name: 'Report a problem' }).waitFor();
      await page.getByLabel('What went wrong').fill('The board froze after I dragged a card');
      await shot(page, `report-1440-${theme}.png`);
      await page.getByRole('button', { name: 'Send report' }).click();
      const rep = await waitFor((w) => w.ep === '/api/v1/problem-reports', 'report sent');
      assert.equal(rep.b.route, '/preview-org/settings/notifications/smart');
      assert.ok(rep.b.appVersion);
      assert.ok(Array.isArray(rep.b.console) && Array.isArray(rep.b.network));
      await page.getByText('Reference PR-1A2B3C').waitFor();
      checks.push('report-problem', rep.b.screenshot ? 'screenshot' : 'no-screenshot');
      await page.getByRole('button', { name: 'Done' }).click();

      // Feature flags (admin).
      await page.goto(origin + '/preview-org/settings/general/features');
      await page.locator('[data-setting="workspace.features"]').waitFor();
      await page.getByRole('switch', { name: 'Shake to report for everyone' }).click();
      const ff = await waitFor((w) => w.ep === '/api/v1/feature-flags/shake-to-report' && w.b.scope === 'workspace', 'flag on');
      assert.equal(ff.b.enabled, true);
      await page.locator('.ff-add').nth(1).getByRole('button', { name: 'Add exception' }).click();
      await page.getByLabel('Who').selectOption({ label: 'Fictional pilot team' });
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      const ex = await waitFor((w) => w.b?.scope === 'team', 'team exception');
      assert.equal(ex.b.enabled, false);
      await page.locator('.ff-chip', { hasText: 'Fictional pilot team' }).waitFor();
      checks.push('flags-workspace', 'flags-team-exception');
    }
    await page.goto(origin + '/preview-org/settings/general/features');
    await page.locator('[data-setting="workspace.features"]').waitFor();
    await shot(page, `flags-1440-${theme}.png`);
    await ctx.close();

    // What's new: once after a release (seen an older one).
    ctx = await make(theme, '2026.11.1');
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(origin + '/preview-org/work');
    await page.getByRole('dialog', { name: 'What’s new' }).waitFor({ timeout: 8000 });
    await shot(page, `whatsnew-1440-${theme}.png`);
    await page.getByRole('button', { name: 'Got it' }).click();
    assert.equal(await page.evaluate(() => localStorage.getItem('pt_whats_new_seen')), '2026.11.2');
    await page.reload();
    await page.waitForTimeout(2000);
    assert.equal(await page.getByRole('dialog', { name: 'What’s new' }).count(), 0, 'shown once');
    if (theme === 'light') checks.push('whats-new-once');
    await ctx.close();

    // ---------------------------------------------------------------- phone 390
    ctx = await make(theme, '2026.11.1');
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(origin + '/preview-org/settings/notifications/smart');
    await page.getByRole('dialog', { name: 'What’s new' }).waitFor({ timeout: 8000 });
    await fitsPhone(page, "what's new sheet", assert);
    await shot(page, `whatsnew-390-${theme}.png`);
    await page.getByRole('button', { name: 'Got it' }).click();
    await page.locator('[data-setting="notifications.smart"]').waitFor();
    await page.waitForTimeout(400);
    await fitsPhone(page, 'smart notifications', assert);
    await shot(page, `smart-390-${theme}.png`);
    await page.evaluate(() => window.dispatchEvent(new Event('pt:report-problem')));
    await page.getByRole('dialog', { name: 'Report a problem' }).waitFor();
    await fitsPhone(page, 'report a problem sheet', assert);
    await shot(page, `report-390-${theme}.png`);
    await page.keyboard.press('Escape');
    await page.goto(origin + '/preview-org/settings/general/features');
    await page.locator('[data-setting="workspace.features"]').waitFor();
    await fitsPhone(page, 'feature flags', assert);
    await shot(page, `flags-390-${theme}.png`);
    await ctx.close();
    checks.push(`phone-${theme}`);
  }

  assert.deepEqual(errors, [], 'no page errors');
  console.log('notify smart ui ok:', checks.join(', '));
} finally { await browser.close(); }
