/**
 * How this device announces notifications (Settings › Notifications › Sounds & alerts): per category whether it plays a sound, shows a
 * banner and counts on the badge, plus "Mute all" for a while and Do Not Disturb. Kept on the device, like the sound switch before it: a
 * laptop at work and a phone at home can differ. Whether a category is pushed to devices is a server choice (the notification
 * preferences' "browser" channel) and lives there.
 */
import { useSyncExternalStore } from 'react';
import type { NotificationCategory } from '../../../api/types';
import { soundOn } from '../../../lib/attention';

export type CategoryPrefs = { sound: boolean; banner: boolean; badge: boolean };
export interface AlertPrefs {
  cats: Record<NotificationCategory, CategoryPrefs>;
  /** Muted until this moment (ms since epoch); -1 until switched back on; null not muted. */
  mutedUntil: number | null;
  /** Do Not Disturb: no sounds and no banners; the badge and the Notification Centre still fill. */
  dnd: boolean;
}

export const CATEGORIES: NotificationCategory[] = ['messages', 'reminders', 'meetings', 'work'];
const KEY = 'pm_alert_prefs_v1';
const on: CategoryPrefs = { sound: true, banner: true, badge: true };
export const DEFAULT_PREFS: AlertPrefs = { cats: { messages: { ...on }, reminders: { ...on }, meetings: { ...on }, work: { ...on, sound: false } }, mutedUntil: null, dnd: false };

function load(): AlertPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    const p = JSON.parse(raw) as Partial<AlertPrefs>;
    const cats = { ...DEFAULT_PREFS.cats };
    for (const c of CATEGORIES) cats[c] = { ...DEFAULT_PREFS.cats[c], ...(p.cats?.[c] ?? {}) };
    return { cats, mutedUntil: typeof p.mutedUntil === 'number' ? p.mutedUntil : null, dnd: !!p.dnd };
  } catch { return DEFAULT_PREFS; }
}

let current = load();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const getAlertPrefs = () => current;
export function setAlertPrefs(patch: Partial<AlertPrefs> | ((p: AlertPrefs) => AlertPrefs)) {
  current = typeof patch === 'function' ? patch(current) : { ...current, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* storage unavailable: kept for this visit */ }
  emit();
}
export function setCategoryPref(cat: NotificationCategory, key: keyof CategoryPrefs, value: boolean) {
  setAlertPrefs((p) => ({ ...p, cats: { ...p.cats, [cat]: { ...p.cats[cat], [key]: value } } }));
}

// Another tab changed them: follow.
if (typeof window !== 'undefined') window.addEventListener('storage', (e) => { if (e.key === KEY) { current = load(); emit(); } });

export function useAlertPrefs(): AlertPrefs {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, getAlertPrefs, getAlertPrefs);
}

/** True while "Mute all" is on (a muting that has run out counts as off). */
export const isMuted = (p = current, now = Date.now()) => p.mutedUntil === -1 || (p.mutedUntil !== null && p.mutedUntil > now);

export type MuteFor = '1h' | 'tomorrow' | 'forever';
/** When "Mute all" for this long ends: an hour, tomorrow at 8:00 on this device's clock, or until switched back on (-1). */
export function muteUntil(choice: MuteFor, now = new Date()): number {
  if (choice === '1h') return now.getTime() + 3_600_000;
  if (choice === 'forever') return -1;
  const t = new Date(now); t.setDate(t.getDate() + 1); t.setHours(8, 0, 0, 0);
  return t.getTime();
}

/** Whether a new notification of this category may make a sound here, now: visible page, not muted, not DND, sound on. */
export const maySound = (cat: NotificationCategory, p = current) =>
  typeof document !== 'undefined' && !document.hidden && soundOn() && !isMuted(p) && !p.dnd && p.cats[cat].sound;
/** Whether it may show an in-app banner. */
export const mayBanner = (cat: NotificationCategory, p = current) => !isMuted(p) && !p.dnd && p.cats[cat].banner;
