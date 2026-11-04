import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { makeState, origin, portfolioContext } from './lib/portfolioFixture.mjs';

// Calm round 3, Portfolio: Action items show Owner · Start · Due · Status like the Plan sheet, edited in place (✓ Saved, PATCH with the
// item's version); clicking an item or a Plan sheet task opens the Work side panel over Portfolio (the address stays on Portfolio); the same
// action item listed twice shows once; the searchable picker (type, arrows, Enter) chooses the owner. 1440 and 390, light and dark.
const out = path.resolve('test-results/calm-round3');
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const checks = [];
try {
  for (const theme of ['light', 'dark']) for (const width of [1440, 1920, 390]) {
    const tag = `${width}-${theme}`;
    const state = makeState();
    const { ctx, page, errors } = await portfolioContext(browser, { width, theme, state });
    await page.goto(`${origin}/preview-org/work/projects?view=portfolio&mode=actions`);
    await page.getByText('Draft the release note').first().waitFor();
    await page.waitForTimeout(600);
    assert.equal(await page.getByRole('button', { name: /^Draft the release note/ }).count(), 1, 'the duplicate shows once');
    if (width >= 1440) {
      const head = await page.locator('.pfa-colh').first().innerText();
      assert.match(head.replace(/\s+/g, ' '), /Item Owner Start Due Status/);
    }
    assert.ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), `${tag}: no sideways scroll`);
    await page.screenshot({ path: path.join(out, `actions-${tag}.png`) });
    if (theme === 'light') {
      // Owner: the calm picker.
      await page.getByRole('button', { name: /^Owner of Freeze main at 14:30/ }).click();
      await page.getByRole('combobox', { name: /Search owner of freeze main/i }).fill(state.people?.[3]?.name?.slice(0, 3) ?? 'a');
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('Enter');
      await page.getByText('✓ Saved').first().waitFor();
      assert.ok(state.writes.some((w) => w.method === 'PATCH' && /work-items/.test(w.ep) && 'assigneeId' in w.b && w.b.version >= 1), 'owner saved with the version');
      // Due date in place.
      await page.getByLabel('Due of Draft the release note').fill('2026-11-03');
      await page.waitForTimeout(300);
      assert.ok(state.writes.some((w) => w.method === 'PATCH' && w.b.dueDate === '2026-11-03'), 'due saved in place');
      // Opening an item keeps Portfolio: the side panel.
      const before = page.url();
      await page.getByRole('button', { name: /^Share the sandbox keys with QA/ }).click();
      await page.getByTestId('calm-work-sheet').waitFor();
      assert.equal(page.url(), before, 'still on Portfolio');
      await page.screenshot({ path: path.join(out, `actions-sheet-${tag}.png`) });
      await page.keyboard.press('Escape');
      // Plan sheet: a task opens the same panel.
      await page.goto(`${origin}/preview-org/work/projects?view=portfolio&mode=sheet`);
      await page.locator('.cps-t').first().waitFor();
      const u = page.url();
      await page.locator('button.cps-t').first().click();
      await page.getByTestId('calm-work-sheet').waitFor();
      assert.equal(page.url(), u, 'Plan sheet: still on Portfolio');
      await page.screenshot({ path: path.join(out, `plansheet-sheet-${tag}.png`) });
      checks.push(`actions + plan sheet side panel ${tag}`);
    }
    assert.deepEqual(errors, [], `${tag}: no page errors`);
    checks.push(`actions ${tag}`);
    await ctx.close();
  }
} finally { await browser.close(); }
console.log(`OK calm round 3 portfolio: ${checks.length} checks\n${checks.join('\n')}`);
