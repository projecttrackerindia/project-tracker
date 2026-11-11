import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { appCsp } from './lib/csp.mjs';

// Performance probe over the built app (dist) with a synthetic API: for Home, My work, the Portfolio plan sheet, Messages and Calendar it
// records the scripts and styles loaded (count and gzip kB), the API requests on first load, and the API requests one task edit sets off
// (the same "mutation committed" fact the API client emits after a successful PATCH /tasks/{id}). Prints JSON; no assertions except
// that each page rendered. Run: node scripts/measure-perf.mjs [label]
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist');
const csp = await appCsp();
const g = (n) => `90000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const user = { id: g(1), displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: g(9), slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 1 };
const me = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, reportCount: 0, permissions: ['projects.view', 'projects.edit', 'projects.create', 'tasks.view', 'tasks.edit', 'tasks.create', 'work.view', 'work.create', 'reports.view'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 0, activity: 3, documents: 3, people: 3, reports: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: {} } };

// The families the current source routes for a task edit, read from src so before/after runs measure the code as it is.
// Node strips the TypeScript types itself (the module has no runtime imports).
const { mutationFamilies } = await import(path.resolve('src/lib/mutationEffects.ts'));
const families = mutationFamilies('PATCH', '/tasks/' + g(500));

const pages = [['Home', '/preview-org/'], ['My work', '/preview-org/work'], ['Plan sheet', '/preview-org/work/projects?view=portfolio&mode=sheet'], ['Messages', '/preview-org/messages'], ['Calendar', '/preview-org/?tab=calendar']];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const results = [];
for (const [name, url] of pages) {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
  await ctx.addInitScript(() => { localStorage.setItem('pm_alerts_prompt', '1'); });
  const log = { assets: new Map(), api: [] };
  await ctx.route('**/*', async (route) => {
    const req = route.request(), u = new URL(req.url()), ep = u.pathname;
    if (u.origin !== origin || ep.startsWith('/hubs/')) return route.abort();
    if (!ep.startsWith('/api/')) {
      const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html');
      let body; try { body = await fs.readFile(file); } catch { return route.fulfill({ status: 404, body: '' }); }
      if (ep.startsWith('/assets/')) log.assets.set(ep, zlib.gzipSync(body).length);
      return route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream', body, headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
    }
    log.api.push(`${req.method()} ${ep}${u.search}`);
    let data = [];
    if (ep.endsWith('/auth/refresh')) data = { accessToken: `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`, expiresAt: '2099-01-01T00:00:00Z', user };
    else if (ep === '/api/v1/me') data = me;
    // The frame's one call, with every part the server really sends: without it the app falls back to a request per badge and per switch,
    // and the counts below would measure a fallback path no signed-in person takes.
    else if (ep === '/api/v1/shell/summary') data = {
      workspaceId: ws.id, notifications: { unread: 0, bundles: [] }, approvals: { needsMe: 0 }, chatUnread: { total: 0, byRoom: [] },
      reminders: { due: 0, upcoming: 0 }, featureFlags: { flags: {} }, aiStatus: { allowed: false, available: false }, timer: { entry: null },
    };
    else if (ep === '/api/v1/me/fingerprint') data = { fingerprint: me.fingerprint };
    else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: true };
    else if (ep.endsWith('/avatar') || ep.endsWith('/file')) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto(origin + url);
  // The first screen's own reads: what the person waits for. Reads the frame defers until after the first paint land after this mark and
  // are counted in apiOnLoad but not here, so the two numbers together show both the critical path and the total.
  const firstScreen = new Promise((r) => setTimeout(() => r(log.api.length), 1000));
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1500);
  const apiFirstScreen = await firstScreen;
  const loadMs = Date.now() - t0;
  const firstLoad = log.api.length;
  const onLoadList = [...log.api];
  const assets = [...log.assets.values()];
  log.api.length = 0;
  await page.evaluate(([wid, fam]) => window.dispatchEvent(new CustomEvent('pm:mutation-committed', { detail: { workspaceId: wid, families: fam } })), [ws.id, families]);
  await page.waitForTimeout(1200);
  const afterEdit = [...log.api];
  // Coming back to the tab half a minute later (a common pattern): how many reads does the focus refetch start?
  let apiOnRefocus = null;
  if (process.env.FOCUS && name === 'My work') {
    await page.waitForTimeout(30_000 - 1200);
    log.api.length = 0;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(1500);
    apiOnRefocus = log.api.length;
  }
  results.push({ apiOnRefocus, page: name, assets: assets.length, gzipKB: +(assets.reduce((a, b) => a + b, 0) / 1024).toFixed(1), apiOnLoad: firstLoad, apiFirstScreen, apiAfterTaskEdit: afterEdit.length, settledMs: loadMs, afterEdit, ...(process.env.ONLOAD ? { onLoad: onLoadList } : {}), ...(process.env.ASSETS ? { assetList: [...log.assets].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([f, n]) => `${f} ${(n / 1024).toFixed(1)}`) } : {}) });
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify({ label: process.argv[2] ?? 'run', taskEditFamilies: families.length, results }, null, 1));
