import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Round 5 adoption: the welcome tour and the sample project. In a brand-new workspace (no projects, tour never seen) the tour opens by
// itself on Home: Welcome, your places, a sample project (added in one click, then opened or removed), and You're all set. Closing or
// finishing saves it with the account (/me/ui/onboarding) so it never opens again by itself; the account menu, ⌘K and Settings › Help
// replay it. A workspace with projects never gets it unasked. 1440 and 390, light and dark. Synthetic fixtures only (made-up names).
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/adoption');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 4 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const SAMPLE = '44444444-4444-4444-4444-444444444444';
const writes = [], errors = [], checks = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
try {
  const make = async (theme = 'light', { projects = 0, tour = null } = {}) => {
    const state = { sample: false, tour, projects };
    const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
    await ctx.addInitScript(([t]) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); }, [theme]);
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
      const sample = () => state.sample ? { exists: true, projectId: SAMPLE, name: 'Sample: Website launch', tasks: 6 } : { exists: false, projectId: null, name: null, tasks: 0 };
      if (ep === '/api/v1/me/ui/onboarding' && method === 'PUT') { const b = req.postDataJSON(); writes.push({ method, ep, b }); state.tour = b.value; data = { key: 'onboarding', value: b.value, updatedAt: null }; }
      else if (ep === '/api/v1/onboarding/sample-project' && method === 'POST') { writes.push({ method, ep }); state.sample = true; state.projects = 1; await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ data: sample() }) }); return; }
      else if (ep === '/api/v1/onboarding/sample-project' && method === 'DELETE') { writes.push({ method, ep }); state.sample = false; state.projects = 0; data = sample(); }
      else if (ep === '/api/v1/me/ui/sidebar' && method === 'PUT') data = {};
      else {
        assert.ok(method === 'GET' || ep.endsWith('/auth/refresh'), `Unexpected write: ${method} ${ep}`);
        if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
        else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['projects.view', 'tasks.view', 'org.manage', 'reports.view', 'work.view'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 3, activity: 3, documents: 3, people: 3, reports: 3, billing: 3, members: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3 } } };
        else if (ep === '/api/v1/me/ui/onboarding') data = { key: 'onboarding', value: state.tour, updatedAt: null };
        else if (ep.startsWith('/api/v1/me/ui/')) data = { key: ep.split('/').pop(), value: null, updatedAt: null };
        else if (ep === '/api/v1/onboarding/sample-project') data = sample();
        else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
        else if (ep === '/api/v1/notifications/counts') data = { unread: 0, needsYou: 0, forInfo: 0, snoozed: 0, messages: 0, reminders: 0, meetings: 0, work: 0 };
        else if (ep === '/api/v1/notifications') data = { items: [], page: 1, pageSize: 50, totalPages: 0, totalItems: 0 };
        else if (ep === '/api/v1/feature-flags/mine') data = { flags: { 'whats-new': true, 'report-problem': true } };
        else if (ep === '/api/v1/notifications/smart') data = { grouping: true, groupWindowMinutes: 60, kinds: [], mutes: [] };
        else if (ep === '/api/v1/reminders/settings') data = { workDays: [1, 2, 3, 4, 5], workStart: '09:00', workEnd: '18:00', quietStart: null, quietEnd: null, defaultTime: '09:00', autoEnabled: true, dueLeads: [1], overdueSteps: [1], dailyAutoLimit: 12, briefingEnabled: false, briefingTime: '08:30', followDeviceTimeZone: false, muteNudges: false, timeZone: 'Asia/Kolkata', digestTime: null };
        else if (ep === '/api/v1/reminders') data = { open: [], completed: [], sent: [], counts: { now: 0, today: 0, upcoming: 0, completed: 0 }, limits: { open: 500, recurring: 100, openUsed: 0, recurringUsed: 0 } };
        else if (ep === '/api/v1/projects') data = { items: [], page: 1, pageSize: 1, totalPages: state.projects ? 1 : 0, totalItems: state.projects };
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
    return { ctx, state };
  };
  const shot = async (page, name) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(500); await page.screenshot({ path: path.join(out, name) }); };
  const waitFor = async (test, what) => { for (let i = 0; i < 60 && !writes.some(test); i++) await new Promise((r) => setTimeout(r, 100)); const w = writes.find(test); assert.ok(w, `expected a call: ${what}`); return w; };
  const noSideScroll = async (page, what) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${what}: no horizontal scroll`);

  for (const theme of ['light', 'dark']) {
    for (const [w, h, tag] of [[1440, 960, '1440'], [390, 844, '390']]) {
      const { ctx, state } = await make(theme);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      await page.setViewportSize({ width: w, height: h });
      await page.goto(origin + '/preview-org/');
      const tour = page.getByRole('dialog', { name: 'Welcome to ProjectTracker' });
      await tour.waitFor({ timeout: 10000 });
      await page.getByText('This is ProjectTracker.').waitFor();
      if (tag === '390') await fitsPhone(page, 'welcome tour', assert);
      await noSideScroll(page, 'welcome');
      await shot(page, `tour-1-welcome-${tag}-${theme}.png`);
      await tour.getByRole('button', { name: 'Continue' }).click();
      await page.getByText('Everything has one place.').waitFor();
      assert.ok(await tour.locator('.wt-places li').count() >= 3, 'the places are listed');
      await shot(page, `tour-2-places-${tag}-${theme}.png`);
      await tour.getByRole('button', { name: 'Continue' }).click();
      await page.getByText('Try it with a sample project.').waitFor();
      await shot(page, `tour-3-sample-${tag}-${theme}.png`);
      await tour.getByRole('button', { name: 'Add sample project' }).click();
      await waitFor((x) => x.method === 'POST' && x.ep === '/api/v1/onboarding/sample-project', 'sample project added');
      await tour.getByText('Added · 6 tasks').waitFor();
      if (tag === '390') await fitsPhone(page, 'sample added', assert);
      await shot(page, `tour-3-sample-added-${tag}-${theme}.png`);
      await tour.getByRole('tab', { name: 'Page 4 of 4' }).click();
      await page.getByText('You’re all set.').waitFor();
      await shot(page, `tour-4-done-${tag}-${theme}.png`);
      await tour.getByRole('button', { name: 'Get started' }).click();
      await tour.waitFor({ state: 'detached' });
      assert.equal(state.tour?.done, true, 'finishing is saved with the account');
      await ctx.close();
      checks.push(`tour-${tag}-${theme}`);
    }
  }

  // A workspace that already has projects never gets the tour unasked; Settings › Help replays it and adds / removes the sample.
  for (const [w, h, tag] of [[1440, 960, '1440'], [390, 844, '390']]) {
    const { ctx } = await make('light', { projects: 3 });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: w, height: h });
    await page.goto(origin + '/preview-org/');
    await page.waitForTimeout(2500);
    assert.equal(await page.getByRole('dialog', { name: 'Welcome to ProjectTracker' }).count(), 0, 'no tour in a workspace with projects');
    await page.goto(origin + '/preview-org/settings/notifications/smart');
    await page.getByText('Sample project').waitFor();
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await waitFor((x) => x.method === 'POST' && x.ep === '/api/v1/onboarding/sample-project', 'add from settings');
    await page.getByText('Sample: Website launch · 6 tasks').waitFor();
    if (tag === '390') await fitsPhone(page, 'settings help', assert);
    await page.getByText('Sample: Website launch · 6 tasks').scrollIntoViewIfNeeded();
    await shot(page, `settings-help-${tag}-light.png`);
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await waitFor((x) => x.method === 'DELETE' && x.ep === '/api/v1/onboarding/sample-project', 'remove from settings');
    await page.getByText('Welcome tour', { exact: true }).click();
    await page.getByRole('dialog', { name: 'Welcome to ProjectTracker' }).waitFor();
    await page.keyboard.press('Escape');
    await ctx.close();
    checks.push(`settings-${tag}`);
  }

  assert.deepEqual(errors, [], 'no page errors');
  console.log('welcome tour ui ok:', checks.join(', '));
} finally { await browser.close(); }
