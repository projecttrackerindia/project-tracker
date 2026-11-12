import { appZone, isoDateIn, shiftIsoDate } from '../../lib/zone';

/**
 * The one set of My Work rules, used by both My Work screens (the Focus Stack in work/MyWork and the list in workitems/MyWorkPage):
 * - overdue work is never in "Today": it has its own Overdue bucket;
 * - "Today" is open work due today (in the app's zone);
 * - "done today" means completed today (completedAt, in the app's zone) - not merely changed today (updatedAt).
 */
export type MyWorkBucket = 'overdue' | 'today' | 'week' | 'later' | 'none';

export interface BucketItem { dueDate: string | null; isOverdue: boolean }

/** Day of the week for a calendar day string: 0 Sunday to 6 Saturday. Pure calendar arithmetic, so no zone is involved. */
function dayOfWeek(iso: string) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * The last day of the calendar week `today` falls in. The app's week runs Monday to Sunday (calendar/timeline.ts
 * weekRange), so this is the coming Sunday, and Sunday itself.
 *
 * This used to be today + 7 days, a rolling window, while everything around it said "This week": the tab, the
 * Mon-Fri strip and the "N things due this week" headline. Work moved to next week stayed in the bucket for days,
 * so moving it looked like it had done nothing.
 */
export function weekEndOf(today: string) { return shiftIsoDate(today, (7 - dayOfWeek(today)) % 7); }

export function myWorkBucket(w: BucketItem, today: string, weekEnd = weekEndOf(today)): MyWorkBucket {
  if (w.isOverdue || (w.dueDate != null && w.dueDate < today)) return 'overdue';
  if (!w.dueDate) return 'none';
  if (w.dueDate === today) return 'today';
  if (w.dueDate <= weekEnd) return 'week';
  return 'later';
}

/** Finished today in the app's zone, from when it was completed. Without a completion time it does not count. */
export function completedToday(w: { completedAt?: string | null }, today: string, zone = appZone()) {
  return !!w.completedAt && isoDateIn(new Date(w.completedAt), zone) === today;
}

/** "14:05" - when an item was completed, for the done-today rows (instead of a misleading "just now"). */
export function completedClock(w: { completedAt?: string | null }, zone = appZone()) {
  if (!w.completedAt) return '';
  try { return new Date(w.completedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: zone }); } catch { return ''; }
}
