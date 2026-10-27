import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Projects (v2). /work/projects: the Projects · Portfolio switch, status counts that are also the filter, simple cards (name, status,
// group · owner, one bar, % · due, no chat button), filters only past 10 projects, the likely-duplicate card ("Darwin box Api" / "Darwin Box
// api": Close one, Not a duplicate). Portfolio: the AI summary and a decision card, old date → new date, whose Accept moves the date and shows
// "✓ team told". One project: Overview · Work · Docs · Time · Activity, "+ Add work" (+ New in this project) and ··· (Meet, Chat, Settings,
// Delay risk); the project agent as one switch with its settings in Settings › AI; "Ask about <project>"; every old tab address landing on
// its new tab with query and #anchor. 1440 light and dark, and a 390 phone. Built frontend, synthetic API only.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist');
const out = path.resolve(process.env.PM_UI_ARTIFACTS || 'test-results/enterprise-ui', 'v2-projects');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Prasanna K', email: 'prasanna@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const siva = { id: '00000000-0000-0000-0000-0000000000b2', name: 'Siva Reddy' };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 4 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const pid = (n) => `00000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`;
const mk = (n, key, name, health, progress, due, group = 'Mule Soft', owner = { id: user.id, name: 'Prasanna' }) => ({
  id: pid(n), key, name, description: null, status: health === 'Completed' ? 'Completed' : 'Active', priority: 'High', health, progress, owner, teamId: null, teamName: null,
  startDate: day(-60), dueDate: due, memberCount: 4, version: 1, position: n * 1024, enforceDependencies: false, projectGroupId: group === 'Other' ? 'g2' : 'g1', projectGroupName: group,
  projectType: 'NewProject', deliveryMethod: 'Hybrid', stageScheduleMode: 'Manual', stats: { total: 8, done: Math.round(progress * 8 / 100), inProgress: progress && progress < 100 ? 1 : 0, todo: 2, cancelled: 0, overdue: health === 'Delayed' ? 2 : 0 },
});
const all = [
  mk(1, 'SIA', 's-internal-api', 'AtRisk', 33, day(6)), mk(2, 'SBI', 'SBI bulk payments', 'Delayed', 0, day(-9)), mk(3, 'CRIF', 'CRIF HIGHMARK', 'Delayed', 0, day(-9)),
  mk(4, 'PED', 'Payment Engine DR', 'AtRisk', 20, day(19), 'Mule Soft', siva), mk(5, 'IDFC', 'idfc-qr-callback-api', 'AtRisk', 40, day(3), 'Mule Soft', siva),
  mk(6, 'DBA', 'Darwin box Api', 'Delayed', 0, day(-7), 'Other'), mk(7, 'CIBIL', 'CIBIL Integration', 'OnTrack', 50, day(12)), mk(8, 'AA', 'Account Aggregator', 'OnTrack', 60, day(16)),
  mk(9, 'DDA', 'Dispatch Details API', 'OnTrack', 0, day(24)), mk(10, 'RP', 'Razor pay', 'Completed', 100, day(-34)), mk(11, 'INS', 'Insurance', 'Completed', 100, day(-20)),
  mk(12, 'DBX', 'Darwin Box api', 'Completed', 100, day(-4), 'Other', siva),
];
const few = all.filter((p) => !['Darwin box Api', 'Darwin Box api'].includes(p.name)).slice(0, 6);
let projects = all;
const rp = all.find((p) => p.key === 'RP');
const stages = ['Created', 'Requirements', 'Development', 'Code review', 'Testing', 'UAT', 'Production', 'Completed'].map((name, i) => ({ id: `st${i}`, name, order: i, plannedStart: null, plannedEnd: null, actualStart: null, actualEnd: null,
  status: 'Completed', effectiveStatus: 'Completed', owner: null, assignee: null, description: null, taskTotal: 1, taskDone: 1, locked: false, lockedBy: null, openIssues: 0, totalIssues: 0 }));
const detail = (p) => ({ project: { ...p, description: p.key === 'RP' ? 'Razorpay integration is live in production (v1.0.1): create order and payment status APIs, UPI, card and netbanking.' : null },
  stages: p.key === 'RP' ? stages : [], statuses: [{ id: 's1', name: 'To Do', order: 0, category: 'Todo', color: '#4f46e5' }, { id: 's2', name: 'Done', order: 1, category: 'Done', color: '#34d399' }],
  members: [{ userId: user.id, name: 'Prasanna', email: user.email, role: 'Owner' }, { userId: siva.id, name: siva.name, email: 'siva@example.test', role: 'Member' }] });
const sia = all[0];
const decision = { projectId: sia.id, key: 'SIA', name: 's-internal-api', headline: 'SIA finishes 47 days late.', causes: ['2 of 3 tasks are overdue', 'both wait on the LMS team'], slipDays: 47, dueDate: day(6), finish: day(53), confidence: 'medium', waitingProposals: 0,
  options: [{ id: 'move_person', kind: 'move_person', title: 'Move Siva Reddy onto SIA for a week', effect: '30 days late', finish: day(36), slipDays: 30, steps: ['Give SIA-4 “Separate QR transactions” to Siva Reddy'], why: 'Siva is at 30%.', personId: siva.id },
    { id: 'accept_date', kind: 'accept_date', title: 'Accept the new date', effect: 'on time against the new date', finish: day(53), slipDays: 0, steps: ['Move SIA’s delivery date'], why: '', personId: null }] };
const brief = { asOf: day(0), projects: 9, onTrack: 3, atRisk: 3, delayed: 3, onHold: 0, overdueTasks: 6, blockedTasks: 1, openActionItems: 2, overdueActionItems: 0, dateChangesLast30Days: 1, headlines: [],
  ranked: [{ projectId: sia.id, key: 'SIA', name: 's-internal-api', group: 'Mule Soft', health: 'AtRisk', progress: 33, owner: 'Prasanna', startDate: day(-60), dueDate: day(6), delayedDays: 0, openTasks: 2, overdueTasks: 2, blockedTasks: 0,
    openActionItems: 0, overdueActionItems: 0, finishedLast28Days: 1, inProgressTasks: 1, projectedFinish: day(53), projectedSlipDays: 47, confidence: 'medium', score: 6, level: 'High', reasons: ['2 of 3 tasks are overdue and both wait on the LMS team'] }],
  recentSlips: [], stretched: [] };
const board = () => ({ asOf: day(0), filter: {}, brief, decisions: [decision], summary: '9 active projects: 3 on track, 3 at risk, 3 delayed. 1 decision this week, the biggest: SIA finishes 47 days late.',
  owners: [{ id: user.id, name: 'Prasanna' }], groups: [{ id: 'g1', name: 'Mule Soft' }], money: { entitled: false, showMoney: false, currency: 'INR', budget: 0, spent: 0, forecast: 0, overrunning: 0, projects: [], burn: [], notes: [] },
  capacity: { from: day(0), to: day(27), people: 4, over: [], projectsAtRisk: [], notes: [] } });
const finding = { id: 'f-date', projectId: sia.id, projectKey: 'SIA', projectName: 's-internal-api', runId: 'run-p', kind: 'Decision', status: 'Proposed', title: 'Move SIA’s delivery date', detail: null, evidence: null, sourceLabel: 'Portfolio', source: null,
  taskId: null, taskKey: null, taskTitle: null, issueId: null, issueKey: null, assignee: null, dueDate: day(53), priority: null, newStatus: 'project_due', comment: null, confidence: 100, createdAt: new Date().toISOString(), decidedBy: null, decidedAt: null,
  appliedEntityId: null, appliedKey: null, error: null, grounded: true, edits: null, ownerResponse: null, ownerNote: null, ownerRespondedAt: null };
let agent = { projectId: rp.id, enabled: true, readMailbox: true, readChat: true, readMeetings: true, liveBot: false, dailyUpdates: true, mailboxAddress: 'agent+rp@inbound.example.test', liveBotAvailable: true, aiAvailable: true,
  pending: 1, lastRunAt: new Date().toISOString(), lastError: null, runsThisMonth: 3, monthlyRunLimit: 300, canManage: true, actingUserName: 'Prasanna', runs: [], transcriptAccess: false, instructions: null, speakerAliases: null,
  autoTranscriptAccess: false, captionLanguage: null, autoJoinCalendar: false, sendMinutes: true, slackChannelId: null, slackAvailable: false, readWhatsApp: false, whatsAppAvailable: false,
  autonomyLevel: 2, autoApplyConfidence: 90, autoApplyKinds: [], followUps: true, meetingBriefs: true, monthlyCreditCap: 0, creditsThisMonth: 12 };
const rpFinding = { ...finding, id: 'f-rp', projectId: rp.id, projectKey: 'RP', projectName: 'Razor pay', kind: 'Suggestion', title: 'Add a reconciliation report for refunds', newStatus: null, dueDate: null, sourceLabel: 'Project chat · today', source: 'Chat', confidence: 80 };
const docs = [
  { id: 'd1', key: 'DOC-1', number: 1, title: 'Razorpay Payments API v1.0.1', typeId: 't1', typeCode: 'API', typeName: 'API documentation', typeColor: '#0ea5e9', typeIcon: 'file', projectId: rp.id, projectKey: 'RP', projectName: 'Razor pay', teamId: null, teamName: null,
    owner: { id: user.id, name: 'Prasanna' }, status: 'Published', visibility: 'Workspace', classification: 'Internal', tags: [], updatedAt: `${day(-34)}T10:00:00Z`, createdAt: `${day(-40)}T10:00:00Z`, linkedCount: 0, versionLabel: '1.0', sharedCount: 0 },
  { id: 'd2', key: 'DOC-2', number: 2, title: 'Business requirements (BRD)', typeId: 't2', typeCode: 'BRD', typeName: 'Business requirement document', typeColor: '#7c3aed', typeIcon: 'file', projectId: rp.id, projectKey: 'RP', projectName: 'Razor pay', teamId: null, teamName: null,
    owner: { id: user.id, name: 'Prasanna' }, status: 'Approved', visibility: 'Workspace', classification: 'Internal', tags: [], updatedAt: `${day(-50)}T10:00:00Z`, createdAt: `${day(-55)}T10:00:00Z`, linkedCount: 0, versionLabel: '1.0', sharedCount: 0 },
];
const files = [{ id: 'a1', projectId: rp.id, taskId: null, taskKey: null, taskTitle: null, fileName: 'razorpay-postman-collection.json', contentType: 'application/json', sizeBytes: 18000, uploadedBy: { id: user.id, name: 'Prasanna' }, createdAt: `${day(-30)}T10:00:00Z`, canDelete: true, isImage: false, issueId: null }];
const writes = [], errors = [], checks = [];

const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const make = async (theme = 'light') => {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
  await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); if (!localStorage.getItem('pm_theme_set')) { localStorage.setItem('pm_theme', t); localStorage.setItem('pm_theme_set', '1'); } }, theme);
  await ctx.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
    if (url.origin !== origin || ep.startsWith('/hubs/')) { await route.abort(); return; }
    if (ep.endsWith('/avatar') || ep.endsWith('/logo/file') || ep.includes('/brand/')) { await route.fulfill({ status: 404, body: '' }); return; }
    if (!ep.startsWith('/api/')) {
      const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
      await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
      return;
    }
    const body = method === 'GET' || method === 'DELETE' ? null : (() => { try { return req.postDataJSON(); } catch { return null; } })();
    if (method !== 'GET' && !ep.endsWith('/auth/refresh')) writes.push({ ep, method, body });
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status < 300 ? { data } : data) });
    const proj = /^\/api\/v1\/projects\/([0-9a-f-]{36})(\/.*)?$/.exec(ep);
    const p = proj && projects.concat(all).find((x) => x.id === proj[1]);
    let data = [];
    if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
    else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['projects.view', 'projects.edit', 'projects.create', 'projects.delete', 'tasks.view', 'tasks.create', 'tasks.edit', 'tasks.comment', 'reports.view', 'reports.broad', 'org.manage', 'work.view', 'work.create', 'documents.view', 'workflow.manage'], modules: { projects: 3, tasks: 3, work: 3, documents: 3, activity: 3, ai: 3, reports: 3, calendar: 3, people: 3, members: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3 } } };
    else if (ep === '/api/v1/me/ui/sidebar') data = { key: 'sidebar', value: null, updatedAt: null };
    else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
    else if (ep === '/api/v1/workspace/members') data = [{ userId: user.id, displayName: 'Prasanna', email: user.email, role: 'Owner' }, { userId: siva.id, displayName: siva.name, email: 'siva@example.test', role: 'Member' }];
    else if (ep === '/api/v1/projects' && method === 'GET') { const ps = Number(url.searchParams.get('pageSize') ?? 25), pg = Number(url.searchParams.get('page') ?? 1); const items = projects.slice((pg - 1) * ps, pg * ps); data = { items, page: pg, pageSize: ps, totalItems: projects.length, totalPages: Math.ceil(projects.length / ps) }; }
    else if (proj && proj[2] === '/move' && method === 'PATCH') { const x = { ...projects.find((y) => y.id === proj[1]), status: body.status }; projects = projects.filter((y) => y.id !== x.id || x.status !== 'Archived'); data = x; }
    else if (proj && !proj[2] && p) data = detail(p);
    else if (proj && proj[2] === '/agent' && method === 'PUT') { agent = { ...agent, ...body }; data = agent; }
    else if (proj && proj[2] === '/agent') data = { ...agent, projectId: proj[1], pending: agent.enabled ? 1 : 0 };
    else if (proj && proj[2] === '/agent/findings') data = proj[1] === sia.id ? { items: [finding], pending: 1, canDecide: true } : { items: agent.enabled ? [rpFinding] : [], pending: 1, canDecide: true };
    else if (proj && proj[2] === '/agent/autonomy') data = { projectId: proj[1], level: 2, minDecisions: 30, minRate: 95, kinds: [], hints: [] };
    else if (proj && proj[2] === '/activity') data = { items: [{ id: 'act1', action: 'project.due_changed', summary: 'moved the due date to 23 Sep', actor: { id: user.id, name: 'Prasanna' }, createdAt: new Date().toISOString() }], page: 1, pageSize: 20, totalItems: 1, totalPages: 1 };
    else if (proj && proj[2] === '/attachments') data = proj[1] === rp.id ? files : [];
    else if (proj && proj[2] === '/time') data = { totalMinutes: 1260, estimatedHours: 40, byPerson: [{ userId: user.id, name: 'Prasanna', minutes: 900 }, { userId: siva.id, name: siva.name, minutes: 360 }], topTasks: [{ taskId: 't1', key: 'RP-1', title: 'Create order API', minutes: 600, estimatedHours: 12 }] };
    else if (proj && (proj[2] === '/tasks')) data = { items: [], page: 1, pageSize: 500, totalItems: 0, totalPages: 0 };
    else if (proj && proj[2] === '/issues') data = [];
    else if (ep === '/api/v1/documents') data = { items: url.searchParams.get('projectId') === rp.id ? docs : [], nextCursor: null, total: url.searchParams.get('projectId') === rp.id ? docs.length : 0 };
    else if (ep === '/api/v1/linked-documents') data = { items: [], restricted: 0 };
    else if (ep === '/api/v1/attachments/limits') data = { maxFileBytes: 10_000_000, allowedExtensions: ['json', 'pdf', 'png'], storageUsedBytes: 0, storageLimitBytes: -1 };
    else if (ep === '/api/v1/portfolio/board') data = board();
    else if (ep === '/api/v1/portfolio/timeline') data = { from: day(-60), to: day(60), projects: [] };
    else if (ep === `/api/v1/portfolio/decisions/${sia.id}/apply`) data = { proposals: 1, message: '1 proposal is waiting in SIA › Agent for approval.', findingIds: [finding.id] };
    else if (ep === `/api/v1/agent/findings/${finding.id}/approve`) data = { ...finding, status: 'Applied', decidedBy: { id: user.id, name: 'Prasanna' }, appliedKey: 'SIA' };
    else if (ep === '/api/v1/portfolio/summary') data = { text: 'SIA is the one to watch: two tasks wait on the LMS team.', model: 'synthetic', at: new Date().toISOString(), cached: false };
    else if (ep === '/api/v1/ai/portfolio/brief') data = brief;
    else if (ep === '/api/v1/project-groups') data = [{ id: 'g1', name: 'Mule Soft' }, { id: 'g2', name: 'Other' }];
    else if (ep.endsWith('/ai/status')) data = { enabled: true, configured: true, entitled: true, allowedHere: true, model: 'synthetic', provider: 'Synthetic', backup: null };
    else if (ep === '/api/v1/ai/conversations') data = [];
    else if (ep === '/api/v1/ai/starters') data = { greeting: 'Hello', starters: [] };
    else if (ep === '/api/v1/ai/provider-status') data = { active: false, provider: null, providerName: null, agreed: false, agreedAt: null, fallbackToPlatform: true, notice: null };
    else if (/^\/api\/v1\/ai\/projects\/[^/]+\/risk$/.test(ep)) data = { risk: 'low', score: 12, headline: 'Delivered on time.', reasons: [], actions: [], generatedAt: new Date().toISOString() };
    else if (ep === '/api/v1/chat/projects/unread') data = [];
    else if (ep === '/api/v1/timer') data = null;
    else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
    else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
    else if (ep === '/api/v1/notifications/counts') data = { unread: 0, needsYou: 0, forInfo: 0, snoozed: 0 };
    else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
    await json(data);
  });
  return ctx;
};
const shot = async (page, name, full = false) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(300); await page.screenshot({ path: path.join(out, name), fullPage: full }); };
const at = (page) => { const u = new URL(page.url()); return `${u.pathname.replace('/preview-org', '')}${u.search}${u.hash}`; };
const waitUrl = async (page, test, what) => { for (let i = 0; i < 60 && !test(at(page)); i++) await page.waitForTimeout(100); assert.ok(test(at(page)), `${what}: ${at(page)}`); };
const waitWrite = async (test) => { for (let i = 0; i < 60 && !writes.some(test); i++) await new Promise((r) => setTimeout(r, 100)); return writes.find(test); };

