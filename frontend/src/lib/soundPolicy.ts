/**
 * When a notification may make a sound, Apple-style: subtle, short, rare. Pure (soundPolicy.test.ts); lib/attention.ts asks it before every
 * cue. The rules (docs/notification-sounds.md):
 *  - never for your own actions, never for the conversation you are looking at, never for a muted chat unless it @mentions you;
 *  - never during Do Not Disturb, "Mute all" or quiet hours (Settings › Notifications › Schedule);
 *  - never when that category's Sound is off, or all sounds are off on this device;
 *  - at most one sound every COALESCE_MS: a burst of ten messages is one sound;
 *  - one sound per alert: when the page plays its cue the system notification is silent, and when the page cannot (hidden, not allowed
 *    yet) the operating system plays its own instead - never both.
 */
export const COALESCE_MS = 2500;

export interface SoundContext {
  now: number;
  /** When the last cue played on this device (any tab: shared through localStorage). */
  lastPlayedAt: number | null;
  masterOn: boolean;
  categoryOn: boolean;
  dnd: boolean;
  muted: boolean;
  quiet: boolean;
  own?: boolean;
  viewingSame?: boolean;
  mutedChat?: boolean;
  mention?: boolean;
}

export type SoundVerdict = { play: true } | { play: false; reason: 'off' | 'own' | 'viewing' | 'muted-chat' | 'dnd' | 'quiet' | 'category' | 'coalesced' };

export function shouldPlay(c: SoundContext): SoundVerdict {
  if (!c.masterOn) return { play: false, reason: 'off' };
  if (c.own) return { play: false, reason: 'own' };
  if (c.viewingSame) return { play: false, reason: 'viewing' };
  if (c.mutedChat && !c.mention) return { play: false, reason: 'muted-chat' };
  if (c.dnd || c.muted) return { play: false, reason: 'dnd' };
  if (c.quiet) return { play: false, reason: 'quiet' };
  if (!c.categoryOn) return { play: false, reason: 'category' };
  if (c.lastPlayedAt !== null && c.now - c.lastPlayedAt >= 0 && c.now - c.lastPlayedAt < COALESCE_MS) return { play: false, reason: 'coalesced' };
  return { play: true };
}

const minutes = (hhmm: string) => { const m = /^(\d{1,2}):(\d{2})/.exec(hhmm); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

/** Whether this wall-clock minute of the day falls in quiet hours "21:00"–"08:00" (overnight ranges wrap). No range: never quiet. */
export function inQuietHours(start: string | null | undefined, end: string | null | undefined, minuteOfDay: number): boolean {
  if (!start || !end) return false;
  const s = minutes(start), e = minutes(end);
  if (s === null || e === null || s === e) return false;
  return s < e ? minuteOfDay >= s && minuteOfDay < e : minuteOfDay >= s || minuteOfDay < e;
}

/** The master volume (0–1) becomes a gain; 0 is silent, and the curve is gentle so the middle of the slider is already quiet. */
export const gainOf = (volume: number) => Math.max(0, Math.min(1, volume)) ** 1.6;
