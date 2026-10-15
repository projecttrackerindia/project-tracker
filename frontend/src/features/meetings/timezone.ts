/**
 * Turning a wall-clock date/time the organizer typed into the right instant - in whichever IANA zone they actually meant, not
 * whatever zone this browser/OS happens to be set to (spec: a scrum call scheduled "for Central" must land on Central, even from a
 * machine whose system clock reports UTC or anything else). Mirrors the backend's own NodaTime-based conversion
 * (see ZoneTime.ToUtc in Reminders/ReminderTime.cs) using only what the browser provides: Intl's per-zone offset.
 */

const CURRENT_NAMES: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata', 'Asia/Katmandu': 'Asia/Kathmandu', 'Asia/Saigon': 'Asia/Ho_Chi_Minh', 'Asia/Rangoon': 'Asia/Yangon',
  'Europe/Kiev': 'Europe/Kyiv', 'America/Buenos_Aires': 'America/Argentina/Buenos_Aires', 'Atlantic/Faeroe': 'Atlantic/Faroe', 'Pacific/Truk': 'Pacific/Chuuk',
};

/** This device's time zone, by its current IANA name - only ever used as a *starting suggestion*; the organizer can change it. */
export const deviceZone = (): string => {
  try { const z = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; return CURRENT_NAMES[z] ?? z; } catch { return 'UTC'; }
};

/** Every IANA zone this browser knows, for the picker; a short, always-available fallback when the browser is too old for the API. */
export function allTimeZones(): string[] {
  try {
    const sv = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    if (sv) return sv('timeZone');
  } catch { /* fall through */ }
  return ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo', 'Europe/London',
    'Europe/Paris', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney'];
}

const offsetMs = (atUtcMs: number, zone: string): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(atUtcMs)).reduce<Record<string, string>>((a, p) => { if (p.type !== 'literal') a[p.type] = p.value; return a; }, {});
  const hour = parts.hour === '24' ? 0 : Number(parts.hour);
  const asIfUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, Number(parts.minute), Number(parts.second));
  return asIfUtc - atUtcMs;
};

/**
 * The instant that a wall-clock date/time means in `zone` - e.g. (2026, 10, 16, 9, 0, "America/Chicago") is 9am Central, whatever this
 * device's own clock/zone is set to. A second pass (not just one) keeps this correct within an hour either side of a daylight-saving
 * change, where a single offset lookup can land a few minutes off.
 */
export function zonedTimeToUtc(y: number, monthIndex: number, d: number, h: number, mi: number, zone: string): Date {
  const guess = Date.UTC(y, monthIndex, d, h, mi, 0);
  const firstOffset = offsetMs(guess, zone);
  const secondOffset = offsetMs(guess - firstOffset, zone);
  return new Date(guess - secondOffset);
}

/** The wall-clock reading of an instant in `zone`, as {year, monthIndex, day, hour, minute} (monthIndex is 0-based, like Date). */
export function wallInZone(instant: Date, zone: string): { year: number; monthIndex: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(instant).reduce<Record<string, string>>((a, p) => { if (p.type !== 'literal') a[p.type] = p.value; return a; }, {});
  return { year: Number(parts.year), monthIndex: Number(parts.month) - 1, day: Number(parts.day), hour: parts.hour === '24' ? 0 : Number(parts.hour), minute: Number(parts.minute) };
}
