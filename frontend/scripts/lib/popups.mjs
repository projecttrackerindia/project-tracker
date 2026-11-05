// Dark-mode guard: open every dropdown / picker / popover trigger on the page and fail on any popup with a light (white) surface,
// or on any native <select> left visible (its list is drawn by the OS, white on Windows). Call with the page already in dark mode.
const TRIGGERS = '.ss-trigger, .cpk-trigger, [aria-haspopup="listbox"], [aria-haspopup="menu"], [aria-haspopup="true"]';
const POPS = '.ss-pop, .cpk-pop, .cpk-sheet, [role="listbox"], [role="menu"]';

export async function darkPopups(page, what, assert, { max = 24 } = {}) {
  const natives = await page.evaluate(() => [...document.querySelectorAll('select')].filter((s) => { const r = s.getBoundingClientRect(), cs = getComputedStyle(s); return r.width > 4 && r.height > 4 && cs.visibility !== 'hidden' && cs.opacity !== '0'; }).map((s) => s.getAttribute('aria-label') || s.name || s.className));
  assert.deepEqual(natives, [], `${what}: no visible native <select>`);
  const n = Math.min(max, await page.locator(TRIGGERS).count());
  const bad = [];
  let opened = 0;
  for (let i = 0; i < n; i++) {
    const t = page.locator(TRIGGERS).nth(i);
    if (!(await t.isVisible().catch(() => false)) || await t.isDisabled().catch(() => true)) continue;
    const label = (await t.getAttribute('aria-label')) || (await t.innerText().catch(() => '')).slice(0, 30);
    await t.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(250);
    const res = await page.evaluate((sel) => {
      const lum = (c) => { const m = c.match(/[\d.]+/g); if (!m) return null; const [r, g, b, a = 1] = m.map(Number); if (a < 0.5) return null; return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
      const bg = (el) => { for (let e = el; e && e !== document.documentElement; e = e.parentElement) { const l = lum(getComputedStyle(e).backgroundColor); if (l !== null) return l; } return null; };
      return [...document.querySelectorAll(sel)].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 20 && r.height > 20 && getComputedStyle(el).visibility !== 'hidden'; }).map((el) => ({ cls: el.className, l: bg(el) }));
    }, POPS);
    if (res.length) opened++;
    for (const r of res) if (r.l !== null && r.l > 0.6) bad.push(`${label} → ${r.cls} (${r.l.toFixed(2)})`);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(120);
  }
  assert.deepEqual(bad, [], `${what}: no white popups in dark mode`);
  return opened;
}
