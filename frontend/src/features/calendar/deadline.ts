import type { CalendarEvent } from '../../api/types';
import { isoDateIn } from '../../lib/zone';
import { END, START, hourOf } from './plannerModel';

/**
 * Where a deadline sits on a day: at its due time when it has one (or, for an open ticket without a due time, at its SLA resolve-by),
 * otherwise at the end of the working shift (a date-only due means "by the end of the day").
 */
export function deadlineHourOf(item: { dueAt?: string | null; dueTime?: string | null }, shift: { start?: number; end: number } = { start: START, end: END }): number {
  if (item.dueAt) return hourOf(new Date(item.dueAt));
  return shift.end;
}

/** The deadline markers of a day: open work with a due time, and open tickets' SLA breach instants (one marker each, the breach winning). */
export interface DayMark { key: string; kind: 'sla' | 'due'; at: number; iso: string; e: CalendarEvent; late: boolean }

export function dayMarks(day: string, due: readonly CalendarEvent[], now: number): DayMark[] {
  const out: DayMark[] = [];
  for (const e of due) {
    const iso = e.slaBreachAt ?? e.dueAt ?? null;
    if (!iso || isoDateIn(new Date(iso)) !== day) continue;   // a breach on another day is marked on that day, not this one
    const kind = e.slaBreachAt ? 'sla' : 'due';
    out.push({ key: `${kind}:${e.type}:${e.id}`, kind, at: deadlineHourOf({ dueAt: iso }), iso, e, late: Date.parse(iso) < now || e.slaState === 'Breached' });
  }
  return out.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}
