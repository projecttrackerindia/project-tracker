import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Aura, Siri style (scratchpad aura-bar-options, option 2): nothing of Aura takes space at rest (desktop: the "Aura ⌘K" hint in the toolbar;
// phone: the orb in the top bar), no reserved bottom padding; ⌘K / Ctrl K, the hint or the phone orb bring up the edge glow (mood colours,
// no pointer events) and the floating glass capsule with suggestions; Esc and a click outside dismiss; asking raises the answer card above
// the capsule with plan → Do it → Undo; on a phone the capsule sits above the tab bar / keyboard. Built frontend, synthetic API only.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/aura-siri-ui');
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
  const actions = [act('a-1', 'update_task_due', 'Move LUM-14 to Fri 30 Oct', 'Due date: Thu 29 Oct → Fri 30 Oct')];
  const msg = { id: 'm-1', role: 'assistant', content: "Here's what I'll do:", reasoning: null, tier: 'quick', model: 'x', routeReason: null, credits: 1, status: 'complete', tools: [], actions, attachments: [], createdAt: '2026-10-28T04:00:00Z' };
  return sse([['started', { conversationId: 'c-1', questionId: 'q-1', title: 'Move LUM-14' }], ['tool', { id: 't1', tool: 'find_work', label: 'Reading LUM-14', state: 'done', count: 1 }],
    ...actions.map((a) => ['action', { action: a }]), ['text', { delta: "Here's what I'll do:" }], ['done', { message: msg, creditsLeft: 99, unlimited: false }]]);
};
const errors = [], checks = [], calls = [];

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
      await new Promise((r) => setTimeout(r, 400));
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: answer() });
      return;
    }
    const am = /^\/api\/v1\/ai\/messages\/[^/]+\/actions\/([^/]+)\/(confirm|undo|dismiss)$/.exec(ep);
    if (am && method === 'POST') {
      calls.push(`${am[2]}:${am[1]}`);
      const status = am[2] === 'confirm' ? 'done' : am[2] === 'undo' ? 'undone' : 'dismissed';
      const data = { ...act(am[1], 'update_task_due', 'Move LUM-14 to Fri 30 Oct', 'Due date: Thu 29 Oct → Fri 30 Oct'), status, undoUntil: status === 'done' ? '2099-01-01T00:00:00Z' : null };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
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
const shot = async (page, name) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(1200); await page.evaluate(() => document.getAnimations().forEach((a) => { if (a.effect?.getTiming().iterations !== Infinity) a.finish(); })); await page.waitForTimeout(100); const p = path.join(out, name); await page.screenshot({ path: p }); return p; };
const dock = (page) => page.getByTestId('aura-dock');
const field = (page) => dock(page).getByPlaceholder('Ask Aura or tell it what to do');
const glow = (page) => page.getByTestId('aura-glow');
const focused = (page) => field(page).evaluate((el) => el === document.activeElement).catch(() => false);
const padBottom = (page) => page.locator('main.content').evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
const shots = [];
/** The card's resting box: the test clock is frozen, so a framer-motion entrance can stay at its first frame; take its translate out. */
const restBox = (loc) => loc.evaluate((el) => { const r = el.getBoundingClientRect(), m = new DOMMatrixReadOnly(getComputedStyle(el).transform); return { x: r.x - m.m41, y: r.y - m.m42, width: r.width, height: r.height }; });

