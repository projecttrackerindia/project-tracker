/** Pure helpers for the Desk page (the SLA ring's colour and label, the incident clock), kept apart so they can be tested. */

export type DeskTone = 'ok' | 'warn' | 'late' | 'idle';

/**
 * The desk's ring: the share of the SLA window still left (0..1) and its colour - green, amber under an hour, red under 15 minutes or
 * once breached; grey when paused or when the ticket has no service level.
 */
export function deskRing(startIso: string | null, dueIso: string | null, state: string | null, now = Date.now()): { left: number; tone: DeskTone } {
  if (!dueIso) return { left: 0, tone: 'idle' };
  const due = Date.parse(dueIso), start = startIso ? Date.parse(startIso) : due - 3600e3;
  const span = due - start, rest = due - now;
  const left = span > 0 ? Math.min(1, Math.max(0, rest / span)) : 0;
  if (state === 'Breached' || state === 'Missed' || rest <= 0) return { left: 1, tone: 'late' };
  if (state === 'Paused') return { left, tone: 'idle' };
  if (rest < 15 * 60e3) return { left, tone: 'late' };
  if (rest < 3600e3) return { left, tone: 'warn' };
  return { left, tone: 'ok' };
}

/** Time left as the ring shows it: "9m", "38m", "4h", "2d". */
export function leftLabel(dueIso: string, now = Date.now()): string {
  const m = Math.max(0, Math.floor((Date.parse(dueIso) - now) / 60e3));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** "1:30:42" since the incident started; days as "2d 01:30:42". */
export function clock(fromIso: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - Date.parse(fromIso)) / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return d ? `${d}d ${p(h)}:${p(m)}:${p(r)}` : `${h}:${p(m)}:${p(r)}`;
}

/** The first line of a description, trimmed to a strip's length. */
export function firstLine(text: string | null | undefined, max = 80): string | null {
  const t = text?.split('\n').map((l) => l.trim()).find(Boolean);
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';
