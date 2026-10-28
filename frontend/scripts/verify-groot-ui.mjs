import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Groot, the assistant: the toolbar Ask field ("Ask Groot or find anything") shows quick-find results while typing and opens the Groot chat;
// the empty chat's suggestions follow the organization's clock (morning: "Plan my day"; evening: "Wrap up my day" and "Check out", which
// fires the groot:checkout hook); a question streams an answer with steps, sources and an action card whose Confirm calls the action
// endpoint; the mascot's data-state changes (greeting → thinking → success); "who are you?" answers as Groot of the workspace; reduced motion
// stops the mascot; dark mode; the phone Ask bar opens a full sheet. Also + New with a pasted paragraph: a short title (≤ 120, Groot's when AI is
// on) and the whole paragraph in the description, and a 422 "too long" message shown as it comes. Built frontend, synthetic API only.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/groot-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Lena Moraes', email: 'lena@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Orbitline Co', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 4, timeZone: 'Asia/Kolkata' };
const project = { id: '00000000-0000-0000-0000-0000000000a1', key: 'FW', name: 'Firewall refresh', status: 'Active', priority: 'High', health: 'OnTrack', progress: 40, version: 1,
  startDate: '2026-10-01', dueDate: '2026-12-19', owner: { id: user.id, name: user.displayName }, stats: { total: 5, done: 2, inProgress: 2, cancelled: 0, todo: 1, overdue: 0 } };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const PARA = 'Hi Team, We will carry out planned security remediation on the network firewall cluster this weekend. Expect short outages between 2 and 4 AM on Saturday. INFRA owns the change and will post updates in the channel; reach out to the on-call engineer with any concerns about critical services before Friday evening so we can plan around them.';
const writes = [], errors = [], checks = [];
const action = (status) => ({ id: 'act-1', kind: 'create_work', title: 'Create ticket: Firewall maintenance window', summary: 'Ticket WT-31 · High · assigned to Lena Moraes', status, link: status === 'done' ? '/work?item=wt-31' : null, error: null, preview: null });
const sse = (events) => events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
const answer = (q) => {
  if (/who are you/i.test(q)) {
    const text = "I'm Groot, Orbitline Co's assistant in ProjectTracker. I can find anything in your workspace, plan your day, and prepare tasks, tickets, reminders and messages for you to confirm.";
    return sse([['started', { conversationId: 'c-1', questionId: 'q-2', title: 'Who are you?' }], ['text', { delta: text }],
      ['done', { message: { id: 'm-2', role: 'assistant', content: text, reasoning: null, tier: null, model: 'builtin-greeting', routeReason: null, credits: 0, status: 'complete', tools: [], actions: [], attachments: [], createdAt: '2026-10-28T04:00:00Z' }, creditsLeft: 100, unlimited: false }]]);
  }
  const text = 'Your morning: **WT-12** is blocking the firewall change, so I prepared a ticket for the maintenance window. Two meetings at 11:00 and 15:00.';
  return sse([
    ['started', { conversationId: 'c-1', questionId: 'q-1', title: 'Plan my day' }],
    ['tool', { id: 't1', tool: 'find_work', label: 'Reading WT-12', state: 'running', count: null }],
    ['tool', { id: 't1', tool: 'find_work', label: 'Reading WT-12', state: 'done', count: 1 }],
    ['tool', { id: 't2', tool: 'propose_create_work', label: 'Creating ticket', state: 'done', count: null }],
    ['action', { action: action('proposed') }],
    ['text', { delta: text.slice(0, 40) }], ['text', { delta: text.slice(40) }],
    ['done', { message: { id: 'm-1', role: 'assistant', content: text, reasoning: null, tier: 'quick', model: 'x', routeReason: null, credits: 1, status: 'complete', tools: [], actions: [action('proposed')], attachments: [], createdAt: '2026-10-28T04:00:00Z',
      followUps: ['What is overdue on my team?'], sources: [{ kind: 'task', id: 'w12', key: 'WT-12', title: 'Firewall rules review', link: '/work?item=w12', version: '1', evidenceAt: '2026-10-28T03:00:00Z' }] }, creditsLeft: 99, unlimited: false }],
  ]);
};
let failFirstCreate = true;

