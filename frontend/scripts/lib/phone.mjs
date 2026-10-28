// Phone checks shared by the screen tests: nothing may scroll the page sideways, and nothing may be cut off at the right edge
// (an element wider than the screen whose overflow is hidden by a parent - the page looks fine to scrollWidth but loses its edge).
export async function cutOff(page) {
  // Let slide-ins (a pane opening) settle first: mid-transition a pane sits partly off screen by design.
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})))).catch(() => {});
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (!r.width || r.right <= innerWidth + 1 || r.left >= innerWidth) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.position === 'fixed') continue;
      if (el.closest('.toast-root')) continue;   // toasts slide in from the edge for a moment, then settle on screen
      let p = el.parentElement, scroller = false;
      while (p) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') { scroller = true; break; } p = p.parentElement; }
      if (scroller) continue;
      if (el.parentElement && el.parentElement.getBoundingClientRect().right > innerWidth + 1) continue;   // report the outermost only
      const name = (e) => `${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).join('.') : ''}`;
      out.push(`${el.parentElement ? name(el.parentElement) + ' > ' : ''}${name(el)} right=${Math.round(r.right)}`);
    }
    return out.slice(0, 12);
  });
}
export async function fitsPhone(page, what, assert) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${what}: no sideways scroll`);
  assert.deepEqual(await cutOff(page), [], `${what}: cut off at the right edge`);
}
