import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { makeState, origin, people, P, NOW, today } from './lib/portfolioFixture.mjs';
import { portfolioContext } from './lib/portfolioFixture.mjs';

// Calm round 4a: the approved header (logo + workspace ▾ "Role · Team" opening the team switcher; on the right only the Aura orb, the
// bell and the avatar; check-in as a small ring opening the day sheet with a week summary), the Siri-style orb, Aura as search (one sheet:
// results with filter chips and keyboard navigation, private chats left out, "Ask Aura" suggestions), Undo instead of confirm, Portfolio
// saved views (pinned built-ins), the Activity tab, and date extensions (the shared "Reason for extending" sheet answering 422
// DATE_EXTENSION_REASON_REQUIRED, Extended ×N badges, original struck → new, the timeline ghost bar, the overview summary).
// 1440 / 1920 / 390, light and dark. Fictional fixtures only.
const out = path.resolve('test-results/calm-round4a');
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const checks = [], shots = [];
const g = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Northwind', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 7 };
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false, mfaEnabled: true };

function extended(state) {
  const cb = state.rows.find((r) => r.id === P.CB);
  Object.assign(cb, { originalDate: '2026-11-10', extensionCount: 2, totalSlipDays: 14 });
  const t = state.rows.find((r) => r.key === 'CB-02');
  Object.assign(t, { originalDate: '2026-10-20', extensionCount: 1, totalSlipDays: 7 });
  state.slips = [
    { projectId: P.CB, projectKey: 'CB', project: 'Credit Bureau Integration', previous: '2026-11-17', revised: '2026-11-24', daysShifted: 7, reason: 'Waiting on the bureau sandbox', dependency: null, by: 'Tomas Ortega', at: '2026-10-21T06:00:00Z' },
    { projectId: P.CB, projectKey: 'CB', project: 'Credit Bureau Integration', previous: '2026-11-10', revised: '2026-11-17', daysShifted: 7, reason: 'Scope changed', dependency: null, by: 'Tomas Ortega', at: '2026-10-08T06:00:00Z' },
  ];
}

