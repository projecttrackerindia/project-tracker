/* Project Tracker service worker: the app shell for offline start, push notifications, and opening them.
 * Data from the API is never cached here - it belongs to whoever is signed in. */
const SHELL = 'pm-shell-v2';

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

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: event.data ? event.data.text() : 'Project Tracker' }; }
  // A reminder carries its one-time key: Done and Snooze work right from the notification, even with the app closed
  // (where the browser shows buttons - Chrome, Edge, Android; elsewhere a tap opens it).
  const reminder = !!data.token;
  event.waitUntil(self.registration.showNotification(data.title || 'Project Tracker', {
    body: data.body || '', tag: data.tag || undefined, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
    data: { link: data.link || '/', token: data.token || null },
    requireInteraction: reminder,
    actions: reminder ? [{ action: 'done', title: '✓ Done' }, { action: 'snooze', title: 'Snooze 1 hour' }] : [],
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
