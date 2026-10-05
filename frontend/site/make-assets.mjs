// Generates the crawlable brand files in public/: favicon.svg, favicon.ico, favicon-48x48.png and the 1200x630 social image.
// Run once after changing the mark:  npm i --no-save playwright-core && node site/make-assets.mjs
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const GRAD = `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c3aed"/><stop offset=".55" stop-color="#a855f7"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient>`;
// A heavier glyph than the app icon so it stays legible at 16 px.
const mark = (r) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs>${GRAD}</defs><rect width="32" height="32" rx="${r}" fill="url(#g)"/>
<path d="M7.3 16.7l5.3 5.3L18.7 13.3" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
<path d="M18.7 13.3l4.3-4.8" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="24.4" cy="7.6" r="2.8" fill="#fff"/></svg>`;
writeFileSync('public/favicon.svg', mark(9));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const shot = async (html, w, h) => {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${html}`);
  const buf = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
  await page.close();
  return buf;
};
const icon = (n) => shot(mark(9).replace('<svg ', `<svg width="${n}" height="${n}" `), n, n);

const png = {};
for (const n of [16, 32, 48]) png[n] = await icon(n);
writeFileSync('public/favicon-48x48.png', png[48]);

// ICO container holding PNG images (supported everywhere that still asks for /favicon.ico).
const sizes = [16, 32, 48];
const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const dirs = sizes.map((n) => {
  const d = Buffer.alloc(16);
  d.writeUInt8(n, 0); d.writeUInt8(n, 1); d.writeUInt8(0, 2); d.writeUInt8(0, 3);
  d.writeUInt16LE(1, 4); d.writeUInt16LE(32, 6); d.writeUInt32LE(png[n].length, 8); d.writeUInt32LE(offset, 12);
  offset += png[n].length;
  return d;
});
writeFileSync('public/favicon.ico', Buffer.concat([head, ...dirs, ...sizes.map((n) => png[n])]));

// Social preview (Open Graph / Twitter): shown when the link is shared and in some search features.
const og = `<div style="width:1200px;height:630px;box-sizing:border-box;padding:84px 96px;display:flex;flex-direction:column;justify-content:center;font-family:Inter,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#fff;background:radial-gradient(circle at 85% 15%,#a855f7 0,rgba(168,85,247,0) 45%),linear-gradient(135deg,#4c1d95 0,#6d28d9 55%,#7c3aed 100%)">
  <div style="display:flex;align-items:center;gap:26px"><div style="width:112px;height:112px">${mark(9).replace('<svg ', '<svg width="112" height="112" ')}</div><div style="font-size:54px;font-weight:700;letter-spacing:-.5px">Project Tracker</div></div>
  <div style="margin-top:56px;font-size:76px;line-height:1.08;font-weight:800;letter-spacing:-1.5px;max-width:960px">Plan the work.<br/>Track it across every team.</div>
  <div style="margin-top:36px;font-size:32px;color:#ede9fe;max-width:900px">Projects, tasks, timesheets and portfolio reporting in one secure workspace.</div>
  <div style="position:absolute;right:96px;top:112px;font-size:28px;color:#ddd6fe;font-weight:600">projecttracker.in</div></div>`;
writeFileSync('public/og-image.png', await shot(og, 1200, 630));
await browser.close();
console.log('assets written');
