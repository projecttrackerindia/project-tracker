import { appZone, isoDateIn, shiftIsoDate } from '../../lib/zone';

/**
 * The one set of My Work rules, used by both My Work screens (the Focus Stack in work/MyWork and the list in workitems/MyWorkPage):
 * - overdue work is never in "Today": it has its own Overdue bucket;
 * - "Today" is open work due today (in the app's zone);
 * - "done today" means completed today (completedAt, in the app's zone) - not merely changed today (updatedAt).
 */
export type MyWorkBucket = 'overdue' | 'today' | 'week' | 'later' | 'none';

export interface BucketItem { dueDate: string | null; isOverdue: boolean }

export function weekEndOf(today: string) { return shiftIsoDate(today, 7); }

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
