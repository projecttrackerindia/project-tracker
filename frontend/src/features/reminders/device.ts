import { orgHref } from '../../lib/orgPath';
import { pushApi } from '../../api/endpoints';
import { playSound } from '../../lib/attention';
import { enableNativePush, isNativeApp, nativeEndpoint, nativePermission } from '../../lib/native';

/**
 * Reminders on this device, outside the Project Tracker tab: the operating system's notifications (Windows, macOS, Android) through the
 * browser's permission and push subscription, and a short chime. Push reaches the device even when the app is closed; while the tab is
 * merely in the background, a system notification is shown straight away.
 */
export type DeviceAlerts = 'unsupported' | 'blocked' | 'off' | 'tab-only' | 'on';

const keyBytes = (b64: string) => {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

const canNotify = () => typeof Notification !== 'undefined';
const canPush = () => 'serviceWorker' in navigator && 'PushManager' in window;

let subscribed: boolean | null = null;
const listeners = new Set<(s: DeviceAlerts) => void>();
export const onDeviceAlerts = (l: (s: DeviceAlerts) => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Where this device stands. "tab-only": allowed, but no push subscription - notifications only while a Project Tracker tab is open. */
export async function deviceAlerts(): Promise<DeviceAlerts> {
  if (isNativeApp()) {   // the Android app: Firebase push, not the browser's
    const perm = await nativePermission();
    subscribed = perm === 'granted' && !!nativeEndpoint();
    return perm === 'denied' ? 'blocked' : subscribed ? 'on' : 'off';
  }
  if (!canNotify()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  if (Notification.permission !== 'granted') return 'off';
  if (!canPush()) { subscribed = false; return 'tab-only'; }
  const reg = await navigator.serviceWorker.getRegistration();
  subscribed = !!(reg && (await reg.pushManager.getSubscription()));
  return subscribed ? 'on' : 'tab-only';
}

/** Asks the browser for permission, then subscribes this device to push (when the service worker is there). */
export async function enableDeviceAlerts(): Promise<DeviceAlerts> {
  if (isNativeApp()) {
    const r = await enableNativePush((token) => pushApi.subscribeNative(token));
    const s: DeviceAlerts = r === 'on' ? 'on' : r === 'blocked' ? 'blocked' : 'off';
    subscribed = r === 'on';
    listeners.forEach((l) => l(s));
    return s;
  }
  if (!canNotify()) return 'unsupported';
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') { const s = permission === 'denied' ? 'blocked' : 'off'; listeners.forEach((l) => l(s)); return s; }
  if (canPush()) {
    // Push needs the browser's push service; if that fails, notifications still work while a Project Tracker tab is open.
    try {
      const reg = (await navigator.serviceWorker.getRegistration()) ? await navigator.serviceWorker.ready : null;
      if (reg) {
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
          const { publicKey } = await pushApi.status();
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
        }
        const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
        await pushApi.subscribe({ endpoint: json.endpoint, keys: json.keys });
      }
    } catch { /* tab-only */ }
  }
  const state = await deviceAlerts();
  listeners.forEach((l) => l(state));
  return state;
}

/** Whether a push will already bring this reminder to the device (then the page does not add a second notification). */
export const pushCoversThisDevice = () => subscribed === true;

/** A notification from the operating system, shown by the page itself (the tab is open but someone is in another app). */
export async function systemNotification(title: string, body: string | null, tag: string, link = '/reminders', opts: { sticky?: boolean } = {}) {
  if (!canNotify() || Notification.permission !== 'granted') return;
  // Urgent ones (reminders by default) stay on screen until dismissed; the rest go away by themselves. The page plays its own sound, so
  // the system one is silent (two sounds for one alert would be noise); renotify makes a repeated tag pop up again instead of updating quietly.
  const sticky = opts.sticky ?? true;
  const options: NotificationOptions & { renotify?: boolean; vibrate?: number[] } = {
    body: body ?? '', tag, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', requireInteraction: sticky, silent: true, renotify: true,
    data: { link: orgHref(link) },
  };
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (reg) { await reg.showNotification(title, options); return; }
  } catch { /* fall back to a page notification */ }
  const n = new Notification(title, options);
  n.onclick = () => { window.focus(); window.location.assign(orgHref(link)); n.close(); };
}

// ------------------------------------------------------------------ sound
// The sounds live in lib/attention.ts (one audio context for the whole app); these names stay for the Reminders screen.

export { primeSound, setSoundOn, soundOn } from '../../lib/attention';

/** The reminder sound: the beacon (three bursts of a two-tone alarm), so a reminder is not mistaken for a chat message. */
export const playChime = () => playSound('urgent');
