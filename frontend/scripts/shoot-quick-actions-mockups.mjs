import { chromium } from 'playwright';
import path from 'node:path';
// Renders the quick-actions design mockups (test-results/quick-actions/mockups.html) to PNGs for design review: 1440 and 390, light and dark.
const dir = path.resolve('test-results/quick-actions'), file = 'file://' + path.join(dir, 'mockups.html');
const browser = await chromium.launch();
for (const [w, tag] of [[1440, 'desktop'], [390, 'phone']]) for (const theme of ['light', 'dark']) {
  const page = await browser.newPage({ viewport: { width: w, height: 900 }, deviceScaleFactor: w < 500 ? 2 : 1 });
  await page.goto(file);
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  if (sw > w) throw new Error(`horizontal scroll at ${w}: ${sw}`);
  await page.screenshot({ path: path.join(dir, `mockups-${tag}-${theme}.png`), fullPage: true });
  await page.close();
}
await browser.close();
console.log('mockups rendered to', dir);
