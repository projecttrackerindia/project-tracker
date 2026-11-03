import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { invokeAura, openAuraPanel } from './lib/aura.mjs';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// The v2 shell: the 84px rail (logo, + New, the five places, the avatar menu), old addresses landing on their new places with query and
// #anchor kept, + New ("I understood this as a ticket" with chips, creating through /work-items and opening it), the Ask bar (and "Ask about
// <project>" on a project page, opening the copilot panel), the phone's bottom bar, and Settings: ten sections and the AI control centre
// (agent levels, "Draft it from my projects"). Built frontend with synthetic API fixtures only.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/calm-theme');
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
  };

  const shot = async (page, name) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(400); await page.screenshot({ path: path.join(out, name) }); };
  const screens = [['today', '/'], ['inbox', '/inbox'], ['my-work', '/work'], ['projects', '/work/projects'], ['project-detail', `/work/projects/${project.id}`],
    ['portfolio', '/work/projects?view=portfolio'], ['portfolio-timeline', '/work/projects?view=timeline'], ['portfolio-capacity', '/work/projects?view=capacity'], ['plan-sheet', '/work/projects?view=sheet'],
    ['desk', '/desk'], ['desk-ticket', '/desk?ticket=00000000-0000-0000-0000-0000000000f1'], ['calendar', '/calendar'], ['meetings', '/meetings'], ['messages', '/messages'], ['mail', '/mail'],
    ['library', '/library'], ['library-doc', '/library/docs'], ['vault', '/vault'], ['insights', '/insights'], ['people', '/people'], ['settings', '/settings/general'], ['time', '/time']];
  const run = async (theme, w, h, list, suffix) => {
    const c = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block', viewport: { width: w, height: h }, isMobile: w < 500, hasTouch: w < 500 });
    await c.addInitScript((t) => { window.__theme = t; }, theme); await c.addInitScript(init); await c.route('**/*', handler);
    const page = await c.newPage();
    for (const [name, url] of list) {
      const file = path.join(out, `${name}-${suffix}.png`);
      try { await page.goto(`${origin}/preview-org${url}`); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(900); await page.screenshot({ path: file }); console.log(file); }
      catch (e) { console.log('FAIL', name, String(e.message).split('\n')[0]); }
    }
    await c.close();
  };
  await run('light', 1440, 900, screens, '1440-light');
  const three = screens.filter(([n]) => ['today', 'project-detail', 'portfolio'].includes(n));
  await run('dark', 1440, 900, three, '1440-dark');
  await run('light', 390, 844, three, '390-light');
  const so = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await so.route('**/*', async (route) => { if (new URL(route.request().url()).pathname.startsWith('/api/')) { await route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }); return; } await handler(route); });
  const sp = await so.newPage(); await sp.goto(`${origin}/login`); await sp.waitForTimeout(1500);
  await sp.screenshot({ path: path.join(out, 'sign-in-1440-light.png') }); console.log(path.join(out, 'sign-in-1440-light.png'));
} finally { await browser.close(); }
