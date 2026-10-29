import { useEffect, useState } from 'react';
import { zonedParts } from '../../lib/zone';

/**
 * Due times and SLA countdowns, shared by the ticket panel, the incident banner, Needs you, Your day and the Calendar.
 * A due time is a wall-clock time on the due date in the workspace's zone ("14:30:00" from the server); `dueAt` is the instant it falls on.
 */

/** "14:30:00" → "14:30"; null for none. */
export const hm = (time: string | null | undefined): string | null => (time ? time.slice(0, 5) : null);

/** "14:30" → "14:30:00" (what the API stores); empty → null. */
export const toApiTime = (value: string): string | null => (/^\d{2}:\d{2}$/.test(value) ? `${value}:00` : null);

/** An instant as a 24-hour "14:29" in the app's zone. */
export function clock24(iso: string | number | Date): string {
  const p = zonedParts(new Date(iso));
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** A span as "3h 52m", "45m", "1d 4h" (rounded down to the minute; under a minute reads "<1m"). */
export function spanText(ms: number): string {
  const m = Math.floor(Math.abs(ms) / 60_000);
  if (m < 1) return '<1m';
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), r = m % 60;
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return r ? `${h}h ${r}m` : `${h}h`;
  return `${r}m`;
}

export type SlaTone = 'ok' | 'warn' | 'late' | 'paused';

/**
 * The SLA row's countdown: "Resolve by 14:29 · 3h 52m left", "Resolve by 14:29 · 12m late". Red (late) when under an hour is left or it is
 * breached; paused while the clock is stopped.
 */
export function slaCountdown(dueAt: string, state: string | null | undefined, now: number): { text: string; tone: SlaTone; left: number } {
  const left = Date.parse(dueAt) - now;
  const by = `Resolve by ${clock24(dueAt)}`;
  if (state === 'Paused') return { text: `${by} · paused`, tone: 'paused', left };
  if (left < 0 || state === 'Breached') return { text: `${by} · ${spanText(left)} late`, tone: 'late', left };
  return { text: `${by} · ${spanText(left)} left`, tone: left < 3_600_000 ? 'late' : state === 'AtRisk' ? 'warn' : 'ok', left };
}

/** Needs you: "breaches in 3h 52m" or "breached 10m ago". */
export function breachText(breachAt: string, now: number): string {
  const left = Date.parse(breachAt) - now;
  return left >= 0 ? `breaches in ${spanText(left)}` : `breached ${spanText(left)} ago`;
}

/** A countdown to an instant for the incident banner: "03:52:10" (or "-00:12:00" once past). */
export function countdown(toIso: string, now: number): string {
  const ms = Date.parse(toIso) - now;
  const s = Math.floor(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${ms < 0 ? '-' : ''}${d ? `${d}d ` : ''}${pad(h)}:${pad(m)}:${pad(r)}`;
}

/**
 * Whether moving a due (date and optional time) makes it later: a later day, the same day at a later time, or the same day losing its time
 * (date-only means the end of the day), or the due being removed. The server asks for a reason in exactly these cases.
 */
export function dueMovesLater(prevDate: string | null | undefined, prevTime: string | null | undefined, date: string | null | undefined, time: string | null | undefined): boolean {
  if (!prevDate) return false;
  if (!date) return true;
  if (date !== prevDate) return date > prevDate;
  const a = hm(prevTime) ?? '24:00', b = hm(time) ?? '24:00';
  return b > a;
}

/** Now, re-read once a minute while `active` (countdowns in lists do not need seconds). */
export function useMinuteNow(active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}
