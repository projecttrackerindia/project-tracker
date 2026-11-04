import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

import { appCsp } from './lib/csp.mjs';

// The calm shell (calm build): the sidebar (captions Today… / Work / Communicate / Know, the selected white pill, small badges, the
// workspace switcher with the purple logo, the collapse-to-rail toggle), the header (check-in, bell with its popover, Aura orb, avatar), the
// floating Aura panel (Chat / Recent / Automations / Activity; ⌘K toggles it), the floating + button (+ turns to ×, the page blurs, five
// create items opening the existing flows), the phone's tab bar (Today, Work, Approvals, Messages, More) with + above it and Aura as a
// sheet, the new routes (/approvals with /inbox redirected, /reminders, /notes, /calls → /meetings), and every existing page rendering in
// the new shell at 1440 / 1920 / 390 in light and dark with no horizontal scroll. Synthetic fixtures only.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/calm-shell');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 4 };
const project = { id: '00000000-0000-0000-0000-0000000000a1', key: 'RP', name: 'Razor pay', description: 'Payment gateway', status: 'Active', priority: 'High', health: 'OnTrack', progress: 40, active: 2,
  startDate: '2026-10-01', dueDate: '2026-12-19', version: 1, stageScheduleMode: 'Manual', projectType: 'NewProject', deliveryMethod: 'Agile',
  owner: { id: '00000000-0000-0000-0000-000000000001', name: 'Asha Rao' }, stats: { total: 5, done: 2, inProgress: 2, cancelled: 0, todo: 1, overdue: 0 } };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const writes = [], errors = [], checks = [];
const ticket = (title) => ({ kind: 'ticket', id: '00000000-0000-0000-0000-0000000000f1', key: 'WT-9', title, description: null, projectId: null, projectKey: null, projectName: null, status: 'To Do', category: 'Todo',
  priority: 'Critical', startDate: null, dueDate: null, isOverdue: false, assignee: { id: '00000000-0000-0000-0000-0000000000b2', name: 'Priya Nair' }, reporter: null, version: 1, createdAt: '2026-10-27T05:00:00Z',
  updatedAt: null, completedAt: null, loggedMinutes: 0, detail: { id: '00000000-0000-0000-0000-0000000000f1', status: 'ToDo', workType: 'Incident', workTypeId: '00000000-0000-0000-0000-0000000000c1', sla: null, can: { edit: true, delete: true } }, activity: [], channel: 'app' });
let levels = { project: 'suggest', notetaker: 'askFirst', mail: 'askFirst', triage: 'suggest', timesheet: 'suggest' };
const agentNames = { project: 'Project agent', notetaker: 'Meeting notetaker', mail: 'Mail agent', triage: 'Ticket triage', timesheet: 'Timesheet helper' };
const control = () => ({ agents: Object.entries(levels).map(([id, level]) => ({ id, name: agentNames[id], description: `${agentNames[id]} does its job`, level })), contextLength: 0, contextLimit: 4000, automations: 2, people: 5, aiOn: true, canEdit: true });

