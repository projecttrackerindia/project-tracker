import { del, download, fetchBlobUrl, get, patch, post, put, uploadFile } from './client';
import type { EffectiveAccessList,AutomationInput,AutomationRule,ProjectTime,TaskTime,TimeEntry,Timesheet,AccessMatrix,DependencyType,Milestone,MilestoneInput,TaskDependencies,ActionItem,ActionItemInput,ActionItemStatus,Attachment,AttachmentLimits,ProjectGroup,ProjectStatusReport,StatusGroup,Issue,IssueDetail,IssueInput,DevEmail,OrgRole,OrgStructure,TimesheetWeek,Approvals } from './types';

export const devApi = { emails: () => get<DevEmail[]>('/dev/emails', undefined, { auth: false }) };

export const orgApi = {
  get: () => get<OrgStructure>('/org'),
  createRole: (b: { name: string; description?: string; color?: string; parentRoleId?: string | null }) => post<OrgRole>('/org/roles', b),
  updateRole: (id: string, b: { name: string; description?: string; color?: string }) => put<OrgStructure>(`/org/roles/${id}`, b),
  moveRole: (id: string, parentRoleId: string | null) => patch<OrgStructure>(`/org/roles/${id}/parent`, { parentRoleId }),
  deleteRole: (id: string, moveTo?: string) => del<{ movedPeople: number; movedRoles: number }>(`/org/roles/${id}${moveTo ? `?moveTo=${moveTo}` : ''}`),
  restoreRole: (id: string) => post<OrgRole>(`/org/roles/${id}/restore`),
  saveLayout: (items: { id: string; x: number | null; y: number | null }[]) => put('/org/layout', { items }),
  assign: (userId: string, roleId: string | null) => put(`/org/members/${userId}/role`, { roleId }),
  reportsTo: (userId: string, reportsToUserId: string | null) => put(`/org/members/${userId}/reports-to`, { reportsToUserId }),
  template: (template: string) => post<{ created: number }>('/org/template', { template }),
  access: () => get<AccessMatrix>('/org/access'),
  setAccess: (roleId: string, b: { modules: Record<string, number>; actions: Record<string, boolean> }) => put<AccessMatrix>(`/org/roles/${roleId}/access`, b),
  resetAccess: (roleId: string) => del<AccessMatrix>(`/org/roles/${roleId}/access`),
  /** What every person can open and do right now, and which rule decided it (job role or access level). */
  effectiveAccess: () => get<EffectiveAccessList>('/org/access/effective'),
};

/** The workspace's master list of project groups. */
export const projectGroupApi = {
  list: (activeOnly = false) => get<ProjectGroup[]>('/project-groups', activeOnly ? { activeOnly: true } : undefined),
  create: (b: { name: string; description?: string | null; isActive?: boolean }) => post<ProjectGroup>('/project-groups', b),
  update: (id: string, b: { name?: string; description?: string | null; isActive?: boolean }) => put<ProjectGroup>(`/project-groups/${id}`, b),
  reorder: (groupIds: string[]) => put<ProjectGroup[]>('/project-groups/order', { groupIds }),
  /** A group that still has projects is deleted only with `moveTo`: the active group they are moved to first. */
  remove: (id: string, moveTo?: string) => del<void>(`/project-groups/${id}${moveTo ? `?moveTo=${moveTo}` : ''}`),
};

/** Action items of a project (follow-ups with an owner, a due date and a priority). */
export const actionItemApi = {
  list: (projectId: string) => get<ActionItem[]>(`/projects/${projectId}/action-items`),
  create: (projectId: string, b: ActionItemInput) => post<ActionItem>(`/projects/${projectId}/action-items`, b),
  update: (projectId: string, id: string, b: ActionItemInput & { status: ActionItemStatus }) => put<ActionItem>(`/projects/${projectId}/action-items/${id}`, b),
  setStatus: (projectId: string, id: string, status: ActionItemStatus) => put<ActionItem>(`/projects/${projectId}/action-items/${id}/status`, { status }),
  remove: (projectId: string, id: string) => del<void>(`/projects/${projectId}/action-items/${id}`),
};

/** The Project Status presentation page. */
export const statusApi = {
  groups: (teamId?: string | null) => get<StatusGroup[]>('/project-status/groups', { teamId: teamId ?? undefined }),
  report: (projectId: string) => get<ProjectStatusReport>(`/project-status/projects/${projectId}`),
};

/** Issues found in a project's stages (Observed / Failed → In progress → Fixed → Resolved). */
export const issueApi = {
  list: (projectId: string, f: { stageId?: string; openOnly?: boolean } = {}) => get<Issue[]>(`/projects/${projectId}/issues`, f),
  get: (projectId: string, id: string) => get<IssueDetail>(`/projects/${projectId}/issues/${id}`),
  create: (projectId: string, b: IssueInput) => post<IssueDetail>(`/projects/${projectId}/issues`, b),
  update: (projectId: string, id: string, b: { title?: string; details?: string; severity?: string; stageId?: string }) => put<IssueDetail>(`/projects/${projectId}/issues/${id}`, b),
  assign: (projectId: string, id: string, assigneeId: string | null) => put<IssueDetail>(`/projects/${projectId}/issues/${id}/assignee`, { assigneeId }),
  setStatus: (projectId: string, id: string, status: string, note?: string) => put<IssueDetail>(`/projects/${projectId}/issues/${id}/status`, { status, note: note ?? null }),
  remove: (projectId: string, id: string) => del<void>(`/projects/${projectId}/issues/${id}`),
};