const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const newCtx = async ({ theme = 'light', at = '2026-10-28T03:45:00Z', phone = false, reduced = false } = {}) => {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block', reducedMotion: reduced ? 'reduce' : 'no-preference', ...(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 960 } }) });
  await ctx.clock.setFixedTime(new Date(at));
  await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); localStorage.setItem('pm_home_mode', 'classic'); }, theme);
  await ctx.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
    if (url.origin !== origin) { await route.abort(); return; }
    if (ep.endsWith('/avatar')) { await route.fulfill({ status: 404, body: '' }); return; }
    if (!ep.startsWith('/api/')) {
      const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
      await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
      return;
    }
    if (/^\/api\/v1\/ai\/(conversations\/[^/]+\/)?ask$/.test(ep) && method === 'POST') {
      const b = req.postDataJSON(); writes.push({ ep, b });
      await new Promise((r) => setTimeout(r, 900));   // long enough to see Groot thinking
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: answer(b.text) });
      return;
    }
    let data = [], status = 200;
    if (ep === '/api/v1/ai/messages/m-1/actions/act-1/confirm' && method === 'POST') { writes.push({ ep }); data = action('done'); }
    else if (ep === '/api/v1/ai/title' && method === 'POST') { const b = req.postDataJSON(); writes.push({ ep, b }); data = { title: 'Firewall security remediation this weekend', ai: true }; }
    else if (ep === '/api/v1/work-items' && method === 'POST') {
      const b = req.postDataJSON(); writes.push({ ep, b });
      if (failFirstCreate) { failFirstCreate = false; await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ success: false, data: null, message: 'The title is too long (320 characters). Keep it to 200 characters and put the rest in the description.', errors: [{ code: 'VALIDATION_FAILED', message: 'The title is too long (320 characters). Keep it to 200 characters and put the rest in the description.', field: 'title' }] }) }); return; }
      data = { kind: b.kind, id: 'wt-31', key: 'WT-31', title: b.title, description: b.description, projectId: b.projectId ?? null, status: 'To Do', category: 'Todo', priority: b.priority, version: 1, activity: [], detail: { id: 'wt-31', can: { edit: true, delete: true } } };
      status = 201;
    }
    else if (ep === '/api/v1/operations/triage' && method === 'POST') data = { duplicates: [], assignee: null };
    else {
      assert.ok(method === 'GET' || ep.endsWith('/auth/refresh'), `Unexpected write: ${method} ${ep}`);
      if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
      else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['projects.view', 'projects.edit', 'projects.create', 'tasks.view', 'tasks.edit', 'tasks.create', 'tasks.comment', 'work.create', 'work.view'], modules: { projects: 3, tasks: 3, work: 3, ai: 3, documents: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3 } } };
      else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
      else if (ep === '/api/v1/operations/settings') data = { canManage: true, businessHoursOnly: true, dayStartMinutes: 540, dayEndMinutes: 1080, workDays: [1, 2, 3, 4, 5], timeZone: 'Asia/Kolkata', escalateOnBreach: false, escalateTo: null, rules: [] };
      else if (ep === '/api/v1/workspace/members') data = [{ userId: user.id, displayName: user.displayName, email: user.email, role: 'Owner' }, { userId: '00000000-0000-0000-0000-0000000000b2', displayName: 'Arjun Pillai', email: 'arjun@example.test', role: 'Member' }];
      else if (ep === '/api/v1/work-types') data = [{ id: '00000000-0000-0000-0000-0000000000c1', name: 'Incident', description: null, order: 1, isActive: true, taskCount: 0 }];
      else if (ep === '/api/v1/search') data = { hits: url.searchParams.get('q')?.toLowerCase().startsWith('fire') ? [{ type: 'project', id: project.id, title: 'Firewall refresh', subtitle: 'Project · FW', projectId: project.id, taskId: null }] : [] };
      else if (ep === '/api/v1/projects') data = { items: [project], page: 1, totalPages: 1, totalItems: 1 };
      else if (ep === '/api/v1/work-items') data = { items: [], offset: 0, limit: 200, hasMore: false };
      else if (ep.endsWith('/tasks') || ep.endsWith('/work-tasks')) data = { items: [], page: 1, totalPages: 0, totalItems: 0 };
      else if (ep === '/api/v1/ai/conversations') data = [];
      else if (ep === '/api/v1/ai/starters') data = { greeting: 'Hello', starters: [] };
      else if (ep === '/api/v1/ai/usage') data = { month: '2026-10', creditsUsed: 1, creditsLimit: 1500, creditsLeft: 1499, unlimited: false, maxTier: 'deep', attachments: true, actions: true, tiers: [], attachmentTypes: [], maxFiles: 4, maxImageMb: 5, maxDocumentMb: 10 };
      else if (ep === '/api/v1/timer') data = null;
      else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
      else if (ep.endsWith('/ai/status')) data = { enabled: true, configured: true, entitled: true, allowedHere: true, model: 'm', provider: 'p', backup: null };
      else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
      else if (ep === '/api/v1/agent/command-center') data = { greeting: 'Good morning, Lena', headline: 'Nothing urgent.', since: '2026-10-26T00:00:00Z', counts: { attention: 0, toDecide: 0, dueToday: 0, overdue: 0, blocking: 0, checkIns: 0, meetingsToday: 0, atRisk: 0 }, attention: [], today: [], changes: [], health: [], reliability: { kept: 0, missed: 0, open: 0, moved: 0 }, checkIns: [], owe: [], delegations: [] };
      else if (ep === '/api/v1/chat/projects/unread') data = [];
      else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
    }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page };
};
const shot = async (page, name) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(350); await page.screenshot({ path: path.join(out, name) }); };
const mascot = (page) => page.locator('.groot-chat .gc-head [data-testid="groot-avatar"]');

