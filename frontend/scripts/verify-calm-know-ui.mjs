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
const bug = (n, title, prio, cat, status, who) => ({ kind: 'issue', id: id(700 + n), key: `BUG-${n}`, title, projectId: id(600), projectKey: 'AT', projectName: 'Atlas', status, category: cat, priority: prio, dueDate: null, isOverdue: false,
  assignee: who ? { id: people[who].userId, name: people[who].displayName } : null, typeName: 'Bug', updatedAt: iso(-30 * n) });
const bugs = [bug(12, 'Refund double-posts on retry', 'Critical', 'Active', 'In progress', 0), bug(9, 'Sign-in loop after password reset', 'Critical', 'Todo', 'Open', 1), bug(5, 'CSV export drops last row', 'Medium', 'Todo', 'Open', 3)];
const detail = (r) => ({ ...r, description: 'Forty people cannot sign in since 10:00. The redirect address changed on Monday.', reporter: { id: id(300), name: 'Contoso Support' }, version: 1, createdAt: iso(-200),
  completedAt: null, loggedMinutes: 0, detail: { can: { edit: true } }, activity: [], channel: r._ch });
let moved = null, role = 'Owner', policyPut = null;
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
  if (process.env.DBG) console.log('api:', method, ep);
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
  else if (ep === '/api/v1/work-items' && url.searchParams.get('kind') === 'issue') data = { items: url.searchParams.get('status') === 'closed' ? [] : bugs, offset: 0, limit: 200, hasMore: false };
  else if (ep === '/api/v1/work-items' && url.searchParams.get('status') === 'closed') data = { items: [], offset: 0, limit: 200, hasMore: false };
  else if (ep === '/api/v1/work-items') data = { items: tickets, offset: 0, limit: 200, hasMore: false };
  else if (ep.startsWith('/api/v1/work-items/')) { const t = tickets.find((r) => ep.endsWith(r.id)); data = t ? detail(t) : null; }
  else if (ep === '/api/v1/activity' || ep.endsWith('/insights/activity')) data = { items: [{ id: id(400), action: 'task.created', summary: 'added the release checklist', actor: { id: id(12), name: 'Cara Lund' }, createdAt: iso(-10) }], page: 1, totalPages: 1, totalItems: 1 };
  else if (ep.endsWith('/projects') || ep.endsWith('/tasks') || ep.endsWith('/work-tasks')) data = { items: [], page: 1, totalPages: 0, totalItems: 0 };
  else if (ep === '/api/v1/documents') data = { items: [{ id: id(500), title: 'Atlas payments spec', key: 'DOC-1', number: 1, typeId: 't-TECH', typeCode: 'TECH', typeName: 'Technical documentation', typeColor: '#4f46e5', typeIcon: 'file', status: 'Published', projectId: id(600), projectKey: 'AT', projectName: 'Atlas', teamId: null, teamName: null, owner: { id: user.id, name: 'Asha Rao' }, visibility: 'Project', classification: 'Internal', tags: [], updatedAt: iso(-90), createdAt: iso(-900), linkedCount: 0 }], nextCursor: null, total: 1 };
  else if (ep === '/api/v1/doctracker/catalog') data = { projects: [{ id: id(600), name: 'Atlas', key: 'AT', endpoints: [], definitions: [], documents: [{ id: id(500), key: 'DOC-1', title: 'Atlas payments spec', typeCode: 'TECH', typeName: 'Technical documentation', typeColor: '#4f46e5', status: 'Published', classification: 'Internal', updatedAt: iso(-90), isApi: false, parentId: null, pageOrder: 0 }], diagrams: 0 }], canCreate: true, isAdmin: true, truncated: 0 };
  else if (ep === '/api/v1/documents/dashboard') data = { total: 1, byStatus: [], byType: [], mine: 1, waitingForMe: 0, updatedThisWeek: 1, notUpdatedIn90Days: 0, unpublished: 0, recent: [] };
  else if (ep === '/api/v1/vault/overview') data = { collections: [{ id: 'c1', name: 'My vault', description: null, kind: 'Personal', projectId: null, projectName: null, teamId: null, teamName: null, myAccess: 'Manage', items: 0, atRisk: 0, requireStepUp: false, rotateEveryDays: null, locked: false, shares: null, sealed: false, rekeyNeeded: false, keyVersion: 0, requireApproval: false, requestable: false }], policy: { stepUpAlways: false, clipboardSeconds: 30, revealSeconds: 10, sharedAdminsOnly: false }, canAdmin: true, canCreateShared: true, health: { total: 0, weak: 0, reused: 0, breached: 0, expired: 0, old: 0, toRotate: 0, score: 100 }, mfaEnabled: true, identity: null, hasPasskeys: false };
  else if (ep === '/api/v1/vault/requests') data = { mine: [], toDecide: [] };
  else if (ep === '/api/v1/vault/keys/circle') data = { circle: null };
  else if (ep === '/api/v1/vault/keys/me') data = { identity: null, unlocks: [] };
  else if (ep === '/api/v1/workload') data = { scope: 'Everyone', available: ['Everyone'], members: people.map((p, i) => ({ userId: p.userId, name: p.displayName, email: `p${i}@example.test`, jobRole: null, level: 0, reportsTo: null, open: 2 + i, overdue: i % 2, doneLast30Days: 3, loggedMinutesLast7Days: 60, nextUp: [], dueThisWeek: 1, openByKind: null })), totals: { people: 5, open: 20, overdue: 2 } };
  else if (ep === '/api/v1/operations/insights') data = { days: 30, open: 3, unassigned: 1, breached: 0, atRisk: 1, compliance: 1, medianResolutionHours: 6, medianResponseMinutes: 18, createdInPeriod: 8, completedInPeriod: 6, weeks: [], aging: [], byTeam: [], byType: [], byPerson: [] };
  else if (ep === '/api/v1/reports/exports' || ep === '/api/v1/ai/operations/jobs' || ep === '/api/v1/ai/operations/schedules') data = [];
  else if (ep === `/api/v1/documents/${id(500)}`) data = { item: { id: id(500), key: 'DOC-1', number: 1, title: 'Atlas payments spec', typeId: 't-TECH', typeCode: 'TECH', typeName: 'Technical documentation', typeColor: '#4f46e5', typeIcon: 'file', projectId: id(600), projectKey: 'AT', projectName: 'Atlas', teamId: null, teamName: null, owner: { id: user.id, name: 'Asha Rao' }, status: 'Published', visibility: 'Project', classification: 'Internal', tags: [], updatedAt: iso(-90), createdAt: iso(-900), linkedCount: 0 }, revision: 1, versionLabel: '1.0', can: { edit: true, delete: true, link: true, share: true, publish: true }, publishedLabel: null, hasUnpublishedChanges: false, viewingPublished: false, sections: [{ key: 'overview', title: 'Overview', kind: 'Rich', sortOrder: 0, content: "{\"type\": \"doc\", \"content\": [{\"type\": \"paragraph\", \"content\": [{\"type\": \"text\", \"text\": \"Atlas moves money between the ledger and the payment gateway. This spec covers how postings, refunds and webhooks behave.\"}]}]}" }, { key: 'ledger', title: 'Ledger', kind: 'Rich', sortOrder: 1, content: "{\"type\": \"doc\", \"content\": [{\"type\": \"paragraph\", \"content\": [{\"type\": \"text\", \"text\": \"Every posting is double-entry and immutable. Corrections are new postings, never edits.\"}]}]}" }, { key: 'payments', title: 'Payments', kind: 'Rich', sortOrder: 2, content: "{\"type\": \"doc\", \"content\": [{\"type\": \"paragraph\", \"content\": [{\"type\": \"text\", \"text\": \"Payments are captured once the gateway confirms them. Pending payments expire after 30 minutes.\"}]}]}" }, { key: 'refunds', title: 'Refunds and idempotency', kind: 'Rich', sortOrder: 3, content: "{\"type\": \"doc\", \"content\": [{\"type\": \"paragraph\", \"content\": [{\"type\": \"text\", \"text\": \"Every refund request carries an idempotency key. The gateway retries failed webhooks with exponential backoff (1s, 4s, 16s, then hourly), and the ledger rejects any posting whose key it has already seen.\"}]}, {\"type\": \"blockquote\", \"content\": [{\"type\": \"paragraph\", \"content\": [{\"type\": \"text\", \"text\": \"Rule: a retry must never create a second refund.\"}]}]}, {\"type\": \"paragraph\", \"content\": [{\"type\": \"text\", \"text\": \"Webhook consumers must return 2xx within 5 seconds, or the gateway treats the delivery as failed.\"}]}]}" }, { key: 'operations', title: 'Operations', kind: 'Rich', sortOrder: 4, content: "{\"type\": \"doc\", \"content\": [{\"type\": \"paragraph\", \"content\": [{\"type\": \"text\", \"text\": \"On-call watches the refund queue depth. Above 500 waiting, page the payments team.\"}]}]}" }, { key: 'rollout', title: 'Rollout', kind: 'Rich', sortOrder: 5, content: "{\"type\": \"doc\", \"content\": [{\"type\": \"paragraph\", \"content\": [{\"type\": \"text\", \"text\": \"Behind a flag for one week, then on for everyone.\"}]}]}" }] };
  else if (ep === `/api/v1/documents/${id(500)}/api`) data = { definitions: [], endpoints: [] };
  else if (ep === `/api/v1/documents/${id(500)}/review`) data = { workflowApplies: false, workflowName: null, stepCount: 0, current: null, history: [], canSubmit: false };
  else if (ep === `/api/v1/documents/${id(500)}/freshness`) data = { stale: false, since: null, reasons: [], lastEditedAt: iso(-90), verifiedAt: null, verifiedBy: null, canVerify: true, summary: 'Edited today' };
  else if (ep === '/api/v1/documents/library-design') data = { customCss: false, sandboxEmbeds: false, canManage: true };
  else if (ep === '/api/v1/document-types') data = [{ id: 't-TECH', code: 'TECH', name: 'Technical documentation', description: null, icon: 'file', color: '#475569', sections: [{ key: 'overview', title: 'Overview', kind: 'Rich', sortOrder: 0, content: '' }, { key: 'ledger', title: 'Ledger', kind: 'Rich', sortOrder: 1, content: '' }, { key: 'payments', title: 'Payments', kind: 'Rich', sortOrder: 2, content: '' }, { key: 'refunds', title: 'Refunds and idempotency', kind: 'Rich', sortOrder: 3, content: '' }, { key: 'operations', title: 'Operations', kind: 'Rich', sortOrder: 4, content: '' }, { key: 'rollout', title: 'Rollout', kind: 'Rich', sortOrder: 5, content: '' }], sortOrder: 0 }];
  else if (ep === '/api/v1/documents/inbox') data = { toReview: [{ approvalId: 'ap1', document: { id: id(500), title: 'Release checklist' }, step: 'Review', state: 'Pending', submittedBy: { id: id(12), name: 'Cara Lund' }, submittedAt: iso(-60), summary: '', dueAt: null, overdue: false }], submitted: [], accessToDecide: [], myAccessRequests: [], waiting: 0 };
  else if (ep === '/api/v1/documents/search') data = { hits: [], total: 0 };
  else if (ep === '/api/v1/approvals/policies') data = [{ type: 'Leave', steps: [{ role: 'Manager' }], expiryHours: null, custom: false }, { type: 'Deployment', steps: [], expiryHours: 48, custom: false }];
  else if (ep.startsWith('/api/v1/approvals/policies/') && method === 'PUT') { policyPut = { ep, b: req.postDataJSON() }; data = { type: ep.split('/').pop(), ...policyPut.b, custom: true }; }
  else if (ep === '/api/v1/public/status/preview') data = { title: 'Preview APIs', workspace: 'Preview Workspace', state: 'operational', updatedAt: iso(-5), source: 'monitors',
    components: ['Payments API', 'Customer portal', 'Webhooks'].map((name, k) => ({ name, state: 'operational', uptime: [99.98, 100, 99.9][k], days: Array.from({ length: 90 }, (_, i) => ({ date: new Date(now - (89 - i) * 864e5).toISOString().slice(0, 10), state: k === 2 && i === 40 ? 'degraded' : 'up' })) })),
    incidents: [{ title: 'Webhook delays', severity: 'minor', startedAt: iso(-60 * 24 * 12), resolvedAt: iso(-60 * 24 * 12 + 18), components: ['Webhooks'] }] };
  else if (ep === '/api/v1/releases') data = [{ id: id(800), name: '2.4', projectId: id(600), projectName: 'Atlas', targetDate: '2026-11-06', status: 'Planned', notes: null, items: 3, runs: 1, approvedBy: null, approvedAt: null, shippedAt: null, createdAt: iso(-9000) }];
  else if (ep === `/api/v1/releases/${id(800)}`) data = { release: { id: id(800), name: '2.4', status: 'Planned' }, items: [{ id: id(712), kind: 'issue', key: 'BUG-12', title: 'Refund double-posts on retry', status: 'In progress', category: 'Active', assignee: null, dueDate: null, bug: true }], runs: [], tests: { run: null, cases: 50, ran: 48, passed: 46, failed: 2, blocked: 0, notRun: 2, passPercent: 96, blockers: [], ready: false }, done: 1, open: 2, openBugs: 1, checks: [], go: false, canApprove: true };
  else if (ep.endsWith('/quality/readiness')) data = { run: null, cases: 1, ran: 1, passed: 1, failed: 0, blocked: 0, notRun: 0, passPercent: 100, blockers: [], ready: true };
  else if (ep.endsWith('/matrix')) data = { runs: [{ id: id(900), name: 'Nightly · build 412', environment: 'staging', build: '412', status: 'Completed', projectId: id(600), createdAt: iso(-600), startedAt: iso(-600), completedAt: iso(-500) }], cases: [{ id: id(901), key: 'TC-1', title: 'Refund once', steps: null, expected: null, priority: 'High', tags: null, projectId: id(600), projectName: 'Atlas', createdAt: iso(-9000), updatedAt: null }], results: [{ id: id(902), runId: id(900), caseId: id(901), status: 'Pass', actual: null, evidence: null, runBy: null, at: iso(-500), linkedWorkItemId: null }] };
  else if (ep.endsWith('/quality/coverage')) data = { days: 30, projects: [{ projectId: id(600), endpoints: 10, covered: 8, linked: 8, untested: 2, percent: 81, untestedIds: [] }] };
  else if (ep === '/api/v1/settings/health') data = { score: 90, checks: [] };
  else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
  else if (ep === '/api/v1/timer') data = null;
  else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
};
const screens = [['desk', '/desk', /tickets? need/], ['quality', '/quality', /open P1 bugs/], ['quality-matrix', '/quality?tab=runs', null], ['insights', '/insights', null], ['reports', '/insights?tab=reports', null], ['activity', '/activity', /happened today|Nothing new|Quiet/],
  ['library', '/library', /Continue reading/], ['doc-reader', `/library/docs/${id(500)}`, null], ['vault', '/library/vault', null], ['people', '/people', /People\./], ['org-chart', '/people/org', /Org chart\./], ['teams', '/people/teams', /Org chart\./], ['settings-owner', '/settings/profile', null], ['status-page', '/status/preview', null]];
