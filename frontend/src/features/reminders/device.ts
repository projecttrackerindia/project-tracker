import { orgHref } from '../../lib/orgPath';
import { pushApi } from '../../api/endpoints';
import { ApiError } from '../../api/client';
import { playSound } from '../../lib/attention';
import { isDesktopApp } from '../../lib/desktop';
import { enableNativePush, isNativeApp, nativeEndpoint, nativePermission } from '../../lib/native';

/**
 * Notifications on this device, outside the Project Tracker tab: the operating system's notifications (Windows, macOS, Android) through
 * the browser's permission and push subscription, and a short chime. Push reaches the device even when the app is closed; while the tab
 * is merely in the background, a system notification is shown straight away.
 *
 * This is the single implementation every screen uses (Notification Center, Reminders, the first-run card), so the button behaves the
 * same everywhere and a failure always comes back with a reason the person can act on - never a silent no-op.
 */
export type DeviceAlerts = 'unsupported' | 'blocked' | 'off' | 'tab-only' | 'on';

/** Why the device is in its state, in words for the person (null when there is nothing to explain). */
export interface DeviceDetail { state: DeviceAlerts; reason: string | null; canFixHere: boolean }

const keyBytes = (b64: string) => {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

const canNotify = () => typeof Notification !== 'undefined';
const canPush = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window !== 'undefined' && 'PushManager' in window;

let subscribed: boolean | null = null;
let lastReason: string | null = null;
const listeners = new Set<(s: DeviceAlerts) => void>();
export const onDeviceAlerts = (l: (s: DeviceAlerts) => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const announce = (s: DeviceAlerts) => { listeners.forEach((l) => l(s)); return s; };

/** Resolves with the value, or null after the time limit (navigator.serviceWorker.ready never settles when no worker can activate). */
const within = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);

/**
 * The service worker that receives push. Production builds register it on load; if that has not happened (the registration failed, or
 * someone cleared site data in this session), it is registered here on demand. Development builds have none, so push is not possible
 * there and the reason says so.
 */
async function pushRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!canPush()) return null;
  let reg = (await navigator.serviceWorker.getRegistration()) ?? null;
  if (!reg && import.meta.env.PROD) {
    try { reg = await navigator.serviceWorker.register('/sw.js'); } catch { reg = null; }
  }
  if (!reg) return null;
  return (await within(navigator.serviceWorker.ready, 8000)) ?? (reg.active ? reg : null);
}

/** Where this device stands. "tab-only": allowed, but no push subscription - notifications only while a Project Tracker tab is open. */
export async function deviceAlerts(): Promise<DeviceAlerts> {
  return (await deviceDetail()).state;
}

/** Where this device stands, and why. */
export async function deviceDetail(): Promise<DeviceDetail> {
  if (isNativeApp()) {   // the Android app: Firebase push, not the browser's
    const perm = await nativePermission();
    subscribed = perm === 'granted' && !!nativeEndpoint();
    if (perm === 'denied') return { state: 'blocked', reason: 'Notifications are turned off for Project Tracker in Android Settings → Apps → Project Tracker → Notifications.', canFixHere: false };
    return { state: subscribed ? 'on' : 'off', reason: null, canFixHere: true };
  }
  if (!canNotify()) return { state: 'unsupported', reason: 'This browser cannot show notifications. Use Chrome, Edge or Firefox, or install Project Tracker as an app.', canFixHere: false };
  if (Notification.permission === 'denied') return { state: 'blocked', reason: 'Notifications are blocked for this site. Click the lock icon left of the address → Notifications → Allow, then reload.', canFixHere: false };
  if (Notification.permission !== 'granted') return { state: 'off', reason: null, canFixHere: true };
  // The desktop app (Windows/macOS/Linux) shows system notifications itself while it runs; it has no browser push service.
  if (isDesktopApp()) { subscribed = false; return { state: 'on', reason: 'The desktop app shows notifications while it is running (also when minimized to the tray).', canFixHere: false }; }
  if (!canPush()) { subscribed = false; return { state: 'tab-only', reason: 'This browser has no push service, so notifications appear only while a Project Tracker tab is open.', canFixHere: false }; }
  const reg = (await navigator.serviceWorker.getRegistration()) ?? null;
  subscribed = !!(reg && (await reg.pushManager.getSubscription()));
  if (subscribed) return { state: 'on', reason: null, canFixHere: true };
  return { state: 'tab-only', reason: lastReason, canFixHere: !!reg || import.meta.env.PROD };
}

/**
 * Turns notifications on for this device: asks for permission if needed, then subscribes to push. Returns the new state; when push could
 * not be set up, {@link lastDeviceError} says why (shown next to the button, so it never looks like nothing happened).
 */
