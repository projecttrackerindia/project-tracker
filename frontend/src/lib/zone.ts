import { useSyncExternalStore } from 'react';

/**
 * The one time zone the whole app runs in for the signed-in person.
 *
 * Order: the person's own zone (My account / Notification Center → Time zone), then their workspace's default zone, then this device.
 * The server applies the same order, so "today", "overdue", due dates, timesheet days, reminders and charts agree everywhere.
 * Instants come from the server in UTC; every place that shows a date or time formats it in this zone.
 */

const CURRENT_NAMES: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata', 'Asia/Katmandu': 'Asia/Kathmandu', 'Asia/Saigon': 'Asia/Ho_Chi_Minh', 'Asia/Rangoon': 'Asia/Yangon',
  'Europe/Kiev': 'Europe/Kyiv', 'America/Buenos_Aires': 'America/Argentina/Buenos_Aires', 'Atlantic/Faeroe': 'Atlantic/Faroe', 'Pacific/Truk': 'Pacific/Chuuk',
};

/** Current IANA name for a zone (browsers still report a few old ones, like Asia/Calcutta). */
export const canonicalZone = (zone: string) => CURRENT_NAMES[zone] ?? zone;

/** This device's time zone. */
export const deviceZone = (): string => {
  try { return canonicalZone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'); } catch { return 'UTC'; }
};

const known = new Map<string, boolean>();
/** Whether the browser knows this IANA zone. */
export function isKnownZone(zone: string | null | undefined): zone is string {
  if (!zone) return false;
  const hit = known.get(zone);
  if (hit !== undefined) return hit;
  let ok = true;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch { ok = false; }
  known.set(zone, ok);
  return ok;
}

// The signed-in person's and workspace's zones, pushed in by the auth store whenever the context changes. (This module must not import
// the auth store: nearly everything imports the date helpers, and that import cycle breaks the bundle's start-up order.)
let userZone: string | null = null;
let workspaceZone: string | null = null;
let version = 0;
const zoneListeners = new Set<() => void>();

/** Called by the auth store with the person's own zone and the active workspace's default zone. */
export function setAppZones(user: string | null | undefined, workspace: string | null | undefined) {
  const u = user ?? null, w = workspace ?? null;
  if (u === userZone && w === workspaceZone) return;
  userZone = u; workspaceZone = w; version++;
  zoneListeners.forEach((l) => l());
}

/** The zone the app runs in right now (see the order above). Safe outside React. */
export function appZone(): string {
  if (isKnownZone(userZone)) return canonicalZone(userZone);
  if (isKnownZone(workspaceZone)) return canonicalZone(workspaceZone);
  return deviceZone();
}

const subscribe = (l: () => void) => { zoneListeners.add(l); return () => { zoneListeners.delete(l); }; };

/** The same, as a hook: components re-render when the person changes their zone. */
export function useAppZone(): string {
  useSyncExternalStore(subscribe, () => version, () => version);
  return appZone();
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Calendar fields of an instant in a zone. */
export function zonedParts(instant: Date, zone = appZone()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant).reduce<Record<string, number>>((a, p) => { if (p.type !== 'literal') a[p.type] = Number(p.value); return a; }, {});
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute, second: parts.second };
}

/** "yyyy-MM-dd" of an instant in the app's zone. */
export function isoDateIn(instant: Date, zone = appZone()) {
  const p = zonedParts(instant, zone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Today ("yyyy-MM-dd") in the app's zone. */
export const zoneToday = (zone = appZone()) => isoDateIn(new Date(), zone);

/** A "yyyy-MM-dd" day moved by whole days (pure calendar arithmetic, no time zone involved). */
export function shiftIsoDate(iso: string, days: number) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Whole days from today (in the app's zone) to a "yyyy-MM-dd" day: 0 today, 1 tomorrow, -1 yesterday. */
export function daysFromToday(iso: string, zone = appZone()) {
  const [ty, tm, td] = zoneToday(zone).split('-').map(Number);
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86_400_000);
}

/** Formats an instant in the app's zone. */
export function formatInZone(instant: Date | string | number, options: Intl.DateTimeFormatOptions, zone = appZone(), locale?: string) {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) return '—';
  try { return d.toLocaleString(locale, { ...options, timeZone: zone }); } catch { return d.toLocaleString(locale, options); }
}

/** "GMT+5:30" style offset of a zone right now. */
export function zoneOffsetLabel(zone: string, at = new Date()) {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value;
    return name === 'GMT' ? 'GMT+0' : name ?? '';
  } catch { return ''; }
}

/** Offset of a zone right now, in minutes (for sorting zone lists). */
export function zoneOffsetMinutes(zone: string, at = new Date()) {
  const p = zonedParts(at, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** Every IANA zone the browser knows (falls back to a short list on older browsers). */
export function allZones(): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone');
    if (list?.length) return [...new Set(list.map(canonicalZone))];
  } catch { /* older browser */ }
  return ['UTC', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'Europe/London', 'Europe/Berlin', 'America/New_York',
    'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo', 'Africa/Johannesburg'];
}

/** A friendly name for a zone: "Kolkata", "New York". */
export const zoneCity = (zone: string) => (zone.split('/').pop() ?? zone).replace(/_/g, ' ');
