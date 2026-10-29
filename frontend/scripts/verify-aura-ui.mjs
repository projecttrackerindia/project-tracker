import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Aura, the assistant as a glowing orb (mock.html §1–4, 6; orb.html): the dock at the bottom centre of every page (glass pill: orb + "Ask Aura
// or tell it what to do"), on desktop and phone; no + New anywhere (header, sidebar, phone top bar); Ctrl K focuses the dock; the chips above
// it (Create a task, Log time, Schedule a meeting, Raise a ticket, Write a doc, More…) open the create flows; asking shows the orb thinking with
// step lines at once; a proposal is a plan card (Do it / Edit / Cancel), unknown action kinds shown by title; the header's check-in capsule in
// its five states (not checked in, office, home, overtime, done); Reduce Motion still draws the orb; the phone dock sits above the tab bar,
// steps aside while scrolling down, comes back on scroll up, and is hidden in a Messages conversation. Built frontend, synthetic API only.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/aura-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Mira Okafor', email: 'mira@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Lumen Fields', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 4, timeZone: 'Asia/Kolkata' };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const today = '2026-10-28', at = (hm) => new Date(`${today}T${hm}:00+05:30`).toISOString();
const policy = { enabled: true, hoursSource: 'workspace', workDays: '1,2,3,4,5', workStart: '09:30', workEnd: '18:30', checkInGraceMinutes: 30, checkOutGraceMinutes: 30, autoClose: true,
  autoCloseAfterHours: 4, allowedModes: ['Office', 'Home', 'ClientSite'], requireClientPlace: true, promptAtSignIn: false, timeZone: 'Asia/Kolkata' };
const rec = (o) => ({ id: 'a1', userId: user.id, userName: user.displayName, date: today, checkOutAt: null, place: null, note: null, source: 'web', autoClosed: false, minutes: 0, checkOutLocal: null, ...o });
/** The capsule's states, by the record today. */
const RECORDS = {
  none: null,
  office: rec({ mode: 'Office', checkInAt: at('09:20'), checkInLocal: '09:20' }),
  home: rec({ mode: 'Home', checkInAt: at('11:00'), checkInLocal: '11:00' }),
  overtime: rec({ mode: 'Office', checkInAt: at('06:00'), checkInLocal: '06:00' }),
  done: rec({ mode: 'Office', checkInAt: at('09:10'), checkInLocal: '09:10', checkOutAt: at('17:14'), checkOutLocal: '17:14', minutes: 484 }),
};
let record = RECORDS.office;
const sse = (events) => events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
const act = (id, kind, title, summary) => ({ id, kind, title, summary, status: 'proposed', link: null, error: null, preview: null });
const answer = () => {
  const actions = [act('a-1', 'update_task_due', 'Move LUM-14 to Fri 30 Oct', 'Due date: Thu 29 Oct → Fri 30 Oct'), act('a-2', 'send_message', 'Tell Tomas Ilves in Messages', '"LUM-14 moved to Friday."'),
    act('a-3', 'future_thing_aura_learns', 'Archive the old sprint board', 'A kind of action this screen has never seen')];
  const msg = { id: 'm-1', role: 'assistant', content: "Here's what I'll do:", reasoning: null, tier: 'quick', model: 'x', routeReason: null, credits: 1, status: 'complete', tools: [], actions, attachments: [], createdAt: '2026-10-28T04:00:00Z' };
  return sse([['started', { conversationId: 'c-1', questionId: 'q-1', title: 'Move LUM-14' }], ['tool', { id: 't1', tool: 'find_work', label: 'Reading LUM-14', state: 'done', count: 1 }],
    ...actions.map((a) => ['action', { action: a }]), ['text', { delta: "Here's what I'll do:" }], ['done', { message: msg, creditsLeft: 99, unlimited: false }]]);
};
const errors = [], checks = [];

const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const newCtx = async ({ theme = 'light', phone = false, reduced = false } = {}) => {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block', reducedMotion: reduced ? 'reduce' : 'no-preference',
    ...(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } }) });
  await ctx.clock.setFixedTime(new Date(at('15:10')));
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
      await new Promise((r) => setTimeout(r, 1500));
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: answer() });
      return;
    }
    let data = [];
    if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
    else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['projects.view', 'projects.edit', 'projects.create', 'tasks.view', 'tasks.edit', 'tasks.create', 'work.create', 'work.view', 'documents.view', 'documents.create'], modules: { projects: 3, tasks: 3, work: 3, ai: 3, documents: 3, calendar: 3, chat: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3 } } };
    else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
    else if (ep === '/api/v1/me/attendance/today') data = { date: today, timeZone: 'Asia/Kolkata', localTime: '15:10', workStart: '09:30', workEnd: '18:30', workingDay: true, onLeave: false, holiday: null, shouldPrompt: false, record, recentPlaces: [], canViewTeam: false, policy };
    else if (ep.endsWith('/ai/status')) data = { enabled: true, configured: true, entitled: true, allowedHere: true, model: 'm', provider: 'p', backup: null };
    else if (ep === '/api/v1/ai/usage') data = { month: '2026-10', creditsUsed: 1, creditsLimit: 1500, creditsLeft: 1499, unlimited: false, maxTier: 'deep', attachments: true, actions: true, tiers: [], attachmentTypes: [], maxFiles: 4, maxImageMb: 5, maxDocumentMb: 10 };
    else if (ep === '/api/v1/ai/starters') data = { greeting: 'Hello', starters: [] };
    else if (ep === '/api/v1/operations/settings') data = { canManage: true, businessHoursOnly: true, dayStartMinutes: 570, dayEndMinutes: 1110, workDays: [1, 2, 3, 4, 5], timeZone: 'Asia/Kolkata', escalateOnBreach: false, escalateTo: null, rules: [] };
    else if (ep === '/api/v1/workspace/members') data = [{ userId: user.id, displayName: user.displayName, email: user.email, role: 'Owner' }];
    else if (ep === '/api/v1/work-types') data = [{ id: '00000000-0000-0000-0000-0000000000c1', name: 'Incident', description: null, order: 1, isActive: true, taskCount: 0 }];
    else if (ep === '/api/v1/search') data = { hits: [] };
    else if (ep === '/api/v1/projects') data = { items: [], page: 1, totalPages: 0, totalItems: 0 };
    else if (ep === '/api/v1/work-items') data = { items: [], offset: 0, limit: 200, hasMore: false };
    else if (ep.endsWith('/tasks') || ep.endsWith('/work-tasks')) data = { items: [], page: 1, totalPages: 0, totalItems: 0 };
    else if (ep === '/api/v1/timer') data = null;
    else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
    else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
    else if (ep === '/api/v1/agent/command-center') data = { greeting: 'Good afternoon, Mira', headline: 'Nothing urgent.', since: '2026-10-26T00:00:00Z', counts: { attention: 0, toDecide: 0, dueToday: 0, overdue: 0, blocking: 0, checkIns: 0, meetingsToday: 0, atRisk: 0 }, attention: [], today: [], changes: [], health: [], reliability: { kept: 0, missed: 0, open: 0, moved: 0 }, checkIns: [], owe: [], delegations: [] };
    else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page };
};
const shot = async (page, name) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(400); await page.screenshot({ path: path.join(out, name) }); };
const dock = (page) => page.getByTestId('aura-dock');
const field = (page) => dock(page).getByPlaceholder('Ask Aura or tell it what to do');
/** Visible buttons or links that are a generic "+ New" (the create sheet with no kind): there must be none. */
const plusNew = (page) => page.evaluate(() => [...document.querySelectorAll('button, a, [role="button"]')].filter((el) => {
  const r = el.getBoundingClientRect(); if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') return false;
  const t = (el.textContent || '').replace(/\s+/g, ' ').trim(), a = el.getAttribute('aria-label') || '';
  return /^(\+|＋)?\s*New$/.test(t) || a === 'New' || el.matches('.v2-tb-new, .v2-rail-new, .m-new');
}).map((el) => el.outerHTML.slice(0, 80)));
/** The orb's canvas has light in it (it is drawn, not blank). */
const lit = (loc) => loc.evaluate((c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n++; return n; });

