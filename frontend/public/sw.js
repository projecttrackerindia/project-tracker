/* Project Tracker service worker: the app shell for offline start, push notifications, and opening them.
 * Data from the API is never cached here - it belongs to whoever is signed in. */
const SHELL = 'pm-shell-v7';

/** The page and the scripts and styles it names, so the app can start without a connection. */
async function cacheShell() {
  const cache = await caches.open(SHELL);
  const res = await fetch('/', { cache: 'no-store' });
  if (!res.ok) return;
  const html = await res.clone().text();
  await cache.put('/', res);
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  await cache.addAll([...new Set([...assets, '/manifest.webmanifest', '/icons/icon-192.png'])]).catch(() => undefined);
}

self.addEventListener('install', (event) => { event.waitUntil(cacheShell().then(() => self.skipWaiting())); });
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('pm-') && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (/^\/(api|hubs|scim|health)(\/|$)/.test(url.pathname)) return;   // live data: always the network
  // The public website (Features, Pricing, Security, sitemap ...) is its own set of pages, not the app: never answer them with the app shell.
  if (/^\/(features|pricing|security|download)(\/|$)|^\/(sitemap\.xml|robots\.txt|favicon\.ico|og-image\.png|\.well-known\/)/.test(url.pathname)) return;
  if (req.mode === 'navigate') {
    // The app itself: fresh when online (and remembered), the remembered one when offline.
    event.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put('/', copy)); }
      return res;
    }).catch(() => caches.match('/')));
    return;
  }
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    // Fingerprinted files never change: the cache first, then the network (and keep what came).
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); }
      return res;
    })));
  }
});

// Which of the page's alert sounds a kind of notification gets (the same grouping as lib/attention.ts).
const URGENT = ['Reminder', 'Nudge', 'DueSoon', 'Overdue', 'ServiceLevel', 'Security', 'SignInRequest'];
const CHAT = ['Message', 'Mention'];

/** Asks an open page to play its alert sound; resolves true if one did (a page that cannot make sound yet, or none, answers false). */
function askPage(win, message) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), 800);
    channel.port1.onmessage = (e) => { clearTimeout(timer); resolve(!!(e.data && e.data.played)); };
    try { win.postMessage(message, [channel.port2]); } catch { clearTimeout(timer); resolve(false); }
  });
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: event.data ? event.data.text() : 'Project Tracker' }; }
  // A reminder carries its one-time key: Done and Snooze work right from the notification, even with the app closed
  // (where the browser shows buttons - Chrome, Edge, Android; elsewhere a tap opens it).
  const reminder = !!data.token;
  // A request to sign in somewhere else is urgent and short-lived: it stays on screen until answered, buzzes, and opens the approval screen.
  const signIn = data.type === 'SignInRequest';
  const urgent = reminder || URGENT.includes(data.type);
  const kind = urgent ? 'urgent' : CHAT.includes(data.type) ? 'message' : 'update';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (wins) => {
    const pages = wins.filter((w) => new URL(w.url).origin === self.location.origin);
    // An open page plays its own (distinct) alert sound, so the system notification stays silent - but only if the page really did: when
    // the page cannot make sound yet, or the app is closed, the notification makes the device's own sound instead.
    const played = (await Promise.all(pages.map((w) => askPage(w, { type: 'pm-push', kind, notificationType: data.type || '', tag: data.tag || '' })))).some(Boolean);
    return self.registration.showNotification(data.title || 'Project Tracker', {
      body: data.body || '', tag: data.tag || undefined, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
      data: { link: data.link || '/', token: data.token || null },
      // Urgent ones stay on screen until dismissed; a repeated tag pops up again instead of updating quietly.
      requireInteraction: urgent || signIn, silent: played && !signIn, renotify: !!data.tag,
      vibrate: signIn ? [200, 80, 200, 80, 400] : urgent ? [300, 100, 300, 100, 300] : [120, 60, 120],
      actions: reminder ? [{ action: 'done', title: '✓ Done' }, { action: 'snooze', title: 'Snooze 1 hour' }] : [],
    });
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const token = event.notification.data && event.notification.data.token;
  if (token && (event.action === 'done' || event.action === 'snooze')) {
    event.waitUntil(fetch(`/api/v1/reminder-actions/${encodeURIComponent(token)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit',
      body: JSON.stringify(event.action === 'done' ? { action: 'done' } : { action: 'snooze', preset: '1h' }),
    }).catch(() => undefined));
    return;
  }
  const link = new URL((event.notification.data && event.notification.data.link) || '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const open = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (open) { open.focus(); return open.navigate(link); }
    return self.clients.openWindow(link);
  }));
});

// Signing out: forget the cached pages too.
self.addEventListener('message', (event) => {
  if (event.data === 'clear') event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('pm-')).map((k) => caches.delete(k)))));
});
