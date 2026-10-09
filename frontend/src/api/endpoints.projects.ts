import { del, download, get, patch, post, put } from './client';
import type { TimelineTemplate,Activity,AdminPlan,AdminStats,AdminTenant,AdminTenantDetail,AdminUser,AdminUserDetail,AppNotification,AuditLog,BillingOverview,CalendarEvent,Comment,Dashboard,Label,Paged,Project,ProjectDetail,ProjectMember,LensTeam,ReportSummary,SearchHit,Stage,Task,TaskDetail,WorkflowStatus,InvoiceBuyer } from './types';
export interface ProjectFilters { q?: string; status?: string; priority?: string; ownerId?: string; teamId?: string; projectGroupId?: string; projectType?: string; includeArchived?: boolean; sort?: string; page?: number; pageSize?: number; mineOnly?: boolean }
export interface ProjectInput {
  name: string; key?: string; description?: string; priority: string; status?: string; ownerId?: string | null; teamId?: string | null;
  startDate?: string | null; dueDate?: string | null; memberIds?: string[];
  /** The project group (required when creating). */
  projectGroupId?: string | null;
  /** What the project is for (required when creating). */
  projectType?: string | null;
  /** Phased, Agile or Hybrid: which planning views the project shows. */
  deliveryMethod?: string | null;
  /** When an existing due date moves: why (required for a delay) and what it depends on. */
  dueDateReason?: string | null; dueDateDependency?: string | null;
  /** Which ready-made timeline the project starts from (see timelineTemplates). */
  timelineTemplate?: string;
}
export interface TimelineTemplateInput { name: string; description?: string; stages: { name: string; weight: number }[] }
export interface StageInput {
  name: string; plannedStart?: string | null; plannedEnd?: string | null; actualStart?: string | null; actualEnd?: string | null; status: string;
  ownerId?: string | null; assigneeId?: string | null; description?: string | null; order?: number;
}
export const projectApi = {
  list: (f: ProjectFilters = {}) => get<Paged<Project>>('/projects', { pageSize: 25, ...f }),
  get: (id: string) => get<ProjectDetail>(`/projects/${id}`),
  timelineTemplates: () => get<TimelineTemplate[]>('/projects/timeline-templates'),
  createTimelineTemplate: (b: TimelineTemplateInput) => post<TimelineTemplate>('/projects/timeline-templates', b),
  updateTimelineTemplate: (id: string, b: TimelineTemplateInput) => put<TimelineTemplate>(`/projects/timeline-templates/${id}`, b),
  deleteTimelineTemplate: (id: string) => del<void>(`/projects/timeline-templates/${id}`),
  /** Saves a project's stages, in their current order, as a timeline of the workspace. */
  saveTimelineTemplate: (projectId: string, b: { name: string; description?: string }) => post<TimelineTemplate>(`/projects/${projectId}/timeline-templates`, b),
  /** Saves the whole timeline order: every stage id of the project, first to last. */
  reorderStages: (projectId: string, stageIds: string[]) => put<Stage[]>(`/projects/${projectId}/stages/order`, { stageIds }),
  create: (b: ProjectInput) => post<ProjectDetail>('/projects', b),
  update: (id: string, b: Omit<ProjectInput, 'key' | 'memberIds'> & { status: string; version: number; enforceDependencies?: boolean }) => put<ProjectDetail>(`/projects/${id}`, b),
  remove: (id: string) => del(`/projects/${id}`),
  /** Projects board: a different status moves the card to another column; the same status only re-orders it. */
  move: (id: string, b: { status: string; position?: number }) => patch<Project>(`/projects/${id}/move`, b),
  addMember: (id: string, userId: string) => post<ProjectMember[]>(`/projects/${id}/members`, { userId }),
  removeMember: (id: string, userId: string) => del(`/projects/${id}/members/${userId}`),
  createStatus: (id: string, b: { name: string; category: string; color?: string }) => post<WorkflowStatus[]>(`/projects/${id}/statuses`, b),
  updateStatus: (id: string, statusId: string, b: { name: string; category: string; color?: string; order?: number }) => put<WorkflowStatus[]>(`/projects/${id}/statuses/${statusId}`, b),
  /** Saves the whole workflow order: every status id of the project, first to last. */
  reorderStatuses: (id: string, statusIds: string[]) => put<WorkflowStatus[]>(`/projects/${id}/statuses/order`, { statusIds }),
  deleteStatus: (id: string, statusId: string) => del<WorkflowStatus[]>(`/projects/${id}/statuses/${statusId}`),
  createStage: (id: string, b: StageInput) => post<Stage[]>(`/projects/${id}/stages`, b),
  updateStage: (id: string, stageId: string, b: StageInput) => put<Stage[]>(`/projects/${id}/stages/${stageId}`, b),
  deleteStage: (id: string, stageId: string) => del<Stage[]>(`/projects/${id}/stages/${stageId}`),
  activity: (id: string, page = 1) => get<Paged<Activity>>(`/projects/${id}/activity`, { page, pageSize: 20 }),
};

