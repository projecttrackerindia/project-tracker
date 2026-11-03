import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { makeState, origin, portfolioContext } from './lib/portfolioFixture.mjs';

// Portfolio in the calm theme (design #portfolio, shots 11–17 and 16-portfolio-board): every tab at 1440, 1920 and 390, light and dark —
// one title with a grey second line, the pill tabs (Overview · Action items · Plan sheet · Timeline · Capacity · Board · Present), the folder
// tabs only on the Plan sheet with Action items fixed first, no sideways scroll, nothing behind the floating + button; a Board card dragged to
// another column saves with "✓ Saved"; a Timeline bar dragged later ripples its dependents. Fictional fixture (lib/portfolioFixture.mjs).
const out = path.resolve('test-results/calm-portfolio-ui');
await fs.mkdir(out, { recursive: true });
const TABS = [['overview', 'Overview'], ['actions', 'Action items'], ['sheet', 'Plan sheet'], ['timeline', 'Timeline'], ['capacity', 'Capacity'], ['board', 'Board']];
const url = (m) => `${origin}/preview-org/work/projects?view=portfolio${m === 'overview' ? '' : `&mode=${m}`}`;
/**
 * The demo's portfolio (fictional): short project names, and Atlas with four phases and ten tasks, one blocked and one overdue, so the
 * Plan sheet reads like demo shot 13. Built on the shared fixture so every endpoint still answers from one state.
 */
