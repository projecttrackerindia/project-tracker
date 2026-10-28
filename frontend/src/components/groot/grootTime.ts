/**
 * Groot's sense of time: the organization's day (its time zone and working hours, from Settings › Operations and the workspace's zone),
 * which part of that day it is now, and what Groot offers to do at that time.
 */

export interface OrgDay { zone: string; startMin: number; endMin: number; /** Monday = 1 … Sunday = 64 (Mon–Fri = 31). */ workDays: number }
export type DayPart = 'early' | 'morning' | 'midday' | 'evening' | 'late' | 'off';
export interface GrootSuggestion { label: string; prompt: string; /** A hook another feature handles (check-out). */ action?: 'checkout' }

export const DEFAULT_DAY: Omit<OrgDay, 'zone'> = { startMin: 9 * 60, endMin: 18 * 60, workDays: 31 };

/** Minutes after midnight and the weekday (Mon = 1 … Sun = 7) at `now` in `zone`. */
export function localClock(now: Date, zone: string): { minutes: number; weekday: number } {
  let parts: Intl.DateTimeFormatPart[];
  try { parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23' }).formatToParts(now); }
  catch { parts = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23' }).formatToParts(now); }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')) + 1;
  return { minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')), weekday: weekday || 1 };
}

/** Where `now` falls in the organization's day: before work, the first hours, the middle, the last hour and a half, after, or a day off. */
export function dayPart(now: Date, day: OrgDay): DayPart {
  const { minutes, weekday } = localClock(now, day.zone);
  if (!(day.workDays & (1 << (weekday - 1)))) return 'off';
  const { startMin: s, endMin: e } = day;
  if (minutes < s - 60) return minutes < 5 * 60 ? 'late' : 'early';
  if (minutes < s + 180) return 'morning';
  if (minutes < e - 90) return 'midday';
  if (minutes < e + 180) return 'evening';
  return 'late';
}

export function greeting(part: DayPart, now: Date, zone: string, firstName?: string | null): string {
  const h = Math.floor(localClock(now, zone).minutes / 60);
  const hello = h < 12 && h >= 4 ? 'Good morning' : h < 17 && h >= 12 ? 'Good afternoon' : 'Good evening';
  const name = firstName ? `, ${firstName}` : '';
  return part === 'off' ? `Hi${name} — it's a day off` : `${hello}${name}`;
}

const hhmm = (min: number) => { const h = Math.floor(min / 60), m = min % 60; const ap = h >= 12 ? 'PM' : 'AM'; return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${ap}`; };
export const workingHours = (day: OrgDay) => `${hhmm(day.startMin)}–${hhmm(day.endMin)}`;

/** What Groot offers on an empty chat, by the organization's time of day. */
export function suggestionsFor(part: DayPart, project?: string | null): GrootSuggestion[] {
  if (project) return [
    { label: `What is at risk on ${project}?`, prompt: `What is at risk on ${project}?` },
    { label: `What's blocking ${project}?`, prompt: `What's blocking ${project}, and who can unblock it?` },
    { label: `Summarise ${project} this week`, prompt: `Summarise ${project} this week` },
  ];
  switch (part) {
    case 'early': case 'morning': return [
      { label: 'Plan my day', prompt: 'Plan my day: my meetings, what is due and what I should do first.' },
      { label: "What's blocking my team?", prompt: "What's blocking my team right now, and who can unblock it?" },
      { label: 'What needs me today?', prompt: 'What needs me today?' },
    ];
    case 'midday': return [
      { label: 'What needs me now?', prompt: 'What needs me now?' },
      { label: "What's overdue on my team?", prompt: 'What is overdue on my team, and who owns it?' },
      { label: 'Catch me up on chat', prompt: 'Catch me up on my unread messages.' },
    ];
    case 'evening': return [
      { label: 'Wrap up my day', prompt: 'Wrap up my day: what I finished, what is still open and what moves to tomorrow.' },
      { label: 'Check out', prompt: 'Help me check out for the day.', action: 'checkout' },
      { label: "What's due tomorrow?", prompt: 'What is due tomorrow?' },
    ];
    case 'late': return [
      { label: 'What did I miss today?', prompt: 'What did I miss today?' },
      { label: 'Plan tomorrow', prompt: 'Plan tomorrow for me.' },
      { label: 'Check out', prompt: 'Help me check out for the day.', action: 'checkout' },
    ];
    case 'off': return [
      { label: 'What happened while I was off?', prompt: 'What happened while I was off?' },
      { label: 'Plan my next workday', prompt: 'Plan my next workday.' },
      { label: 'Anything urgent?', prompt: 'Is anything urgent that needs me?' },
    ];
  }
}

/**
 * The check-out hook: Groot's "Check out" fires a cancelable `groot:checkout` window event. The attendance feature listens and calls
 * `preventDefault()` when it takes over; when nobody does, this returns false and Groot falls back to wrapping up the day in chat.
 */
export function grootCheckout(source: 'groot-chat' | 'suggestion' = 'suggestion'): boolean {
  const e = new CustomEvent('groot:checkout', { cancelable: true, detail: { source, at: new Date().toISOString() } });
  window.dispatchEvent(e);
  return e.defaultPrevented;
}
