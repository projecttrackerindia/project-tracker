import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { appCsp } from './lib/csp.mjs';
import { fitsPhone } from './lib/phone.mjs';

// Work › Automations (design s-automations): the When / If / Then sentence with AND conditions (incl. within business hours), numbered
// steps (Assign to, Post in a Messages channel, Tell the customer), "＋ Add condition" / "＋ Add step", the header "N automations on" with
// Save as draft / Turn on, the "Describe it in words" card, the five recipes, and the dry run "would have fired N times last week" with
// per-day bars and "See the N tickets" from the backtest endpoint. 1440 light and dark, 390 phone. Synthetic API only; writes are checked.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/automations-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const g = (n) => `93000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const user = { id: g(1), displayName: 'Prasanna K', email: 'prasanna@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: g(9), slug: 'preview-org', name: 'Preview Org', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 3 };
const members = [[g(1), 'Prasanna K'], [g(2), 'Shiva Kumar'], [g(3), 'Siva Rao']].map(([id, n], i) => ({ userId: id, displayName: n, email: `u${i}@example.test`, role: i ? 'Member' : 'Owner', joinedAt: '2026-01-01T00:00:00Z', jobRole: null }));
const channel = { id: g(60), type: 'Group', name: 'lending-incidents', members: [], lastMessage: null, unread: 0, isMuted: false, canManage: true, otherUserId: null, lastActivityAt: '2026-10-01T00:00:00Z', projectId: null, unreadMentions: 0 };
const base = (o) => ({ projectId: null, whenStatusId: null, whenPriority: null, whenStatusCategory: null, triggerDays: null, actionPriority: null, actionStatusId: null, actionStatusCategory: null,
  actionLabelId: null, actionTarget: 'User', actionUserId: null, actionText: null, actionConversationId: null, moreActions: [], conditions: [], isDraft: false, runCount: 0, lastRunAt: null, conversationName: null, ...o });
const rules = () => [
  base({ id: g(70), name: 'Escalate silent critical tickets', isEnabled: false, isDraft: true, trigger: 'TicketChanged', action: 'SetAssignee', actionUserId: g(2),
    conditions: [{ field: 'priority', value: 'Critical', minutes: null }, { field: 'noReply', value: null, minutes: 30 }, { field: 'businessHours', value: null, minutes: null }],
    moreActions: [base({ action: 'PostToChannel', actionConversationId: g(60), actionTarget: 'User' }), base({ action: 'TellCustomer', actionText: "We're on it — update within 1 hour", actionTarget: 'User' })],
    summary: 'When a Desk ticket is created or updated …' }),
  base({ id: g(71), name: 'Overdue nudge', isEnabled: true, trigger: 'Overdue', triggerDays: 0, action: 'Notify', actionTarget: 'Assignee', summary: 'When an open task becomes overdue, notify the assignee.', runCount: 4, lastRunAt: '2026-10-20T10:00:00Z' }),
];
const day = (i) => { const d = new Date(); d.setDate(d.getDate() - (6 - i)); return d.toISOString().slice(0, 10); };
const backtest = (b) => {
  const counts = b.trigger.startsWith('Ticket') ? [1, 2, 0, 1, 2, 0, 0] : [0, 1, 0, 0, 0, 0, 0];
  const total = counts.reduce((a, c) => a + c, 0);
  return { total, days: counts.map((c, i) => ({ date: day(i), count: c })), note: 'Replayed from tickets created or updated in the last 7 days. Conditions are checked against each item as it is now. Nothing was changed or sent.',
    items: Array.from({ length: total }, (_, i) => ({ id: g(200 + i), key: `WT-${40 + i}`, title: `Payout failing for branch ${i + 1}`, at: new Date(Date.now() - (i + 1) * 864e5).toISOString(), isTicket: true })) };
};