try {
  // ---------------------------------------------------------------- desktop, morning (09:15 in Asia/Kolkata, a Wednesday)
  {
    const { ctx, page } = await newCtx();
    await page.goto(`${origin}/preview-org/`); await page.locator('.v2-rail').waitFor();
    const field = page.getByRole('toolbar', { name: 'Ask and create' }).getByPlaceholder('Ask Groot or find anything');
    await field.waitFor();
    // Ctrl K still lands in the field; typing shows quick find above any chat.
    await page.keyboard.press('Control+k'); assert.ok(await field.evaluate((el) => el === document.activeElement), 'Ctrl K puts the cursor in the Ask field');
    await field.fill('fire');
    await page.locator('#groot-quick-find').waitFor();
    await page.locator('#groot-quick-find .gq-row', { hasText: 'Ask Groot: “fire”' }).waitFor();
    await page.locator('#groot-quick-find .gq-row', { hasText: 'Firewall refresh' }).waitFor();
    await shot(page, 'quick-find-1440.png');
    await page.keyboard.press('Escape'); checks.push('quick find');

    // The avatar opens the empty chat: a greeting by the organization's clock and morning suggestions.
    await page.getByRole('button', { name: 'Open Groot' }).click();
    const chat = page.locator('.groot-chat'); await chat.waitFor();
    assert.equal(await mascot(page).getAttribute('data-state'), 'greeting', 'Groot waves hello');
    await chat.getByText('Good morning, Lena').waitFor();
    await chat.getByText("I'm Groot, Orbitline Co's assistant.").waitFor();
    const morning = await chat.locator('.gc-sugg .gc-chip').allTextContents();
    assert.ok(morning.includes('Plan my day') && morning.includes("What's blocking my team?"), `morning suggestions: ${morning}`);
    assert.ok(!morning.includes('Check out'));
    const w = (await chat.boundingBox()).width; assert.ok(w >= 400 && w <= 440, `panel ~420px wide (${w})`);
    await shot(page, 'groot-empty-1440.png');
    // Resizable: drag the left edge.
    const edge = await chat.locator('.gc-resize').boundingBox();
    await page.mouse.move(edge.x + 3, edge.y + 200); await page.mouse.down(); await page.mouse.move(edge.x - 80, edge.y + 200, { steps: 4 }); await page.mouse.up();
    assert.ok((await chat.boundingBox()).width > w + 60, 'dragging the edge widens Groot');
    checks.push('empty state');

    // A suggestion asks Groot: thinking while it reads, then the streamed answer with steps, sources and an action card.
    await page.waitForTimeout(2900);   // the greeting wave is over
    await chat.locator('.gc-chip', { hasText: 'Plan my day' }).click();
    await page.waitForFunction(() => document.querySelector('.groot-chat .gc-head [data-testid="groot-avatar"]')?.getAttribute('data-state') === 'thinking');
    assert.equal(await chat.getAttribute('data-state'), 'thinking');
    await chat.getByText('Groot is thinking…').first().waitFor();
    await chat.locator('.gc-md', { hasText: 'is blocking the firewall change' }).waitFor();
    const ask = writes.find((x) => x.ep === '/api/v1/ai/ask'); assert.ok(ask && /^Plan my day/.test(ask.b.text), 'the suggestion was asked');
    assert.deepEqual(await chat.locator('.gc-steps li').allTextContents(), ['Reading WT-12', 'Creating ticket']);
    await chat.locator('.gc-s', { hasText: 'WT-12 Firewall rules review' }).waitFor();
    const card = chat.locator('[data-testid="groot-action"]'); await card.waitFor();
    await card.getByText('Groot suggests').waitFor();
    await page.waitForFunction(() => document.querySelector('.groot-chat .gc-head [data-testid="groot-avatar"]')?.getAttribute('data-state') === 'success');
    await shot(page, 'groot-answer-1440.png');
    await card.getByRole('button', { name: 'Confirm' }).click();
    await card.getByText('✓ Done').waitFor();
    assert.ok(writes.some((x) => x.ep === '/api/v1/ai/messages/m-1/actions/act-1/confirm'), 'Confirm calls the action endpoint');
    checks.push('streamed answer, steps, sources, action card');

    // A follow-up continues the same conversation; "who are you" is Groot of this workspace.
    await chat.getByRole('textbox', { name: 'Ask Groot' }).fill('who are you?');
    await page.keyboard.press('Enter');
    await chat.getByText("I'm Groot, Orbitline Co's assistant in ProjectTracker.", { exact: false }).waitFor();
    assert.ok(writes.some((x) => x.ep === '/api/v1/ai/conversations/c-1/ask'), 'the follow-up stays in the conversation');
    checks.push('identity');
    // History is kept for the session: close and open again.
    await page.keyboard.press('Escape'); await chat.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Open Groot' }).click();
    await page.locator('.groot-chat .gc-me', { hasText: 'who are you?' }).waitFor();
    checks.push('session history');
    await page.keyboard.press('Escape');

    // + New with a pasted paragraph: a short title, the paragraph in the description, and a 422 "too long" shown as sent.
    await page.locator('.v2-tb-new').click();
    await page.getByLabel('What to create').fill(PARA);
    await page.getByRole('radio', { name: 'Task' }).click();
    await page.getByLabel('Change project').selectOption(project.id);
    await page.locator('[data-testid="new-short-title"]', { hasText: 'Groot titled it' }).waitFor();
    await shot(page, 'new-long-text-1440.png');
    await page.locator('.v2-new-create').click();
    await page.getByText('The title is too long (320 characters). Keep it to 200 characters and put the rest in the description.').first().waitFor();
    await page.locator('.v2-new-create').click();
    await page.locator('.v2-new-sheet').waitFor({ state: 'detached' });
    const made = writes.filter((x) => x.ep === '/api/v1/work-items');
    assert.equal(made.length, 2);
    const body = made[1].b;
    assert.equal(body.title, 'Firewall security remediation this weekend');
    assert.ok(body.title.length <= 120);
    assert.equal(body.description, PARA);
    assert.ok(writes.some((x) => x.ep === '/api/v1/ai/title'), 'Groot titled it');
    checks.push('+ New long text');
    await ctx.close();
  }

  // ---------------------------------------------------------------- + New long text with AI off: the first sentence
  {
    const { ctx, page } = await newCtx();
    await ctx.route('**/api/v1/ai/title', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
    failFirstCreate = false;
    await page.goto(`${origin}/preview-org/`); await page.locator('.v2-tb-new').click();
    await page.getByLabel('What to create').fill(PARA);
    await page.getByRole('radio', { name: 'Task' }).click();
    await page.getByLabel('Change project').selectOption(project.id);
    await page.locator('[data-testid="new-short-title"]', { hasText: 'We will carry out planned security remediation on the network firewall cluster this weekend' }).waitFor();
    const before = writes.length;
    await page.locator('.v2-new-create').click(); await page.locator('.v2-new-sheet').waitFor({ state: 'detached' });
    const b = writes.slice(before).find((x) => x.ep === '/api/v1/work-items').b;
    assert.equal(b.title, 'We will carry out planned security remediation on the network firewall cluster this weekend');
    assert.equal(b.description, PARA);
    checks.push('+ New first-sentence title');
    await ctx.close();
  }

  // ---------------------------------------------------------------- evening (18:15), dark: wrap up and the check-out hook
  {
    const { ctx, page } = await newCtx({ theme: 'dark', at: '2026-10-28T12:45:00Z' });
    await page.goto(`${origin}/preview-org/`); await page.getByRole('button', { name: 'Open Groot' }).click();
    const chat = page.locator('.groot-chat'); await chat.waitFor();
    await chat.getByText('Good evening, Lena').waitFor();
    const evening = await chat.locator('.gc-sugg .gc-chip').allTextContents();
    assert.ok(evening.includes('Wrap up my day') && evening.includes('Check out'), `evening suggestions: ${evening}`);
    const bg = await chat.evaluate((el) => getComputedStyle(el).backgroundColor);
    const [r, g, bl] = bg.match(/\d+/g).map(Number); assert.ok(r + g + bl < 200, `dark panel (${bg})`);
    await shot(page, 'groot-evening-dark-1440.png');
    await page.evaluate(() => window.addEventListener('groot:checkout', (e) => { e.preventDefault(); window.__checkout = e.detail.source; }));
    await chat.locator('.gc-chip', { hasText: 'Check out' }).click();
    assert.equal(await page.evaluate(() => window.__checkout), 'groot-chat', 'Check out fires groot:checkout');
    await chat.waitFor({ state: 'detached' });
    checks.push('evening + checkout hook + dark');
    await ctx.close();
  }

  // ---------------------------------------------------------------- reduced motion
  {
    const { ctx, page } = await newCtx({ reduced: true });
    await page.goto(`${origin}/preview-org/`); await page.getByRole('button', { name: 'Open Groot' }).click();
    await page.locator('.groot-chat').waitFor();
    const still = await page.locator('.gc-empty .groot').evaluate((el) => ({ cls: el.className, anim: getComputedStyle(el.querySelector('.gr-float')).animationName }));
    assert.ok(still.cls.includes('still')); assert.equal(still.anim, 'none', 'Groot does not move with reduced motion');
    checks.push('reduced motion');
    await ctx.close();
  }

  // ---------------------------------------------------------------- phone: the Ask bar opens a full sheet
  {
    const { ctx, page } = await newCtx({ phone: true });
    await page.goto(`${origin}/preview-org/`);
    const bar = page.locator('form.v2-ask'); await bar.waitFor();
    await bar.getByPlaceholder('Ask Groot…').fill('Plan my day');
    await bar.getByRole('button', { name: 'Ask Groot' }).click();
    const sheet = page.locator('.groot-chat.phone'); await sheet.waitFor();
    const box = await sheet.boundingBox(); assert.ok(box.width >= 389 && box.x <= 1, 'full-width sheet');
    await sheet.locator('.gc-md', { hasText: 'is blocking the firewall change' }).waitFor();
    await fitsPhone(page, 'Groot sheet', assert);
    await shot(page, 'groot-phone-390.png');
    checks.push('phone sheet');
    await ctx.close();
  }

  assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
  console.log(`verify-groot-ui: ok (${checks.join(', ')})`);
} finally {
  await browser.close();
}
