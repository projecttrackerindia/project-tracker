/* Project Tracker service worker: the app shell for offline start, push notifications, and opening them.
 * Data from the API is never cached here - it belongs to whoever is signed in. */
const SHELL = 'pm-shell-v9';

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
const URGENT = ['Reminder', 'Nudge', 'DueSoon', 'Overdue', 'ServiceLevel', 'Support', 'Security', 'SignInRequest'];
const CHAT = ['Message', 'Mention'];

// ------------------------------------------------------------------ the app icon's badge
// While signed in, the installed app's icon (desktop Chrome / Edge, Android, iOS 16.4+ home-screen apps) shows the unread count even with
// no window open: every push carries it (`badge`), an open page keeps it exact (`pm-badge` messages), and opening a notification takes one off.
let badgeCount = null;
function setBadge(n) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  badgeCount = count;
  const nav = self.navigator;
  try {
    if (count > 0 && nav && nav.setAppBadge) return nav.setAppBadge(count).catch(() => undefined);
    if (count === 0 && nav && nav.clearAppBadge) return nav.clearAppBadge().catch(() => undefined);
  } catch { /* not supported here */ }
  return Promise.resolve();
}

/**
 * Read somewhere else (this device's open page, another device, the server): the OS notifications for those notification ids (their tag)
 * close, so the notification shade never shows something already read. Matched by tag; `links` also closes ones shown for the same thing.
 */
function closeRead(tags, links) {
  const want = new Set((tags || []).map(String));
  const paths = (links || []).map(String).filter(Boolean);
  const reg = self.registration;
  if (!reg || !reg.getNotifications || (want.size === 0 && paths.length === 0)) return Promise.resolve(0);
  return reg.getNotifications().then((list) => {
    let closed = 0;
    for (const n of list) {
      const link = (n.data && n.data.link) || '';
      if ((n.tag && want.has(n.tag)) || paths.some((p) => link === p || link.endsWith(p))) { n.close(); closed++; }
    }
    return closed;
  }).catch(() => 0);
}

/** Asks an open page to play its alert sound; resolves true if one did (a page that cannot make sound yet, or none, answers false). */
function askPage(win, message) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), 800);
    channel.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data && e.data.viewing ? 'viewing' : !!(e.data && e.data.played)); };
    try { win.postMessage(message, [channel.port2]); } catch { clearTimeout(timer); resolve(false); }
  });
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: event.data ? event.data.text() : 'Project Tracker' }; }
  // A 'read' data message: notifications were read on another device - close them here and correct the badge, show nothing.
  if (data.kind === 'read') {
    event.waitUntil(Promise.all([closeRead(data.tags, data.links), typeof data.badge === 'number' ? setBadge(data.badge) : Promise.resolve()]));
    return;
  }
  // A reminder carries its one-time key: Done and Snooze work right from the notification, even with the app closed
  // (where the browser shows buttons - Chrome, Edge, Android; elsewhere a tap opens it).
  const reminder = !!data.token;
  // An incoming call: it rings (the device's own sound and a long buzz when no open page can ring), stays until answered, and offers
  // Answer / Decline. An open page shows its own incoming-call card and ringtone.
  const call = data.type === 'Call' && data.call ? String(data.call) : null;
  // A request to sign in somewhere else is urgent and short-lived: it stays on screen until answered, buzzes, and opens the approval screen.
  const signIn = data.type === 'SignInRequest';
  const urgent = reminder || URGENT.includes(data.type);
  const kind = urgent ? 'urgent' : CHAT.includes(data.type) ? 'message' : 'update';
  const badging = typeof data.badge === 'number' ? setBadge(data.badge) : Promise.resolve();
  event.waitUntil(badging.then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true })).then(async (wins) => {
    const pages = wins.filter((w) => new URL(w.url).origin === self.location.origin);
    // An open page plays its own (distinct) alert sound, so the system notification stays silent - but only if the page really did: when
    // the page cannot make sound yet, or the app is closed, the notification makes the device's own sound instead.
    const answers = await Promise.all(pages.map((w) => askPage(w, { type: 'pm-push', kind, notificationType: data.type || '', tag: data.tag || '', call, title: data.title || '', category: data.category || '', link: data.link || '' })));
    // A page has that very conversation open in front of the person: nothing to show, it is read there.
    if (!call && answers.includes('viewing')) return undefined;
    const played = answers.some(Boolean);
    if (call) {
      return self.registration.showNotification(data.title || 'Incoming call', {
        body: data.body || '', tag: `call-${call}`, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
        data: { link: data.link || '/', call }, requireInteraction: true, renotify: true, silent: played,
        vibrate: [500, 250, 500, 250, 500, 250, 500],
        actions: [{ action: 'answer', title: 'Answer' }, { action: 'decline', title: 'Decline' }],
      });
    }
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
  const call = event.notification.data && event.notification.data.call;
  if (call && event.action === 'decline') {
    // Turned down: an open page tells the server (it holds the sign-in); with none open the call simply stops ringing here.
    event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins.filter((x) => new URL(x.url).origin === self.location.origin)) w.postMessage({ type: 'pm-call', action: 'decline', callId: call });
    }));
    return;
  }
  const link = new URL((event.notification.data && event.notification.data.link) || '/', self.location.origin).href;
  // Opened: one fewer unread on the icon until the page (which marks it read) sends the exact number.
  if (badgeCount !== null && badgeCount > 0) event.waitUntil(setBadge(badgeCount - 1));
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const open = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (open) { open.focus(); return open.navigate(link); }
    return self.clients.openWindow(link);
  }));
});

// Signing out: forget the cached pages too. "Reload" on the new-version banner: a worker still waiting takes over now (the page reloads
// once it has).
self.addEventListener('message', (event) => {
  if (event.data === 'clear') event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('pm-')).map((k) => caches.delete(k)))));
  if (event.data === 'skip-waiting') self.skipWaiting();
  if (event.data && event.data.type === 'pm-badge') event.waitUntil(setBadge(event.data.count));
  if (event.data && event.data.type === 'pm-read') event.waitUntil(closeRead(event.data.tags, event.data.links));
});