const errors = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const make = async (theme, state) => {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
  await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); }, theme);
  await ctx.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
    if (url.origin !== origin || ep.startsWith('/hubs/')) { await route.abort(); return; }
    if (ep.endsWith('/avatar') || ep.endsWith('/logo/file') || ep.endsWith('/thumbnail')) { await route.fulfill({ status: 404, body: '' }); return; }
    if (!ep.startsWith('/api/')) {
      const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
      await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
      return;
    }
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status < 400 ? { data } : data) });
    if (method !== 'GET' && !ep.endsWith('/auth/refresh')) {
      const b = method === 'DELETE' ? null : req.postDataJSON();
      state.writes.push({ ep, method, b });
      if (ep === '/api/v1/automations/backtest') return json(backtest(b));
      if (ep === '/api/v1/automations' && method === 'POST') { const r = base({ ...b, id: g(90), summary: 'x' }); state.rules.push(r); return json(r, 201); }
      const put = ep.match(/^\/api\/v1\/automations\/([0-9a-f-]{36})$/);
      if (put && method === 'PUT') { const i = state.rules.findIndex((r) => r.id === put[1]); state.rules[i] = base({ ...state.rules[i], ...b }); return json(state.rules[i]); }
      return json(null);
    }
    let data = null;
    if (ep.endsWith('/auth/refresh')) data = { accessToken: `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`, expiresAt: '2099-01-01T00:00:00Z', user };
    else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, reportCount: 0, permissions: ['projects.view', 'projects.edit', 'tasks.view', 'tasks.edit', 'work.view', 'work.create', 'work.edit', 'workflow.manage', 'org.manage'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 0, activity: 3, documents: 3, people: 3, reports: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AUTOMATION: 1 } } };
    else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: true };
    else if (ep === '/api/v1/workspace/members') data = members;
    else if (ep === '/api/v1/automations') data = state.rules;
    else if (/^\/api\/v1\/automations\/[0-9a-f-]{36}\/runs$/.test(ep)) data = [];
    else if (ep === '/api/v1/chat/conversations') data = [channel];
    else if (ep === '/api/v1/labels') data = [];
    else if (ep === '/api/v1/work-items') data = { items: [], offset: 0, limit: 50, hasMore: false };
    else if (ep === '/api/v1/projects') data = { items: [], page: 1, pageSize: 100, totalItems: 0, totalPages: 0 };
    else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
    else if (ep.endsWith('/ai/status')) data = { enabled: false, configured: false, entitled: true, allowedHere: false };
    else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
    else if (ep === '/api/v1/chat/projects/unread') data = [];
    else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  return ctx;
};
const shot = async (page, name) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(600); await page.screenshot({ path: path.join(out, name), fullPage: true, animations: 'disabled' }); };
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => { if (e.type() === 'error' && !e.text().startsWith('Failed to load resource')) errors.push(e.text()); });
};

