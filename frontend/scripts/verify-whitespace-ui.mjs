import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { makeState, origin, portfolioContext } from './lib/portfolioFixture.mjs';

// No dead space on Portfolio: every tab, at 1440 x 900 and at 390, is measured for (1) the empty band between the last real content
// (text, bars, cells, charts) and the bottom of the page or of its card, and (2) the dead strip on the right of the stage. Capacity is also
// measured on "My reports" (two people), the short grid that used to leave half the window empty. One fictional fixture (lib/portfolioFixture.mjs).
// `--report <file>` also writes the measurements as a Markdown table.
const out = path.resolve('test-results/whitespace-ui');
await fs.mkdir(out, { recursive: true });
const reportAt = process.argv.includes('--report') ? process.argv[process.argv.indexOf('--report') + 1] : null;
const VIEWS = [['board', 'Board', ''], ['timeline', 'Timeline', ''], ['sheet', 'Plan sheet', ''], ['capacity', 'Capacity', ''], ['capacity-reports', 'Capacity · My reports', 'Reports']];
// The most a page may leave empty: below the last content, inside a card, and on the right.
const LIMIT = { bottom: 120, inCard: 120, right: 120 };
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });

/** Where content really ends: text, form controls, images and the drawn marks (bars, cells, chart columns), not empty backgrounds. */
const measure = (page) => page.evaluate(() => {
  const stage = document.querySelector('.pfx-stage');
  if (!stage) return null;
  const vis = (r) => r.width > 0 && r.height > 0;
  const marks = '.ptl-bar, .ptl-gbar, .ptl-ms, .cp-cell, .pf-bar, .pf-card, svg, img, input, button, [role="img"], .pfp-col i, .pfp-bar';
  const boxes = [];
  const walker = document.createTreeWalker(stage, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent.trim()) continue;
    const el = n.parentElement; if (!el || getComputedStyle(el).visibility === 'hidden' || el.closest('[role="tooltip"], .pf-tip')) continue;
    const rg = document.createRange(); rg.selectNodeContents(n); for (const r of rg.getClientRects()) if (vis(r)) boxes.push(r);
  }
  for (const e of stage.querySelectorAll(marks)) { const r = e.getBoundingClientRect(); if (vis(r) && !e.closest('[role="tooltip"]')) boxes.push(r); }
  const sr = stage.getBoundingClientRect();
  const page = document.querySelector('.pfx-page')?.getBoundingClientRect() ?? sr;
  const bottomOf = (list) => Math.max(...list.map((r) => r.bottom + scrollY));
  const contentBottom = bottomOf(boxes);
  const viewBottom = Math.max(innerHeight, page.bottom + scrollY);
  // Inside each card: the band under its last content.
  const cards = [...stage.querySelectorAll('.ptl-frame, .cp-card, .pf-col, .pf-rail, .pfp-card, .ps4-card, section.card')].map((c) => {
    const r = c.getBoundingClientRect(); if (!vis(r)) return null;
    const inner = boxes.filter((b) => b.top >= r.top - 1 && b.bottom <= r.bottom + 1 && b.left >= r.left - 1 && b.right <= r.right + 1);
    const last = inner.length ? Math.max(...inner.map((b) => b.bottom)) : r.top;
    return { cls: c.className.split(' ').slice(0, 2).join('.'), empty: Math.round(r.bottom - last) };
  }).filter(Boolean);
  const worst = cards.reduce((a, c) => (c.empty > (a?.empty ?? -1) ? c : a), null);
  const contentRight = Math.max(...boxes.map((r) => r.right));
  return {
    bottom: Math.max(0, Math.round(viewBottom - contentBottom - 24)), // less the page's own bottom padding
    inCard: worst ? worst.empty : 0, inCardWhere: worst?.cls ?? '-',
    right: Math.max(0, Math.round(sr.right - contentRight - 24)),
    sideways: document.documentElement.scrollWidth > innerWidth + 1,
  };
});

