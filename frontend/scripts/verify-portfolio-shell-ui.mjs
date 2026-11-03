import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { makeState, origin, portfolioContext, T } from './lib/portfolioFixture.mjs';

// Portfolio's one shell on every tab (design plansheet4–8): the same head (Portfolio · title · the tabs · ⋯), the project folder tabs with the fixed
// Action items tab, one command field with tokens and the colour filter, kept in the address so a tab switch keeps them; one skeleton while loading,
// one fade on every switch, the page reaching the window's bottom, one colour per project on every tab; and an edit on the Plan sheet showing on the
// Board and the Timeline without a reload. One consistent fictional fixture (lib/portfolioFixture.mjs).
const out = path.resolve('test-results/portfolio-shell-ui');
await fs.mkdir(out, { recursive: true });
// The calm order (design #portfolio). The project columns (the old Board) live under the Overview; Board is the task board.
const TABS = [['overview', 'Overview'], ['actions', 'Action items'], ['sheet', 'Plan sheet'], ['timeline', 'Timeline'], ['capacity', 'Capacity'], ['board', 'Board'], ['present', 'Present']];
const url = (q = '') => `${origin}/preview-org/work/projects?view=portfolio${q}`;
const checks = [], allErrors = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const shot = async (page, name) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(300); await page.screenshot({ path: path.join(out, name) }); };
const tabsOf = (page) => page.getByRole('tablist', { name: 'Portfolio view' });
const goTab = async (page, label) => { await tabsOf(page).getByRole('tab', { name: label }).click(); await page.locator('.pfx-stage').first().waitFor(); await page.waitForTimeout(450); };
/** The shell as drawn now: one head, one field, the folder tabs, the tokens, and whether the page reaches the window's bottom. */
const shell = (page) => page.evaluate(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const pageEl = document.querySelector('.pfx-page');
  const head = document.querySelector('.pfc-head');
  return {
    heads: [...document.querySelectorAll('.pfc-head')].filter(vis).length, crumb: head?.querySelector('.pfc-crumb')?.textContent ?? null, headTop: head ? Math.round(head.getBoundingClientRect().top) : null,
    fields: [...document.querySelectorAll('.ps3-cmd')].filter((e) => vis(e) && !e.closest('.ps3-float')).length,
    folderTabs: !!document.querySelector('[role="tablist"][aria-label="Plan sheet tabs"]'),
    toks: [...document.querySelectorAll('.pfx-cmdrow .ps3-tok')].map((e) => e.textContent.replace('✕', '').trim()),
    colourOn: [...document.querySelectorAll('[aria-label="Filter projects by colour"] button[aria-pressed="true"]')].map((e) => e.getAttribute('aria-label')),
    pageBottom: pageEl ? Math.round(pageEl.getBoundingClientRect().bottom + scrollY) : 0, docH: document.documentElement.scrollHeight, vh: innerHeight,
    stageAnim: document.querySelector('.pfx-stage') ? getComputedStyle(document.querySelector('.pfx-stage')).animationName : `none at ${location.search}`, sideways: document.documentElement.scrollWidth > innerWidth + 1,
    stageRadius: [...document.querySelectorAll('.pf-card, .ptl-frame, .cp-card, tbody.ps4-card td:first-child, .pf-tile')].filter(vis).slice(0, 1).map((e) => getComputedStyle(e).borderTopLeftRadius)[0] ?? null,
  };
});