function extra(state) {
  state.views = [];
  return async ({ ep, method, req, url }) => {
    if (ep === '/api/v1/me') return { user, workspaces: [ws, { ...ws, id: g(3), slug: 'personal', name: 'Personal', type: 'Personal' }], fingerprint: 'preview', pendingConsent: [],
      current: { ...ws, permissions: ['projects.view', 'projects.edit', 'tasks.view', 'tasks.edit', 'tasks.create', 'org.manage', 'reports.view', 'reports.broad', 'work.view'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 3, activity: 3, documents: 3, people: 3, reports: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3 } } };
    if (ep === '/api/v1/lens/teams') return [{ id: g(801), name: 'Engineering', projects: 4, members: 6 }, { id: g(802), name: 'Quality', projects: 2, members: 3 }, { id: g(803), name: 'Support Desk', projects: 1, members: 4 }];
    if (ep === '/api/v1/me/attendance/today') return { date: today, timeZone: 'Asia/Kolkata', localTime: '16:00', workStart: '09:30', workEnd: '18:30', workingDay: true, onLeave: false, holiday: null, shouldPrompt: false,
      record: { id: g(901), userId: user.id, userName: user.displayName, date: today, checkInAt: new Date(NOW.getTime() - 5.8 * 3600_000).toISOString(), checkOutAt: null, mode: 'Office', place: null, note: null, source: 'web', autoClosed: false, minutes: 0, checkInLocal: '09:42', checkOutLocal: null },
      recentPlaces: [], canViewTeam: true, policy: { enabled: true, hoursSource: 'workspace', workDays: '1,2,3,4,5', workStart: '09:30', workEnd: '18:30', checkInGraceMinutes: 10, checkOutGraceMinutes: 0, autoClose: true, autoCloseAfterHours: 12, allowedModes: ['Office', 'Home', 'ClientSite'], requireClientPlace: true, promptAtSignIn: false, timeZone: 'Asia/Kolkata' } };
    if (ep === '/api/v1/attendance') return ['2026-10-26', '2026-10-27', '2026-10-28'].map((d, i) => ({ id: g(910 + i), userId: user.id, userName: user.displayName, date: d, checkInAt: `${d}T04:00:00Z`, checkOutAt: `${d}T13:00:00Z`, mode: 'Office', place: null, note: null, source: 'web', autoClosed: false, minutes: [510, 480, 455][i], checkInLocal: '09:30', checkOutLocal: '18:30' }));
    if (ep === '/api/v1/search') return { hits: [
      { type: 'project', id: P.CB, title: 'Credit Bureau Integration', subtitle: 'CB · Active', projectId: P.CB, taskId: null },
      { type: 'task', id: g(105), title: 'Consumer report parsing for v2 schema', subtitle: 'CB-02 · In progress', projectId: P.CB, taskId: g(105) },
      { type: 'member', id: people[2].id, title: people[2].name, subtitle: 'Member', projectId: null, taskId: null },
      { type: 'file', id: g(950), title: 'bureau-v2-schema.pdf', subtitle: '240 KB', projectId: P.CB, taskId: null },
      { type: 'page', id: g(951), title: 'Bureau mapping notes', subtitle: 'Mapping', projectId: P.CB, taskId: null },
      { type: 'action', id: g(952), title: 'Share the bureau keys with QA', subtitle: 'AI-4 · Open', projectId: P.CB, taskId: null },
    ] };
    if (ep === '/api/v1/chat/search') return [{ messageId: g(960), conversationId: g(961), conversationName: 'Lending team', senderName: people[1].name, snippet: 'Mapping for the bureau is ready', at: NOW.toISOString() }];
    if (ep === '/api/v1/activity' && url.searchParams.get('entityType')) return { items: [
      { id: g(1301), at: new Date(NOW.getTime() - 3600_000).toISOString(), actor: { id: people[2].id, name: people[2].name }, action: 'date_extended', field: 'dueDate', from: '2026-10-20', to: '2026-10-27', summary: 'moved the due date later', reason: 'Waiting on the bureau sandbox' },
      { id: g(1302), at: new Date(NOW.getTime() - 26 * 3600_000).toISOString(), actor: { id: people[1].id, name: people[1].name }, action: 'updated', field: 'status', from: 'To do', to: 'In progress', summary: 'changed the status', reason: null },
      { id: g(1303), at: '2026-10-09T06:00:00Z', actor: { id: user.id, name: user.displayName }, action: 'created', field: null, from: null, to: null, summary: 'created the task', reason: null },
    ], page: 1, pageSize: 50, totalItems: 3, totalPages: 1 };
    if (ep === '/api/v1/me/ui/portfolio-pins') { if (method === 'PUT') { state.pins = req.postDataJSON().value.pins; return { key: 'portfolio-pins', value: { pins: state.pins } }; } return { key: 'portfolio-pins', value: state.pins ? { pins: state.pins } : null }; }
    if (ep === '/api/v1/saved-views' && method === 'POST') { const b = req.postDataJSON(); state.writes.push({ ep, b, method }); const v = { id: g(1400 + state.views.length), scope: 'portfolio', name: b.name, sharing: b.sharing, teamId: null, teamName: null, ownerId: user.id, ownerName: user.displayName, mine: true, config: b.config, createdAt: NOW.toISOString() }; state.views.push(v); return v; }
    if (/^\/api\/v1\/saved-views\/[^/]+$/.test(ep) && method === 'DELETE') { state.writes.push({ ep, method }); state.views = state.views.filter((v) => !ep.endsWith(v.id)); return null; }
    if (ep === '/api/v1/saved-views') return state.views;
    if (/^\/api\/v1\/work-items\/[^/]+$/.test(ep) && method === 'PATCH') {
      const b = req.postDataJSON();
      if (b.dueDate && b.dueDate > '2026-11-01' && !b.extensionReason) { state.writes.push({ ep, b, method, refused: true });
        return { __status: 422, body: { message: 'Say why the due date is moving later (for example a dependency, a change in scope or waiting on a client).', errors: [{ code: 'DATE_EXTENSION_REASON_REQUIRED', message: 'Say why the due date is moving later.', field: 'extensionReason' }] } }; }
    }
    return undefined;
  };
}

