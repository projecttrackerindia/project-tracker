// Browser check of the Android app's native features, with a pretend Capacitor bridge (the real one only exists inside the APK): the app turns on
// push (the phone's token reaches the server), a tapped notification opens its page, the Back button goes back and leaves from the first screen,
// a download goes to the share sheet, and signing out forgets the phone. Run against a running API (Development, seeded) and the Vite dev server:
//   npm i --no-save playwright-core && BASE=http://127.0.0.1:5173 node e2e/android.mjs
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173';
const EMAIL = process.env.EMAIL ?? 'demo@example.com', PASSWORD = process.env.PASSWORD ?? 'Demo@12345';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--no-sandbox'] });
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };
const errors = [];

const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36 ProjectTrackerApp' });
await ctx.addInitScript(() => {
  const listeners = {}, calls = [];
  const plugin = (name, impl = {}) => new Proxy({}, { get: (_, m) => {
    if (m === 'addListener') return async (ev, cb) => { (listeners[`${name}.${ev}`] ??= []).push(cb); return { remove: async () => {} }; };
    return async (args) => { calls.push({ name, m, args }); return impl[m] ? impl[m](args) : undefined; };
  } });
  const push = plugin('PushNotifications', {
    checkPermissions: () => ({ receive: localStorage.getItem('e2e_perm') ?? 'prompt' }),
    requestPermissions: () => { localStorage.setItem('e2e_perm', 'granted'); return { receive: 'granted' }; },
    register: () => setTimeout(() => (listeners['PushNotifications.registration'] ?? []).forEach((cb) => cb({ value: 'e2e-token-' + (localStorage.getItem('e2e_t') ?? (localStorage.setItem('e2e_t', Math.random().toString(36).slice(2)), localStorage.getItem('e2e_t'))) })), 30),
  });
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {
    PushNotifications: push, App: plugin('App'), StatusBar: plugin('StatusBar'), SplashScreen: plugin('SplashScreen'),
    Filesystem: plugin('Filesystem', { writeFile: (a) => ({ uri: 'file:///cache/' + a.path }) }), Share: plugin('Share'),
  } };
  window.__cap = { listeners, calls, fire: (key, e) => (listeners[key] ?? []).forEach((cb) => cb(e)) };
});
const p = await ctx.newPage();
p.on('pageerror', (e) => errors.push(e.message));
const pushPosts = [];
p.on('request', (r) => { if (r.url().includes('/api/v1/push/') && r.method() === 'POST') pushPosts.push({ url: r.url().split('/api/v1')[1], body: r.postData() }); });

await p.goto(`${BASE}/login`); await p.waitForTimeout(1200);
check('the page knows it is inside the app', await p.evaluate(() => document.documentElement.classList.contains('native-app')));
check('the splash screen is hidden', await p.evaluate(() => window.__cap.calls.some((c) => c.name === 'SplashScreen' && c.m === 'hide')));
await p.fill('input[type=email], input[name=email]', EMAIL); await p.fill('input[type=password]', PASSWORD); await p.click('button[type=submit]');
await p.waitForSelector('.m-tabs', { timeout: 25000 });
check('the status bar is matched to the theme', await p.evaluate(() => window.__cap.calls.some((c) => c.name === 'StatusBar' && c.m === 'setBackgroundColor')));

// Push on, from Account → Notifications
await p.goto(`${BASE}/account/notifications`); await p.waitForTimeout(1500);
const turnOn = p.getByRole('button', { name: /turn on/i }).first();
check('push is offered', await turnOn.count() > 0);
await turnOn.click(); await p.waitForTimeout(1500);
const reg = pushPosts.find((x) => x.url === '/push/native');
check('the phone\'s token reaches the server', !!reg && /e2e-token-/.test(reg.body ?? ''), JSON.stringify(reg));
check('a notification channel is made', await p.evaluate(() => window.__cap.calls.some((c) => c.name === 'PushNotifications' && c.m === 'createChannel')));
check('the row now reads on', await p.getByRole('button', { name: /^turn off$/i }).count() > 0, (await p.locator('.setting-row button').allInnerTexts()).join('|'));

// After a restart the token is refreshed with the server again
pushPosts.length = 0;
await p.reload(); await p.waitForSelector('.m-tabs', { timeout: 25000 }); await p.waitForTimeout(2500);
check('on the next start the token is refreshed', pushPosts.some((x) => x.url === '/push/native'));

// A tapped notification opens its page without reloading
await p.evaluate(() => { window.__marker = 'same-page'; window.__cap.fire('PushNotifications.pushNotificationActionPerformed', { notification: { data: { link: '/account/notifications' } } }); });
await p.waitForTimeout(800);
check('tapping a notification opens its page in the running app', (await p.evaluate(() => location.pathname)).endsWith('/account/notifications') && await p.evaluate(() => window.__marker === 'same-page'));
await p.evaluate(() => window.__cap.fire('PushNotifications.pushNotificationActionPerformed', { notification: { data: { link: 'https://evil.example/x' } } }));
await p.waitForTimeout(400);
check('a notification cannot send the app to another site', (await p.evaluate(() => location.hostname)) !== 'evil.example');

// Back button
await p.goto(`${BASE}/projects`); await p.waitForTimeout(1200);
await p.evaluate(() => { history.pushState({}, '', '/tasks'); dispatchEvent(new PopStateEvent('popstate')); });
await p.evaluate(() => window.__cap.fire('App.backButton', { canGoBack: true })); await p.waitForTimeout(600);
check('Back goes back inside the app', (await p.evaluate(() => location.pathname)).endsWith('/projects'));
await p.evaluate(() => window.__cap.fire('App.backButton', { canGoBack: false }));
check('Back from the first screen leaves the app', await p.evaluate(() => window.__cap.calls.some((c) => c.name === 'App' && c.m === 'exitApp')));
await p.evaluate(() => window.__cap.fire('App.appUrlOpen', { url: 'https://projecttracker.in/account/notifications' })); await p.waitForTimeout(300);

// A file goes to the share sheet
await p.goto(`${BASE}/ai`).catch(() => undefined); await p.waitForTimeout(2500);
const saved = await p.evaluate(async () => {
  const { saveFile } = await import('/src/lib/native.ts');
  await saveFile(new Blob(['a,b\n1,2'], { type: 'text/csv' }), 'tasks template.csv');
  return window.__cap.calls.filter((c) => ['Filesystem', 'Share'].includes(c.name)).map((c) => `${c.name}.${c.m}`);
});
check('saving a file writes it and opens the share sheet', saved.join() === 'Filesystem.writeFile,Share.share', saved.join());

// Signing out forgets this phone
pushPosts.length = 0;
const out = await p.evaluate(async () => { const { useAuth } = await import('/src/stores/auth.ts'); await useAuth.getState().logout(); return localStorage.getItem('pm_fcm_token'); });
check('signing out removes this phone from the account', pushPosts.some((x) => x.url === '/push/unsubscribe' && /fcm:e2e-token-/.test(x.body ?? '')) && out === null, JSON.stringify(pushPosts));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
