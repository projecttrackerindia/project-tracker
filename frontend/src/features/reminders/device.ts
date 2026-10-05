import { orgHref } from '../../lib/orgPath';
import { pushApi } from '../../api/endpoints';

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
export async function systemNotification(title: string, body: string | null, tag: string, link = '/reminders') {
  if (!canNotify() || Notification.permission !== 'granted') return;
  const options: NotificationOptions = { body: body ?? '', tag, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', requireInteraction: true, data: { link: orgHref(link) } };
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (reg) { await reg.showNotification(title, options); return; }
  } catch { /* fall back to a page notification */ }
  const n = new Notification(title, options);
  n.onclick = () => { window.focus(); window.location.assign(orgHref(link)); n.close(); };
}

// ------------------------------------------------------------------ sound

const SOUND_KEY = 'pm_reminder_sound';
export const soundOn = () => { try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; } };
export const setSoundOn = (on: boolean) => { try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch { /* storage unavailable */ } };

let audio: AudioContext | null = null;
const context = () => {
  if (!audio) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    audio = new AC();
  }
  return audio;
};

/** Browsers only allow sound after the person has touched the page once: get ready on the first click or key press. */
export function primeSound() {
  const once = () => { void context()?.resume().catch(() => undefined); window.removeEventListener('pointerdown', once); window.removeEventListener('keydown', once); };
  window.addEventListener('pointerdown', once);
  window.addEventListener('keydown', once);
}

/** A soft three-note chime (generated, no sound file). Plays in a background tab too, once the page has been touched. */
export function playChime() {
  const c = context();
  if (!c) return;
  void c.resume().catch(() => undefined);
  const start = c.currentTime + 0.02;
  [[880, 0], [1174.66, 0.15], [1567.98, 0.3]].forEach(([freq, at]) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start + at);
    gain.gain.exponentialRampToValueAtTime(0.2, start + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + at + 0.55);
    osc.connect(gain).connect(c.destination);
    osc.start(start + at);
    osc.stop(start + at + 0.6);
  });
}
