import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// The v2 shell: the 84px rail (logo, + New, the five places, the avatar menu), old addresses landing on their new places with query and
// #anchor kept, + New ("I understood this as a ticket" with chips, creating through /work-items and opening it), the Ask bar (and "Ask about
// <project>" on a project page, opening the copilot panel), the phone's bottom bar, and Settings: ten sections and the AI control centre
// (agent levels, "Draft it from my projects"). Built frontend with synthetic API fixtures only.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/shell-ui');
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
  await ctx.addInitScript(() => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', 'light'); localStorage.setItem('pm_home_mode', 'classic'); });
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
    const agent = /^\/api\/v1\/ai\/control\/agents\/([a-z]+)$/.exec(ep);
    if (agent && method === 'PUT') { const b = req.postDataJSON(); writes.push({ ep, b }); levels = { ...levels, [agent[1]]: b.level }; data = control(); }
    else if (ep === '/api/v1/ai/control/context/draft' && method === 'POST') { writes.push({ ep }); data = { text: 'We are Preview Workspace.\nActive projects:\n- RP Razor pay' }; }
    else if (ep === '/api/v1/work-items' && method === 'POST') { const b = req.postDataJSON(); writes.push({ ep, b }); data = ticket(b.title); }
    else if (ep === '/api/v1/operations/triage' && method === 'POST') { data = { workTypeId: null, workTypeName: null, priority: null, suggestedAssignee: null, similar: [] }; }   // read-only suggestions (POST for the body)
    else {
      assert.ok(method === 'GET' || ep.endsWith('/auth/refresh'), `Unexpected write: ${method} ${ep}`);
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
      else if (ep === '/api/v1/ai/conversations') data = [];
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
  });
  const shot = async (page, name) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(400); await page.screenshot({ path: path.join(out, name) }); };
  const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message)); await page.setViewportSize({ width: 1440, height: 960 });
  const at = () => { const u = new URL(page.url()); return `${u.pathname.replace('/preview-org', '') || '/'}${u.search}${u.hash}`; };

  // The rail: logo, + New, the five places with their labels, the avatar; no sidebar, no top bar, no Customize.
  await page.goto(`${origin}/preview-org/`); await page.locator('.v2-rail').waitFor();
  assert.deepEqual(await page.locator('.v2-rail-item span').allTextContents(), ['Home', 'Work', 'Talk', 'Library', 'Insights']);
  await page.waitForTimeout(500); if (!(await page.locator('.v2-rail').count())) { await page.getByText('Details').click().catch(()=>{}); console.log('ERRORS', errors, await page.locator('body').innerText()); await shot(page, 'fail.png'); }
  assert.equal(Math.round((await page.locator('.v2-rail').boundingBox()).width), 84);
  assert.equal(await page.locator('.sidebar, .topbar').count(), 0, 'no sidebar or top bar');
  assert.equal(await page.getByRole('button', { name: 'Customize' }).count(), 0);
  assert.ok(await page.locator('.v2-rail-item.on', { hasText: 'Home' }).isVisible());
  assert.ok(await page.locator('.v2-ask input[placeholder="Ask, find, or tell it what to do…"]').isVisible(), 'the Ask bar');
  await shot(page, 'rail-home-1440.png'); checks.push('rail');
  await page.locator('.v2-rail-item', { hasText: 'Work' }).click(); await page.waitForTimeout(400);
  assert.equal(at(), '/work'); assert.ok(await page.locator('.v2-rail-item.on', { hasText: 'Work' }).isVisible()); checks.push('rail-navigates');

  // The slim avatar menu: Profile, Workspaces, Settings, People, Help, Sign out (dark mode and team view live in Settings now).
  await page.locator('.v2-avatar').first().click();
  const items = await page.locator('.v2-menu [role="menuitem"]').allInnerTexts();
  for (const want of ['Profile', 'Settings', 'People', 'Sign out']) assert.ok(items.some((t) => t.includes(want)), `avatar menu has ${want}: ${items}`);
  assert.equal(await page.locator('.v2-menu .theme-switch').count(), 0, 'dark mode moved to Settings');
  await shot(page, 'avatar-menu-1440.png');
  await page.locator('.v2-menu [role="menuitem"]', { hasText: 'Settings' }).click(); await page.waitForTimeout(500);
  assert.equal(at(), '/settings/general'); checks.push('avatar-menu');

  // Old addresses: their new place, with the query and #anchor kept.
  const moved = [
    ['/projects/' + project.id + '?task=7#c-1', '/work?item=7#c-1'], ['/projects/' + project.id + '?tab=issues&issue=8', '/work?item=8'], ['/projects/' + project.id + '?tab=board', `/work/projects/${project.id}?tab=board`],
    ['/operations?task=12', '/work?tab=tickets&item=12'], ['/operations?project=p1', '/work?project=p1&tab=tickets&view=queue'], ['/tasks/7', '/work?item=7'], ['/my-work', '/work'],
    ['/chat', '/talk?f=chat'], ['/mailbox', '/talk?f=mail'], ['/meet/past', '/talk?f=meetings&s=past'], ['/calendar', '/?tab=calendar'], ['/reminders', '/?tab=reminders'],
    ['/agents', '/'], ['/project-agent/assigned', '/?tab=given'], ['/ai/operations', '/insights?tab=workflows'], ['/agent-tracker', '/settings/ai/tracker'],
    ['/doctracker?p=1&t=documents', '/library/docs?p=1&t=documents'], ['/vault', '/library/vault'], ['/timesheet/approvals', '/insights?tab=time&s=approvals'],
    ['/workload', '/insights'], ['/reports', '/insights?tab=reports'], ['/portfolio', '/work/projects?view=portfolio'], ['/account/security#s-account.twoStep', '/settings/profile/security#s-account.twoStep'],
    ['/account/resumes', '/settings/profile'], ['/notifications/preferences', '/settings/notifications/delivery'], ['/settings/sso', '/settings/security/sso'],
    ['/settings/labels#s-config.labels', '/settings/fields/labels#s-config.labels'], ['/settings', '/settings/profile'],
  ];
  for (const [from, to] of moved) { await page.goto(`${origin}/preview-org${from}`); for (let i = 0; i < 40 && at() !== to; i++) await page.waitForTimeout(100); assert.equal(at(), to, `${from} moved`); }
  checks.push(`redirects:${moved.length}`);

  // Settings: You (2) and Workspace (8) sections; tabs inside a section.
  await page.goto(`${origin}/preview-org/settings/security`); await page.locator('.set-place-head').waitFor({ timeout: 8000 }).catch(async (e) => { await page.getByText('Details').click().catch(() => {}); console.log(at(), errors, (await page.locator('body').innerText()).slice(0, 600)); throw e; });
  const sections = await page.locator('.section-nav a').allInnerTexts();
  for (const want of ['Profile & sign-in', 'Notifications', 'General', 'People', 'Fields & types', 'Timelines & automation', 'Security & audit', 'Integrations', 'AI', 'Billing']) assert.ok(sections.some((t) => t.trim().startsWith(want)), `Settings has ${want}: ${sections}`);
  assert.equal(sections.length, 10, `ten sections: ${sections}`);
  await page.getByRole('tab', { name: 'Single sign-on' }).click(); await page.waitForTimeout(300); assert.equal(at(), '/settings/security/sso');
  await page.goto(`${origin}/preview-org/settings/profile`); await page.locator('.set-place-head').waitFor();
  assert.ok(!(await page.locator('.set-place-head [role="tab"]').allInnerTexts()).some((t) => /Resume/.test(t)), 'no Resume studio');
  await shot(page, 'settings-profile-1440.png'); checks.push('settings-sections');

  // The AI control centre: the four figures, agent levels saved at once, the model, Teach it with a draft, the MCP address.
  await page.goto(`${origin}/preview-org/settings/ai`); await page.locator('.aic-agents').waitFor();
  const kpis = await page.locator('.aic-kpis .ds-kpi').allInnerTexts();
  assert.ok(kpis[0].includes('351') && kpis[0].includes('1,500'), kpis[0]); assert.ok(kpis[1].includes('79%') && kpis[1].includes('34 failed'), kpis[1]); assert.ok(kpis[2].includes('Empty'));
  assert.equal(await page.locator('.aic-agent').count(), 5);
  await page.locator('.aic-agent', { hasText: 'Ticket triage' }).getByRole('tab', { name: 'Auto' }).click(); await page.waitForTimeout(400);
  assert.deepEqual(writes.at(-1), { ep: '/api/v1/ai/control/agents/triage', b: { level: 'auto' } });
  assert.equal(await page.locator('.aic-agent', { hasText: 'Ticket triage' }).locator('[role="tab"][aria-selected="true"]').innerText(), 'Auto');
  await page.getByRole('button', { name: 'Draft it from my projects' }).click(); await page.waitForTimeout(400);
  assert.ok((await page.locator('.aic-teach textarea').inputValue()).includes('RP Razor pay'));
  assert.ok((await page.locator('.aic-mcp code').innerText()).endsWith('/api/v1/mcp'));
  assert.ok(await page.locator('.aic-model.on', { hasText: 'Google Gemini' }).isVisible(), 'Gemini until a Claude key is added');
  await shot(page, 'ai-control-centre-1440.png'); checks.push('ai-control-centre');

  // + New: words in, "I understood this as a ticket" with chips, created through the one Work API and opened in the side panel.
  await page.goto(`${origin}/preview-org/`); await page.locator('.v2-new').click();
  await page.locator('.v2-new-input input').fill('VPN down for collections team, critical, give to Priya');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.v2-new-type.on').innerText(), 'Ticket');
  assert.ok((await page.locator('.v2-understood-label').innerText()).includes('I understood this as a ticket'));
  const chips = await page.locator('.v2-new-chip b').allInnerTexts();
  assert.ok(chips.includes('Critical') && chips.includes('Priya Nair'), `chips: ${chips}`);
  await shot(page, 'new-ticket-1440.png');
  await page.getByRole('button', { name: 'Create ticket' }).click(); await page.waitForTimeout(500);
  const made = writes.find((w) => w.ep === '/api/v1/work-items');
  assert.equal(made.b.kind, 'ticket'); assert.equal(made.b.priority, 'Critical'); assert.equal(made.b.assigneeId, '00000000-0000-0000-0000-0000000000b2'); assert.equal(made.b.workTypeId, '00000000-0000-0000-0000-0000000000c1');
  assert.equal(await page.locator('.v2-new-sheet').count(), 0);
  await page.locator('.v2-panel').getByText('WT-9 · Ticket').waitFor(); assert.equal(at(), '/work?item=00000000-0000-0000-0000-0000000000f1'); checks.push('new-sheet');
  await page.keyboard.press('Control+k'); assert.ok(await page.locator('.v2-ask input').evaluate((el) => el === document.activeElement), 'Ctrl K puts the cursor in the Ask bar');
  await page.keyboard.press('Control+k'); await page.locator('.cmdk').waitFor(); await page.keyboard.press('Escape'); checks.push('ctrl-k');

  // On a project page the Ask bar is "Ask about <project>" at the bottom right; it opens the copilot panel.
  await page.goto(`${origin}/preview-org/work/projects/${project.id}`); await page.locator('.v2-ask.corner').waitFor();
  await page.locator('.v2-ask.corner', { hasText: 'Ask about Razor pay' }).waitFor();
  await page.locator('.v2-ask.corner').click(); await page.locator('.v2-panel').waitFor();
  assert.ok((await page.locator('.v2-panel h2').innerText()).includes('Razor pay'));
  assert.equal(await page.locator('.v2-panel footer, .v2-panel .modal-footer').count(), 0, 'no Save / Cancel footer');
  await page.waitForTimeout(800); if (await page.getByText('Something went wrong').count()) { await page.getByText('Details').click(); console.log('CRASH', (await page.locator('body').innerText()).slice(0, 800)); }
  await shot(page, 'copilot-1440.png'); await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  assert.equal(await page.locator('.v2-panel').count(), 0); checks.push('copilot');

  // Phone: the five places and + New at the bottom, nothing cut off.
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${origin}/preview-org/work`); await page.locator('.v2-phone-bar').waitFor(); await page.waitForTimeout(500);
  assert.deepEqual(await page.locator('.v2-phone-tab span').allTextContents(), ['Home', 'Work', 'Talk', 'Library', 'Insights']);
  assert.equal(await page.locator('.v2-phone-new').count(), 1);
  await fitsPhone(page, 'work', assert); await shot(page, 'phone-390.png'); checks.push('phone-bar');

  await page.close(); await ctx.close();
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(out, 'checks.json'), JSON.stringify({ checks, writes: writes.length, errors }, null, 2));
  console.log(JSON.stringify({ checks, writes: writes.length, errors }));
} finally { await browser.close(); }