const open = async (theme, w, h) => {
  const c = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block', viewport: { width: w, height: h }, isMobile: w < 500, hasTouch: w < 500 });
  await c.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); localStorage.setItem('pm_home_mode', 'classic'); }, theme);
  await c.route('**/*', handler);
  const page = await c.newPage(); page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error' && process.env.DBG) console.log('console:', m.text().slice(0, 300)); });
  return { c, page };
};
const go = async (page, url) => { await page.goto(`${origin}${url.startsWith('/status/') ? '' : '/preview-org'}${url}`); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(700); };
try {
  for (const [theme, w, h, suffix] of (process.env.ONLY ? [['light', 1440, 900, '1440-light']] : null) ?? [['light', 1440, 900, '1440-light'], ['light', 1920, 1080, '1920-light'], ['dark', 1440, 900, '1440-dark'], ['light', 390, 844, '390-light'], ['dark', 390, 844, '390-dark']]) {
    const { c, page } = await open(theme, w, h);
    for (const [name, url, headline] of screens.filter(([n]) => !process.env.ONLY || process.env.ONLY.split(',').includes(n))) {
      await go(page, url);
      assert.equal(await page.getByText('Something went wrong').count(), 0, `${name} ${suffix}: page crashed`);
      if (name === 'doc-reader') {
        assert.match(await page.locator('.rd-col').innerText(), /idempotency key/, `doc-reader ${suffix}: the body renders`);
        if (w > 1180) { await page.getByTestId('doc-outline').locator('li').nth(3).waitFor(); await page.getByTestId('doc-read').waitFor(); }
        else { await page.getByRole('button', { name: /^Outline · / }).click(); await page.getByRole('dialog', { name: 'Outline' }).waitFor(); await page.screenshot({ path: path.join(out, `doc-outline-sheet-${suffix}.png`) }); await page.keyboard.press('Escape'); await page.waitForTimeout(400); }
        assert.ok(await page.getByTestId('doc-comment').isVisible(), `doc-reader ${suffix}: Comment… box`);
      }
      if (headline) assert.match(await page.locator('.calm-hero-title').first().innerText(), headline, `${name}: calm headline`);
      if (w < 500) await fitsPhone(page, `${name} ${suffix}`, assert).catch((e) => { throw new Error(`${name} ${suffix}: ${e.message.split('\n').slice(0, 6).join(' ')}`); });
      if (process.env.DUMP === name) console.log('DUMP', await page.evaluate(() => [...document.querySelector('.rd-page')?.children ?? []].map((e) => `${e.tagName}.${e.className} ${Math.round(e.getBoundingClientRect().top)} ${Math.round(e.getBoundingClientRect().height)}`).join(' | ')));
      const file = path.join(out, `${name}-${suffix}.png`); await page.screenshot({ path: file }); console.log(file);
    }
    await c.close();
  }

  if (process.env.ONLY) { await browser.close(); console.log('calm-know UI checks passed'); process.exit(0); }
  // Org chart: change manager → impact sheet → confirm posts the move.
  { const { c, page } = await open('light', 1440, 900);
    await go(page, '/people/org?layout=canvas');   // the calm canvas (the org chart itself is the earlier lines view again)
    await page.getByRole('button', { name: /^Dev Mora/ }).click();
    await page.getByRole('button', { name: 'Change manager' }).click();
    await page.locator('.co-pick').getByRole('button', { name: /Cara Lund/ }).click();
    await page.getByTestId('org-impact').waitFor();
    await page.screenshot({ path: path.join(out, 'org-move-confirm-1440-light.png') });
    await page.getByRole('button', { name: /^Move Dev/ }).click();
    await page.waitForTimeout(300);
    assert.deepEqual(moved, { kind: 'person', id: id(13), newParentId: id(12) }, 'org move posted');
    await c.close(); }

  // Approval policies (shot 56b): add a step to Deployment, saved through PUT /approvals/policies/Deployment.
  { const { c, page } = await open('light', 1440, 900);
    await go(page, '/settings/approvals');
    await page.getByTestId('approval-policies').locator('.cs-policy').nth(1).locator('select').selectOption('role:Admin');
    await page.getByText('✓ Saved').waitFor();
    assert.deepEqual(policyPut, { ep: '/api/v1/approvals/policies/Deployment', b: { steps: [{ role: 'Admin' }], expiryHours: 48 } }, 'policy saved');
    await page.screenshot({ path: path.join(out, 'approval-policies-1440-light.png') });
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