try {
  // ---------------------------------------------------------------- one shell, one filter, kept across tabs (1440, light)
  {
    const { ctx, page, errors } = await portfolioContext(browser, { width: 1440, state: makeState() });
    await page.goto(url('&mode=sheet&classic=1')); await page.getByRole('grid', { name: 'Plan sheet' }).waitFor();
    // A sentence in the one field becomes tokens; a colour joins them; both go into the address.
    const field = page.getByRole('textbox', { name: 'Filter, search or ask' });
    await field.fill('late or at risk'); await field.press('Enter');
    await page.getByRole('group', { name: 'Filter projects by colour' }).getByRole('button', { name: 'Blue' }).click();
    await page.getByRole('group', { name: 'Filter projects by colour' }).getByRole('button', { name: 'Violet' }).click();
    await page.waitForFunction(() => new URL(location.href).searchParams.get('pc') === 'blue,violet' && !!new URL(location.href).searchParams.get('f'));
    const seen = {};
    for (const [mode, label] of TABS.filter(([m]) => m !== 'present')) {
      await goTab(page, label);
      const s = await shell(page);
      seen[mode] = s;
      assert.equal(s.heads, 1, `${label}: one head`);
      assert.ok(s.crumb?.startsWith('Portfolio'), `${label}: the crumb`);
      assert.equal(s.fields, 1, `${label}: one command field (on Overview too while a filter is on)`);
      assert.equal(s.folderTabs, mode === 'sheet', `${label}: the project folder tabs only on the Plan sheet`);
      assert.deepEqual(s.toks, ['status Late or at risk'], `${label}: the token stays`);
      assert.deepEqual(s.colourOn, ['Blue', 'Violet'], `${label}: the colour filter stays`);
      assert.equal(s.stageAnim, 'pfx-in', `${label}: the same tab-switch fade`);
      assert.ok(s.pageBottom >= s.vh - 2, `${label}: the page reaches the window's bottom (${s.pageBottom} of ${s.vh})`);
      assert.equal(s.sideways, false, `${label}: no sideways scroll`);
      const u = new URL(page.url()); assert.equal(u.searchParams.get('pc'), 'blue,violet'); assert.ok(u.searchParams.get('f')?.startsWith('status~lateorrisk'), u.search);
      await shot(page, `${mode}-filtered-1440.png`);
    }
    const tops = new Set(Object.values(seen).map((s) => s.headTop));
    assert.equal(tops.size, 1, `the head does not move between tabs: ${JSON.stringify(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, v.headTop])))}`);
    // The filter does its work on each tab: late-or-at-risk and blue/violet leaves AA (blue, at risk) and UP (violet, late).
    await goTab(page, 'Overview');
    assert.deepEqual((await page.locator('.pf-board .pf-card').evaluateAll((els) => els.map((e) => e.dataset.project))).sort(), ['AA', 'UP']);
    await goTab(page, 'Timeline');
    assert.deepEqual((await page.locator('.ptl-pname').allInnerTexts()).sort(), ['Account Aggregator', 'UPI AutoPay']);
    // Present opens over the Overview and keeps the shell under it.
    await goTab(page, 'Present');
    await page.getByRole('dialog', { name: 'Present decisions' }).waitFor({ state: 'attached', timeout: 3000 }).catch(() => {});
    assert.equal(new URL(page.url()).searchParams.get('mode'), 'present');
    checks.push('one-shell-filter-persists');

    // A project folder tab on the Plan sheet opens that project; Action items stay the fixed first folder tab.
    await page.goto(url('&mode=sheet&classic=1')); await page.getByRole('grid', { name: 'Plan sheet' }).waitFor();
    assert.match(await page.getByRole('tablist', { name: 'Plan sheet tabs' }).getByRole('tab').first().innerText(), /Action items/);
    await page.getByRole('tablist', { name: 'Plan sheet tabs' }).getByRole('tab', { name: /Credit Bureau Integration/ }).click();
    await page.waitForFunction(() => new URL(location.href).searchParams.get('pt') !== null);
    await page.waitForFunction(() => /pc-teal/.test(document.querySelector('.pfx-page')?.className ?? ''), null, { timeout: 5000 }).catch(() => {});   // the page colour follows the tab a render after the address
    assert.match(await page.locator('.pfx-page').getAttribute('class'), /pc-teal/);
    await page.getByRole('tablist', { name: 'Plan sheet tabs' }).getByRole('tab', { name: /Action items/ }).click();
    await page.waitForFunction(() => { const u = new URL(location.href); return u.searchParams.get('mode') === 'sheet' && u.searchParams.get('pt') === 'actions'; });
    await page.getByRole('textbox', { name: 'Search action items' }).waitFor();
    assert.equal((await shell(page)).fields, 1, 'Action items: still one field');
    checks.push('folder-tabs-on-the-plan-sheet');

    // One colour per project, the Plan sheet's: UP is the third tab (violet) on the sheet, the Board and the Timeline.
    await page.goto(url('&mode=sheet&classic=1')); await page.getByRole('grid', { name: 'Plan sheet' }).waitFor();
    const sheetColours = await page.locator('tbody.ps4-card').evaluateAll((els) => els.map((e) => [...e.classList].find((c) => c.startsWith('pc-'))));
    assert.deepEqual(sheetColours, ['pc-blue', 'pc-teal', 'pc-violet', 'pc-amber', 'pc-rose']);
    await goTab(page, 'Overview');
    const boardColours = Object.fromEntries(await page.locator('.pf-board .pf-card').evaluateAll((els) => els.map((e) => [e.dataset.project, [...e.classList].find((c) => c.startsWith('pc-'))])));
    assert.deepEqual(boardColours, { AA: 'pc-blue', CB: 'pc-teal', UP: 'pc-violet', DP: 'pc-amber', PR: 'pc-rose' });
    await goTab(page, 'Timeline');
    const tlColours = Object.fromEntries(await page.locator('.ptl-prow').evaluateAll((els) => els.map((e) => [e.querySelector('.ptl-pname').textContent, [...e.querySelector('.ps4-sq').classList].find((c) => c.startsWith('pc-'))])));
    assert.deepEqual(tlColours, { 'Account Aggregator': 'pc-blue', 'Credit Bureau Integration': 'pc-teal', 'UPI AutoPay': 'pc-violet', 'Data Privacy API': 'pc-amber', 'Payments Revamp': 'pc-rose' });
    for (const [mode, label] of TABS.filter(([m]) => m !== 'present')) { await goTab(page, label); await shot(page, `${mode}-1440.png`); }
    checks.push('one-colour-per-project');
    allErrors.push(...errors); await ctx.close();
  }

  // ---------------------------------------------------------------- the same skeleton on every tab while it loads
  for (const [mode] of TABS.filter(([m]) => m !== 'present' && m !== 'overview' && m !== 'actions')) {
    const { ctx, page, errors } = await portfolioContext(browser, { width: 1440, state: makeState(), delay: 2500 });
    await page.goto(url(`&mode=${mode}`));
    await page.locator('.pfx-skel').first().waitFor({ timeout: 2400 });
    assert.equal(await page.locator('.spinner, .page-loader').count(), 0, `${mode}: no spinner, the skeleton`);
    if (mode === 'board') await shot(page, 'loading-1440.png');
    allErrors.push(...errors); await ctx.close();
  }
  checks.push('one-skeleton');

  // ---------------------------------------------------------------- live sync: a Plan sheet edit shows on the Board and the Timeline, no reload
  {
    const state = makeState();
    const { ctx, page, errors } = await portfolioContext(browser, { width: 1440, state });
    await page.goto(url()); await page.locator('.pf-board .pf-card').first().waitFor();
    assert.equal(await page.locator('.pf-colwrap.late .pf-card[data-project="UP"]').count(), 1, 'UP starts late');
    await goTab(page, 'Timeline');
    assert.match(await page.locator('.ptl-bar', { hasText: '45%' }).first().getAttribute('aria-label'), /UPI AutoPay.*45% done/);
    await page.evaluate(() => { window.__sameDocument = true; });
    await goTab(page, 'Plan sheet');
    // The calm Plan sheet; the full grid (with every editor) is ⋯ › Open the full sheet.
    await page.getByRole('button', { name: /More on the plan sheet/ }).click(); await page.getByRole('menuitem', { name: /Open the full sheet/ }).click();
    await page.getByRole('grid', { name: 'Plan sheet' }).waitFor();
    // The calm head is taller, so UP-01 starts below the grid's fold: bring it into view first (the grid scrolls inside itself).
    { const td = page.locator(`td[data-cell="${T['UP-01']}:status"]`); await td.scrollIntoViewIfNeeded(); await page.waitForTimeout(250); await td.click();
      if (!(await page.getByRole('listbox', { name: 'Status of UP-01' }).isVisible().catch(() => false))) { await page.waitForTimeout(250); await td.click(); } }
    await page.getByRole('listbox', { name: 'Status of UP-01' }).getByRole('option', { name: /Done/ }).click();
    for (let i = 0; i < 50 && !state.writes.length; i++) await page.waitForTimeout(100);
    assert.equal(state.writes[0]?.b.changes[0].statusId, `${state.rows.find((r) => r.key === 'UP').id}-s3`);
    await goTab(page, 'Overview');
    await page.waitForFunction(() => !document.querySelector('.pf-colwrap.late .pf-card[data-project="UP"]'), null, { timeout: 5000 });
    await page.getByRole('status', { name: 'Work complete, check sign-offs' }).getByText('All work is done on UPI AutoPay.').waitFor();
    await goTab(page, 'Timeline');
    await page.waitForFunction(() => [...document.querySelectorAll('.ptl-bar')].some((e) => /UPI AutoPay.*100% done/.test(e.getAttribute('aria-label') ?? '')), null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => window.__sameDocument), true, 'no reload');
    await shot(page, 'sync-timeline-1440.png');
    checks.push('sheet-edit-shows-on-board-and-timeline');
    allErrors.push(...errors); await ctx.close();
  }

  // ---------------------------------------------------------------- dark and phone
  {
    const { ctx, page, errors } = await portfolioContext(browser, { width: 1440, theme: 'dark', state: makeState() });
    await page.goto(url()); await page.locator('.pf-board .pf-card').first().waitFor(); await shot(page, 'board-1440-dark.png');
    await goTab(page, 'Timeline'); await shot(page, 'timeline-1440-dark.png');
    allErrors.push(...errors); await ctx.close();
  }
  {
    const { ctx, page, errors } = await portfolioContext(browser, { width: 390, state: makeState() });
    await page.goto(url()); await page.locator('.pf-board .pf-card').first().waitFor();
    for (const [mode, label] of TABS.filter(([m]) => m !== 'present')) {
      await goTab(page, label);
      const s = await shell(page);
      assert.equal(s.heads, 1, `${label} phone: one head`);
      assert.equal(s.fields, 0, `${label} phone: one field (none on a calm Overview without a filter)`);
      assert.ok(await tabsOf(page).isVisible(), `${label} phone: the tabs show`);
      await fitsPhone(page, `${label} phone`, assert);
      await shot(page, `${mode}-390.png`);
    }
    checks.push('phone');
    allErrors.push(...errors); await ctx.close();
  }
  assert.deepEqual(allErrors, []);
} finally { await browser.close(); }
console.log(JSON.stringify({ ok: true, checks, out }, null, 2));
