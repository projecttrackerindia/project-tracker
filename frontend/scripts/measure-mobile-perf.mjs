import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { appCsp } from './lib/csp.mjs';

// Playwright's request routing bypasses DevTools network emulation, so the throttle is applied here: every response waits one round trip
// (150 ms) and then its bytes (gzip size for scripts and styles) queue on one shared 1.6 Mbit/s downlink.
const RTT = 150, BYTES_PER_MS = (1.6 * 1024 * 1024) / 8 / 1000;
let pipeFree = 0;
const wire = async (bytes) => {
  const start = Math.max(Date.now() + RTT, pipeFree);
  pipeFree = start + bytes / BYTES_PER_MS;
  await new Promise((r) => setTimeout(r, pipeFree - Date.now()));
};
// Phone performance probe over the built app (dist) with a synthetic API (fictional data): Today, Messages and Approvals at 390 px on
// "Fast 3G" (150 ms RTT, 1.6 Mbit/s down, 750 kbit/s up, as Lighthouse/DevTools define it) with the CPU slowed 4x. Per page it records the
// JavaScript downloaded before the page settled (files and gzip kB, critical = before first paint vs later), first contentful paint, largest
// contentful paint, a time-to-interactive proxy (network quiet for 500 ms and no long task for 500 ms after FCP), and the waterfall of API
// calls (start, end, in what order). Every synthetic API call answers after LATENCY ms (default 120) on top of the throttle.
// Prints JSON; fails only if a page did not render. Run: node scripts/measure-mobile-perf.mjs [label]
const origin = 'https://projecttracker-preview.test', dist = path.resolve(process.env.DIST ?? 'dist');
const csp = await appCsp();
const latency = Number(process.env.LATENCY ?? 120);
const g = (n) => `90000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const user = { id: g(1), displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: g(9), slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 3 };
const me = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, reportCount: 0, permissions: ['projects.view', 'projects.edit', 'projects.create', 'tasks.view', 'tasks.edit', 'tasks.create', 'work.view', 'work.create', 'reports.view'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 0, activity: 3, documents: 3, people: 3, reports: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: {} } };

const pages = [['Today', '/preview-org/'], ['Messages', '/preview-org/messages'], ['Approvals', '/preview-org/approvals']];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const results = [];
for (const [name, url] of pages) {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  // A person who has signed in on this phone before (pm_hint), opening the app with an empty cache: the first-visit case for the app.
  // HINT=0 measures a browser that has never signed in here.
  await ctx.addInitScript((hint) => {
    localStorage.setItem('pm_alerts_prompt', '1');
    if (hint) localStorage.setItem('pm_hint', '1');
    window.__perf = { lcp: 0, fcp: 0, long: [] };
    new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__perf.lcp = e.startTime; window.__perf.lcpEl = e.element ? `${e.element.tagName.toLowerCase()}.${[...e.element.classList].join('.')} "${(e.element.textContent ?? '').trim().slice(0, 40)}"` : ''; } }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') window.__perf.fcp = e.startTime; }).observe({ type: 'paint', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.long.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true });
  }, process.env.HINT !== '0');
  pipeFree = 0;
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  let t0 = Date.now();
  let log = { js: [], api: [], inflight: 0, lastActivity: t0 };
  const cached = new Set();   // WARM=1: the second open finds the fingerprinted files in the HTTP cache (nginx: immutable)
  await ctx.route('**/*', async (route) => {
    const req = route.request(), u = new URL(req.url()), ep = u.pathname;
    if (u.origin !== origin || ep.startsWith('/hubs/')) return route.abort();
    if (!ep.startsWith('/api/')) {
      log.inflight++; log.lastActivity = Date.now();
      try {
      const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html');
      let body; try { body = await fs.readFile(file); } catch { return route.fulfill({ status: 404, body: '' }); }
      const hit = ep.startsWith('/assets/') && cached.has(ep);
      if (!hit) await wire(ep.startsWith('/assets/') ? zlib.gzipSync(body).length : body.length);
      if (ep.startsWith('/assets/')) cached.add(ep);
      if (ep.endsWith('.css') || ep.endsWith('.woff2')) (log.other ??= []).push({ file: ep.replace('/assets/', ''), gz: hit ? 0 : (ep.endsWith('.css') ? zlib.gzipSync(body).length : body.length), at: Date.now() - t0 });
      if (ep.endsWith('.js')) log.js.push({ file: ep.replace('/assets/', ''), gz: hit ? 0 : zlib.gzipSync(body).length, at: Date.now() - t0 });
      return await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream', body, headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
      } finally { log.inflight--; log.lastActivity = Date.now(); }
    }
    const entry = { call: `${req.method()} ${ep.replace('/api/v1', '')}${u.search}`, start: Date.now() - t0, end: 0 };
    log.api.push(entry); log.inflight++;
    await new Promise((r) => setTimeout(r, latency));
    await wire(600);
    let data = [];
    if (ep.endsWith('/auth/refresh')) data = { accessToken: `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`, expiresAt: '2099-01-01T00:00:00Z', user };
    else if (ep === '/api/v1/me') data = me;
    else if (ep === '/api/v1/me/fingerprint') data = { fingerprint: me.fingerprint };
    else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: true };
    else if (ep.endsWith('/approvals')) data = { items: [], counts: { needsMe: 0, mine: 0, all: 0, history: 0 }, week: { approved: 0, rejected: 0, expired: 0, medianMinutes: null }, byType: {}, elsewhere: [] };
    else if (ep.endsWith('/shell/summary')) data = { workspaceId: ws.id, notifications: { unread: 0, needsYou: 0, forInfo: 0, tabs: {} }, approvals: { needsMe: 0 }, chatUnread: { count: 0, conversations: 0 }, reminders: null };
    else if (ep.endsWith('/approvals/counts')) data = { needsMe: 0, mine: 0, all: 0, history: 0 };
    else if (ep.endsWith('/notifications/counts')) data = { unread: 0, needsYou: 0, forInfo: 0, tabs: {} };
    else if (ep.endsWith('/avatar') || ep.endsWith('/file')) { log.inflight--; entry.end = Date.now() - t0; return route.fulfill({ status: 404, body: '' }); }
    log.inflight--; entry.end = Date.now() - t0; log.lastActivity = Date.now();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  page.on('request', () => { log.lastActivity = Date.now(); });
  const settle = async () => {
    await page.goto(origin + url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    // Settled: nothing on the network for 2.5 s (or 60 s at most).
    while (Date.now() - log.lastActivity < 2500 || log.inflight > 0) { if (Date.now() - t0 > 60_000) break; await page.waitForTimeout(100); }
    await page.waitForTimeout(800);
  };
  await settle();
  if (process.env.WARM) {
    // Reopening the app later: same device (its storage and HTTP cache), a fresh page load.
    await page.waitForTimeout(5000);   // the warm-start copy is saved a few seconds after reads settle
    await page.goto('about:blank');
    t0 = Date.now(); log = { js: [], api: [], inflight: 0, lastActivity: t0 }; pipeFree = 0;
    await settle();
  }
  const perf = await page.evaluate(() => window.__perf);
  const rendered = await page.evaluate(() => (document.querySelector('main')?.textContent ?? document.body.textContent ?? '').trim().length > 0);
  const scrollX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  // Time-to-interactive proxy: after FCP, the first moment with 500 ms free of long tasks and of API traffic.
  const quietFrom = Math.max(perf.fcp, ...perf.long.map(([s, d]) => s + d), ...log.api.map((a) => a.end));
  const fcpAt = perf.fcp;
  const critical = log.js.filter((j) => j.at <= fcpAt + 50);
  results.push({
    page: name, rendered, scrollX,
    jsFiles: log.js.length, jsKB: +(log.js.reduce((a, b) => a + b.gz, 0) / 1024).toFixed(1),
    criticalJsFiles: critical.length, criticalJsKB: +(critical.reduce((a, b) => a + b.gz, 0) / 1024).toFixed(1),
    // Bytes that arrived before the page's largest paint (with the splash in index.html, first contentful paint is the splash itself).
    lcpJsKB: +(log.js.filter((j) => j.at <= perf.lcp + 50).reduce((a, b) => a + b.gz, 0) / 1024).toFixed(1),
    lcpCssKB: +((log.other ?? []).filter((c) => c.file.endsWith('.css') && c.at <= perf.lcp + 50).reduce((a, b) => a + b.gz, 0) / 1024).toFixed(1),
    cssKB: +((log.other ?? []).filter((c) => c.file.endsWith('.css')).reduce((a, b) => a + b.gz, 0) / 1024).toFixed(1),
    criticalCssKB: +((log.other ?? []).filter((c) => c.file.endsWith('.css') && c.at <= fcpAt + 50).reduce((a, b) => a + b.gz, 0) / 1024).toFixed(1),
    fontKB: +((log.other ?? []).filter((c) => c.file.endsWith('.woff2')).reduce((a, b) => a + b.gz, 0) / 1024).toFixed(1),
    fcpMs: Math.round(perf.fcp), lcpMs: Math.round(perf.lcp), lcpElement: perf.lcpEl, ttiMs: Math.round(quietFrom),
    longTasks: perf.long.length, longTaskMs: Math.round(perf.long.reduce((a, [, d]) => a + d, 0)),
    apiCalls: log.api.length, apiWaterfall: log.api.map((a) => `${String(a.start).padStart(5)}→${String(a.end).padStart(5)} ${a.call}`),
    ...(process.env.ASSETS ? { js: log.js.sort((a, b) => b.gz - a.gz).slice(0, 20).map((j) => `${(j.gz / 1024).toFixed(1).padStart(6)} @${j.at} ${j.file}`), other: (log.other ?? []).map((j) => `${(j.gz / 1024).toFixed(1).padStart(6)} @${j.at} ${j.file}`) } : {}),
  });
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify({ label: process.argv[2] ?? 'run', network: 'Fast 3G + 4x CPU, 390x844', warm: !!process.env.WARM, apiLatencyMs: latency, results }, null, 1));
if (results.some((r) => !r.rendered)) process.exit(1);
