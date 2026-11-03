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
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const checks = [], errorsAll = [];
const look = (page) => page.evaluate(() => ({
  sideways: document.documentElement.scrollWidth > innerWidth + 1,
  title: document.querySelector('.pfc-title')?.textContent ?? '',
  folder: !!document.querySelector('[role="tablist"][aria-label="Plan sheet tabs"]'),
  firstFolder: document.querySelector('[role="tablist"][aria-label="Plan sheet tabs"] [role="tab"]')?.textContent ?? null,
  pills: [...document.querySelectorAll('[role="tablist"][aria-label="Portfolio view"] [role="tab"]')].map((e) => e.textContent),
  // Nothing interactive under the floating + button (bottom-right 88px square).
  underFab: (() => { const fab = document.querySelector('.v2-fab, .fab, [aria-label="New"]'); if (!fab) return 0; const f = fab.getBoundingClientRect();
    return [...document.querySelectorAll('.pfc button, .pfc a')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.right > f.left && r.left < f.right && r.bottom > f.top && r.top < f.bottom && !fab.contains(e); }).length; })(),
}));
try {
  for (const theme of ['light', 'dark']) for (const width of [1440, 1920, 390]) {
    const { ctx, page, errors } = await portfolioContext(browser, { width, theme, state: makeState() });
    for (const [m] of TABS) {
      await page.goto(url(m)); await page.locator('.pfx-stage').first().waitFor(); await page.waitForTimeout(700);
      const s = await look(page);
      assert.equal(s.sideways, false, `${m} ${width} ${theme}: no sideways scroll`);
      assert.deepEqual(s.pills, ['Overview', 'Action items', 'Plan sheet', 'Timeline', 'Capacity', 'Board', 'Present']);
      assert.ok(s.title.length > 3, `${m}: a title`);
      assert.equal(s.folder, m === 'sheet', `${m}: folder tabs only on the Plan sheet`);
      if (m === 'sheet') assert.match(s.firstFolder ?? '', /Action items/, 'Action items is the fixed first folder tab');
      if (width !== 390) assert.equal(s.underFab, 0, `${m} ${width}: nothing under the + button`);
      await page.screenshot({ path: path.join(out, `${m}-${width}-${theme}.png`), fullPage: false });
      checks.push(`${m} ${width} ${theme}`);
    }
    if (theme === 'light' && width === 1440) {
      // Present: the calm title slide.
      await page.goto(url('present')); await page.locator('.pf-present').waitFor(); await page.waitForTimeout(500);
      assert.match(await page.locator('.pf-slide.on .pf-calm-t').innerText(), /Week \d+\.\s*Portfolio review\./);
      await page.screenshot({ path: path.join(out, `present-1440-light.png`) }); await page.keyboard.press('Escape');
      // Board: drag a card from To do to In progress — optimistic, "✓ Saved".
      await page.goto(url('board')); await page.locator('.pfb-card').first().waitFor();
      const src = page.locator('.pfb-col').nth(0).locator('.pfb-card').first();
      const name = await src.locator('.pfb-t').innerText();
      await src.dragTo(page.locator('.pfb-col').nth(1));
      await page.locator('.pfb-col').nth(1).locator('.pfb-card', { hasText: name }).waitFor();
      await page.locator('.pfb-saved').first().waitFor({ timeout: 4000 });
      await page.screenshot({ path: path.join(out, `board-dragged-1440-light.png`) });
      checks.push('board drag saves');
      // Timeline: drag a bar later; the dependents slide with it (ripple), then the reason pop asks.
      await page.goto(url('timeline')); await page.locator('.ptl-bar').first().waitFor();
      const bar = page.locator('.ptl-bar').first(); const b = await bar.boundingBox();
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
