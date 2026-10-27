// Shared by the UI checks: the page fills the main area (no empty band on the right) and a toolbar segmented control sits wholly inside the toolbar.
export async function assertFills(page, sel, label) {
  const r = await page.evaluate((s) => { const e = document.querySelector(s); const b = e.getBoundingClientRect(); return { right: b.right, w: Math.round(Math.min(document.documentElement.clientWidth, document.documentElement.getBoundingClientRect().right)) }; }, sel);
  if (r.w - r.right > 40) throw new Error(`${label}: content ends at ${Math.round(r.right)}px in a ${r.w}px window (empty band on the right)`);
}
export async function assertInToolbar(page, sel, label) {
  const r = await page.evaluate((s) => { const t = document.querySelector('.v2-tb').getBoundingClientRect(), e = document.querySelector(s).getBoundingClientRect();
    return { t: [t.top, t.bottom, t.left, t.right], e: [e.top, e.bottom, e.left, e.right] }; }, sel);
  const [tt, tb, tl, tr] = r.t, [et, eb, el, er] = r.e;
  if (et < tt - 0.5 || eb > tb + 0.5 || el < tl || er > tr) throw new Error(`${label}: the segmented control (${r.e.map(Math.round)}) is not inside the toolbar (${r.t.map(Math.round)})`);
  if (Math.abs((et + eb) / 2 - (tt + tb) / 2) > 1.5) throw new Error(`${label}: the segmented control is not vertically centred in the toolbar`);
}
// The element reaches the right edge of the main area's content box (no page-level max-width leaving a band), at any width.
export async function assertFillsMain(page, sel, label) {
  const r = await page.evaluate((s) => { const m = document.querySelector('#main-content'), e = document.querySelector(s);
    return { inner: m.getBoundingClientRect().right - parseFloat(getComputedStyle(m).paddingRight), right: e.getBoundingClientRect().right }; }, sel);
  if (r.inner - r.right > 8) throw new Error(`${label}: content stops ${Math.round(r.inner - r.right)}px short of the main area's edge`);
}