try {
  for (const theme of ['light', 'dark']) {
    const state = { rules: rules(), writes: [] };
    const ctx = await make(theme, state);
    const page = await ctx.newPage();
    watch(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${origin}/preview-org/work?tab=automations`);
    const main = page.locator('.au-main');
    await main.getByLabel('Automation name').waitFor();
    assert.equal(await main.getByLabel('Automation name').inputValue(), 'Escalate silent critical tickets');
    await page.getByText('Desk · 1 automation on').waitFor();
    await page.getByText(/^Draft · /).waitFor();
    // The sentence: When a ticket is created or updated / If priority is Critical and no agent has replied for 30 minutes and within business hours / Then ① ② ③.
    assert.equal(await main.getByLabel('What the rule acts on').inputValue(), 'ticket');
    assert.equal(await main.getByLabel('Event', { exact: true }).inputValue(), 'TicketChanged');
    await main.getByText('no agent has replied').waitFor();
    await main.getByText('within business hours').waitFor();
    assert.equal(await main.getByLabel('Minutes without a reply').inputValue(), '30');
    assert.equal(await main.getByLabel('Step 1', { exact: true }).inputValue(), 'SetAssignee');
    assert.equal(await main.getByLabel('Step 2', { exact: true }).inputValue(), 'PostToChannel');
    assert.equal(await main.getByLabel('Step 3', { exact: true }).inputValue(), 'TellCustomer');
    assert.equal(await main.getByLabel('Messages channel').inputValue(), g(60));
    assert.match(await main.getByLabel('Step 2', { exact: true }).locator('option:checked').innerText(), /② Post in/);
    // The dry run, from the backtest endpoint.
    await main.getByText('Dry run · would have fired 6 times last week').waitFor();
    assert.equal(await main.locator('.au-bars i').count(), 7);
    assert.ok(state.writes.some((w) => w.ep === '/api/v1/automations/backtest' && w.b.conditions.length === 3 && w.b.isDraft === true), 'backtest sent the flow with its conditions');
    await main.getByRole('button', { name: 'See the 6 tickets' }).click();
    assert.equal(await main.locator('.au-dry-items li').count(), 6);
    // Right column: Describe it in words + the five recipes.
    await page.getByText('Describe it in words').waitFor();
    for (const r of ['Page on-call for outages', 'Mail becomes a ticket', 'Failed test files a bug', 'Close resolved after 3 days', 'Friday status report']) await page.getByText(r, { exact: true }).waitFor();
    if (theme === 'light') await shot(page, 'automations-1440.png'); else await shot(page, 'automations-1440-dark.png');

    if (theme === 'light') {
      // ＋ Add condition (AND) and ＋ Add step, then Save as draft / Turn on.
      await main.getByLabel('Add condition').selectOption('unassigned');
      await main.getByText('nobody is assigned').waitFor();
      await main.getByRole('button', { name: '＋ Add step' }).click();
      assert.equal(await main.getByLabel('Step 4', { exact: true }).inputValue(), 'PostToChannel');
      await main.getByRole('button', { name: 'Remove step 4' }).click();
      await main.getByRole('button', { name: 'Save as draft' }).click();
      await page.getByText(/Saved as a draft/).waitFor();
      const draft = state.writes.filter((w) => w.method === 'PUT').at(-1);
      assert.equal(draft.b.isDraft, true); assert.equal(draft.b.isEnabled, false);
      assert.deepEqual(draft.b.conditions.map((c) => c.field), ['priority', 'noReply', 'businessHours', 'unassigned']);
      assert.equal(draft.b.action, 'SetAssignee'); assert.deepEqual(draft.b.moreActions.map((s) => s.action), ['PostToChannel', 'TellCustomer']);
      await main.getByRole('button', { name: 'Turn on' }).click();
      await page.getByText('Turned on.').waitFor();
      const on = state.writes.filter((w) => w.method === 'PUT').at(-1);
      assert.equal(on.b.isDraft, false); assert.equal(on.b.isEnabled, true);

      // A recipe starts a draft flow.
      await page.getByRole('button', { name: /Close resolved after 3 days/ }).click();
      assert.equal(await main.getByLabel('Automation name').inputValue(), 'Close resolved after 3 days');
      // A real Desk ticket rule: resolved for 3 days → tell the customer on the ticket's channel, then close it.
      assert.equal(await main.getByLabel('Event', { exact: true }).inputValue(), 'TicketResolved');
      assert.equal(await main.getByLabel('Days', { exact: true }).inputValue(), '3');
      assert.equal(await main.getByLabel('Step 1', { exact: true }).inputValue(), 'TellCustomer');
      assert.equal(await main.getByLabel('Step 2', { exact: true }).inputValue(), 'CloseTicket');
      await main.getByText('on the ticket’s WhatsApp or e-mail').waitFor();
      await shot(page, 'automations-close-recipe-1440.png');
      // "Waiting on a reply" counts minutes.
      await main.getByLabel('Event', { exact: true }).selectOption('TicketWaiting');
      assert.equal(await main.getByLabel('Minutes', { exact: true }).inputValue(), '30');

      // Phone: no sideways scroll, the sentence stacks.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('.au-item').first().click();
      await main.getByText(/Dry run · would have fired/).waitFor();
      await page.waitForTimeout(300);
      await fitsPhone(page, 'Automations 390', assert);
      await shot(page, 'automations-390.png');
    }
    await ctx.close();
  }
  // Settings › Automation (the project / workspace rules card): Pause and Edit › Save keep a rule's conditions, draft flag and Messages channel.
  {
    const state = { rules: [base({ id: g(72), name: 'High work to the channel', isEnabled: true, trigger: 'TaskCreated', action: 'PostToChannel', actionConversationId: g(60), actionText: 'New high task',
      conditions: [{ field: 'priority', value: 'High', minutes: null }, { field: 'unassigned', value: null, minutes: null }],
      moreActions: [base({ action: 'Notify', actionTarget: 'Assignee' })], summary: 'When a task is created in any project and priority is High and nobody is assigned, post in #lending-incidents and notify the assignee.' })], writes: [] };
    const ctx = await make('light', state);
    const page = await ctx.newPage();
    watch(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${origin}/preview-org/settings/automation`);
    await page.getByText('High work to the channel').waitFor();
    await page.getByRole('button', { name: 'Pause' }).click();
    await page.waitForFunction(() => true);
    for (let i = 0; i < 40 && !state.writes.some((w) => w.method === 'PUT'); i++) await page.waitForTimeout(100);
    const paused = state.writes.filter((w) => w.method === 'PUT').at(-1);
    assert.equal(paused.b.isEnabled, false);
    assert.deepEqual(paused.b.conditions.map((c) => c.field), ['priority', 'unassigned']);
    assert.equal(paused.b.actionConversationId, g(60));
    assert.deepEqual(paused.b.moreActions.map((x) => x.action), ['Notify']);
    await page.getByRole('button', { name: 'Edit High work to the channel' }).click();
    const cond = page.getByTestId('rule-conditions');
    await cond.getByText('Priority is…').waitFor();
    await cond.getByText('Nobody is assigned').waitFor();
    await cond.getByLabel('Add a condition').click();
    await page.getByRole('option', { name: 'Within business hours' }).click();
    await cond.getByText('Within business hours').waitFor();
    await page.getByTestId('rule-draft').check();
    await shot(page, 'settings-rule-modal-1440.png');
    await page.getByRole('button', { name: 'Save rule' }).click();
    for (let i = 0; i < 40 && state.writes.filter((w) => w.method === 'PUT').length < 2; i++) await page.waitForTimeout(100);
    const saved = state.writes.filter((w) => w.method === 'PUT').at(-1);
    assert.deepEqual(saved.b.conditions.map((c) => c.field), ['priority', 'unassigned', 'businessHours']);
    assert.equal(saved.b.isDraft, true);
    assert.equal(saved.b.action, 'PostToChannel'); assert.equal(saved.b.actionConversationId, g(60));
    await ctx.close();
  }
  assert.deepEqual(errors, [], `console errors: ${errors.join('\n')}`);
  console.log(`verify-automations-ui: ok · screenshots in ${out}`);
} finally {
  await browser.close();
}
