/**
 * One number, everywhere it can show while the person is signed in:
 *  - the browser tab: "(3) Acme · Project Tracker" and a red dot with the count on the favicon;
 *  - the installed app's icon (desktop Chrome / Edge, Android, iOS 16.4+ home-screen apps): navigator.setAppBadge, and the service worker is
 *    told so the badge it sets from a push (with no window open) starts from the right number;
 *  - the desktop app (Electron): the dock / taskbar badge, from the title and, more precisely, through its bridge.
 * Signing out clears all of them.
 */
import { setTitleParts } from '../../../lib/title';

type Bridge = { setBadge?: (n: number) => void };
const bridge = () => (window as unknown as { ptDesktop?: Bridge }).ptDesktop;
type BadgeNavigator = Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };

let last = -1;

export function applyBadge(count: number) {
  const n = Math.max(0, Math.floor(count));
  if (n === last) return;
  last = n;
  setTitleParts({ badge: n });
  drawFavicon(n);
  const nav = navigator as BadgeNavigator;
  try {
    if (n > 0) void nav.setAppBadge?.(n)?.catch(() => undefined);
    else void nav.clearAppBadge?.()?.catch(() => undefined);
  } catch { /* not supported here */ }
  try { navigator.serviceWorker?.controller?.postMessage({ type: 'pm-badge', count: n }); } catch { /* no worker */ }
  try { bridge()?.setBadge?.(n); } catch { /* not the desktop app */ }
}

/** Signed out (or a platform administrator): no number anywhere. */
export function clearBadge() {
  last = -1;
  setTitleParts({ badge: null });
  drawFavicon(0);
  try { void (navigator as BadgeNavigator).clearAppBadge?.()?.catch(() => undefined); } catch { /* not supported */ }
  try { navigator.serviceWorker?.controller?.postMessage({ type: 'pm-badge', count: 0 }); } catch { /* no worker */ }
  try { bridge()?.setBadge?.(0); } catch { /* not the desktop app */ }
  last = 0;
}

// ------------------------------------------------------------------ favicon

let original: string | null = null;
let image: HTMLImageElement | null = null;

function iconLink(): HTMLLinkElement {
  let link = document.querySelector<HTMLLinkElement>('link[data-pm-badge]');
  if (link) return link;
  link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]') ?? document.createElement('link');
  if (!link.parentNode) { link.rel = 'icon'; link.href = '/favicon-48x48.png'; document.head.appendChild(link); }
  link.setAttribute('data-pm-badge', '');
  return link;
}

function drawFavicon(n: number) {
  if (typeof document === 'undefined' || document.documentElement.classList.contains('landing')) return;
  const link = iconLink();
  if (original === null) original = link.href;
  if (n <= 0) { if (link.href !== original) { link.type = ''; link.href = original; } return; }
  const paint = () => {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const x = c.getContext('2d');
      if (!x || !image) return;
      x.drawImage(image, 0, 0, 64, 64);
      const text = n > 99 ? '99+' : String(n);
      const w = text.length > 1 ? 44 : 36;
      x.fillStyle = '#ff3b30';
      x.beginPath();
      x.roundRect(64 - w, 0, w, 36, 18);
      x.fill();
      x.fillStyle = '#fff';
      x.font = `700 ${text.length > 2 ? 22 : 28}px -apple-system, system-ui, sans-serif`;
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.fillText(text, 64 - w / 2, 19);
      link.type = 'image/png';
      link.href = c.toDataURL('image/png');
    } catch { /* a favicon is a nicety */ }
  };
  if (image?.complete && image.naturalWidth) { paint(); return; }
  image = new Image();
  image.onload = paint;
  image.src = '/favicon-48x48.png';
}