export const labelApi = {
  list: () => get<Label[]>('/labels'),
  create: (b: { name: string; color?: string }) => post<Label>('/labels', b),
  update: (id: string, b: { name: string; color?: string }) => put<Label>(`/labels/${id}`, b),
  remove: (id: string) => del(`/labels/${id}`),
};

export interface TaskFilters {
  projectId?: string; mine?: boolean; assigneeId?: string; statusId?: string; category?: string; priority?: string; labelId?: string; q?: string;
  openOnly?: boolean; sprintId?: string; backlog?: boolean; dueFrom?: string; dueTo?: string; overdue?: boolean; includeSubtasks?: boolean; sort?: string; page?: number; pageSize?: number;
}
export interface TaskInput {
  title: string; description?: string | null; statusId?: string | null; priority: string; assigneeId?: string | null; startDate?: string | null;
  dueDate?: string | null; estimatedHours?: number | null; labelIds?: string[]; parentTaskId?: string | null; milestoneId?: string | null;
  /** When an existing due date moves: why (required for a delay) and what it depends on. */
  dueDateReason?: string | null; dueDateDependency?: string | null;
}

export const taskApi = {
  listForProject: (projectId: string, f: Omit<TaskFilters, 'projectId'> = {}) => get<Paged<Task>>(`/projects/${projectId}/tasks`, { pageSize: 500, ...f }),
  get: (id: string) => get<TaskDetail>(`/tasks/${id}`),
  create: (projectId: string, b: TaskInput) => post<Task>(`/projects/${projectId}/tasks`, b),
  update: (id: string, b: Omit<TaskInput, 'parentTaskId' | 'statusId'> & { statusId: string; actualHours?: number | null; version: number }) => put<Task>(`/tasks/${id}`, b),
  move: (id: string, b: { statusId: string; position?: number }) => patch<Task>(`/tasks/${id}/move`, b),
  remove: (id: string) => del(`/tasks/${id}`),
  comments: (id: string) => get<Comment[]>(`/tasks/${id}/comments`),
  addComment: (id: string, b: { body: string; mentionUserIds?: string[] }) => post<Comment>(`/tasks/${id}/comments`, b),
  updateComment: (id: string, body: string) => put<Comment>(`/comments/${id}`, { body }),
  deleteComment: (id: string) => del(`/comments/${id}`),
};

export const insightApi = {
  dashboard: (teamId?: string | null) => get<Dashboard>('/dashboard', { teamId: teamId ?? undefined }),
  lensTeams: () => get<LensTeam[]>('/lens/teams'),
  calendar: (from: string, to: string, projectId?: string, mine?: boolean, userId?: string) => get<CalendarEvent[]>('/calendar', { from, to, projectId, mine, userId }),
  search: (q: string) => get<{ hits: SearchHit[] }>('/search', { q }),
  activity: (page = 1) => get<Paged<Activity>>('/activity', { page, pageSize: 25 }),
  audit: (action: string | undefined, page = 1) => get<Paged<AuditLog>>('/audit-logs', { action, page, pageSize: 25 }),
  report: (days: number, teamId?: string | null) => get<ReportSummary>('/reports/summary', { days, teamId: teamId ?? undefined }),
};