try {
  // ---------------------------------------------------------------- desktop: the dock on every page, the header, no + New
  {
    const { ctx, page } = await newCtx();
    for (const where of ['', 'calendar', 'work', 'desk', 'messages']) {
      await page.goto(`${origin}/preview-org/${where}`); await page.locator('.v2-rail').waitFor();
      await field(page).waitFor();
      await page.waitForTimeout(600);
      const box = await dock(page).locator('form.v2-ask').boundingBox();
      assert.ok(box.y + box.height > 900 - 40 && box.y + box.height <= 900, `/${where}: the dock sits at the bottom (${box.y + box.height})`);
      const main = await page.locator('.v2-main').boundingBox();
      assert.ok(Math.abs(box.x + box.width / 2 - (main.x + main.width / 2)) < 12, `/${where}: centred in the main area (${box.x + box.width / 2} vs ${main.x + main.width / 2})`);
      assert.ok(box.width >= 560 && box.width <= 624, `/${where}: ~620px wide (${box.width})`);
      assert.equal(await dock(page).locator('[data-testid="aura-orb"] canvas').count(), 1, `/${where}: the orb in the dock`);
      assert.deepEqual(await plusNew(page), [], `/${where}: no + New`);
      assert.equal(await page.locator('.v2-tb input, .v2-tb [role="search"]').count(), 0, `/${where}: no Ask bar in the header`);
      await page.locator('.v2-tb [data-ncx-bell]').waitFor();
      if (!where) await shot(page, 'dock-today-1440.png');
    }
    checks.push('dock on Today, Calendar, Work, Desk, Messages; no + New; header without Ask');

    // Ctrl K focuses the dock (⌘K on a Mac); the orb listens; chips appear above.
    await page.goto(`${origin}/preview-org/`); await field(page).waitFor();
    for (let i = 0; i < 10 && !(await field(page).evaluate((el) => el === document.activeElement)); i++) { await page.keyboard.press('Control+k'); await page.waitForTimeout(300); }
    assert.ok(await field(page).evaluate((el) => el === document.activeElement), 'Ctrl K focuses the dock');
    assert.equal(await dock(page).locator('[data-testid="aura-orb"]').getAttribute('data-mood'), 'listen', 'the orb listens');
    const chips = await page.locator('.aura-chip').allTextContents();
    assert.deepEqual(chips, ['Create a task', 'Log time', 'Schedule a meeting', 'Raise a ticket', 'Write a doc', 'More…']);
    await page.keyboard.type('Move LUM-14 to Friday');
    await shot(page, 'dock-typing-1440.png');
    checks.push('Ctrl K, listen, chips');

    // Each chip opens its create flow (the words typed carry over).
    const kinds = [['task', 'Task'], ['meeting', 'Meeting'], ['ticket', 'Ticket'], ['doc', 'Doc'], ['time', null], ['more', null]];
    for (const [chip, radio] of kinds) {
      if (!(await field(page).evaluate((el) => el === document.activeElement))) await field(page).click();
      await page.locator(`.aura-chip[data-chip="${chip}"]`).click();
      const sheet = page.locator('.v2-new-sheet'); await sheet.waitFor();
      if (chip === 'task') assert.equal(await page.getByLabel('What to create').inputValue(), 'Move LUM-14 to Friday');
      if (radio) assert.equal(await sheet.getByRole('radio', { name: radio, exact: true }).getAttribute('aria-checked'), 'true', `${chip}: ${radio} chosen`);
      if (chip === 'ticket') assert.equal(await page.getByText('Notify on WhatsApp').count(), 0, 'WhatsApp stays hidden');
      if (chip === 'more') await shot(page, 'chip-more-1440.png');
      await page.getByLabel('What to create').focus(); await page.keyboard.press('Escape'); await sheet.waitFor({ state: 'detached' });
    }
    checks.push('chips open task, meeting, ticket, doc, time and the full chooser');

    // Asking: the chat opens on the right with the orb thinking and step lines at once; then a plan card.
    await field(page).click(); await field(page).fill('Move LUM-14 to Friday and tell Tomas'); await page.keyboard.press('Enter');
    const chat = page.locator('.groot-chat'); await chat.waitFor();
    await chat.locator('[data-testid="aura-thinking"] [data-testid="aura-orb"][data-mood="think"]').waitFor({ timeout: 500 });
    assert.ok((await chat.locator('[data-testid="aura-thinking"] .gc-steps li').count()) >= 1, 'step lines while waiting');
    assert.equal(await dock(page).isVisible(), false, 'the dock steps aside while the chat is open');
    await shot(page, 'chat-thinking-1440.png');
    const plan = chat.locator('[data-testid="aura-plan"]'); await plan.waitFor();
    assert.match(await plan.innerText(), /3 changes/i);
    assert.equal(await plan.locator('[data-testid="aura-action"]').count(), 3);
    await plan.locator('[data-testid="aura-action"][data-kind="future_thing_aura_learns"]', { hasText: 'Archive the old sprint board' }).waitFor();
    for (const b of ['Do it', 'Edit', 'Cancel']) await plan.getByRole('button', { name: b }).waitFor();
    await plan.getByRole('button', { name: 'Edit' }).click();
    assert.equal(await chat.getByRole('textbox', { name: 'Ask Aura' }).inputValue(), 'Move LUM-14 to Friday and tell Tomas', 'Edit puts the request back to change');
    await shot(page, 'chat-plan-1440.png');
    checks.push('chat: think at once, plan card with unknown kinds, Edit');
    await ctx.close();
  }

  // ---------------------------------------------------------------- the check-in capsule: five states
  {
    const { ctx, page } = await newCtx();
    const want = { none: /^Check in$/, office: /Office\s*·\s*5h 50m/, home: /Home\s*·\s*4h 10m/, overtime: /Overtime\s*·\s*9h 10m/, done: /Done\s*·\s*8h 4m/ };
    for (const [state, text] of Object.entries(want)) {
      record = RECORDS[state];
      await page.goto(`${origin}/preview-org/calendar`);
      const cap = page.locator('.v2-tb [data-testid="att-capsule"]'); await cap.waitFor();
      assert.equal(await cap.getAttribute('data-state'), state);
      assert.match((await cap.innerText()).replace(/\s+/g, ' ').trim(), text, `${state}: ${await cap.innerText()}`);
      assert.equal(await cap.locator('.att-ring').count(), state === 'none' ? 0 : 1, `${state}: ring`);
      await cap.click();
      const day = page.locator('[data-testid="att-day"]'); await day.waitFor();
      if (state === 'none') { await day.getByRole('button', { name: 'Check in' }).waitFor(); assert.equal(await day.getByRole('radio', { name: 'Office' }).getAttribute('aria-checked'), 'true'); }
      else if (state === 'done') { assert.match(await day.innerText(), /Done for today/); assert.equal(await day.getByRole('button', { name: /Check (in|out)/ }).count(), 0); }
      else { await day.getByRole('button', { name: 'Check out' }).waitFor(); await day.locator('[data-testid="att-now"]').waitFor(); }
      if (state === 'office') { assert.match(await day.innerText(), /Working from the office/); await shot(page, 'capsule-office-1440.png'); }
      await page.keyboard.press('Escape');
    }
    record = RECORDS.office;
    checks.push('capsule: not checked in, office, home, overtime, done');
    await ctx.close();
  }

  // ---------------------------------------------------------------- dark mode
  {
    const { ctx, page } = await newCtx({ theme: 'dark' });
    await page.goto(`${origin}/preview-org/`); await field(page).waitFor();
    const bg = await dock(page).locator('form.v2-ask').evaluate((el) => getComputedStyle(el).backgroundColor);
    const [r, g, b] = bg.match(/\d+/g).map(Number); assert.ok(r + g + b < 200, `dark glass dock (${bg})`);
    await field(page).click();
    await shot(page, 'dock-dark-1440.png');
    checks.push('dark');
    await ctx.close();
  }

  // ---------------------------------------------------------------- reduced motion: the orb is still drawn
  {
    const { ctx, page } = await newCtx({ reduced: true });
    await page.goto(`${origin}/preview-org/`); await field(page).waitFor();
    const cv = dock(page).locator('[data-testid="aura-orb"] canvas');
    await page.waitForTimeout(800);
    assert.ok((await lit(cv)) > 300, 'the orb is drawn with Reduce Motion');
    checks.push('reduced motion renders');
    await ctx.close();
  }

  // ---------------------------------------------------------------- phone
  {
    const { ctx, page } = await newCtx({ phone: true });
    await page.goto(`${origin}/preview-org/`); await field(page).waitFor();
    const d = await dock(page).locator('form.v2-ask').boundingBox(), tabs = await page.locator('.v2-phone-bar').boundingBox();
    assert.ok(d.y + d.height <= tabs.y - 4, `the dock sits above the tab bar (${d.y + d.height} / ${tabs.y})`);
    assert.ok(d.x >= 15 && d.x + d.width <= 375, 'the dock keeps the 16px gutters');
    assert.deepEqual(await plusNew(page), [], 'no + New on the phone');
    await page.locator('.m-top [data-testid="att-capsule"]').waitFor();
    assert.match(await page.locator('.m-top [data-testid="att-capsule"]').innerText(), /^\s*5h 50m\s*$/, 'phone capsule: ring and hours');
    await fitsPhone(page, 'Today with the dock', assert);
    await shot(page, 'dock-phone-390.png');
    // the page ends above the dock: the content's bottom padding covers the tab bar and the dock
    const pad = await page.locator('main.content').evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
    assert.ok(pad >= 844 - d.y, `the page has room under its last row (${pad} ≥ ${844 - d.y})`);
    // scrolling down hides it, scrolling up brings it back
    await page.evaluate(() => { const s = document.createElement('div'); s.style.height = '3000px'; s.id = 'aura-spacer'; document.querySelector('main.content').appendChild(s); });
    await page.mouse.wheel(0, 0);
    for (let i = 0; i < 6; i++) { await page.evaluate(() => window.scrollBy(0, 120)); await page.waitForTimeout(60); }
    await page.waitForTimeout(400);
    assert.equal(await dock(page).evaluate((el) => getComputedStyle(el).opacity), '0', 'hidden while scrolling down');
    for (let i = 0; i < 3; i++) { await page.evaluate(() => window.scrollBy(0, -120)); await page.waitForTimeout(60); }
    await page.waitForTimeout(400);
    assert.equal(await dock(page).evaluate((el) => getComputedStyle(el).opacity), '1', 'back on scroll up');
    // the chips on a phone, and the chat as a full sheet
    await field(page).click();
    assert.equal(await page.locator('.aura-chip').count(), 6);
    await shot(page, 'dock-chips-phone-390.png');
    await field(page).fill('Move LUM-14 to Friday'); await page.keyboard.press('Enter');
    const sheet = page.locator('.groot-chat.phone'); await sheet.waitFor();
    await sheet.locator('[data-testid="aura-thinking"]').waitFor({ timeout: 500 });
    await sheet.locator('[data-testid="aura-plan"]').waitFor();
    await fitsPhone(page, 'Aura sheet', assert);
    await shot(page, 'chat-plan-phone-390.png');
    await page.locator('.gc-head').getByRole('button', { name: 'Close Aura' }).click();
    // a Messages conversation: no dock
    await page.goto(`${origin}/preview-org/messages/00000000-0000-0000-0000-0000000000d1`); await page.waitForTimeout(1200);
    assert.equal(await dock(page).count(), 0, 'no dock inside a conversation');
    checks.push('phone: above the tab bar, padding, hides on scroll, chips, sheet, not in a conversation');
    await ctx.close();
  }

  assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
  console.log(`verify-aura-ui: ok (${checks.join('; ')})`);
} finally {
  await browser.close();
}