export const attachmentApi = {
  list: (projectId: string, taskId?: string, issueId?: string) => get<Attachment[]>(issueId ? `/projects/${projectId}/issues/${issueId}/attachments` : taskId ? `/projects/${projectId}/tasks/${taskId}/attachments` : `/projects/${projectId}/attachments`),
  limits: () => get<AttachmentLimits>('/attachments/limits'),
  uploadPath: (projectId: string, taskId?: string, issueId?: string) => (issueId ? `/projects/${projectId}/issues/${issueId}/attachments` : taskId ? `/projects/${projectId}/tasks/${taskId}/attachments` : `/projects/${projectId}/attachments`),
  upload: (projectId: string, file: File, taskId?: string) => uploadFile<Attachment>(attachmentApi.uploadPath(projectId, taskId), file),
  download: (id: string, fileName: string) => download(`/attachments/${id}/download`, fileName),
  /** Thumbnails: fetched with the access token and shown from an object URL. */
  inlineBlob: (id: string, signal?: AbortSignal) => fetchBlobUrl(`/attachments/${id}/download?inline=true`, signal),
  remove: (id: string) => del(`/attachments/${id}`),
};

export const planningApi = {
  milestones: (projectId: string) => get<Milestone[]>(`/projects/${projectId}/milestones`),
  createMilestone: (projectId: string, b: MilestoneInput) => post<Milestone[]>(`/projects/${projectId}/milestones`, b),
  updateMilestone: (projectId: string, id: string, b: MilestoneInput) => put<Milestone[]>(`/projects/${projectId}/milestones/${id}`, b),
  deleteMilestone: (projectId: string, id: string) => del<Milestone[]>(`/projects/${projectId}/milestones/${id}`),
  dependencies: (taskId: string) => get<TaskDependencies>(`/tasks/${taskId}/dependencies`),
  addDependency: (taskId: string, b: { dependsOnTaskId: string; type: DependencyType }) => post<TaskDependencies>(`/tasks/${taskId}/dependencies`, b),
  removeDependency: (taskId: string, dependencyId: string) => del<TaskDependencies>(`/tasks/${taskId}/dependencies/${dependencyId}`),
};

export const timeApi = {
  forTask: (taskId: string) => get<TaskTime>(`/tasks/${taskId}/time`),
  log: (taskId: string, b: { minutes: number; workDate?: string; note?: string; billable?: boolean }) => post<TimeEntry>(`/tasks/${taskId}/time`, b),
  /** Operational work: the same time tracking as project tasks. */
  forWorkTask: (workTaskId: string) => get<TaskTime>(`/work-tasks/${workTaskId}/time`),
  logOnWorkTask: (workTaskId: string, b: { minutes: number; workDate?: string; note?: string; billable?: boolean }) => post<TimeEntry>(`/work-tasks/${workTaskId}/time`, b),
  startOnWorkTask: (workTaskId: string) => post<TimeEntry>(`/work-tasks/${workTaskId}/timer/start`),
  update: (id: string, b: { minutes: number; workDate: string; note?: string | null; billable?: boolean }) => put<TimeEntry>(`/time/${id}`, b),
  remove: (id: string) => del(`/time/${id}`),
  start: (taskId: string) => post<TimeEntry>(`/tasks/${taskId}/timer/start`),
  stop: () => post<TimeEntry>('/timer/stop'),
  running: () => get<TimeEntry | null>('/timer'),
  timesheet: (p: { from?: string; to?: string; userId?: string }) => get<Timesheet>(`/time?${new URLSearchParams(Object.entries(p).filter(([, v]) => v) as [string, string][])}`),
  project: (projectId: string) => get<ProjectTime>(`/projects/${projectId}/time`),
  /** A person's week (mine without a user) and where its approval stands. */
  week: (weekStart?: string, userId?: string) => get<TimesheetWeek>('/time/week', { weekStart, userId }),
  submitWeek: (weekStart: string, note?: string) => post<TimesheetWeek>('/time/week/submit', { weekStart, note: note || null }),
  withdrawWeek: (weekStart: string) => post<TimesheetWeek>('/time/week/withdraw', { weekStart }),
  approvals: (weekStart?: string) => get<Approvals>('/time/approvals', { weekStart }),
  approve: (id: string, note?: string) => post<TimesheetWeek>(`/time/approvals/${id}/approve`, { note: note || null }),
  reject: (id: string, note: string) => post<TimesheetWeek>(`/time/approvals/${id}/reject`, { note }),
};

export const automationApi = {
  list: (projectId: string) => get<AutomationRule[]>(`/projects/${projectId}/automations`),
  create: (projectId: string, b: AutomationInput) => post<AutomationRule>(`/projects/${projectId}/automations`, b),
  update: (projectId: string, id: string, b: AutomationInput) => put<AutomationRule>(`/projects/${projectId}/automations/${id}`, b),
  remove: (projectId: string, id: string) => del(`/projects/${projectId}/automations/${id}`),
};

/** Workspace-wide automation rules (they apply to every project). */
export const workspaceAutomationApi = {
  list: () => get<AutomationRule[]>('/automations'),
  create: (b: AutomationInput) => post<AutomationRule>('/automations', b),
  update: (id: string, b: AutomationInput) => put<AutomationRule>(`/automations/${id}`, b),
  remove: (id: string) => del(`/automations/${id}`),
};