export const notificationApi = {
  list: (page = 1, unreadOnly = false) => get<Paged<AppNotification>>('/notifications', { page, pageSize: 20, unreadOnly }),
  unread: () => get<{ count: number }>('/notifications/unread-count'),
  read: (id: string) => post(`/notifications/${id}/read`),
  readAll: () => post('/notifications/read-all'),
};

export const billingApi = {
  overview: () => get<BillingOverview>('/billing'),
  checkout: (planCode: string, startTrial: boolean, seats?: number, period?: 'monthly' | 'yearly') => post<BillingOverview>('/billing/checkout', { planCode, startTrial, seats, period }),
  confirm: (paymentId: string, subscriptionId: string, signature: string) => post<BillingOverview>('/billing/confirm', { paymentId, subscriptionId, signature }),
  details: () => get<InvoiceBuyer>('/billing/details'),
  setDetails: (b: InvoiceBuyer) => put<InvoiceBuyer>('/billing/details', b),
  downloadInvoice: (id: string, number: string) => download(`/billing/invoices/${id}/pdf`, `Invoice-${number}.pdf`),
  cancel: () => post<BillingOverview>('/billing/cancel'),
  resume: () => post<BillingOverview>('/billing/resume'),
};

export const adminApi = {
  stats: () => get<AdminStats>('/admin/stats'),
  tenants: (q?: string, page = 1, type?: string, status?: string) => get<Paged<AdminTenant>>('/admin/tenants', { q, page, pageSize: 20, type, status }),
  tenant: (id: string) => get<AdminTenantDetail>(`/admin/tenants/${id}`),
  createTenant: (b: { name: string; description?: string; ownerEmail: string; planCode: string }) => post<AdminTenantDetail>('/admin/tenants', b),
  updateTenant: (id: string, b: { name: string; description?: string | null; ownerUserId?: string | null }) => put<AdminTenantDetail>(`/admin/tenants/${id}`, b),
  /** Soft delete: members lose access, data is retained, and it can be restored. */
  deleteTenant: (id: string) => del(`/admin/tenants/${id}`),
  restoreTenant: (id: string) => post<AdminTenantDetail>(`/admin/tenants/${id}/restore`),
  setTenantStatus: (id: string, status: string) => put(`/admin/tenants/${id}/status`, { status }),
  setTenantSubscription: (id: string, b: { planCode: string; status: string; periodEnd?: string | null }) => put(`/admin/tenants/${id}/subscription`, b),
  users: (q?: string, page = 1) => get<Paged<AdminUser>>('/admin/users', { q, page, pageSize: 20 }),
  user: (id: string) => get<AdminUserDetail>(`/admin/users/${id}`),
  signOutUser: (id: string) => post(`/admin/users/${id}/sign-out`),
  setUserStatus: (id: string, isActive: boolean) => put(`/admin/users/${id}/status`, { isActive }),
  setPlatformAdmin: (id: string, isPlatformAdmin: boolean) => put(`/admin/users/${id}/platform-admin`, { isPlatformAdmin }),
  plans: () => get<AdminPlan[]>('/admin/plans'),
  updatePlan: (id: string, b: { name: string; description?: string | null; priceMonthly: number | null; isActive: boolean; features: Record<string, number>; perSeat?: boolean }) => put<AdminPlan>(`/admin/plans/${id}`, b),
  audit: (action: string | undefined, page = 1) => get<Paged<AuditLog>>('/admin/audit-logs', { action, page, pageSize: 25 }),
};