export async function enableDeviceAlerts(): Promise<DeviceAlerts> {
  lastReason = null;
  if (isNativeApp()) {
    const r = await enableNativePush((token) => pushApi.subscribeNative(token));
    subscribed = r === 'on';
    if (r === 'blocked') lastReason = 'Notifications are turned off for Project Tracker in Android Settings → Apps → Project Tracker → Notifications.';
    else if (r !== 'on') lastReason = 'Push is not set up in this build of the app. Update the app from the website.';
    return announce(r === 'on' ? 'on' : r === 'blocked' ? 'blocked' : 'off');
  }
  if (!canNotify()) return announce('unsupported');
  let permission: NotificationPermission = Notification.permission;
  if (permission === 'default') {
    try { permission = await Notification.requestPermission(); } catch { permission = Notification.permission; }
  }
  if (permission !== 'granted') {
    lastReason = permission === 'denied' ? 'The browser blocked notifications for this site. Allow them from the lock icon left of the address, then reload.' : 'The permission prompt was closed without an answer.';
    return announce(permission === 'denied' ? 'blocked' : 'off');
  }
  if (isDesktopApp()) return announce('on');
  if (!canPush()) return announce('tab-only');
  try {
    const reg = await pushRegistration();
    if (!reg) {
      lastReason = import.meta.env.PROD
        ? 'The notification service worker could not start. Reload the page and try again.'
        : 'Push needs the production build (development builds have no service worker). Notifications still show while this tab is open.';
    } else {
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const { publicKey } = await pushApi.status();
        if (!publicKey) throw new Error('The server has no push key yet.');
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
      }
      const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
      await pushApi.subscribe({ endpoint: json.endpoint, keys: json.keys });
    }
  } catch (e) {
    lastReason = e instanceof ApiError ? `The server refused the push sign-up: ${e.message}`
      : e instanceof Error && /permission|denied/i.test(e.message) ? 'The browser refused the push sign-up. Check that notifications are allowed for this site.'
      : e instanceof Error && e.message ? `Push could not be set up: ${e.message}` : 'Push could not be set up on this browser.';
  }
  const detail = await deviceDetail();
  return announce(detail.state);
}

/** Turns push off for this device (the browser permission stays as it is - only the browser can take that back). */
export async function disableDeviceAlerts(): Promise<DeviceAlerts> {
  lastReason = null;
  try {
    const reg = canPush() ? await navigator.serviceWorker.getRegistration() : undefined;
    const sub = await reg?.pushManager.getSubscription();
    if (sub) { await pushApi.unsubscribe(sub.endpoint).catch(() => undefined); await sub.unsubscribe(); }
  } catch { /* already off */ }
  subscribed = false;
  return announce(await deviceAlerts());
}

/** Why the last attempt to turn notifications on fell short (null when it worked or nothing was tried). */
export const lastDeviceError = () => lastReason;

/** Whether a push will already bring this reminder to the device (then the page does not add a second notification). */
export const pushCoversThisDevice = () => subscribed === true;

/** A notification from the operating system, shown by the page itself (the tab is open but someone is in another app). */
export async function systemNotification(title: string, body: string | null, tag: string, link = '/reminders', opts: { sticky?: boolean } = {}): Promise<boolean> {
  if (!canNotify() || Notification.permission !== 'granted') return false;
  // Urgent ones (reminders by default) stay on screen until dismissed; the rest go away by themselves. The page plays its own sound, so
  // the system one is silent (two sounds for one alert would be noise); renotify makes a repeated tag pop up again instead of updating quietly.
  const sticky = opts.sticky ?? true;
  const options: NotificationOptions & { renotify?: boolean; vibrate?: number[] } = {
    body: body ?? '', tag, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', requireInteraction: sticky, silent: true, renotify: true,
    data: { link: orgHref(link) },
  };
  try {
    const reg = canPush() ? await navigator.serviceWorker.getRegistration() : undefined;
    if (reg?.active) { await reg.showNotification(title, options); return true; }
  } catch { /* fall back to a page notification */ }
  // Some browsers (Chrome on Android) only allow notifications through a service worker: the constructor throws there.
  try {
    const n = new Notification(title, options);
    n.onclick = () => { window.focus(); window.location.assign(orgHref(link)); n.close(); };
    return true;
  } catch { return false; }
}

// ------------------------------------------------------------------ sound
// The sounds live in lib/attention.ts (one audio context for the whole app); these names stay for the Reminders screen.

export { primeSound, setSoundOn, soundOn } from '../../lib/attention';

/** The reminder sound: the beacon (three bursts of a two-tone alarm), so a reminder is not mistaken for a chat message. */
export const playChime = () => playSound('urgent');
