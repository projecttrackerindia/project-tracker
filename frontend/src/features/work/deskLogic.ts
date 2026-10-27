/** Pure helpers for the support desk (SLA ring, incident timer) and the automation builder, kept apart so they can be tested. */

export type RingTone = 'ok' | 'warn' | 'late' | 'paused';

/**
 * How much of a ticket's SLA window is used (0..1) and its colour: green, amber from 75%, red once breached. A paused clock is grey;
 * the server's state wins over the arithmetic (it knows business hours and pauses).
 */
export function slaRing(startIso: string, dueIso: string, state: string | null, now = Date.now()): { used: number; tone: RingTone } {
  const start = Date.parse(startIso), due = Date.parse(dueIso);
  const span = due - start;
  const used = span > 0 ? Math.min(1, Math.max(0, (now - start) / span)) : 1;
  if (state === 'Breached' || state === 'Missed' || now > due) return { used: 1, tone: 'late' };
  if (state === 'Paused') return { used, tone: 'paused' };
  if (state === 'AtRisk' || used >= 0.75) return { used, tone: 'warn' };
  return { used, tone: 'ok' };
}

/** "00:42:07", "3d 04:10:00": time since an incident started. */
export function elapsed(fromIso: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - Date.parse(fromIso)) / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d ? `${d}d ` : ''}${pad(h)}:${pad(m)}:${pad(r)}`;
}

/** Ready-made replies for the ticket panel; {name} is the reporter's first name. */
export const MACROS: { id: string; label: string; text: string }[] = [
  { id: 'ack', label: 'Acknowledge', text: 'Hi {name}, thanks for reporting this. We are looking into it and will update you here shortly.' },
  { id: 'info', label: 'Need more info', text: 'Hi {name}, could you share a screenshot, the time it happened and the steps to reproduce? That will help us fix it faster.' },
  { id: 'fixed', label: 'Fixed, please confirm', text: 'Hi {name}, we have deployed a fix. Could you check on your side and confirm it works for you?' },
];

export const fillMacro = (text: string, reporter: string | null | undefined) => text.replace(/\{name\}/g, reporter?.split(' ')[0] || 'there');