try {
  // ---------------------------------------------------------------- desktop
  {
    const { ctx, page } = await newCtx();
    for (const where of ['', 'calendar', 'work']) {
      await page.goto(`${origin}/preview-org/${where}`); await page.locator('.v2-rail').waitFor();
      await page.locator('.v2-tb .aura-hint').waitFor();
      await page.waitForTimeout(400);
      assert.equal(await dock(page).count(), 0, `/${where}: no Aura bar at rest`);
      assert.equal(await glow(page).count(), 0, `/${where}: no glow at rest`);
      assert.ok((await padBottom(page)) <= 32, `/${where}: no bottom space reserved for Aura (${await padBottom(page)})`);
      assert.match((await page.locator('.v2-tb .aura-hint').innerText()).replace(/\s+/g, ' '), /Aura\s*(⌘K|Ctrl K)/);
    }
    shots.push(await shot(page, 'siri-rest-1440.png'));
    checks.push('rest: hint only, no bar, no glow, no reserved padding');

    // ⌘K / Ctrl K opens: glow + capsule, the cursor in it; Esc closes.
    await page.goto(`${origin}/preview-org/`); await page.locator('.v2-tb .aura-hint').waitFor();
    for (let i = 0; i < 10 && !(await focused(page)); i++) { await page.keyboard.press('Control+k'); await page.waitForTimeout(250); }
    assert.ok(await focused(page), 'Ctrl K opens the capsule with the cursor in it');
    await glow(page).waitFor();
    assert.equal(await glow(page).evaluate((el) => getComputedStyle(el).pointerEvents), 'none', 'the glow never takes the pointer');
    assert.ok(await glow(page).getAttribute('data-mood'), 'the glow follows the mood');
    const cap = await dock(page).locator('form.v2-ask').boundingBox(), main = await page.locator('.v2-main').boundingBox();
    assert.ok(Math.abs(cap.x + cap.width / 2 - (main.x + main.width / 2)) < 12, 'capsule centred on the page');
    assert.ok(cap.y > 900 - 130 && cap.width >= 520 && cap.width <= 600, `capsule floats low, ~580 wide (${JSON.stringify(cap)})`);
    assert.ok((await page.locator('.aura-chip[data-sugg]').count()) >= 2, 'suggestions under the capsule');
    await page.keyboard.type('What is slipping this w');
    assert.deepEqual(await page.locator('.aura-chip[data-chip]').allTextContents(), ['Create a task', 'Log time', 'Schedule a meeting', 'Raise a ticket', 'Write a doc', 'More…'], 'typing: the create chips');
    shots.push(await shot(page, 'siri-invoked-1440.png'));
    // ⌘K inside the capsule: the command palette, as before
    await page.keyboard.press('Escape');
    await dock(page).waitFor({ state: 'detached' }); await glow(page).waitFor({ state: 'detached' });
    checks.push('Ctrl K opens (glow, capsule, suggestions, chips); Esc closes');

    // the hint opens; a click outside closes
    await page.locator('.v2-tb .aura-hint').click(); await field(page).waitFor();
    await page.mouse.click(700, 300);
    await dock(page).waitFor({ state: 'detached' });
    checks.push('hint opens, click outside closes');

    // a chip still creates
    await page.locator('.v2-tb .aura-hint').click(); await field(page).fill('Draft release notes');
    await page.locator('.aura-chip[data-chip="task"]').click();
    await page.locator('.v2-new-sheet').waitFor();
    assert.equal(await page.getByLabel('What to create').inputValue(), 'Draft release notes');
    assert.equal(await dock(page).count(), 0, 'the capsule steps away for the create sheet');
    await page.getByLabel('What to create').focus(); await page.keyboard.press('Escape'); await page.locator('.v2-new-sheet').waitFor({ state: 'detached' });
    checks.push('chips create');

    // asking: the answer card rises above the capsule; plan → Do it → Undo
    await page.locator('.v2-tb .aura-hint').click(); await field(page).fill('Move LUM-14 to Friday'); await page.keyboard.press('Enter');
    const card = page.locator('.groot-chat.card'); await card.waitFor();
    assert.equal(await page.locator('.groot-chat:not(.card)').count(), 0, 'no side panel');
    await card.locator('[data-testid="aura-thinking"]').waitFor({ timeout: 1000 });
    const plan = card.locator('[data-testid="aura-plan"]'); await plan.waitFor(); await page.waitForTimeout(450);
    const cb = await restBox(card), cap2 = await dock(page).locator('form.v2-ask').boundingBox();
    assert.ok(cb.y + cb.height <= cap2.y + 1, `the card sits above the capsule (${cb.y + cb.height} / ${cap2.y})`);
    assert.ok(Math.abs(cb.x + cb.width / 2 - (cap2.x + cap2.width / 2)) < 12, 'card and capsule share a centre');
    assert.equal(await dock(page).locator('.aura-chip').count(), 0, 'no chips while answering');
    assert.ok(await glow(page).evaluate((el) => el.classList.contains('soft')), 'the glow softens while answering');
    shots.push(await shot(page, 'siri-answer-1440.png'));
    await plan.getByRole('button', { name: 'Edit' }).click();
    assert.equal(await field(page).inputValue(), 'Move LUM-14 to Friday', 'Edit puts the request back in the capsule');
    await field(page).fill('');
    await plan.getByRole('button', { name: 'Do it' }).click();
    await plan.getByRole('button', { name: 'Undo' }).waitFor();
    await plan.getByRole('button', { name: 'Undo' }).click();
    await plan.locator('[data-status="undone"]').waitFor();
    assert.deepEqual(calls, ['confirm:a-1', 'undo:a-1']);
    // Esc puts the card and the capsule away; the orb opens the full panel
    await page.keyboard.press('Escape');
    await card.waitFor({ state: 'detached' }); await dock(page).waitFor({ state: 'detached' });
    await page.keyboard.press('Control+k'); await field(page).waitFor();
    await dock(page).getByRole('button', { name: 'Open Aura' }).click();
    await page.locator('.groot-chat:not(.card)').waitFor();
    assert.equal(await dock(page).count(), 0, 'the panel has its own field');
    checks.push('answer card above the capsule, Edit, Do it, Undo, Esc, orb → panel');
    await ctx.close();
  }

  // ---------------------------------------------------------------- dark + reduced motion
  {
    const { ctx, page } = await newCtx({ theme: 'dark', reduced: true });
    await page.goto(`${origin}/preview-org/`); await page.locator('.v2-tb .aura-hint').click(); await field(page).waitFor();
    const bg = await dock(page).locator('form.v2-ask').evaluate((el) => getComputedStyle(el).backgroundColor);
    const [r, g, b] = bg.match(/\d+/g).map(Number); assert.ok(r + g + b < 200, `dark glass capsule (${bg})`);
    const a1 = await glow(page).evaluate((el) => el.style.getPropertyValue('--glow-a')); await page.waitForTimeout(500);
    assert.equal(await glow(page).evaluate((el) => el.style.getPropertyValue('--glow-a')), a1, 'the glow stays still under Reduce Motion');
    await shot(page, 'siri-invoked-dark-1440.png');
    checks.push('dark, reduced motion');
    await ctx.close();
  }

  // ---------------------------------------------------------------- phone
  {
    const { ctx, page } = await newCtx({ phone: true });
    await page.goto(`${origin}/preview-org/`); await page.locator('.m-top .m-aura-orb').waitFor();
    await page.waitForTimeout(400);
    assert.equal(await dock(page).count(), 0, 'phone: nothing at rest');
    const tabs = await page.locator('.v2-phone-bar').boundingBox();
    const pad = await padBottom(page);
    const tabVar = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--m-tab')) || 62);
    assert.ok(pad <= tabVar + 12, `phone: only the tab bar is reserved, nothing for Aura (${pad} vs --m-tab ${tabVar})`);
    await fitsPhone(page, 'phone rest', assert);
    shots.push(await shot(page, 'siri-rest-phone-390.png'));
    // long-press the orb
    const orb = await page.locator('.m-top .m-aura-orb').boundingBox();
    await page.mouse.move(orb.x + orb.width / 2, orb.y + orb.height / 2); await page.mouse.down(); await page.waitForTimeout(600); await page.mouse.up();
    await field(page).waitFor(); await glow(page).waitFor();
    const d = await dock(page).locator('form.v2-ask').boundingBox();
    assert.ok(d.y + d.height <= tabs.y - 4, `phone: capsule above the tab bar (${d.y + d.height} / ${tabs.y})`);
    assert.ok(d.x >= 11 && d.x + d.width <= 379, 'phone: capsule keeps its gutters');
    await fitsPhone(page, 'phone invoked', assert);
    // above the keyboard
    await page.evaluate(() => { document.documentElement.classList.add('kb-open'); document.documentElement.style.setProperty('--kb', '300px'); });
    await field(page).focus(); await page.waitForTimeout(100);
    const k = await dock(page).locator('form.v2-ask').boundingBox();
    assert.ok(Math.abs(844 - 300 - 8 - (k.y + k.height)) < 4, `phone: capsule rides on the keyboard (${k.y + k.height})`);
    await page.evaluate(() => { document.documentElement.classList.remove('kb-open'); document.documentElement.style.removeProperty('--kb'); });
    await field(page).fill('Move LUM-14 to Friday'); await page.keyboard.press('Enter');
    const card = page.locator('.groot-chat.card'); await card.locator('[data-testid="aura-plan"]').waitFor(); await page.waitForTimeout(450);
    assert.equal(await page.locator('.groot-chat.phone').count(), 0, 'phone: a card, not the full sheet');
    const cb = await restBox(card), d2 = await dock(page).locator('form.v2-ask').boundingBox();
    assert.ok(cb.y >= 0 && cb.y + cb.height <= d2.y + 1 && cb.x >= 11 && cb.x + cb.width <= 379, `phone: card above the capsule (${JSON.stringify(cb)})`);
    await fitsPhone(page, 'phone answer', assert);
    shots.push(await shot(page, 'siri-answer-phone-390.png'));
    await page.mouse.click(195, 120);
    await card.waitFor({ state: 'detached' }); await dock(page).waitFor({ state: 'detached' });
    checks.push('phone: orb at rest, long-press, above tab bar and keyboard, answer card, tap outside');
    await ctx.close();
  }

  assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
  console.log(`verify-aura-siri-ui: ok (${checks.join('; ')})\n${shots.join('\n')}`);
} finally {
  await browser.close();
}