function atlasState() {
  const st = makeState();
  const names = { AA: 'Atlas Payments', CB: 'Orbit Mobile', UP: 'Helix Data', DP: 'Beacon Support', PR: 'Lumen Web' };
  for (const r of st.rows) if (r.kind === 'project' && names[r.key]) r.title = names[r.key];
  const atlas = st.rows.find((r) => r.key === 'AA');
  const base = st.rows.find((r) => r.key === 'AA-05');
  st.statuses.push({ id: `${atlas.id}-s4`, projectId: atlas.id, name: 'Blocked', category: 'Active' });
  const sOf = (n) => st.statuses.find((x) => x.id === `${atlas.id}-s${n}`);
  const people = Object.fromEntries(st.rows.filter((r) => r.owner).map((r) => [r.owner.split(' ')[0], [r.ownerId, r.owner]]));
  const who = (n) => people[n] ?? Object.values(people)[0];
  let k = 0;
  const mk = (title, owner, start, due, sn, parentId = null, extra = {}) => {
    const id = `a7000000-0000-4000-8000-${String(++k).padStart(12, '0')}`; const s0 = sOf(sn);
    return { ...base, id, key: `AA-${10 + k}`, title, parentId, level: parentId ? 2 : 1, ownerId: who(owner)[0], owner: who(owner)[1], start, due, status: s0.name, category: s0.category, statusId: s0.id,
      progress: sn === 3 ? 100 : sn === 0 ? 0 : 40, late: false, atRisk: false, dependsOn: [], ...extra };
  };
  const out = [];
  const phase = (title, start, due, kids) => { const p = mk(title, 'Ravi', start, due, 1); out.push(p); for (const c of kids) out.push(mk(...c.slice(0, 5), p.id, c[5])); };
  phase('Build core ledger', '2026-10-20', '2026-10-27', [['Posting service split', 'Ravi', '2026-10-20', '2026-10-23', 3], ['Idempotency keys', 'Ravi', '2026-10-22', '2026-10-27', 3]]);
  phase('QA & hardening', '2026-10-26', '2026-11-02', [['Refund webhook retries', 'Ravi', '2026-10-28', '2026-10-30', 1], ['Staging API keys', 'Aisha', '2026-10-24', '2026-10-27', 4, { late: true }],
    ['Load test 2k tps', 'Jonas', '2026-10-30', '2026-11-02', 0]]);
  phase('Release 2.4', '2026-11-02', '2026-11-06', [['Release checklist', 'Mei', '2026-11-02', '2026-11-04', 0], ['Rollback drill', 'Tomás', '2026-11-03', '2026-11-03', 0], ['Status page notice', 'Mei', '2026-11-04', '2026-11-04', 0]]);
  phase('Post-launch review', '2026-11-09', '2026-11-13', [['Metrics review', 'Ravi', '2026-11-09', '2026-11-13', 0]]);
  // One overdue item outside a phase would break the look; the overdue one is "Staging API keys" (blocked, due before today).
  st.rows = st.rows.filter((r) => !(r.projectId === atlas.id && r.kind !== 'project'));
  st.rows.splice(st.rows.indexOf(atlas) + 1, 0, ...out);
  return st;
}
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const checks = [], errorsAll = [];
const look = (page) => page.evaluate(() => ({
  sideways: document.documentElement.scrollWidth > innerWidth + 1,
  title: document.querySelector('.pfc-title')?.textContent ?? '',
  folder: !!document.querySelector('[role="tablist"][aria-label="Plan sheet projects"]'),
  folderTabs: [...document.querySelectorAll('[role="tablist"][aria-label="Plan sheet projects"] [role="tab"]')].map((e) => e.textContent),
  cols: [...document.querySelectorAll('table[aria-label="Plan sheet"] th')].map((e) => e.textContent),
  field: !!document.querySelector('.pfc .ps3-cmd'),
  pills: [...document.querySelectorAll('[role="tablist"][aria-label="Portfolio view"] [role="tab"]')].map((e) => e.textContent),
  // Nothing interactive under the floating + button (bottom-right 88px square).
  underFab: (() => { const fab = document.querySelector('.v2-fab, .fab, [aria-label="New"]'); if (!fab) return 0; const f = fab.getBoundingClientRect();
    return [...document.querySelectorAll('.pfc button, .pfc a')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.right > f.left && r.left < f.right && r.bottom > f.top && r.top < f.bottom && !fab.contains(e); }).length; })(),
}));
try {
  for (const theme of ['light', 'dark']) for (const width of [1440, 1920, 390]) {
    const state = atlasState();
    const { ctx, page, errors } = await portfolioContext(browser, { width, theme, state });
    for (const [m] of TABS) {
      await page.goto(url(m)); await page.locator('.pfx-stage').first().waitFor(); await page.waitForTimeout(700);
      const s = await look(page);
      assert.equal(s.sideways, false, `${m} ${width} ${theme}: no sideways scroll`);
      assert.deepEqual(s.pills, ['Overview', 'Action items', 'Plan sheet', 'Timeline', 'Capacity', 'Board', 'Present']);
      assert.ok(s.title.length > 3, `${m}: a title`);
      assert.equal(s.folder, m === 'sheet', `${m}: folder tabs only on the Plan sheet`);
      if (m === 'sheet') {
        // The approved design: one folder tab per project by its short name, All last, no Action items tab; exactly five columns; no field bar.
        assert.equal(s.folderTabs.at(-1), 'All'); assert.ok(!s.folderTabs.some((t) => /Action items/.test(t)));
        assert.deepEqual(s.cols, ['Task', 'Owner', 'Start', 'Due', 'Status']); assert.equal(s.field, false);
      }
      if (width !== 390) assert.equal(s.underFab, 0, `${m} ${width}: nothing under the + button`);
      await page.screenshot({ path: path.join(out, `${m}-${width}-${theme}.png`), fullPage: false });
      checks.push(`${m} ${width} ${theme}`);
    }
    if (theme === 'light' && width === 1440) {
      // Present: the calm title slide.
      await page.goto(url('present')); await page.locator('.pf-present').waitFor(); await page.waitForTimeout(500);
      assert.match(await page.locator('.pf-slide.on .pf-calm-t').innerText(), /Week \d+\.\s*Portfolio review\./);
      await page.screenshot({ path: path.join(out, `present-1440-light.png`) }); await page.keyboard.press('Escape');
      // Plan sheet: a Due date opens the rounded calendar with the slip preview.
      await page.goto(url('sheet')); await page.locator('.cps-dc').first().waitFor();
      await page.locator('.cps-dc:not([disabled])').first().click(); await page.locator('.ps3-datepop').waitFor();
      await page.screenshot({ path: path.join(out, 'sheet-date-1440-light.png') }); await page.keyboard.press('Escape');
      // Board: drag a card from To do to In progress — optimistic, "✓ Saved".
      await page.goto(url('board')); await page.locator('.pfb-card').first().waitFor();
      const src = page.locator('.pfb-col').nth(0).locator('.pfb-card').first();
      const name = await src.locator('.pfb-t').innerText();
      { const dt = await page.evaluateHandle(() => new DataTransfer()); const dst = page.locator('.pfb-col').nth(1);
        await src.dispatchEvent('dragstart', { dataTransfer: dt }); await dst.dispatchEvent('dragover', { dataTransfer: dt }); await dst.dispatchEvent('drop', { dataTransfer: dt }); }
      await page.locator('.pfb-col').nth(1).locator('.pfb-card', { hasText: name }).waitFor();
      await page.locator('.pfb-saved').first().waitFor({ timeout: 4000 });
      await page.screenshot({ path: path.join(out, `board-dragged-1440-light.png`) });
      checks.push('board drag saves');
      // Timeline: drag a bar later; the dependents slide with it (ripple), then the reason pop asks.
      await page.goto(url('timeline')); await page.locator('.ptl-bar').first().waitFor();
      const bar = page.locator('.ptl-bar[aria-label^="Atlas"]').first(); const b = await bar.boundingBox();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2 + 60, b.y + b.height / 2, { steps: 8 });
      const ripples = await page.locator('.ptl-rip.on').count();
      await page.screenshot({ path: path.join(out, `timeline-drag-1440-light.png`) });
      await page.mouse.up();
      assert.ok(ripples >= 1, 'a dependent ripples while the bar moves'); checks.push(`timeline drag (${ripples} rippled)`);
    }
    errorsAll.push(...errors.filter((e) => !/favicon|ResizeObserver/.test(e)));
    await ctx.close();
  }
  assert.deepEqual(errorsAll, [], 'no page errors');
  console.log(`OK calm portfolio: ${checks.length} checks\n${checks.join('\n')}`);
} finally { await browser.close(); }