try {
  // ---------------------------------------------------------------- Projects, 1440 light
  let ctx = await make('light'); let page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/preview-org/work/projects`);
  await page.locator('.pj2-card').first().waitFor();
  const sw = page.getByRole('tablist', { name: 'Projects or portfolio' });
  assert.deepEqual(await sw.getByRole('tab').allInnerTexts(), ['Projects', 'Portfolio']);
  assert.equal(await sw.getByRole('tab', { name: 'Projects' }).getAttribute('aria-selected'), 'true');
  assert.ok(await page.locator('.pj2-back', { hasText: 'Work' }).isVisible(), '‹ Work above the title');
  checks.push('switch');

  // Status counts, which are the filter.
  const stats = page.getByRole('group', { name: 'Status' });
  assert.deepEqual(await stats.locator('.pj2-stat').evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim())), ['12 All', '3 On track', '3 At risk', '3 Delayed', '3 Completed']);
  assert.equal(await stats.locator('.pj2-stat.on').innerText().then((t) => t.replace(/\s+/g, ' ')), '12 All');
  assert.equal(await page.locator('.pj2-card').count(), 12);
  await stats.locator('.pj2-stat', { hasText: 'At risk' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.pj2-card').length === 3);
  assert.deepEqual((await page.locator('.pj2-card .pj2-pill').allInnerTexts()).sort(), ['At risk', 'At risk', 'At risk']);
  assert.ok(at(page).includes('status=AtRisk'), 'the filter is in the address');
  await stats.locator('.pj2-stat', { hasText: 'Completed' }).click();
  await page.waitForFunction(() => location.search.includes('status=Completed') && [...document.querySelectorAll('.pj2-card .pj2-pill')].every((p) => !/At risk/.test(p.textContent ?? '')) && document.querySelectorAll('.pj2-card').length === 3);
  assert.deepEqual((await page.locator('.pj2-card .pj2-name').allInnerTexts()).sort(), ['Darwin Box api', 'Insurance', 'Razor pay']);
  await stats.locator('.pj2-stat', { hasText: 'All' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.pj2-card').length === 12);
  checks.push('status-filters');

  // A simple card: name and status, group · owner, one bar, % · due. No chat button on a card.
  const card = page.locator('.pj2-card[data-project="s-internal-api"]');
  assert.equal(await card.locator('.pj2-name').innerText(), 's-internal-api');
  assert.equal(await card.locator('.pj2-pill').innerText(), 'At risk');
  assert.equal(await card.locator('.pj2-sub').innerText(), 'Mule Soft · Prasanna');
  assert.equal(await card.locator('.pj2-bar').count(), 1);
  assert.match(await card.locator('.pj2-foot').innerText(), /^33% · due \d{1,2} [A-Z][a-z]{2}$/);
  assert.equal(await page.locator('.pj2-card .pchat-btn, .pj2-card [aria-label*="chat" i]').count(), 0, 'no chat button on the cards');
  checks.push('cards');

  // Past 10 projects the filters show: search narrows the cards.
  // v2: search is always there; the one Filter chip appears past 10 projects.
  const filters = page.getByRole('group', { name: 'Search and filter' });
  assert.ok(await filters.locator('.pj2-filter-chip').isVisible(), 'Filter chip with 12 projects');
  await filters.getByLabel('Search projects').fill('darwin');
  await page.waitForFunction(() => document.querySelectorAll('.pj2-card').length === 2);
  await filters.getByLabel('Search projects').fill('');
  await page.waitForFunction(() => document.querySelectorAll('.pj2-card').length === 12);
  checks.push('filters-past-10');

  // The likely duplicate: "Darwin box Api" and "Darwin Box api".
  const dupe = page.locator('.pj2-dupe');
  assert.equal(await dupe.count(), 1);
  assert.match(await dupe.innerText(), /Likely duplicate: “Darwin box Api” and “Darwin Box api”/);
  assert.match(await dupe.innerText(), /Merge or close/);
  assert.equal(await dupe.locator('.v2-spark').count(), 1, 'an AI card (✦, violet)');
  await shot(page, 'projects-1440-light.png', true);
  await dupe.getByRole('button', { name: 'Close one' }).click();
  await dupe.getByRole('button', { name: /Close “Darwin box Api”/ }).click();
  await page.locator('.modal').getByRole('button', { name: 'Close it' }).click();
  const closed = await waitWrite((w) => w.ep === `/api/v1/projects/${pid(6)}/move`);
  assert.equal(closed.body.status, 'Archived');
  await page.waitForFunction(() => document.querySelectorAll('.pj2-card').length === 11);
  assert.equal(await page.locator('.pj2-dupe').count(), 0, 'closing one clears the flag');
  checks.push('duplicate-close-one');
  // "Not a duplicate" is remembered for the workspace.
  projects = all.map((x) => ({ ...x, status: x.health === 'Completed' ? 'Completed' : 'Active' }));
  await page.reload(); await page.locator('.pj2-dupe').waitFor();
  await page.locator('.pj2-dupe').getByRole('button', { name: 'Not a duplicate' }).click();
  await page.locator('.pj2-dupe').waitFor({ state: 'detached' });
  await page.reload(); await page.locator('.pj2-card').first().waitFor(); await page.waitForTimeout(300);
  assert.equal(await page.locator('.pj2-dupe').count(), 0, 'not flagged again after a reload');
  checks.push('duplicate-not-a-duplicate');

  // The list view is still there (···), and New project.
  await page.getByRole('button', { name: 'More on Projects' }).click();
  const menu = page.getByRole('menu', { name: 'More on Projects' });
  assert.deepEqual(await menu.getByRole('menuitem').locator('b').allInnerTexts(), ['New project', 'Show as cards', 'Show as a list', 'Show as a board']);
  await menu.getByRole('menuitem', { name: /Show as a list/ }).click();
  await page.locator('.pj2-list tbody tr').first().waitFor();
  assert.equal(await page.locator('.pj2-list tbody tr').count(), 12);
  await page.getByRole('button', { name: 'More on Projects' }).click();
  await page.getByRole('menu', { name: 'More on Projects' }).getByRole('menuitem', { name: /Show as cards/ }).click();
  await page.locator('.pj2-card').first().waitFor();
  await page.getByRole('button', { name: 'More on Projects' }).click();
  await page.getByRole('menu', { name: 'More on Projects' }).getByRole('menuitem', { name: /New project/ }).click();
  await page.getByRole('dialog').waitFor(); await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' });
  checks.push('list-view-and-new-project');

  // Ten or fewer projects: no filters.
  projects = few;
  await page.reload(); await page.locator('.pj2-card').first().waitFor();
  assert.equal(await page.getByRole('group', { name: 'Filters' }).count(), 0, 'no filters with 6 projects');
  assert.equal(await page.locator('.pj2-dupe').count(), 0);
  projects = all.map((x) => ({ ...x }));
  checks.push('no-filters-under-10');

  // ---------------------------------------------------------------- Portfolio
  await page.goto(`${origin}/preview-org/work/projects`); await page.locator('.pj2-card').first().waitFor();
  await page.getByRole('tablist', { name: 'Projects or portfolio' }).getByRole('tab', { name: 'Portfolio' }).click();
  await waitUrl(page, (u) => u === '/work/projects?view=portfolio', 'the switch keeps the view in the address');
  const summary = page.getByRole('region', { name: 'Summary' });
  await summary.waitFor();
  assert.equal(await summary.locator('.v2-ai-card').count(), 1, 'the summary is an AI card');
  assert.ok((await summary.innerText()).trim().length > 0, 'one sentence');
  await summary.getByRole('button', { name: 'Write it for the meeting' }).click();
  await summary.getByText('SIA is the one to watch').waitFor();
  checks.push('portfolio-ai-summary');
  const dec = page.locator('.pf-dec[data-project="SIA"]');
  const dm = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]}`; };
  assert.equal(await dec.locator('.pf-dec-dates s').innerText(), dm(day(6)), 'the old date');
  assert.equal(await dec.locator('.pf-dec-dates b').innerText(), dm(day(53)), 'the forecast');
  { const t = await dec.innerText(); assert.match(t, /47 days late/); assert.match(t, /s-internal-api/); }
  assert.equal(await page.locator('.pj2-portfolio .pj2-dupe').count(), 0, 'dismissed duplicates stay dismissed on Portfolio too');
  await shot(page, 'portfolio-1440-light.png', true);
  await dec.getByRole('button', { name: 'What changes' }).click();
  assert.ok(await dec.getByText('Move Siva Reddy onto SIA for a week').isVisible());
  await dec.getByRole('button', { name: `Propose ${dm(day(53))}` }).click();
  await dec.getByText('✓ proposed').waitFor();
  const applied = writes.find((w) => w.ep === `/api/v1/portfolio/decisions/${sia.id}/apply`);
  assert.equal(applied.body.option, 'accept_date');
  checks.push('decision-accept-team-told');
  await page.getByRole('button', { name: 'More on Portfolio' }).click();
  const pmenu = (await page.getByRole('menu', { name: 'More on Portfolio' }).getByRole('menuitem').locator('b').allInnerTexts()).join(' | ');
  for (const want of ['Filters', 'Export to Excel', 'Export to PDF', 'Action items', 'Send me this', 'Risk review']) assert.ok(pmenu.includes(want), `portfolio ··· has ${want}: ${pmenu}`);
  await page.keyboard.press('Escape');
  checks.push('portfolio-menu');

  // Old portfolio addresses: the board → Portfolio; one project → its one project page.
  await page.goto(`${origin}/preview-org/portfolio`); await waitUrl(page, (u) => u === '/work/projects?view=portfolio', '/portfolio');
  await page.goto(`${origin}/preview-org/portfolio?project=${rp.id}`); await waitUrl(page, (u) => u === `/work/projects/${rp.id}`, '/portfolio?project=');
  await page.goto(`${origin}/preview-org/project-status?project=${rp.id}&actions=1`); await waitUrl(page, (u) => u === `/work/projects/${rp.id}?tab=work&kind=action`, '/project-status?project=&actions=1');
  checks.push('portfolio-redirects');

  // ---------------------------------------------------------------- one project
  await page.goto(`${origin}/preview-org/work/projects/${rp.id}`);
  await page.locator('.pp-head h1').waitFor();
  assert.equal(await page.locator('.pp-head h1').innerText(), 'Razor pay');
  assert.ok(await page.locator('.pp-head .pj2-back', { hasText: 'Projects' }).isVisible());
  assert.match(await page.locator('.pp-meta').innerText(), /RP · Mule Soft[\s\S]*Completed[\s\S]*Prasanna · 4 people/);
  const tabs = page.getByRole('tablist', { name: 'Project' });
  assert.deepEqual(await tabs.getByRole('tab').allInnerTexts(), ['Overview', 'Work', 'Docs', 'Time', 'Activity']);
  assert.equal(await tabs.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected'), 'true');
  // The six old header buttons are gone; their jobs are under ···.
  for (const old of ['Meet', 'Chat', 'Settings', 'Schedule studio', 'Delay risk', 'Add task']) assert.equal(await page.locator('.pp-head').getByRole('button', { name: old, exact: true }).count(), 0, `no ${old} button in the head`);
  checks.push('project-head');
  // Overview: the AI summary, the completion ring, the stage chips and the key numbers.
  const ov = page.getByRole('region', { name: 'Summary' });
  assert.equal(await ov.locator('.v2-ai-card').count(), 1);
  assert.match(await ov.innerText(), /Razorpay integration is live in production[\s\S]*All 8 tasks done/);
  assert.deepEqual(await ov.locator('.pp-chips .ds-pill').allInnerTexts(), ['API doc · published', 'BRD · approved']);
  assert.equal(await page.locator('.pp-ring .ds-ring').getAttribute('aria-label'), '100% of the tasks done');
  assert.match(await page.locator('.pp-ring').innerText(), /100%[\s\S]*8 of 8 tasks[\s\S]*Completed/);
  assert.deepEqual(await page.locator('.pp-stage').allInnerTexts(), ['✓ Created', '✓ Requirements', '✓ Development', '✓ Code review', '✓ Testing', '✓ UAT', '✓ Production', '✓ Completed']);
  assert.deepEqual(await page.locator('.pp-kpis .ds-kpi .l').allInnerTexts(), ['Open work', 'Overdue', 'Open issues', 'People']);
  await shot(page, 'project-overview-1440-light.png', true);
  checks.push('tab-overview');

  // ···: Meet, Chat, Settings, Delay risk first, then the rarer actions.
  await page.getByRole('button', { name: 'More on this project' }).click();
  const more = page.getByRole('menu', { name: 'More on this project' });
  const items = await more.getByRole('menuitem').locator('b').allInnerTexts();
  assert.deepEqual(items.slice(0, 4), ['Meet', 'Chat', 'Settings', 'Delay risk'], items.join(', '));
  for (const want of ['Edit details', 'Import tasks from CSV', 'Delete project']) assert.ok(items.includes(want), `··· has ${want}`);
  await more.getByRole('menuitem', { name: /^Settings/ }).click();
  await page.getByRole('dialog').waitFor(); assert.ok(at(page).includes('settings=members'));
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'More on this project' }).click();
  await page.getByRole('menu', { name: 'More on this project' }).getByRole('menuitem', { name: /^Delay risk/ }).click();
  await page.getByRole('dialog').getByText('Delivered on time.').waitFor();
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'More on this project' }).click();
  await page.getByRole('menu', { name: 'More on this project' }).getByRole('menuitem', { name: /^Meet/ }).click();
  await waitUrl(page, (u) => u.startsWith('/talk') && u.includes(`project=${rp.id}`), 'Meet opens the project’s meetings in Talk');
  await page.goBack(); await page.locator('.pp-head h1').waitFor();
  checks.push('dots-menu');

  // + Add work: + New, already in this project.
  await page.getByRole('button', { name: 'Add work' }).click();
  await page.locator('.v2-new-sheet').waitFor();
  assert.equal(await page.locator('.v2-new-type.on').innerText(), 'Task');
  assert.ok((await page.locator('.v2-new-chip').allInnerTexts()).some((t) => /Project\s*Razor pay/.test(t)), 'the project chip');
  assert.match(await page.locator('.v2-understood p').innerText(), /Adds it to Razor pay/);
  await page.keyboard.press('Escape'); await page.locator('.v2-new-sheet').waitFor({ state: 'detached' });
  checks.push('add-work');

  // Work.
  await tabs.getByRole('tab', { name: 'Work' }).click();
  await waitUrl(page, (u) => u.endsWith('?tab=work'), 'Work');
  await page.locator('.pp-body[data-tab="work"]').waitFor(); await page.waitForTimeout(300);
  assert.ok((await page.locator('.pp-body[data-tab="work"]').innerText()).trim().length > 0, 'the Work tab shows the project’s work');
  checks.push('tab-work');
  // Docs: documents and files in one list; no filters with 3 items.
  await tabs.getByRole('tab', { name: 'Docs' }).click();
  await page.locator('.pp-doc-rows .lib-row').first().waitFor();
  assert.deepEqual(await page.locator('.pp-doc-rows .lib-row').evaluateAll((els) => els.map((e) => `${e.querySelector('.lib-kind').textContent} ${e.getAttribute('data-doc')}`)),
    ['File razorpay-postman-collection.json', 'API Razorpay Payments API v1.0.1', 'Doc Business requirements (BRD)']);
  assert.equal(await page.getByLabel('Search docs and files').count(), 0, 'no search with 3 items');
  assert.ok(await page.getByRole('button', { name: 'New document or file' }).isVisible(), 'one + New in Docs');
  checks.push('tab-docs');
  // Time.
  await tabs.getByRole('tab', { name: 'Time' }).click();
  await page.locator('.pp-body[data-tab="time"]').getByText('Prasanna').first().waitFor();
  checks.push('tab-time');
  // Activity: the project agent as one switch with a link to its settings, its proposals, and the history.
  await tabs.getByRole('tab', { name: 'Activity' }).click();
  const sw2 = page.getByRole('switch', { name: 'Project agent' });
  await sw2.waitFor();
  assert.equal(await sw2.getAttribute('aria-checked'), 'true');
  const link = page.getByRole('link', { name: 'Set how the agent behaves ›' });
  assert.equal(await link.getAttribute('href'), `/preview-org/settings/ai/project-agent?project=${rp.id}`);
  await page.getByText('Add a reconciliation report for refunds').waitFor();
  await page.getByText('moved the due date to 23 Sep').waitFor();
  assert.equal(await page.locator('.pp-body').getByText('What it reads').count(), 0, 'the agent’s settings are not on the project');
  await sw2.click(); const off = await waitWrite((w) => w.ep === `/api/v1/projects/${rp.id}/agent` && w.method === 'PUT');
  assert.equal(off.body.enabled, false);
  await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Project agent"]')?.getAttribute('aria-checked') === 'false');
  await sw2.click(); await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Project agent"]')?.getAttribute('aria-checked') === 'true');
  await shot(page, 'project-activity-1440-light.png', true);
  checks.push('tab-activity-agent-switch');
  // Settings › AI › Project agent keeps every control the Agent tab had.
  await link.click();
  await waitUrl(page, (u) => u === `/settings/ai/project-agent?project=${rp.id}`, 'Set how the agent behaves');
  await page.getByText('What it reads').waitFor();
  for (const want of ['Project mailbox', 'Live meeting bot', 'Minutes by e-mail (MOM)', 'Morning updates', 'Autonomy', 'Observer', 'Delegate', 'Accuracy', 'Project email address', 'Add transcript', 'Read new now']) {
    assert.ok(await page.getByText(want, { exact: true }).first().isVisible(), `Settings › AI › Project agent has ${want}`);
  }
  assert.ok(await page.getByText('Use my Google account').isVisible(), 'the Google account for transcripts');
  assert.equal(await page.getByRole('tablist', { name: 'AI settings' }).getByRole('tab', { name: 'Project agent' }).getAttribute('aria-selected'), 'true');
  await shot(page, 'settings-project-agent-1440.png', true);
  checks.push('agent-settings-in-settings-ai');

  // Ask about <project>: the floating pill opens the copilot about it.
  await page.goto(`${origin}/preview-org/work/projects/${rp.id}`); await page.locator('.pp-head h1').waitFor();
  const ask = page.locator('.v2-ask.corner', { hasText: 'Ask about Razor pay' }); await ask.waitFor();
  await ask.click(); await page.locator('.v2-panel').waitFor();
  assert.match(await page.locator('.v2-panel h2').innerText(), /Ask about Razor pay/);
  await page.keyboard.press('Escape'); await page.locator('.v2-panel').waitFor({ state: 'detached' });
  checks.push('ask-about-project');

  // Old tab addresses land on the new tab, keeping the query and the #anchor.
  const old = [
    [`/work/projects/${rp.id}/board`, `/work/projects/${rp.id}?tab=work&view=board`],
    [`/work/projects/${rp.id}/list`, `/work/projects/${rp.id}?tab=work&view=list`],
    [`/work/projects/${rp.id}/plan`, `/work/projects/${rp.id}?tab=work&view=timeline`],
    [`/work/projects/${rp.id}/issues?issue=i1#x`, `/work/projects/${rp.id}?issue=i1&tab=work&kind=issue#x`],
    [`/work/projects/${rp.id}/action-items`, `/work/projects/${rp.id}?tab=work&kind=action`],
    [`/work/projects/${rp.id}/documents`, `/work/projects/${rp.id}?tab=docs`],
    [`/work/projects/${rp.id}/files`, `/work/projects/${rp.id}?tab=docs&type=file`],
    [`/work/projects/${rp.id}/time`, `/work/projects/${rp.id}?tab=time`],
    [`/work/projects/${rp.id}/agent#runs`, `/work/projects/${rp.id}?tab=activity#runs`],
    [`/work/projects/${rp.id}/activity`, `/work/projects/${rp.id}?tab=activity`],
    [`/work/projects/${rp.id}?tab=board&q=x`, `/work/projects/${rp.id}?tab=work&q=x&view=board`],
    [`/work/projects/${rp.id}?tab=actions&action=a1`, `/work/projects/${rp.id}?tab=work&action=a1&kind=action`],
    [`/work/projects/${rp.id}?tab=files`, `/work/projects/${rp.id}?tab=docs&type=file`],
    [`/work/projects/${rp.id}?tab=agent`, `/work/projects/${rp.id}?tab=activity`],
    [`/work/projects/${rp.id}?tab=team`, `/work/projects/${rp.id}?settings=members`],
    [`/projects/${rp.id}`, `/work/projects/${rp.id}`],
    [`/projects/${rp.id}?tab=issues`, `/work/projects/${rp.id}?tab=work&kind=issue`],
    [`/projects/${rp.id}/documents?x=1#top`, `/work/projects/${rp.id}?x=1&tab=docs#top`],
  ];
  for (const [from, to] of old) {
    await page.goto(`${origin}/preview-org${from}`);
    await waitUrl(page, (u) => u === to, `${from} → ${to}`);
  }
  await page.locator('.pp-head h1').waitFor();
  assert.equal(await page.getByRole('tablist', { name: 'Project' }).getByRole('tab', { name: 'Docs' }).getAttribute('aria-selected'), 'true');
  checks.push('old-tab-redirects');
  await ctx.close();

  // ---------------------------------------------------------------- dark mode
  projects = all.map((x) => ({ ...x }));
  ctx = await make('dark'); page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/preview-org/work/projects`); await page.locator('.pj2-card').first().waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  const bg = await page.locator('.pj2-card').first().evaluate((e) => getComputedStyle(e).backgroundColor);
  const [r, g, b] = bg.match(/\d+/g).map(Number); assert.ok(r + g + b < 150, `dark cards: ${bg}`);
  const text = await page.locator('.pj2-card .pj2-name').first().evaluate((e) => getComputedStyle(e).color);
  assert.ok(text.match(/\d+/g).map(Number).slice(0, 3).reduce((a, c) => a + c) > 600, `light text on dark: ${text}`);
  await shot(page, 'projects-1440-dark.png', true);
  await page.goto(`${origin}/preview-org/work/projects?view=portfolio`); await page.locator('.pf-dec').first().waitFor(); await shot(page, 'portfolio-1440-dark.png', true);
  await page.goto(`${origin}/preview-org/work/projects/${rp.id}`); await page.locator('.pp-ring').waitFor(); await shot(page, 'project-1440-dark.png', true);
  checks.push('dark-mode');
  await ctx.close();

  // ---------------------------------------------------------------- phone, 390
  ctx = await make('light'); page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/preview-org/work/projects`); await page.locator('.pj2-card').first().waitFor(); await page.waitForTimeout(400);
  await fitsPhone(page, 'projects', assert); await shot(page, 'projects-390.png', true);
  await page.goto(`${origin}/preview-org/work/projects?view=portfolio`); await page.locator('.pf-dec').first().waitFor(); await page.waitForTimeout(400);
  await fitsPhone(page, 'portfolio', assert); await shot(page, 'portfolio-390.png', true);
  for (const t of ['', '?tab=work', '?tab=docs', '?tab=time', '?tab=activity']) {
    await page.goto(`${origin}/preview-org/work/projects/${rp.id}${t}`); await page.locator('.pp-head h1').waitFor(); await page.waitForTimeout(500);
    await fitsPhone(page, `project ${t || 'overview'}`, assert);
    // Nothing covers content: the Ask pill sits beside the page, the bottom bar under it, and both clear the last line.
    const covered = await page.evaluate(() => {
      const pill = document.querySelector('.v2-ask.corner')?.getBoundingClientRect();
      const actions = document.querySelector('.pp-actions')?.getBoundingClientRect();
      return !!pill && !!actions && pill.top < actions.bottom && pill.bottom > actions.top;
    });
    assert.equal(covered, false, 'the Ask pill does not cover the head');
  }
  await page.goto(`${origin}/preview-org/work/projects/${rp.id}`); await page.locator('.pp-ring').waitFor(); await shot(page, 'project-390.png', true);
  checks.push('phone-390');
  await ctx.close();

  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(out, 'checks.json'), JSON.stringify({ checks, writes: writes.length, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors }));
} finally { await browser.close(); }
