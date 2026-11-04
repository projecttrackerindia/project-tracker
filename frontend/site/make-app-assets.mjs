// Generates every app icon size (PWA any + maskable, Android launcher source) and the iOS splash screens from the calm purple check mark.
// Run after changing the mark:  node site/make-app-assets.mjs   (uses the Playwright Chromium already installed for the UI checks)
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, readdirSync } from 'node:fs';

const GRAD = `<linearGradient id="g" x1="8" y1="4" x2="56" y2="60" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#8b6cf6"/><stop offset=".55" stop-color="#a27cf8"/><stop offset="1" stop-color="#b996fb"/></linearGradient><linearGradient id="h" x1="0" y1="0" x2="0" y2="64" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>`;
const GLYPH = `<path d="M20 34l8 8L43 24" fill="none" stroke="#fff" stroke-width="5.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="44.5" cy="22.5" r="4.4" fill="#fff"/>`;
const rounded = (n) => `<svg width="${n}" height="${n}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs>${GRAD}</defs><rect x="2" y="2" width="60" height="60" rx="16" fill="url(#g)"/><rect x="2" y="2" width="60" height="60" rx="16" fill="url(#h)"/><rect x="2.5" y="2.5" width="59" height="59" rx="15.5" fill="none" stroke="#fff" stroke-opacity=".35"/>${GLYPH}</svg>`;
// Maskable: full bleed, glyph inside the 80% safe zone.
const maskable = (n) => `<svg width="${n}" height="${n}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs>${GRAD}</defs><rect width="64" height="64" fill="url(#g)"/><rect width="64" height="64" fill="url(#h)"/><g transform="translate(9.6 9.6) scale(.7)">${GLYPH}</g></svg>`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const shot = async (html, w, h, bg = 'transparent') => {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.setContent(`<style>html,body{margin:0;background:${bg}}</style>${html}`);
  const buf = await page.screenshot({ omitBackground: bg === 'transparent', clip: { x: 0, y: 0, width: w, height: h } });
  await page.close();
  return buf;
};

mkdirSync('public/icons', { recursive: true });
for (const n of [72, 96, 128, 144, 152, 192, 256, 384, 512]) writeFileSync(`public/icons/icon-${n}.png`, await shot(rounded(n), n, n));
for (const n of [192, 512]) writeFileSync(`public/icons/icon-maskable-${n}.png`, await shot(maskable(n), n, n));
writeFileSync('public/icons/apple-touch-icon.png', await shot(maskable(180), 180, 180));
for (const f of ['icon-512.png', 'icon-maskable-512.png']) writeFileSync(`../apps/android/icons/${f}`, await shot(f.includes('mask') ? maskable(512) : rounded(512), 512, 512));
mkdirSync('../apps/ios/icons', { recursive: true });
writeFileSync('../apps/ios/icons/AppIcon-1024.png', await shot(maskable(1024), 1024, 1024, '#8b6cf6'));

// iOS launch screens: the calm canvas, the mark and the wordmark (filenames are WxH, linked from index.html).
for (const f of readdirSync('public/splash').filter((x) => /^\d+x\d+\.png$/.test(x))) {
  const [w, h] = f.replace('.png', '').split('x').map(Number);
  const s = Math.round(Math.min(w, h) * 0.24);
  const html = `<div style="width:${w}px;height:${h}px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${Math.round(s * 0.28)}px;background:#f6f4fb;font:600 ${Math.round(s * 0.24)}px -apple-system,'Inter Variable',system-ui,sans-serif;color:#1d1830;letter-spacing:-.01em">${rounded(s)}<div>ProjectTracker</div></div>`;
  writeFileSync(`public/splash/${f}`, await shot(html, w, h, '#f6f4fb'));
}
await browser.close();
console.log('app icons and splash screens written');
