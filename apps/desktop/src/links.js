'use strict';

/** A projecttracker:// link opens the matching page of the app: projecttracker://my-work becomes <app>/my-work. Anything else is ignored. */
function deepLinkToUrl(link, base) {
  try {
    const u = new URL(link);
    if (u.protocol !== 'projecttracker:') return null;
    const path = `/${u.hostname}${u.pathname}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    if (/[^A-Za-z0-9\-._~!$&'()*+,;=:@/%]/.test(path)) return null;
    return base + path + u.search;
  } catch { return null; }
}

/** Whether a page address belongs to the app (it opens inside the window) or to someone else (it opens in the person's browser). */
function isInternal(url, base) {
  try { return new URL(url).origin === new URL(base).origin; } catch { return false; }
}

/** The unread count from a title like "(3) Acme · Project Tracker": the app puts it first, so the badge needs no connection to the page. */
function unreadFromTitle(title) {
  const m = /^(?:⏰ )?\((\d{1,3})\+?\)/.exec(title || '');
  return m ? Number(m[1]) : 0;
}

/** True when `latest` ("v1.2.0" or "1.2.0") is a newer version than `current`. */
function isNewer(latest, current) {
  const n = (v) => String(v).replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  const a = n(latest), b = n(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); }
  return false;
}

module.exports = { deepLinkToUrl, isInternal, unreadFromTitle, isNewer };