// The fixture fixes the clock (Date and performance), which can leave framer-motion's enter animation on its first frame in a long run:
// screenshots show the sheets in their settled state.
const at = async (page, name) => { await page.waitForTimeout(900); await page.addStyleTag({ content: '.calm-sheet,.calm-scrim{opacity:1!important;transform:none!important}' }).catch(() => {}); const file = path.join(out, `${name}.png`); await page.screenshot({ path: file }); shots.push(file); };
try {
  for (const theme of ['light', 'dark']) for (const width of [1440, 1920, 390]) {
    const tag = `${width}-${theme}`, phone = width < 500;
    const state = makeState(); extended(state); state.extra = extra(state);
    const { ctx, page, errors } = await portfolioContext(browser, { width, theme, state });
    await page.goto(`${origin}/preview-org/work/projects?view=portfolio`);
    await page.getByTestId('extension-summary').waitFor();
    await page.getByTestId('team-switcher').first().waitFor().catch(() => {});

    // 1. Header: right side only orb, bell, avatar; check-in is a ring; no separate search icon.
    if (phone) {
      const kids = await page.locator('.m-top-r4 .m-top-actions > *').count();
      assert.equal(kids, 3, `${tag}: phone header right side has only Aura, bell and avatar (${kids})`);
      assert.equal(await page.locator('.m-top [aria-label="Search"]').count(), 0, 'no separate search icon');
      assert.equal(await page.locator('.m-top .lens-chip').count(), 0, 'no stray team square');
      assert.ok(await page.locator('.m-top-left [data-testid="team-switcher"]').isVisible(), 'workspace ▾ on the left');
    } else {
      const order = await page.locator('.shell-head > :not(.v2-tb-sp)').evaluateAll((els) => els.map((e) => e.querySelector('[data-testid="att-capsule"]') ? 'ring' : e.classList.contains('shell-orb') ? 'orb' : /bell|notif/i.test(e.className + (e.getAttribute('aria-label') ?? '')) ? 'bell' : 'other'));
      assert.equal(order[0], 'ring', `${tag}: ring first ${order}`); assert.equal(order[1], 'orb', `${tag}: then the orb ${order}`);
    }
    assert.ok(await page.locator('[data-testid="att-capsule"].ring').first().isVisible(), 'check-in ring');
    assert.equal(await page.locator('[data-testid="att-capsule"] .att-cap-t').count(), 0, 'ring only, no label');
    assert.ok((await page.getByTestId('siri-orb').count()) > 0, 'Siri orb on screen');
    assert.ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), `${tag}: no sideways scroll`);
    await page.waitForFunction(() => /extended this month, \+/.test(document.querySelector('[data-testid="extension-summary"]')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => {});
    const sum = await page.getByTestId('extension-summary').innerText();
    assert.match(sum, /2 dates extended this month, \+14 days/, `overview summary: ${sum}`);
    assert.ok(await page.getByTestId('portfolio-views').isVisible(), 'saved views bar');
    await at(page, `overview-${tag}`);
    checks.push(`header + overview ${tag}`);

    // 2. Aura = search.
    await page.locator(phone ? '.m-aura-orb' : '.shell-orb').first().click();
    await page.getByTestId('aura-search').waitFor();
    assert.equal(await page.locator('[data-testid="aura-search"] [data-state]').first().getAttribute('data-state'), 'idle');
    await page.getByTestId('aura-search-input').fill('bureau');
    await page.getByText('Consumer report parsing for v2 schema').waitFor();
    for (const f of ['all', 'project', 'task', 'person', 'message', 'file', 'note', 'action']) assert.equal(await page.locator(`.aura-s-chips [data-filter="${f}"]`).count(), 1, `filter chip ${f}`);
    await page.getByText('Mapping for the bureau is ready').waitFor();
    assert.ok((await page.locator('.aura-s-row.ask').count()) >= 2, 'Ask Aura suggestions');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('.aura-s-row[data-sel="true"]').count(), 1, 'keyboard selection');
    await at(page, `aura-search-${tag}`);
    await page.locator('.aura-s-chips [data-filter="message"]').click();
    assert.equal(await page.locator('.aura-s-group').first().locator('.aura-s-row').count(), 1, 'Messages filter');
    await page.keyboard.press('Escape');
    await page.getByTestId('aura-search').waitFor({ state: 'detached' });
    if (!phone) { await page.keyboard.press('Control+k'); await page.getByTestId('aura-search').waitFor(); await page.keyboard.press('Escape'); await page.getByTestId('aura-search').waitFor({ state: 'detached' }); }
    checks.push(`aura search ${tag}`);

    // 3. Team switcher and the check-in sheet.
    await page.getByTestId('team-switcher').first().click();
    await page.getByTestId('team-switcher-sheet').waitFor();
    for (const t of ['Northwind', 'Personal', 'Engineering · Owner', 'Quality · Owner', 'Support Desk · Owner']) await page.getByTestId('team-switcher-sheet').getByText(t, { exact: false }).first().waitFor();
    await at(page, `team-switcher-${tag}`);
    await page.getByTestId('team-switcher-sheet').getByText('Engineering · Owner').click();
    await page.getByTestId('team-switcher-sheet').waitFor({ state: 'detached' });
    assert.match(await page.getByTestId('team-switcher').first().innerText(), /Owner · Engineering/, 'switched instantly');
    await page.locator('[data-testid="att-capsule"].ring').first().click();
    await page.getByTestId('att-week').waitFor();
    assert.match(await page.getByTestId('att-day').innerText(), /Check out/);
    await at(page, `checkin-${tag}`);
    await page.keyboard.press('Escape'); await page.mouse.click(5, 300);
    checks.push(`team switcher + check-in ${tag}`);

    // 4. Saved views: Dates extended opens the plan sheet filtered, with Extended ×N and the original struck.
    await page.locator('[data-view="b:extended"]').click();
    await page.getByTestId('extended-badge').first().waitFor();
    assert.ok((await page.locator('.xd-was').count()) >= 1, 'original date struck');
    await at(page, `view-extended-${tag}`);
    await page.locator('[data-view="b:week-owner"]').click();
    await page.waitForURL(/tg=owner/);
    assert.match(page.url(), /mode=timeline/);
    await page.goto(`${origin}/preview-org/work/projects?view=portfolio&mode=timeline`);
    await page.waitForTimeout(1200);
    assert.ok((await page.getByTestId('timeline-ghost').count()) >= 1 || phone, `${tag}: timeline ghost bar`);
    await at(page, `timeline-ghost-${tag}`);
    checks.push(`saved views + extended ${tag}`);

    if (theme === 'light' || width === 390) {
      // 5. Views sheet: save, then delete with Undo (no confirm dialog).
      await page.locator('.pfv-more').click();
      await page.getByLabel('View name').fill('Lending late work');
      await page.getByRole('button', { name: 'Save and pin' }).click();
      await page.locator('.pfv-sheet').getByText('Lending late work').waitFor();
      await at(page, `views-sheet-${tag}`);
      await page.getByRole('button', { name: 'Delete Lending late work' }).click();
      const undo = page.getByRole('button', { name: 'Undo' }).last(); await undo.waitFor();
      assert.equal(await page.locator('[role="alertdialog"]').count(), 0, 'no confirm pop-up');
      await at(page, `undo-toast-${tag}`);
      await undo.click();
      await page.waitForTimeout(400);
      assert.equal(state.writes.filter((w) => w.ep === '/api/v1/saved-views' && w.method === 'POST').length, 2, 'Undo restored the view');
      await page.keyboard.press('Escape');
      checks.push(`views sheet + undo ${tag}`);

      // 6. Reason for extending: an in-place due edit later is refused (422) and the shared sheet asks, then the edit is resent with the reason.
      await page.goto(`${origin}/preview-org/work/projects?view=portfolio&mode=actions`);
      await page.getByText('Draft the release note').first().waitFor();
      await page.getByLabel('Due of Draft the release note').fill('2026-11-20');
      await page.getByTestId('extension-reason').waitFor();
      await page.waitForTimeout(900);
      await at(page, `reason-sheet-${tag}`);
      await page.getByTestId('extension-reason').getByRole('button', { name: 'Waiting on the client' }).click();
      await page.getByRole('button', { name: 'Extend date' }).click();
      await page.waitForTimeout(500);
      const sent = state.writes.filter((w) => w.method === 'PATCH' && w.b?.dueDate === '2026-11-20');
      assert.ok(sent.some((w) => w.refused) && sent.some((w) => w.b.extensionReason === 'Waiting on the client'), 'resent with extensionReason');
      checks.push(`reason for extending ${tag}`);

      // 7. Activity tab in the side panel.
      await page.getByRole('button', { name: /^Share the sandbox keys with QA/ }).click();
      await page.getByTestId('calm-work-sheet').waitFor();
      await page.locator('.xh-tabs [data-tab="activity"]').click();
      await page.getByTestId('activity-history').waitFor();
      assert.match(await page.getByTestId('activity-history').innerText(), /Waiting on the bureau sandbox/);
      await at(page, `activity-${tag}`);
      checks.push(`activity tab ${tag}`);
    }
    assert.deepEqual(errors, [], `${tag}: no page errors`);
    await ctx.close();
  }
} finally { await browser.close(); }
console.log(`OK calm round 4a: ${checks.length} checks\n${checks.join('\n')}\n${shots.length} screenshots in ${out}`);
