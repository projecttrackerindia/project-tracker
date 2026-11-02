// Current phone bar and Aura Create sheet replace the retired capsule/FAB.
import assert from 'node:assert/strict';
import { go, start, waitFor } from './support.mjs';
const s = await start('demo@example.com', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
try {
  await go(s);
  const bar = s.page.locator('.v2-phone-bar');
  await bar.waitFor();
  assert.equal(await bar.locator('.v2-phone-tab').count(), 5);
  assert.equal(await bar.getByRole('link', { name: /Today/ }).getAttribute('aria-current'), 'page');
  assert.equal(await s.page.locator('.v2-side').count(), 0);
  await bar.getByRole('link', { name: /Projects/ }).click();
  await s.page.waitForURL(/\/work\/projects/);
  await waitFor(async () => await bar.getByRole('link', { name: /Projects/ }).getAttribute('aria-current') === 'page', 'Projects becomes the current phone destination');
  await bar.getByRole('button', { name: /More/ }).click();
  const more = s.page.getByRole('dialog'); await more.waitFor();
  await more.getByRole('button', { name: /Library/ }).waitFor();
  await s.page.keyboard.press('Escape'); await more.waitFor({ state: 'hidden' });
  await go(s);
  await s.page.locator('.aura-dock input').click();
  await s.page.locator('.aura-chip[data-chip="task"]').click();
  const create = s.page.getByRole('dialog'); await create.waitFor();
  assert.ok(await create.isVisible(), 'Create task opens a phone sheet');
  assert.ok(await s.page.evaluate(() => [...document.querySelectorAll('input,textarea,select')].filter((e) => e.getBoundingClientRect().height).every((e) => parseFloat(getComputedStyle(e).fontSize) >= 16)), 'Phone fields avoid focus zoom');
  await s.page.keyboard.press('Escape');
  for (const path of ['', '/work', '/work/projects', '?tab=calendar', '/work/projects?view=portfolio', '/people']) {
    await go(s, path); await s.page.locator('main').waitFor();
    assert.ok(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), path + ' fits a phone');
  }
  await go(s);
  await s.page.getByRole('region', { name: 'Your day', exact: true }).waitFor();
  let reads = 0; s.page.on('request', (r) => { if (r.url().includes('/api/v1/') && r.method() === 'GET') reads++; });
  await s.page.waitForTimeout(300); reads = 0;
  await s.page.evaluate(async () => {
    const touch = (y) => new Touch({ identifier: 1, target: document.body, clientX: 190, clientY: y });
    const fire = (type, y) => document.body.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [touch(y)], changedTouches: [touch(y)] }));
    window.scrollTo(0, 0); fire('touchstart', 200);
    for (let y = 220; y <= 420; y += 20) fire('touchmove', y);
    fire('touchend', 420); await new Promise((r) => setTimeout(r, 1200));
  });
  assert.ok(reads > 0, 'Pull to refresh requests current data');
  await s.page.setViewportSize({ width: 1366, height: 900 });
  await s.page.locator('.v2-side').waitFor();
  assert.equal(await s.page.locator('.v2-phone-bar').count(), 0);
  await s.page.setViewportSize({ width: 390, height: 844 }); await bar.waitFor();
  console.log('PASS phone navigation, More, Create, field sizing, layouts, refresh and resize');
} finally { await s.finish(); }
