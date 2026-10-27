// The one Work API (v2): every kind of work - project tasks, issues, action items and tickets - through /api/v1/work-items.
// Each kind keeps its own rules on the server; `detail` on an item is the kind's own full record.
import { create, del, get, patch } from './client';
import type { Priority, StatusCategory, UserRef } from './types';

export type WorkKind = 'task' | 'issue' | 'action' | 'ticket';
/** open (default), closed (done or cancelled), all, or one category. */
export type WorkStatusFilter = 'open' | 'closed' | 'all' | 'todo' | 'active' | 'done' | 'cancelled';

export interface WorkRow {
  kind: WorkKind;
  id: string;
  key: string;
  title: string;
  projectId: string | null;
  projectKey: string | null;
  projectName: string | null;
  status: string;
  category: StatusCategory;
  priority: Priority;
  dueDate: string | null;
  isOverdue: boolean;
  assignee: UserRef | null;
  typeName: string | null;
  updatedAt: string;
  /** Tickets with a service level: when the clock started, when it is due (resolution, else response) and its state. */
  slaStartAt?: string | null;
  slaDueAt?: string | null;
  slaState?: string | null;
}

export interface WorkPage { items: WorkRow[]; offset: number; limit: number; hasMore: boolean }

export interface WorkListFilters {
  kind?: WorkKind[];
  mine?: boolean;
  /** A team id, or 'mine' for everyone in my teams. */
  team?: string;
  assigneeId?: string;
  projectId?: string;
  status?: WorkStatusFilter;
  overdue?: boolean;
  q?: string;
  offset?: number;
  limit?: number;
}

/** comment, time (logged), file, change (a field changed) or ai (the project agent's change). */
export type WorkActivityType = 'comment' | 'time' | 'file' | 'change' | 'ai';

export interface WorkActivity {
  type: WorkActivityType;
  id: string;
  at: string;
  actor: UserRef | null;
  summary: string;
  body?: string | null;
  minutes?: number | null;
  workDate?: string | null;
  fileId?: string | null;
  fileName?: string | null;
  action?: string | null;
  auto?: boolean | null;
}

export interface WorkItemDetail {
  kind: WorkKind;
  id: string;
  key: string;
  title: string;
  description: string | null;
  projectId: string | null;
  projectKey: string | null;
  projectName: string | null;
  status: string;
  category: StatusCategory;
  priority: Priority;
  startDate: string | null;
  dueDate: string | null;
  isOverdue: boolean;
  assignee: UserRef | null;
  reporter: UserRef | null;
  /** Send it back with every change (PATCH); a 409 VERSION_CONFLICT means someone saved in between. */
  version: number;
  createdAt: string;
  updatedAt: string | null;
  completedAt: string | null;
  loggedMinutes: number;
  /** The kind's own record (Task, Issue, ActionItem or WorkTask shape). */
  detail: Record<string, unknown>;
  /** Newest first. */
  activity: WorkActivity[];
  /** Tickets: where it came from (app, email, whatsapp, phone, webhook, ai); null for other kinds. */
  channel?: string | null;
}

export interface CreateWorkItemInput {
  kind: WorkKind;
  title?: string;
  description?: string | null;
  projectId?: string | null;
  assigneeId?: string | null;
  priority?: Priority;
  startDate?: string | null;
  dueDate?: string | null;
  statusId?: string | null;
  stageId?: string | null;
  workTypeId?: string | null;
  estimatedHours?: number | null;
  parentTaskId?: string | null;
  milestoneId?: string | null;
  labelIds?: string[];
}

/**
 * Only the fields sent change; null clears. `status` is the kind's own status (a task's column name, an issue's Observed/InProgress/
 * Fixed/Resolved, an action's Open/InProgress/Completed, a ticket's ToDo/InProgress/OnHold/Completed/Cancelled).
 */
export interface WorkItemPatch {
  version: number;
  title?: string;
  description?: string | null;
  assigneeId?: string | null;
  priority?: Priority;
  status?: string;
  statusId?: string;
  startDate?: string | null;
  dueDate?: string | null;
  stageId?: string | null;
  workTypeId?: string | null;
  projectId?: string | null;
  estimatedHours?: number | null;
  actualHours?: number | null;
  milestoneId?: string | null;
  /** A task's due date moved later (or cleared) needs a reason; the dependency causing it is optional. */
  dueDateReason?: string;
  dueDateDependency?: string;
}

export interface WorkCommentResult { comment: WorkActivity; time: WorkActivity | null; timeProblem: string | null }

export const workItemsApi = {
  list: (f: WorkListFilters = {}) =>
    get<WorkPage>('/work-items', { ...f, kind: f.kind?.length ? f.kind.join(',') : undefined }),
  get: (id: string) => get<WorkItemDetail>(`/work-items/${id}`),
  create: (b: CreateWorkItemInput) => create<WorkItemDetail>('/work-items', b),
  update: (id: string, b: WorkItemPatch) => patch<WorkItemDetail>(`/work-items/${id}`, b),
  /** "log 2h …" also logs the time on tasks and tickets. */
  comment: (id: string, body: string, mentionUserIds?: string[]) => create<WorkCommentResult>(`/work-items/${id}/comments`, { body, mentionUserIds }),
  remove: (id: string) => del(`/work-items/${id}`),
};