const rows = [];
const failures = [];
try {
  for (const width of [1440, 390]) {
    for (const [mode, label, scope] of VIEWS) {
      const { ctx, page, errors } = await portfolioContext(browser, { width, state: makeState() });
      const m = mode.startsWith('capacity') ? 'capacity' : mode;
      await page.goto(`${origin}/preview-org/work/projects?view=portfolio&mode=${m}`);
      await page.locator('.pfx-stage').first().waitFor();
      await page.waitForTimeout(700);
      if (scope) { await page.getByRole('radio', { name: 'My reports' }).or(page.getByRole('button', { name: 'My reports' })).or(page.getByRole('tab', { name: 'My reports' })).first().click(); await page.waitForTimeout(600); }
      await page.evaluate(() => document.fonts.ready);
      if (mode === 'timeline' && width > 500) {
        // One colour per row: the project's square only; the status is the bar's style and a word.
        const marks = await page.locator('.ptl-prow').evaluateAll((els) => els.map((e) => e.querySelectorAll('i').length));
        assert.ok(marks.length > 0 && marks.every((n) => n === 1), `one colour mark per timeline row: ${marks}`);
        assert.equal(await page.locator('.ptl-names .ptl-dot').count(), 0, 'no status dots on the timeline');
        assert.equal(await page.locator('.ptl-bar[class*="pc-"]').count(), await page.locator('.ptl-bar').count(), 'every bar is in its project colour');
        assert.match(await page.locator('.ptl-label .ptl-st').first().innerText(), /^(Late|At risk)$/);
      }
      const r = await measure(page);
      assert.ok(r, `${label} @${width}: the stage is drawn`);
      await page.screenshot({ path: path.join(out, `${mode}-${width}.png`), fullPage: width < 500 });
      rows.push({ view: label, width, ...r });
      const lim = width < 500 ? { ...LIMIT, right: 40 } : LIMIT;
      if (r.bottom > lim.bottom) failures.push(`${label} @${width}: ${r.bottom}px empty under the content (limit ${lim.bottom})`);
      if (r.inCard > lim.inCard) failures.push(`${label} @${width}: ${r.inCard}px empty inside ${r.inCardWhere} (limit ${lim.inCard})`);
      if (r.right > lim.right) failures.push(`${label} @${width}: ${r.right}px dead on the right (limit ${lim.right})`);
      if (r.sideways) failures.push(`${label} @${width}: sideways scroll`);
      assert.deepEqual(errors, [], `${label} @${width}: no page errors`);
      await ctx.close();
    }
  }
  // The calm inline status on the Board when the work is done and sign-offs are open: one card, an icon, one sentence, one action.
  for (const width of [1440, 390]) {
    const state = makeState();
    for (const r of state.rows.filter((x) => x.projectId === state.rows.find((y) => y.key === 'DP').id)) { r.category = 'Done'; r.progress = 100; r.status = 'Done'; }
    const { ctx, page, errors } = await portfolioContext(browser, { width, state });
    await page.goto(`${origin}/preview-org/work/projects?view=portfolio`);
    const note = page.getByRole('status', { name: 'Work complete, check sign-offs' });
    await note.waitFor();
    assert.match(await note.innerText(), /All work is done on Data Privacy API\.\s*Release sign-offs are still open\./);
    assert.equal(await note.getByRole('link').count(), 1, 'one action');
    assert.equal(await note.getByRole('link').getAttribute('href'), `/preview-org/work/projects/${state.rows.find((y) => y.key === 'DP').id}`);
    await page.screenshot({ path: path.join(out, `board-signoff-${width}.png`) });
    const box = await note.boundingBox(); assert.ok(box.height <= (width < 500 ? 120 : 64), `the note stays one calm line (${box.height}px)`);
    assert.equal(await page.locator('h3', { hasText: 'Work complete · check release sign-offs' }).count(), 0, 'the old banner is gone');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(out, `board-signoff-${width}.png`) });
    assert.deepEqual(errors, []);
    await ctx.close();
  }
} finally { await browser.close(); }

const table = ['| View | Width | Empty below content (px) | Worst empty band in a card (px) | Card | Dead on the right (px) |', '|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.view} | ${r.width} | ${r.bottom} | ${r.inCard} | ${r.inCardWhere} | ${r.right} |`)].join('\n');
console.log(table);
if (reportAt) await fs.writeFile(reportAt, `${table}\n`);
assert.deepEqual(failures, [], `Dead space:\n${failures.join('\n')}`);
console.log(JSON.stringify({ ok: true, checks: rows.length, out }, null, 2));
