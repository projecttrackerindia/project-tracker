import { ApiError } from '../../api/client';
import { actionItemApi, opsApi, projectApi, taskApi, timeApi, workApi } from '../../api/endpoints';
import type { CalendarEvent, Task, TimeEntry } from '../../api/types';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { appZone, instantIn } from '../../lib/zone';
import { reminderApi } from '../reminders/api';

/**
 * Every edit the Calendar makes writes the real record (a time entry, a task's due date, a meeting, a reminder) through the same API the
 * timesheet, My Work and Reminders use, then refreshes every view built on it: the one timeline (Today and the Calendar), the timesheet
 * and its week grid (Insights › Time), My Work and the reminders. One source of truth, never a calendar-only copy.
 */
export function refreshAfterEdit(wid: string | null) {
  for (const k of ['time', 'timesheet', 'timer', 'timeline', 'work', 'work-items', 'my-work', 'tasks', 'task', 'calendar', 'reminders']) void invalidateWorkspace(wid, k);
}

/** My own time entries for a range, as the timesheet has them (who may change each, locked weeks, its stamp). Same 'time' family as Insights › Time. */
export function useMyEntries(from: string, to: string, enabled = true) {
  return useWsQuery(['time', 'calendar', from, to], () => timeApi.timesheet({ from, to }), { staleTime: 30_000, retry: false, enabled, placeholderData: (p) => p });
}

/** Why an entry cannot be changed from the calendar, or null when it can. */
export function entryLock(e: TimeEntry | null | undefined): string | null {
  if (!e) return 'Loading the entry…';
  if (e.locked) return 'This week is submitted for approval or approved. Withdraw it on the timesheet to change its time.';
  if (e.isRunning) return 'The timer is still running. Stop it first.';
  if (!e.canEdit) return 'Only the person who logged this time can change it.';
  return null;
}

/** "2026-10-28T14:30": a wall-clock time on the grid's day (in the app's zone), as Reminders take it. */
export const wallAt = (day: string, h: number) => { const m = Math.round(h * 60); return `${day}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
export const isoAt = (day: string, h: number) => instantIn(day, h).toISOString();

/** Place (or move, or resize) a time entry at a time of day. Its minutes follow the span; its note, work and billable flag stay. */
export function placeEntry(e: TimeEntry, day: string, start: number, end: number) {
  return timeApi.update(e.id, {
    minutes: Math.max(1, Math.round((end - start) * 60)), workDate: day, note: e.note, billable: e.billable,
    startedAt: isoAt(day, start), endedAt: isoAt(day, end), stamp: e.stamp ?? null,
  });
}

/** The message to show for a refused edit (a locked week, a change made elsewhere, validation). */
export const editError = (err: unknown, fallback: string) => {
  if (err instanceof ApiError) {
    if (err.code === 'TIME_ENTRY_CHANGED') return 'This entry changed somewhere else in the meantime. The calendar now shows the latest; try again.';
    return err.message;
  }
  return fallback;
};

/** Mark a piece of work done the way its own screen does (a ticket's status, an action item's status, a task moved to its project's Done). */
export async function completeWork(e: Pick<CalendarEvent, 'type' | 'id' | 'projectId'>) {
  if (e.type === 'work') await workApi.setStatus(e.id, 'Completed');
  else if (e.type === 'action') await actionItemApi.setStatus(e.projectId!, e.id, 'Completed');
  else {
    const p = await projectApi.get(e.projectId!);
    const done = p.statuses.find((s) => s.category === 'Done');
    if (!done) throw new ApiError(400, 'This project has no Done status.', []);
    await taskApi.move(e.id, { statusId: done.id });
  }
}
export const canComplete = (e: Pick<CalendarEvent, 'type' | 'projectId'>) => (e.type === 'work') || ((e.type === 'task' || e.type === 'action') && !!e.projectId);
export const canMoveDue = (e: Pick<CalendarEvent, 'type'>) => e.type === 'task' || e.type === 'work';

/** Move a due date. A task moved later carries its reason (the task form's rule; the server refuses it without one). */
export async function moveDue(e: Pick<CalendarEvent, 'type' | 'id'>, date: string, reason: string, known?: Task | null) {
  if (e.type === 'work') { await opsApi.bulk({ ids: [e.id], dueDate: date }); return; }
  const x = known ?? (await taskApi.get(e.id)).task;
  await taskApi.update(e.id, { title: x.title, description: x.description, priority: x.priority, assigneeId: x.assignee?.id ?? null, startDate: x.startDate, dueDate: date,
    estimatedHours: x.estimatedHours, labelIds: x.labels.map((l) => l.id), milestoneId: x.milestoneId, statusId: x.statusId, actualHours: x.actualHours, version: x.version,
    dueDateReason: reason || null, dueDateDependency: null });
}

/** Move a one-off reminder to a new time (the same save as the Reminders screen). A repeating one moves from Reminders. */
export async function moveReminder(id: string, day: string, hour: number) {
  const list = await reminderApi.list();
  const r = [...list.open, ...list.completed, ...list.sent].find((x) => x.id === id);
  if (!r) throw new ApiError(404, 'That reminder is gone.', []);
  if (!r.canEdit) throw new ApiError(403, 'Only the person who set this reminder can move it.', []);
  if (r.recurrence) throw new ApiError(409, 'A repeating reminder moves from Reminders.', []);
  await reminderApi.update(id, { title: r.title, note: r.note, targetType: r.targetType, targetId: r.targetId, when: { at: wallAt(day, hour), timeZone: appZone() }, onlyIfOpen: r.onlyIfOpen, exact: r.exact });
}