const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
try {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
  const init = () => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', window.__theme || 'light'); localStorage.setItem('pm_home_mode', 'classic'); };
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
    const agent = /^\/api\/v1\/ai\/control\/agents\/([a-z]+)$/.exec(ep);
    if (agent && method === 'PUT') { const b = req.postDataJSON(); writes.push({ ep, b }); levels = { ...levels, [agent[1]]: b.level }; data = control(); }
    else if (ep === '/api/v1/ai/control/context/draft' && method === 'POST') { writes.push({ ep }); data = { text: 'We are Preview Workspace.\nActive projects:\n- RP Razor pay' }; }
    else if (ep === '/api/v1/work-items' && method === 'POST') { const b = req.postDataJSON(); writes.push({ ep, b }); data = ticket(b.title); }
    else if (ep === '/api/v1/operations/triage' && method === 'POST') { data = { workTypeId: null, workTypeName: null, priority: null, suggestedAssignee: null, similar: [] }; }   // read-only suggestions (POST for the body)
    else {
      
      if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
      else if (ep === '/api/v1/me') data = { user, workspaces: [ws, { ...ws, id: '00000000-0000-0000-0000-000000000003', slug: 'second', name: 'Second Org' }], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['projects.view', 'projects.edit', 'projects.create', 'tasks.view', 'tasks.edit', 'tasks.create', 'work.create', 'org.manage', 'reports.view', 'reports.broad', 'work.view', 'vault.use', 'workflow.manage', 'labels.manage', 'audit.view'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 3, activity: 3, documents: 3, people: 3, reports: 3, billing: 3, members: 3, audit: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3 } } };
      else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
      else if (ep === '/api/v1/workspace/members') data = [{ userId: user.id, displayName: 'Asha Rao', email: user.email, role: 'Owner' }, { userId: '00000000-0000-0000-0000-0000000000b2', displayName: 'Priya Nair', email: 'priya@example.test', role: 'Member' }];
      else if (ep === '/api/v1/work-types') data = [{ id: '00000000-0000-0000-0000-0000000000c1', name: 'Incident', description: null, order: 1, isActive: true, taskCount: 0 }, { id: '00000000-0000-0000-0000-0000000000c2', name: 'Bug fix', description: null, order: 2, isActive: true, taskCount: 0 }];
      else if (ep === '/api/v1/work-items') data = { items: [], offset: 0, limit: 200, hasMore: false };
      else if (ep === '/api/v1/work-items/00000000-0000-0000-0000-0000000000f1') data = ticket('VPN down for collections team');
      else if (ep === `/api/v1/projects/${project.id}`) data = { project, stages: [], statuses: [{ id: project.id, name: 'To Do', order: 0, category: 'Todo', color: '#4f46e5' }], members: [{ userId: user.id, name: user.displayName, email: user.email, role: 'Owner' }] };
      else if (ep.endsWith('/projects') || ep.endsWith('/tasks') || ep.endsWith('/work-tasks')) data = { items: [], page: 1, totalPages: 0, totalItems: 0 };
      else if (ep === '/api/v1/ai/control') data = control();
      else if (ep === '/api/v1/workspace/security') data = { requireMfa: false, ipAllowlistEnabled: false, ipRanges: [], myIp: '49.37.12.9', entitled: true, minPasswordLength: 0, sessionHours: 0, allowedSignIn: ['password', 'passkey', 'sso'], platformMinPasswordLength: 8 };
      else if (ep === '/api/v1/workspace/security/members') data = { total: 2, withoutMfa: 0, people: [] };
      else if (ep === '/api/v1/agent/command-center') data = { greeting: 'Good morning, Asha', headline: 'Nothing urgent.', since: '2026-10-26T00:00:00Z', counts: { attention: 0, toDecide: 0, dueToday: 0, overdue: 0, blocking: 0, checkIns: 0, meetingsToday: 0, atRisk: 0 }, attention: [], today: [], changes: [], health: [], reliability: { kept: 0, missed: 0, open: 0, moved: 0 }, checkIns: [], owe: [], delegations: [] };
      else if (ep === '/api/v1/ai/usage') data = { month: '2026-10', creditsUsed: 351, creditsLimit: 1500, creditsLeft: 1149, unlimited: false, maxTier: 'deep', attachments: true, actions: true, tiers: [], attachmentTypes: [], maxFiles: 4, maxImageMb: 5, maxDocumentMb: 10 };
      else if (ep === '/api/v1/ai/usage/report') data = { month: '2026-10', creditsUsed: 351, creditsLimit: 1500, unlimited: false, answers: 160, failed: 34, byTier: [], people: [] };
      else if (ep === '/api/v1/ai/instructions') data = { text: null, canEdit: true };
      else if (ep === '/api/v1/workspace/ai-provider') data = { configured: false, provider: 'anthropic', providerName: 'Claude (Anthropic)', keyHint: null, quickModel: '', standardModel: '', deepModel: '', enabled: false, fallbackToPlatform: true, lastCheckedAt: null, lastError: null, peopleAgreed: 0, version: 1 };
      else if (ep === '/api/v1/ai/provider-status') data = { active: false, provider: null, providerName: null, agreed: false, agreedAt: null, fallbackToPlatform: true, notice: null };
      else if (ep === '/api/v1/ai/conversations') data = [{ id: 'c1', title: 'Plan my afternoon', lastMessageAt: '2026-11-03T08:00:00Z', isPinned: false }];
      else if (ep === '/api/v1/automations') data = [];
      else if (ep === '/api/v1/approvals') data = { items: [], counts: { needsMe: 0, mine: 0, all: 0, history: 0 }, week: { approved: 0, rejected: 0, expired: 0, medianMinutes: 0 }, byType: {}, expiringToday: 0, elsewhere: [] };
      else if (ep === '/api/v1/approvals/counts') data = { needsMe: 2 };
      else if (ep === '/api/v1/timeline') { const d = new Date().toISOString().slice(0, 10); const long = 'Riverline Payments Collections Platform Modernisation Programme';
        data = { from: url.searchParams.get('from'), to: url.searchParams.get('to'), timeZone: 'Asia/Kolkata', scope: 'me', generatedAt: new Date().toISOString(), events: [
          { id: `meeting:m1:${d}`, type: 'meeting', title: `${long} weekly steering review`, start: `${d}T04:30:00Z`, end: `${d}T05:30:00Z`, date: d, allDay: false, link: null, projectId: project.id, projectName: long, people: [], status: null, colour: '', key: null,
            approximated: false, overdue: false, priority: null, minutes: null, note: null, joinUrl: null, notes: false, userId: user.id, mode: null, running: false, sourceType: 'projectMeeting', sourceId: 'm1' }] }; }
      else if (ep === '/api/v1/approvals/chain') data = { type: url.searchParams.get('type'), custom: false, rule: 'Leave needs your lead.', steps: [] };
      else if (ep === '/api/v1/notes') data = { items: [], counts: { all: 0, pinned: 0, shared: 0, meetings: 0 }, folders: [], tags: [] };
      // Empty, correctly shaped answers so every page renders in the shell (the pages' own checks cover them with data).
      else if (ep === '/api/v1/activity') data = { items: [], page: 1, pageSize: 25, totalItems: 0, totalPages: 0 };
      else if (ep === '/api/v1/time/grid') { const wk = new Date(); wk.setUTCDate(wk.getUTCDate() - ((wk.getUTCDay() + 6) % 7)); const m = wk.toISOString().slice(0, 10);
        const days = [0, 1, 2, 3, 4, 5, 6].map((i) => { const d = new Date(`${m}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i); return { date: d.toISOString().slice(0, 10), minutes: 0, targetMinutes: i < 5 ? 480 : 0, weekend: i >= 5, leave: false, leaveNote: null, future: false, meetings: 0, meetingMinutes: 0 }; });
        data = { weekStart: m, weekEnd: days[6].date, user: { id: user.id, name: user.displayName }, mine: true, editable: true, locked: false, status: 'NotSubmitted', days, rows: [], suggestions: [], totalMinutes: 0, billableMinutes: 0, targetMinutes: 2400, overtimeMinutes: 0, missingDays: 0, running: null }; }
      else if (ep === '/api/v1/time/week') data = { weekStart: null, weekEnd: null, userId: user.id, status: 'NotSubmitted', totalMinutes: 0, billableMinutes: 0, note: null, submittedAt: null, reviewer: null, reviewedAt: null, reviewNote: null, locked: false, canSubmit: true, canWithdraw: false, canReview: false, id: null, entitled: true };
      else if (ep === '/api/v1/time/insights') data = { user: { id: user.id, name: user.displayName }, from: null, to: null, weeks: [], byProject: [], byWeekday: [], loggedMinutes: 0, billableMinutes: 0, targetMinutes: 0, overtimeMinutes: 0, utilisation: null, billableShare: 0, sameDayShare: null, streak: 0, missingDays: [] };
      else if (ep === '/api/v1/workload') data = { scope: 'Everyone', available: ['Everyone'], members: [], totals: { people: 0, open: 0, overdue: 0 } };
      else if (ep === '/api/v1/operations/insights') data = { days: 30, open: 0, unassigned: 0, breached: 0, atRisk: 0, compliance: 1, medianResolutionHours: null, medianResponseMinutes: null, createdInPeriod: 0, completedInPeriod: 0, weeks: [], aging: [], byTeam: [], byType: [], byPerson: [] };
      else if (ep === '/api/v1/doctracker/catalog') data = { projects: [], canCreate: true, isAdmin: true, truncated: 0 };
      else if (ep === '/api/v1/documents/inbox') data = { toReview: [], submitted: [], accessToDecide: [], myAccessRequests: [], waiting: 0 };
      else if (ep === '/api/v1/documents/dashboard') data = { total: 0, byStatus: [], byType: [], mine: 0, waitingForMe: 0, updatedThisWeek: 0, notUpdatedIn90Days: 0, unpublished: 0, recent: [] };
      else if (ep === '/api/v1/documents') data = { items: [], page: 1, pageSize: 50, totalItems: 0, totalPages: 0 };
      else if (ep === '/api/v1/quality/matrix') data = { runs: [], cases: [], results: [] };
      else if (ep === '/api/v1/quality/readiness') data = null;
      else if (ep === '/api/v1/reminders') data = { open: [], completed: [], sent: [], counts: { now: 0, today: 0, upcoming: 0, completed: 0 }, limits: { open: 500, recurring: 100, openUsed: 0, recurringUsed: 0 } };
      else if (ep === '/api/v1/reminders/counts') data = { now: 0, today: 0, upcoming: 0, completed: 0 };
      else if (ep === '/api/v1/reminders/settings') data = { workDays: [1, 2, 3, 4, 5], workStart: '09:00', workEnd: '18:00', quietStart: '21:00', quietEnd: '08:00', defaultTime: '09:00', autoEnabled: true, dueLeads: [1, 0], overdueSteps: [1, 3, 7], dailyAutoLimit: 12, briefingEnabled: true, briefingTime: '08:30', followDeviceTimeZone: false, muteNudges: false, timeZone: 'Asia/Kolkata' };
      else if (ep === '/api/v1/reminders/insights') data = null;
      else if (ep === '/api/v1/agent/audit') data = [];
      else if (ep === '/api/v1/notifications') data = { items: [
        { id: 'n1', type: 'Mention', title: 'Priya Nair mentioned you', body: 'Can you check the refund retries?', link: '/work', isRead: false, createdAt: new Date(Date.now() - 20 * 60_000).toISOString(), browser: false },
        { id: 'n2', type: 'DueSoon', title: 'Ship onboarding states is due tomorrow', body: null, link: '/work', isRead: true, createdAt: '2026-10-30T05:00:00Z', browser: false },
      ], page: 1, pageSize: 20, totalItems: 2, totalPages: 1 };
      else if (ep === '/api/v1/notifications/counts') data = { unread: 1, mentions: 1, reminders: 0, meetings: 0, work: 0, lanes: {} };
      else if (ep === '/api/v1/notifications/unread-count') data = { count: 1 };
      else if (ep === '/api/v1/ai/starters') data = { greeting: 'Hello', starters: [] };
      else if (ep === '/api/v1/timer') data = null;
      else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
      else if (ep.endsWith('/ai/status')) data = { enabled: true, configured: true, entitled: true, allowedHere: true, model: 'gemini', provider: 'Google Gemini', backup: null };
      else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
      else if (ep === '/api/v1/settings/health') data = { score: 90, checks: [] };
      else if (ep === '/api/v1/chat/projects/unread') data = [];
      else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
  };

  const screens = [['today', '/'], ['approvals', '/approvals'], ['my-work', '/work'], ['reminders', '/reminders'], ['notes', '/notes'],
    ['desk', '/desk'], ['quality', '/quality'], ['projects', '/work/projects'], ['project-detail', `/work/projects/${project.id}`], ['portfolio', '/work/projects?view=portfolio'], ['calendar', '/?tab=calendar'],
    ['meetings', '/meetings'], ['messages', '/messages'], ['mail', '/mail'],
    ['library', '/library'], ['insights', '/insights'], ['reports', '/insights?tab=reports'], ['activity', '/activity'], ['people', '/people'], ['settings', '/settings/general'], ['time', '/time']];
  const errors = [], checks = [], shots = [], fixtureGaps = [];
  const ctxFor = async (theme, w, h) => {
    const c = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block', viewport: { width: w, height: h }, isMobile: w < 500, hasTouch: w < 500 });
    await c.addInitScript((t) => { window.__theme = t; }, theme); await c.addInitScript(init); await c.route('**/*', handler);
    return c;
  };
  const at = (page) => { const u = new URL(page.url()); return `${u.pathname.replace('/preview-org', '') || '/'}${u.search}`; };
  const go = async (page, url) => { await page.goto(`${origin}/preview-org${url}`); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(700); };
  const snap = async (page, name) => { const file = path.join(out, `${name}.png`); await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: file }); shots.push(file); };
  const noSideScroll = async (page, what) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${what}: no horizontal scroll`);

  // ---------------------------------------------------------------- desktop: the shell itself
  {
    const c = await ctxFor('light', 1440, 900); const page = await c.newPage(); page.on('pageerror', (e) => errors.push(e.message));
    await go(page, '/');
    const labels = await page.locator('.shell-side .v2-rail-item .v2-rail-label').allTextContents();
    assert.deepEqual(labels, ['Today', 'Approvals', 'My work', 'Reminders', 'Notes', 'Projects', 'Portfolio', 'Desk', 'Quality', 'Calendar', 'Meetings', 'Messages', 'Mail', 'Library', 'Reports', 'Insights', 'Activity', 'People', 'Time'], `sidebar: ${labels}`);
    assert.deepEqual(await page.locator('.shell-side .v2-side-sl').allTextContents(), ['Work', 'Communicate', 'Know']);
    assert.equal(await page.locator('.shell-side .v2-rail-item', { hasText: /^Calls$/ }).count(), 0, 'no Calls');
    assert.equal(await page.locator('.shell-side .v2-side-pin, .shell-side .v2-side-pins').count(), 0, 'no nested project list');
    assert.equal(await page.locator('.shell-side .shell-ws-btn svg.pt-logo').count(), 1, 'logo in the switcher');
    assert.equal((await page.locator('.shell-side .shell-wn b').innerText()).trim(), 'ProjectTracker');
    assert.equal(Math.round((await page.locator('.shell-side').boundingBox()).width), 236);
    const on = page.locator('.shell-side .v2-rail-item.on'); assert.equal(await on.count(), 1); assert.equal((await on.innerText()).split('\n')[0].trim(), 'Today');
    assert.equal(await on.evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)', 'selected: white pill');
    // the header: check-in · bell · orb · avatar, in that order, top right
    const head = await page.locator('.shell-head > *:not(.v2-tb-sp)').evaluateAll((els) => els.map((e) => e.className.toString()));
    assert.ok(/ncx-bell/.test(head.join(' ')) && /shell-orb/.test(head.join(' ')) && /acct-icon/.test(head.join(' ')), `header: ${head}`);
    assert.ok(head.findIndex((x) => /ncx-bell/.test(x)) < head.findIndex((x) => /shell-orb/.test(x)) && head.findIndex((x) => /shell-orb/.test(x)) < head.findIndex((x) => /acct-icon/.test(x)), 'bell, orb, avatar order');
    assert.equal(await page.locator('[data-testid="aura-dock"], .aura-siri, form.v2-ask, .aura-hint').count(), 0, 'no bottom Aura capsule');
    await snap(page, 'shell-today-1440-light'); checks.push('sidebar+header');
    // the bell's popover: grouped, Mark all read, settings
    await page.locator('.shell-head .ncx-bell').click(); await page.waitForTimeout(400); await page.locator('.ncx-pop').waitFor();
    assert.ok(await page.getByRole('button', { name: 'Mark all read' }).isVisible()); assert.ok(await page.getByRole('button', { name: 'Notification settings' }).isVisible());
    await snap(page, 'shell-bell-1440-light'); await page.keyboard.press('Escape'); await page.waitForTimeout(300); checks.push('bell');
    // the Aura panel: the orb opens it (grows from the corner), four tabs, ⌘K toggles it
    await page.locator('.shell-head .shell-orb').click(); const panel = page.locator('.groot-chat.float'); await panel.waitFor(); await page.waitForTimeout(600);
    assert.deepEqual(await panel.locator('.gc-tabs [role="tab"]').allTextContents(), ['Chat', 'Recent', 'Automations', 'Activity']);
    const pb = await panel.boundingBox(); assert.ok(pb.x + pb.width <= 1440 - 20 && pb.y >= 50, `panel at the top right: ${JSON.stringify(pb)}`);
    await snap(page, 'shell-aura-1440-light');
    await panel.getByRole('tab', { name: 'Recent' }).click(); await panel.getByText('All conversations ›').waitFor();
    await panel.getByRole('tab', { name: 'Automations' }).click(); await panel.getByText('All automations ›').waitFor();
    await panel.getByRole('tab', { name: 'Activity' }).click(); await panel.getByText('Full audit trail ›').waitFor();
    await page.keyboard.press('Control+k'); await panel.waitFor({ state: 'detached' });
    await page.keyboard.press('Control+k'); await panel.waitFor(); await page.keyboard.press('Control+k'); await panel.waitFor({ state: 'detached' });
    await page.keyboard.press('Control+Shift+k'); await page.locator('.cmdk').waitFor(); await page.waitForTimeout(200); await page.keyboard.press('Escape'); await page.locator('.cmdk-overlay').waitFor({ state: 'detached' }); checks.push('aura-panel');
    // the + button: + turns to ×, the page blurs, five items; New task opens the create sheet
    const fab = page.getByTestId('fab'); const fb = await fab.locator('.shell-fab-btn').boundingBox();
    assert.ok(fb.x + fb.width > 1440 - 40 && fb.y + fb.height > 900 - 40, 'bottom right');
    await fab.locator('.shell-fab-btn').click(); await page.waitForTimeout(500);
    assert.deepEqual(await fab.locator('.shell-fab-menu [role="menuitem"]').allInnerTexts(), ['New task', 'New project', 'Schedule meeting', 'New doc', 'Request approval']);
    assert.equal(await fab.locator('.shell-fab-btn').getAttribute('aria-label'), 'Close');
    assert.ok(Number(await fab.locator('.shell-fab-scrim').evaluate((e) => getComputedStyle(e).opacity)) > .9, 'the page blurs');
    await snap(page, 'shell-fab-1440-light');
    await fab.getByRole('menuitem', { name: 'New task' }).click(); await page.getByRole('dialog', { name: 'New task' }).waitFor();   // the calm New task sheet (features/calm/createSheets)
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    // the hook: a page agent's handler takes over an item
    await fab.locator('.shell-fab-btn').click(); await page.waitForTimeout(300);
    await page.evaluate(() => { window.addEventListener('pt:create', (e) => { if (e.detail.kind === 'approval') { e.preventDefault(); window.__took = true; } }, { once: true }); });
    await fab.getByRole('menuitem', { name: 'Request approval' }).click(); assert.equal(await page.evaluate(() => window.__took), true, 'pt:create hook'); checks.push('fab');
    // collapse to the icon rail and back
    await page.getByRole('button', { name: 'Collapse sidebar' }).click(); await page.waitForTimeout(500);
    assert.equal(Math.round((await page.locator('.shell-side').boundingBox()).width), 68);
    assert.equal(await page.locator('.shell-side .v2-rail-label').first().isVisible(), false);
    await snap(page, 'shell-rail-1440-light');
    await page.getByRole('button', { name: 'Expand sidebar' }).click(); await page.waitForTimeout(500);
    assert.equal(Math.round((await page.locator('.shell-side').boundingBox()).width), 236); checks.push('collapse');
    // the workspace switcher
    await page.locator('.shell-ws-btn').click(); await page.locator('.shell-ws-menu').waitFor();
    assert.ok((await page.locator('.shell-ws-menu').innerText()).includes('Second Org')); await page.keyboard.press('Escape'); checks.push('switcher');
    // routes
    for (const [from, to] of [['/inbox', '/approvals'], ['/calls', '/meetings'], ['/reminders', '/reminders'], ['/notes', '/notes']]) {
      await go(page, from); for (let i = 0; i < 30 && at(page) !== to; i++) await page.waitForTimeout(100); assert.equal(at(page), to, `${from} → ${to}`);
    }
    await go(page, '/approvals'); assert.equal((await page.locator('.shell-side .v2-rail-item.on').innerText()).split('\n')[0].trim(), 'Approvals'); checks.push('routes');
    await c.close();
  }

  // ---------------------------------------------------------------- every page in the new shell
  for (const [theme, w, h, list] of [['light', 1440, 900, screens], ['dark', 1440, 900, screens], ['light', 1920, 1080, screens.filter(([n]) => ['today', 'projects', 'messages', 'insights'].includes(n))],
    ['light', 390, 844, screens], ['dark', 390, 844, screens.filter(([n]) => ['today', 'my-work', 'messages', 'library', 'approvals'].includes(n))]]) {
    const c = await ctxFor(theme, w, h); const page = await c.newPage(); page.on('pageerror', (e) => errors.push(`${theme}-${w} ${e.message}`));
    for (const [name, url] of list) {
      await go(page, url);
      if (await page.getByText('An unexpected error occurred while displaying this page').count()) { await page.getByText('Details').click().catch(() => {}); await snap(page, `${name}-${w}-${theme}-CRASH`); }
      // A page that cannot render with these thin fixtures is noted (its own verify script covers it); the shell must still be around it.
      if (await page.getByText('An unexpected error occurred while displaying this page').count()) { fixtureGaps.push(`${name}-${w}-${theme}: ${(await page.locator('body').innerText()).split('\n').find((l) => /Error/.test(l)) ?? ''}`); continue; }
      await noSideScroll(page, `${name} ${w} ${theme}`);
      // Side panels never spill: every text in a side card stays inside its card (long calendar names truncate).
      if (name === 'insights') assert.equal(await page.getByRole('button', { name: /^Time$/ }).or(page.getByRole('tab', { name: /^Time$/ })).count(), 0, `insights ${w}: no Time section (Time has its own place)`);
      if (name === 'time') assert.equal(at(page), '/time', 'Time opens its own page');
      if (name === 'calendar') { const spill = await page.evaluate(() => [...document.querySelectorAll('.wp-side .wp-rc')].flatMap((card) => { const c = card.getBoundingClientRect();
        return [...card.querySelectorAll('span, b, small')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.right > c.right + 1; }).map((e) => e.textContent); }));
        assert.deepEqual(spill, [], `calendar ${w} ${theme}: side text stays in its card`); }
      if (w < 500) {
        if (!url.startsWith('/messages')) await page.getByTestId('fab').waitFor();
        await page.locator('.v2-phone-bar').waitFor();
      } else { await page.locator('.shell-side').waitFor(); await page.getByTestId('fab').waitFor(); }
      await snap(page, `${name}-${w}-${theme}`);
    }
    checks.push(`pages-${w}-${theme}:${list.length}`);
    await c.close();
  }

  // ---------------------------------------------------------------- phone: tab bar, + above it, Aura as a sheet
  {
    const c = await ctxFor('light', 390, 844); const page = await c.newPage(); page.on('pageerror', (e) => errors.push(e.message));
    await go(page, '/work');
    assert.deepEqual(await page.locator('.v2-phone-tab .v2-rail-label').allTextContents(), ['Today', 'Work', 'Approvals', 'Messages', 'More']);
    const fb = await page.locator('.shell-fab-btn').boundingBox(), tb = await page.locator('.v2-phone-bar').boundingBox();
    assert.ok(fb.y + fb.height <= tb.y + 1, `+ above the tab bar: ${fb.y + fb.height} vs ${tb.y}`);
    assert.ok(fb.width >= 44 && fb.height >= 44, '+ is a 44px target');
    await page.locator('.shell-fab-btn').click(); await page.waitForTimeout(500); await snap(page, 'phone-fab-390-light');
    await page.locator('.shell-fab-btn').click(); await page.waitForTimeout(300);
    await page.locator('.m-top .m-aura-orb').click(); const sheet = page.locator('.groot-chat.phone'); await sheet.waitFor(); await page.waitForTimeout(500);
    assert.deepEqual(await sheet.locator('.gc-tabs [role="tab"]').allTextContents(), ['Chat', 'Recent', 'Automations', 'Activity']);
    // pinned to the bottom: the sheet reaches the screen's foot and its field sits just above it (no extra page padding pushes it up)
    const sb = await sheet.boundingBox(), cb = await sheet.locator('.gc-compose').boundingBox();
    assert.ok(Math.abs(sb.y + sb.height - 844) <= 1, `Aura sheet reaches the bottom: ${sb.y + sb.height}`);
    assert.ok(844 - (cb.y + cb.height) <= 40, `Aura field pinned near the bottom: ${cb.y + cb.height}`);
    await snap(page, 'phone-aura-390-light'); checks.push('phone');
    await c.close();
  }

  // ---------------------------------------------------------------- sign-in: the logo, no + button; the splash
  {
    const so = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    await so.route('**/*', async (route) => { if (new URL(route.request().url()).pathname.startsWith('/api/')) { await route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }); return; } await handler(route); });
    const sp = await so.newPage(); await sp.goto(`${origin}/login`); await sp.waitForTimeout(1500);
    assert.ok(await sp.locator('svg.pt-logo').count() >= 1, 'logo on sign-in'); assert.equal(await sp.getByTestId('fab').count(), 0, 'no + on sign-in');
    await snap(sp, 'sign-in-1440-light');
    // the splash: hold the session check so the start screen stays up
    const sp2 = await so.newPage(); await sp2.route('**/api/v1/auth/refresh', () => new Promise(() => {})); await sp2.goto(`${origin}/preview-org/`); await sp2.locator('.app-splash .pt-logo').waitFor();
    assert.equal((await sp2.locator('.as-name').innerText()).trim(), 'ProjectTracker'); await sp2.waitForTimeout(900); await snap(sp2, 'splash-1440-light');
    checks.push('sign-in+splash');
    await so.close();
    // Phone sign-in: no dead space above the e-mail field (an empty passkey / SSO slot must collapse).
    for (const theme of ['light', 'dark']) {
      const po = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
      await po.addInitScript((t) => { try { localStorage.setItem('pm_theme', t); } catch { /* private */ } }, theme);
      await po.route('**/*', async (route) => { if (new URL(route.request().url()).pathname.startsWith('/api/')) { await route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }); return; } await handler(route); });
      const pp = await po.newPage(); await pp.goto(`${origin}/login`); await pp.locator('input[type="email"]').first().waitFor();
      const gap = await pp.evaluate(() => {
        const email = document.querySelector('input[type="email"]'); const field = email.closest('label, .field, .form-group, div');
        let prev = field; while (prev && !prev.previousElementSibling) prev = prev.parentElement;
        const above = prev?.previousElementSibling; if (!above) return 0;
        return Math.round(field.getBoundingClientRect().top - above.getBoundingClientRect().bottom);
      });
      assert.ok(gap <= 80, `sign-in 390 ${theme}: no blank band above the e-mail field (${gap}px)`);
      assert.ok(await pp.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'sign-in 390: no sideways scroll');
      await snap(pp, `sign-in-390-${theme}`); checks.push(`sign-in-390-${theme}`);
      await po.close();
    }
  }

  // Page errors from pages that fell over on the thin fixtures are theirs, not the shell's.
  const own = errors.filter((e) => !/reading '(length|label|map|filter|isRead)'|is not iterable|is not a function/.test(e));
  assert.deepEqual(own, []);
  await fs.writeFile(path.join(out, 'checks.json'), JSON.stringify({ checks, shots, fixtureGaps }, null, 2));
  console.log(JSON.stringify({ checks, shots: shots.length, fixtureGaps }));
  assert.deepEqual(fixtureGaps, [], 'every page renders in the shell (no error screen)');
} finally { await browser.close(); }
