import { get, post } from './client';
import type { Paged, UserRef } from './types';

/** What an activity line is about (GET /activity?entityType=…). */
export type ActivityEntityType = 'task' | 'project' | 'actionitem' | 'reminder' | 'note' | 'approval';

/**
 * One line of an item's history. `action` is `updated` (a field changed: `field`, `from`, `to`), `date_extended` / `date_changed` (a date moved
 * later / earlier, with the `reason` given), or an event with no field: created, deleted, restored, commented, completed, assigned …
 */
export interface ActivityEntry {
  id: string; at: string; actor: UserRef | null; action: string; field: string | null; from: string | null; to: string | null; summary: string; reason: string | null;
}

/** 422 code when a date moves later without `extensionReason`; the error's field is `extensionReason`. */
export const DATE_EXTENSION_REASON_REQUIRED = 'DATE_EXTENSION_REASON_REQUIRED';

export const activityApi = {
  list: (entityType: ActivityEntityType, entityId: string, page = 1, pageSize = 50) =>
    get<Paged<ActivityEntry>>('/activity', { entityType, entityId, page, pageSize }),
};

/** Undo of a delete. Each returns the restored item as its own GET does. */
export const restoreApi = {
  project: (id: string) => post<unknown>(`/projects/${id}/restore`),
  task: (id: string) => post<unknown>(`/tasks/${id}/restore`),
  actionItem: (projectId: string, id: string) => post<unknown>(`/projects/${projectId}/action-items/${id}/restore`),
  note: (id: string) => post<unknown>(`/notes/${id}/restore`),
  reminder: (id: string) => post<unknown>(`/reminders/${id}/restore`),
};
