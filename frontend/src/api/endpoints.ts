import { del, download, fetchBlobUrl, get, patch, post, put, uploadFile } from './client';
import type { ChatAttachment, BillingSettings, TimelineTemplate,
  Activity, AdminPlan, AdminStats, AdminTenant, AdminTenantDetail, AdminUser, AdminUserDetail, AppContext, AppNotification, AuditLog, AuthResponse, ApiKey, GoLive, AdminTestEmailResult, PlatformBilling, AdminUsage, FeatureOverride, PlatformSettings, PlatformStatus, SystemHealth, Workload, WorkloadPersonDetail, WorkloadScope, WorkItem, WorkItemKind, EffectiveAccessList, Webhook, WebhookDelivery, Checklist, CustomField, CustomFieldValue, ImportPreview, ImportResult, PriorityInfo, ReportExport, ReportFormat, ReportKind, Sprint, SprintDetail, AutomationInput, AutomationRule, ProjectTime, TaskTime, TimeEntry, Timesheet, MfaChallenge, MfaSetup, MfaStatus, PasswordPolicy, BillingOverview, CalendarEvent,
  AccessMatrix, DependencyType, Milestone, MilestoneInput, TaskDependencies, ActionItem, ActionItemInput, ActionItemStatus, Attachment, AttachmentLimits, ProjectChatUnread, ProjectGroup, ProjectStatusReport, StatusGroup, Issue, IssueDetail, IssueInput, NotificationPreference, TestEmailResult, Comment, Dashboard, DevEmail, OrgRole, OrgStructure, Invitation, InvitationLookup, Label, Member, MemberProfile, Paged, PermissionMatrix, Project, ProjectDetail, ProjectMember,
  ChatFilePage, ChatMessage, ChatPerson, ChatSearchHit, ChatThread, Conversation,
  WorkActivity, WorkAttachment, WorkComment, WorkSummary, WorkTask, WorkTaskInput, WorkType,
  LensTeam, OrgSecurity, ProjectVisibility, ReportSummary, SearchHit, Session, Stage, Task, TaskDetail, Team, TeamDetail, User, Workspace, WorkflowStatus,
  ConsentDocument, MyConsent, SignInDevice, DeviceLoginStart, DeviceLoginPending, Passkey, PasskeyChallenge, InvoiceBuyer, InvoiceSeller, EmailOverview, EmailBlocked, EmailDomainCheck, UnsubscribeInfo,
  ExternalProvider, SsoDiscovery, UserLogin, SsoSettings, SsoConnectionInput, ScimToken,
  TimesheetWeek, Approvals, Rates, Utilisation, ProjectFinancials, SlaSettings, SlaTarget, WebhookFormat,
  CalendarFeed, InboundMailbox, GitConnection, GitProvider, DevLink, DataPolicy, Priority, GoogleConnectionStatus, Meeting, MeetingParticipant,
  DocumentType, DocumentPage, DocumentDetail, DocumentFilters, DocumentVisibility, LinkedWork, LinkedDocuments, LinkTarget, LinkRelation,
  DocVersions, DocVersionContent, VersionDiff, DocAccess, DocAccessLevel, GrantPrincipal, DocFile, DocWorkflows, DocWorkflow, ApiOverview, EndpointPage, EndpointDetail, SaveEndpoint, SaveDefinition, ApiImportResult, ApiChanges, EndpointHit, SaveWorkflow, DocumentReview, DocumentInbox, DocumentGate, AccessRequest, Requirement, Coverage, DocActivity, DocAuditPage, SecretClass, WorkspaceLogo, GroupMappings, DocumentDashboard, SecretList, SecretReveal, StepUpToken, ChainStatus, DocSecurity,
} from './types';

export const authApi = {
  passwordPolicy: () => get<PasswordPolicy>('/auth/password-policy', undefined, { auth: false }),
  register: (b: { email: string; password: string; displayName: string; acceptedTerms: boolean }) => post<{ userId: string; requiresEmailVerification: boolean }>('/auth/register', b, { auth: false }),
  login: (b: { email: string; password: string }) => post<AuthResponse | MfaChallenge>('/auth/login', b, { auth: false }),
  loginMfa: (b: { challenge: string; code: string }) => post<AuthResponse>('/auth/login/mfa', b, { auth: false }),
  logout: () => post('/auth/logout', {}, { auth: true, retry: false }),
  logoutAll: () => post('/auth/logout-all'),
  verifyEmail: (token: string) => post('/auth/verify-email', { token }, { auth: false }),
  resendVerification: (email: string) => post('/auth/resend-verification', { email }, { auth: false }),
  forgotPassword: (email: string) => post('/auth/forgot-password', { email }, { auth: false }),
  resetPassword: (b: { token: string; password: string }) => post('/auth/reset-password', b, { auth: false }),
  /** Google / Microsoft / GitHub / Apple sign-in options this installation has set up. */
  providers: () => get<{ providers: ExternalProvider[] }>('/auth/providers', undefined, { auth: false }),
  /** Whether an email address signs in through its organization's single sign-on. */
  ssoDiscover: (email: string) => post<SsoDiscovery>('/auth/sso/discover', { email }, { auth: false }),
};

export const meApi = {
  context: () => get<AppContext>('/me'),
  fingerprint: () => get<{ fingerprint: string }>('/me/fingerprint'),
  updateProfile: (b: { displayName: string; timeZone?: string }) => put<User>('/me', b),
  changePassword: (b: { currentPassword: string; newPassword: string }) => post('/me/password', b),
  mfaStatus: () => get<MfaStatus>('/me/mfa'),
  mfaSetup: (password: string) => post<MfaSetup>('/me/mfa/setup', { password }),
  mfaEnable: (code: string) => post<{ codes: string[] }>('/me/mfa/enable', { code }),
  mfaDisable: (password: string, code: string) => post('/me/mfa/disable', { password, code }),
  mfaRecoveryCodes: (password: string, code: string) => post<{ codes: string[] }>('/me/mfa/recovery-codes', { password, code }),
  sessions: () => get<Session[]>('/me/sessions'),
  revokeSession: (id: string) => del(`/me/sessions/${id}`),
  notificationPrefs: () => get<NotificationPreference[]>('/me/notification-preferences'),
  setNotificationPrefs: (items: { type: string; inApp: boolean; email: boolean; browser: boolean }[]) => put<NotificationPreference[]>('/me/notification-preferences', { items }),
  testEmail: () => post<TestEmailResult>('/me/notification-preferences/test-email'),
  /** Outside accounts connected to mine. */
  logins: () => get<UserLogin[]>('/me/logins'),
  unlinkLogin: (id: string) => del(`/me/logins/${id}`),
  /** Starts connecting Google / Microsoft / GitHub / Apple: returns where to send the browser. */
  linkLogin: (provider: string) => post<{ url: string }>(`/auth/external/${provider}/link`),
  setAvatar: (file: File) => uploadFile<void>('/me/avatar', file),
  removeAvatar: () => del('/me/avatar'),
};

/** Workspace settings → Single sign-on (owners and admins of an organization). */
export const ssoApi = {
  get: () => get<SsoSettings>('/workspace/sso'),
  save: (b: SsoConnectionInput) => put<SsoSettings>('/workspace/sso/connection', b),
  check: () => post<{ ok: boolean; message: string; issuer: string | null }>('/workspace/sso/check'),
  addDomain: (domain: string) => post<SsoSettings>('/workspace/sso/domains', { domain }),
  verifyDomain: (id: string) => post<SsoSettings>(`/workspace/sso/domains/${id}/verify`),
  removeDomain: (id: string) => del<SsoSettings>(`/workspace/sso/domains/${id}`),
  createScimToken: (name: string) => post<{ token: ScimToken; secret: string }>('/workspace/sso/scim-tokens', { name }),
  revokeScimToken: (id: string) => del<SsoSettings>(`/workspace/sso/scim-tokens/${id}`),
  groupMappings: () => get<GroupMappings>('/workspace/sso/group-mappings'),
  addGroupMapping: (group: string, teamId: string) => post<GroupMappings>('/workspace/sso/group-mappings', { group, teamId }),
  removeGroupMapping: (id: string) => del<GroupMappings>(`/workspace/sso/group-mappings/${id}`),
};

export const workspaceApi = {
  list: () => get<Workspace[]>('/workspaces'),
  create: (b: { name: string; description?: string }) => post<Workspace>('/workspaces', b),
  switch: (id: string) => post<{ accessToken: string; expiresAt: string }>(`/workspaces/${id}/switch`),
  update: (b: { name: string; description?: string }) => put<Workspace>('/workspace', b),
  logo: () => get<WorkspaceLogo>('/workspace/logo'),
  uploadLogo: (file: File) => uploadFile<WorkspaceLogo>('/workspace/logo', file),
  removeLogo: () => del<WorkspaceLogo>('/workspace/logo'),
  members: () => get<Member[]>('/workspace/members'),
  setRole: (userId: string, role: string) => put<Member>(`/workspace/members/${userId}`, { role }),
  removeMember: (userId: string) => del(`/workspace/members/${userId}`),
  invitations: () => get<Invitation[]>('/workspace/invitations'),
  invite: (b: { email: string; role: string; orgRoleId?: string | null; reportsToUserId?: string | null }) => post<Invitation>('/workspace/invitations', b),
  /** Creates the account directly (instead of inviting): the first password is chosen by the administrator and must be replaced at first sign-in. */
  createMember: (b: { email: string; displayName: string; role: string; password: string; orgRoleId?: string | null; reportsToUserId?: string | null }) => post<Member>('/workspace/members', b),
  revokeInvitation: (id: string) => del(`/workspace/invitations/${id}`),
  permissions: () => get<PermissionMatrix>('/workspace/permissions'),
  setPermission: (b: { role: string; permission: string; allowed: boolean }) => put<PermissionMatrix>('/workspace/permissions', b),
  lookupInvitation: (token: string) => get<InvitationLookup>('/invitations/lookup', { token }, { auth: false }),
  acceptInvitation: (token: string) => post<Workspace>('/invitations/accept', { token }),
  security: () => get<OrgSecurity>('/workspace/security'),
  setSecurity: (b: { requireMfa: boolean; ipAllowlistEnabled: boolean; ipRanges: string[] }) => put<OrgSecurity>('/workspace/security', b),
  projectVisibility: () => get<ProjectVisibility>('/workspace/project-visibility'),
  setProjectVisibility: (mode: 'organization' | 'teams') => put<ProjectVisibility>('/workspace/project-visibility', { mode }),
  memberProfile: (userId: string) => get<MemberProfile>(`/workspace/members/${userId}/profile`),
  /** An authenticated object URL for a member's photo; caller must revoke it when done. */
  memberAvatarUrl: (userId: string, signal?: AbortSignal) => fetchBlobUrl(`/workspace/members/${userId}/avatar`, signal),
};

export const teamApi = {
  list: () => get<Team[]>('/teams'),
  get: (id: string) => get<TeamDetail>(`/teams/${id}`),
  create: (b: { name: string; description?: string; parentTeamId?: string | null }) => post<TeamDetail>('/teams', b),
  update: (id: string, b: { name: string; description?: string; parentTeamId?: string | null }) => put<TeamDetail>(`/teams/${id}`, b),
  remove: (id: string) => del(`/teams/${id}`),
  addMember: (id: string, b: { userId: string; isLead: boolean }) => post<TeamDetail>(`/teams/${id}/members`, b),
  removeMember: (id: string, userId: string) => del<TeamDetail>(`/teams/${id}/members/${userId}`),
};

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

export const sprintApi = {
  list: (projectId: string) => get<Sprint[]>(`/projects/${projectId}/sprints`),
  get: (projectId: string, id: string) => get<SprintDetail>(`/projects/${projectId}/sprints/${id}`),
  create: (projectId: string, b: { name: string; goal: string | null; startDate: string; endDate: string }) => post<Sprint>(`/projects/${projectId}/sprints`, b),
  update: (projectId: string, id: string, b: { name: string; goal: string | null; startDate: string; endDate: string }) => put<Sprint>(`/projects/${projectId}/sprints/${id}`, b),
  remove: (projectId: string, id: string) => del(`/projects/${projectId}/sprints/${id}`),
  start: (projectId: string, id: string) => post<Sprint>(`/projects/${projectId}/sprints/${id}/start`),
  complete: (projectId: string, id: string, moveUnfinishedTo: string | null) => post<Sprint>(`/projects/${projectId}/sprints/${id}/complete`, { moveUnfinishedTo }),
  addTasks: (projectId: string, id: string, taskIds: string[]) => post(`/projects/${projectId}/sprints/${id}/tasks`, { taskIds }),
  toBacklog: (projectId: string, taskIds: string[]) => post(`/projects/${projectId}/backlog`, { taskIds }),
  setForTask: (taskId: string, sprintId: string | null) => put(`/tasks/${taskId}/sprint`, { sprintId }),
};

export const exportApi = {
  list: () => get<ReportExport[]>('/reports/exports'),
  request: (b: { kind: ReportKind; format: ReportFormat; projectId?: string | null; targetUserId?: string | null; days?: number }) => post<ReportExport>('/reports/exports', b),
  remove: (id: string) => del(`/reports/exports/${id}`),
};

export const checklistApi = {
  get: (taskId: string) => get<Checklist>(`/tasks/${taskId}/checklist`),
  add: (taskId: string, title: string) => post<Checklist>(`/tasks/${taskId}/checklist`, { title }),
  update: (taskId: string, itemId: string, b: { title?: string; isDone?: boolean }) => put<Checklist>(`/tasks/${taskId}/checklist/${itemId}`, b),
  remove: (taskId: string, itemId: string) => del<Checklist>(`/tasks/${taskId}/checklist/${itemId}`),
  reorder: (taskId: string, itemIds: string[]) => put<Checklist>(`/tasks/${taskId}/checklist/order`, { itemIds }),
};

export const priorityApi = {
  get: () => get<PriorityInfo[]>('/priorities'),
  set: (items: { level: string; name: string; color: string }[]) => put<PriorityInfo[]>('/priorities', { items }),
  reset: () => del<PriorityInfo[]>('/priorities'),
};

export interface ImportOptions { skipInvalid: boolean; createMissingLabels: boolean; dateFormat: string }
export const importApi = {
  preview: (projectId: string, file: File, mapping: string | undefined, options: ImportOptions) =>
    uploadFile<ImportPreview>(`/projects/${projectId}/import/preview`, file, { ...(mapping ? { mapping } : {}), options: JSON.stringify(options) }),
  run: (projectId: string, file: File, mapping: string, options: ImportOptions) =>
    uploadFile<ImportResult>(`/projects/${projectId}/import`, file, { mapping, options: JSON.stringify(options) }),
};

export const customFieldApi = {
  list: () => get<CustomField[]>('/custom-fields'),
  create: (b: { name: string; type: string; options: string[] | null }) => post<CustomField>('/custom-fields', b),
  update: (id: string, b: { name: string; type: string; options: string[] | null }) => put<CustomField>(`/custom-fields/${id}`, b),
  remove: (id: string) => del(`/custom-fields/${id}`),
  reorder: (ids: string[]) => put<CustomField[]>('/custom-fields/order', { ids }),
  values: (taskId: string) => get<CustomFieldValue[]>(`/tasks/${taskId}/custom-fields`),
  setValues: (taskId: string, values: Record<string, string | null>) => put<CustomFieldValue[]>(`/tasks/${taskId}/custom-fields`, { values }),
};

export const apiKeyApi = {
  list: () => get<ApiKey[]>('/api-keys'),
  create: (b: { name: string; scope: string; expiresInDays: number | null }) => post<{ key: ApiKey; secret: string }>('/api-keys', b),
  revoke: (id: string) => del(`/api-keys/${id}`),
};

export const webhookApi = {
  list: () => get<Webhook[]>('/webhooks'),
  events: () => get<string[]>('/webhooks/events'),
  create: (b: { name: string; url: string; events: string[]; format?: WebhookFormat }) => post<{ webhook: Webhook; secret: string }>('/webhooks', b),
  update: (id: string, b: { name: string; url: string; events: string[]; isActive: boolean; format?: WebhookFormat }) => put<Webhook>(`/webhooks/${id}`, b),
  rotate: (id: string) => post<{ webhook: Webhook; secret: string }>(`/webhooks/${id}/rotate-secret`),
  remove: (id: string) => del(`/webhooks/${id}`),
  deliveries: (id: string) => get<WebhookDelivery[]>(`/webhooks/${id}/deliveries`),
  test: (id: string) => post(`/webhooks/${id}/test`),
  retry: (id: string, deliveryId: string) => post(`/webhooks/${id}/deliveries/${deliveryId}/retry`),
};

export interface WorkItemFilters { kinds?: WorkItemKind[]; open?: boolean; projectId?: string; dueFrom?: string; dueTo?: string; overdue?: boolean; q?: string; limit?: number }
/** Work of every kind in one shape: My work and the workload views. */
export const workItemApi = {
  /** Everything assigned to me: project tasks, issues, action items and operational work. */
  mine: (f: WorkItemFilters = {}) => get<WorkItem[]>('/my-work', { ...f, kinds: f.kinds?.length ? f.kinds.join(',') : undefined }),
  /** Open work per person: my reporting line, the whole workspace (with broad reports access) or just me. */
  /** Every open action item of the projects I can see (the Portfolio's view); follows the team being looked at. */
  actionItems: (open = true) => get<WorkItem[]>('/action-items', { open }),
  workload: (scope?: WorkloadScope) => get<Workload>('/workload', { scope }),
  person: (userId: string, scope?: WorkloadScope) => get<WorkloadPersonDetail>(`/workload/${userId}`, { scope }),
};

export const platformApi = {
  billing: () => get<PlatformBilling>('/admin/billing'),
  usage: (p: { q?: string; sort?: string; warningsOnly?: boolean; page?: number }) => get<Paged<AdminUsage>>('/admin/usage', { pageSize: 25, ...p }),
  health: () => get<SystemHealth>('/admin/health'),
  goLive: () => get<GoLive>('/admin/go-live'),
  testEmail: () => post<AdminTestEmailResult>('/admin/test-email'),
  billingSettings: () => get<BillingSettings>('/admin/billing-settings'),
  setBillingSettings: (b: { currency: string }) => put<BillingSettings>('/admin/billing-settings', b),
  settings: () => get<PlatformSettings>('/admin/settings'),
  setSettings: (b: PlatformSettings) => put<PlatformSettings>('/admin/settings', b),
  passwordPolicy: () => get<PasswordPolicy>('/admin/password-policy'),
  setPasswordPolicy: (b: PasswordPolicy) => put<PasswordPolicy>('/admin/password-policy', b),
  consentDocuments: () => get<ConsentDocument[]>('/admin/consent'),
  publishConsentDocument: (b: { type: string; title: string; body: string }) => put<ConsentDocument>('/admin/consent', b),
  overrides: (tenantId: string) => get<FeatureOverride[]>(`/admin/tenants/${tenantId}/overrides`),
  setOverride: (tenantId: string, key: string, b: { value: number; reason: string; expiresInDays: number | null }) => put<FeatureOverride[]>(`/admin/tenants/${tenantId}/overrides/${key}`, b),
  removeOverride: (tenantId: string, key: string) => del<FeatureOverride[]>(`/admin/tenants/${tenantId}/overrides/${key}`),
  status: () => get<PlatformStatus>('/platform/status', undefined, { auth: false }),
};

export const chatApi = {
  people: () => get<ChatPerson[]>('/chat/people'),
  unread: () => get<{ count: number }>('/chat/unread'),
  search: (q: string) => get<ChatSearchHit[]>('/chat/search', { q }),
  conversations: () => get<Conversation[]>('/chat/conversations'),
  conversation: (id: string) => get<Conversation>(`/chat/conversations/${id}`),
  /** The team chat of a project (created on first use). Only the project's team, its owner and Owners, Admins and Managers get in. */
  openProject: (projectId: string) => post<Conversation>(`/chat/projects/${projectId}/open`),
  projectUnread: () => get<ProjectChatUnread[]>('/chat/projects/unread'),
  openDirect: (userId: string) => post<Conversation>('/chat/conversations/direct', { userId }),
  createGroup: (name: string, memberIds: string[]) => post<Conversation>('/chat/conversations/group', { name, memberIds }),
  rename: (id: string, name: string) => put<Conversation>(`/chat/conversations/${id}`, { name }),
  addMembers: (id: string, userIds: string[]) => post<Conversation>(`/chat/conversations/${id}/members`, { userIds }),
  removeMember: (id: string, userId: string) => del(`/chat/conversations/${id}/members/${userId}`),
  messages: (id: string, before?: string) => get<ChatThread>(`/chat/conversations/${id}/messages`, { before, limit: 40 }),
  /** Every file ever sent in the conversation, newest first - the Files view next to the thread. */
  files: (id: string, before?: string) => get<ChatFilePage>(`/chat/conversations/${id}/files`, { before, limit: 40 }),
  send: (id: string, body: string, replyToId?: string | null, attachmentIds?: string[]) =>
    post<ChatMessage>(`/chat/conversations/${id}/messages`, { body, replyToId: replyToId ?? null, attachmentIds: attachmentIds ?? [] }),
  /** Stores a file for a message about to be sent (the plan decides whether, how big and how much). */
  uploadFile: (id: string, file: File) => uploadFile<ChatAttachment>(`/chat/conversations/${id}/files`, file),
  removeFile: (fileId: string) => del(`/chat/files/${fileId}`),
  /** A file as an object URL, fetched with the signed-in person's access (pictures inline). */
  fileUrl: (fileId: string, inline = false) => fetchBlobUrl(`/chat/files/${fileId}${inline ? '?inline=true' : ''}`),
  react: (messageId: string, emoji: string) => put<ChatMessage>(`/chat/messages/${messageId}/reaction`, { emoji }),
  unreact: (messageId: string, emoji: string) => del<ChatMessage>(`/chat/messages/${messageId}/reaction?emoji=${encodeURIComponent(emoji)}`),
  edit: (messageId: string, body: string) => put<ChatMessage>(`/chat/messages/${messageId}`, { body }),
  deleteMessage: (messageId: string) => del(`/chat/messages/${messageId}`),
  markRead: (id: string) => post(`/chat/conversations/${id}/read`),
  mute: (id: string, muted: boolean) => put(`/chat/conversations/${id}/mute`, { muted }),
};

export const consentApi = {
  documents: () => get<ConsentDocument[]>('/consent/documents', undefined, { auth: false }),
  status: () => get<MyConsent>('/consent/status'),
  accept: (types: string[]) => post<MyConsent>('/consent/accept', { types }),
};

// ---- push notifications on this person's devices
export const pushApi = {
  status: () => get<{ publicKey: string; devices: number }>('/push'),
  subscribe: (b: { endpoint: string; keys: { p256dh: string; auth: string } }) => post<{ publicKey: string; devices: number }>('/push/subscriptions', b),
  subscribeNative: (token: string) => post<{ publicKey: string; devices: number; nativeEnabled: boolean }>('/push/native', { token }),
  unsubscribe: (endpoint: string) => post<{ publicKey: string; devices: number }>('/push/unsubscribe', { endpoint }),
  signInStatus: (endpoint?: string | null) => get<SignInDevice>('/push/sign-in', { endpoint: endpoint ?? undefined }),
  setSignIn: (endpoint: string, enabled: boolean) => put<SignInDevice>('/push/sign-in', { endpoint, enabled }),
};

// ---- signing in on a computer by approving on a phone
export const deviceLoginApi = {
  start: (email: string) => post<DeviceLoginStart>('/auth/device-login', { email }, { auth: false }),
  poll: (id: string, secret: string) => post<{ status: 'pending' | 'approved' | 'denied' | 'expired'; auth?: AuthResponse }>(`/auth/device-login/${id}/poll`, { secret }, { auth: false }),
  pending: () => get<DeviceLoginPending[]>('/me/device-login/pending'),
  get: (id: string) => get<DeviceLoginPending | null>(`/me/device-login/${id}`),
  approve: (id: string, number: number) => post<void>(`/me/device-login/${id}/approve`, { number }),
  deny: (id: string) => post<void>(`/me/device-login/${id}/deny`),
};

// ---- integrations and compliance
export const integrationsApi = {
  calendarFeed: () => get<CalendarFeed>('/calendar/feed'),
  resetCalendarFeed: () => post<CalendarFeed>('/calendar/feed'),
  removeCalendarFeed: () => del('/calendar/feed'),
  mailbox: () => get<InboundMailbox>('/integrations/inbound-email'),
  saveMailbox: (b: { enabled: boolean; workTypeId: string | null; priority: Priority }) => put<InboundMailbox>('/integrations/inbound-email', b),
  resetMailbox: () => post<InboundMailbox>('/integrations/inbound-email/reset'),
  git: () => get<GitConnection[]>('/integrations/git'),
  createGit: (b: { provider: GitProvider; name: string; closeOnKeyword: boolean }) => post<{ connection: GitConnection; secret: string }>('/integrations/git', b),
  updateGit: (id: string, b: { provider: GitProvider; name: string; closeOnKeyword: boolean }) => put<GitConnection>(`/integrations/git/${id}`, b),
  removeGit: (id: string) => del(`/integrations/git/${id}`),
  taskLinks: (taskId: string) => get<DevLink[]>(`/tasks/${taskId}/dev-links`),
  workTaskLinks: (workTaskId: string) => get<DevLink[]>(`/work-tasks/${workTaskId}/dev-links`),
  dataPolicy: () => get<DataPolicy>('/workspace/data-policy'),
  saveDataPolicy: (b: { activityRetentionDays: number | null; notificationRetentionDays: number | null; chatRetentionDays: number | null; auditRetentionDays: number | null }) => put<DataPolicy>('/workspace/data-policy', b),
  /** Google Workspace: one Calendar/Meet grant per person (never a shared workspace credential - see GoogleCalendarAuthService). */
  googleStatus: () => get<GoogleConnectionStatus>('/integrations/google/status'),
  /** Returns Google's consent screen address; the caller navigates the whole page there itself (window.location.assign) - this call cannot
   * redirect there itself because only an ordinary authenticated fetch, not a bare page navigation, can carry the Authorization header. */
  googleConnectUrl: (returnUrl?: string) => get<{ url: string }>('/integrations/google/connect', returnUrl ? { returnUrl } : undefined),
  googleDisconnect: () => del('/integrations/google/disconnect'),
};

export const meetingApi = {
  list: (projectId: string) => get<Meeting[]>(`/projects/${projectId}/meetings`),
  participants: (projectId: string) => get<MeetingParticipant[]>(`/projects/${projectId}/meetings/participants`),
  start: (projectId: string, b: { title?: string; participantUserIds?: string[] }) => post<Meeting>(`/projects/${projectId}/meetings/start`, b),
  schedule: (projectId: string, b: { title: string; description?: string; startTime: string; endTime: string; timeZone: string; participantUserIds?: string[] }) =>
    post<Meeting>(`/projects/${projectId}/meetings/schedule`, b),
  get: (id: string) => get<Meeting>(`/meetings/${id}`),
  cancel: (id: string) => post(`/meetings/${id}/cancel`, {}),
};

// ---- capacity and cost
export const resourcesApi = {
  rates: () => get<Rates>('/resources/rates'),
  setRates: (userId: string, b: { weeklyCapacityHours: number | null; costRate: number | null; billRate: number | null }) => put<Rates>(`/resources/rates/${userId}`, b),
  setCurrency: (currency: string) => put<Rates>('/resources/currency', { currency }),
  utilisation: (p: { from?: string; to?: string; scope?: WorkloadScope }) => get<Utilisation>('/resources/utilisation', p),
  project: (projectId: string) => get<ProjectFinancials>(`/resources/projects/${projectId}`),
  setBudget: (projectId: string, b: { isBillable: boolean; budgetHours: number | null; budgetAmount: number | null; billRate: number | null }) => put<ProjectFinancials>(`/resources/projects/${projectId}/budget`, b),
};

// ---- Work management
export interface WorkFilters {
  q?: string; workTypeId?: string; relatedProjectId?: string; noProject?: boolean; assigneeId?: string; mine?: boolean; priority?: string; status?: string; open?: boolean;
  dueFrom?: string; dueTo?: string; overdue?: boolean; sort?: string; page?: number; pageSize?: number;
  /** Service levels: 'breached' (a target already missed), 'atRisk' or 'tracked'. */
  sla?: string;
}
export const workApi = {
  types: (includeInactive = false) => get<WorkType[]>('/work-types', includeInactive ? { includeInactive: true } : undefined),
  createType: (b: { name: string; description?: string | null }) => post<WorkType>('/work-types', b),
  updateType: (id: string, b: { name: string; description?: string | null; isActive?: boolean }) => put<WorkType>(`/work-types/${id}`, b),
  reorderTypes: (ids: string[]) => put<void>('/work-types/order', { ids }),
  removeType: (id: string) => del<void>(`/work-types/${id}`),
  sla: () => get<SlaSettings>('/work/sla'),
  saveSla: (workTypeId: string | null, targets: SlaTarget[]) => put<SlaSettings>('/work/sla', { workTypeId, targets }),
  clearSla: (workTypeId: string) => del<SlaSettings>(`/work/sla/${workTypeId}`),

  list: (f: WorkFilters = {}) => get<Paged<WorkTask>>('/work-tasks', { pageSize: 25, ...f }),
  get: (id: string) => get<WorkTask>(`/work-tasks/${id}`),
  create: (b: WorkTaskInput) => post<WorkTask>('/work-tasks', b),
  update: (id: string, b: WorkTaskInput & { status: string; priority: string; version: number }) => put<WorkTask>(`/work-tasks/${id}`, b),
  setStatus: (id: string, status: string) => put<WorkTask>(`/work-tasks/${id}/status`, { status }),
  remove: (id: string) => del<void>(`/work-tasks/${id}`),
  summary: (from?: string, to?: string) => get<WorkSummary>('/work-tasks/summary', { from, to }),
  /** The filtered list as a CSV file (every filter but the page). */
  exportCsv: (f: WorkFilters) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...f, page: undefined, pageSize: undefined })) if (v !== undefined && v !== '' && v !== false) q.set(k, String(v));
    return download(`/work-tasks/export?${q}`, 'work-tasks.csv');
  },

  comments: (id: string) => get<WorkComment[]>(`/work-tasks/${id}/comments`),
  addComment: (id: string, body: string, mentionUserIds?: string[]) => post<WorkComment>(`/work-tasks/${id}/comments`, { body, mentionUserIds: mentionUserIds ?? null }),
  updateComment: (id: string, commentId: string, body: string) => put<WorkComment>(`/work-tasks/${id}/comments/${commentId}`, { body }),
  deleteComment: (id: string, commentId: string) => del<void>(`/work-tasks/${id}/comments/${commentId}`),
  history: (id: string) => get<WorkActivity[]>(`/work-tasks/${id}/history`),
  files: (id: string) => get<WorkAttachment[]>(`/work-tasks/${id}/attachments`),
  upload: (id: string, file: File) => uploadFile<WorkAttachment>(`/work-tasks/${id}/attachments`, file),
  download: (fileId: string, fileName: string) => download(`/work-attachments/${fileId}/download`, fileName),
  removeFile: (fileId: string) => del<void>(`/work-attachments/${fileId}`),
};

// ---- passkeys: sign in with the device's own fingerprint, face or screen lock
export const passkeyApi = {
  list: () => get<Passkey[]>('/me/passkeys'),
  registerOptions: () => post<PasskeyChallenge>('/me/passkeys/options', {}),
  add: (challengeId: string, response: Record<string, unknown>, name: string) => post<Passkey>('/me/passkeys', { challengeId, response, name }),
  rename: (id: string, name: string) => put<void>(`/me/passkeys/${id}`, { name }),
  remove: (id: string) => del(`/me/passkeys/${id}`),
  signInOptions: (email: string) => post<PasskeyChallenge>('/auth/passkey/options', { email }, { auth: false }),
  signIn: (challengeId: string, response: Record<string, unknown>) => post<AuthResponse>('/auth/passkey/verify', { challengeId, response }, { auth: false }),
};

export const invoiceSellerApi = {
  get: () => get<InvoiceSeller>('/admin/invoice-seller'),
  set: (b: InvoiceSeller) => put<InvoiceSeller>('/admin/invoice-seller', b),
};
export const emailAdminApi = {
  overview: (status?: string) => get<EmailOverview>('/admin/email', { status }),
  blocked: () => get<EmailBlocked[]>('/admin/email/suppressions'),
  unblock: (id: string) => del(`/admin/email/suppressions/${id}`),
  domain: (domain?: string) => get<EmailDomainCheck>('/admin/email/domain-check', { domain }),
};
export const unsubscribeApi = {
  info: (token: string) => get<UnsubscribeInfo>('/email/unsubscribe', { token }, { auth: false }),
  confirm: (token: string) => post<UnsubscribeInfo>(`/email/unsubscribe?token=${encodeURIComponent(token)}`, {}, { auth: false }),
};

export const documentApi = {
  types: () => get<DocumentType[]>('/document-types'),
  list: (f: DocumentFilters = {}) => get<DocumentPage>('/documents', { ...f }),
  get: (id: string) => get<DocumentDetail>(`/documents/${id}`),
  create: (b: { title: string; typeId: string; projectId?: string | null; teamId?: string | null; visibility?: DocumentVisibility; tags?: string[]; sections?: { key: string; content: string }[] }) => post<DocumentDetail>('/documents', b),
  update: (id: string, b: { title: string; visibility: DocumentVisibility; tags: string[]; ownerId?: string | null; revision: number; teamId?: string | null }) => put<DocumentDetail>(`/documents/${id}`, b),
  saveSections: (id: string, b: { revision: number; sections: { key: string; content: string }[] }) => put<DocumentDetail>(`/documents/${id}/sections`, b),
  archive: (id: string) => post<DocumentDetail>(`/documents/${id}/archive`),
  reopen: (id: string) => post<DocumentDetail>(`/documents/${id}/reopen`),
  restore: (id: string) => post<DocumentDetail>(`/documents/${id}/restore`),
  remove: (id: string) => del(`/documents/${id}`),
  links: (id: string) => get<LinkedWork>(`/documents/${id}/links`),
  addLink: (id: string, b: { targetType: LinkTarget; targetId: string; relation: LinkRelation; requirementId?: string | null }) => post<LinkedWork>(`/documents/${id}/links`, b),
  removeLink: (id: string, linkId: string) => del(`/documents/${id}/links/${linkId}`),
  linkedTo: (targetType: LinkTarget, targetId: string) => get<LinkedDocuments>('/linked-documents', { targetType, targetId }),
  versions: (id: string) => get<DocVersions>(`/documents/${id}/versions`),
  version: (id: string, versionId: string) => get<DocVersionContent>(`/documents/${id}/versions/${versionId}`),
  compare: (id: string, from: string, to: string) => get<VersionDiff>(`/documents/${id}/compare`, { from, to }),
  publish: (id: string, b: { changeSummary: string; changeReason?: string; major: boolean; revision: number }) => post<DocVersions>(`/documents/${id}/publish`, b),
  restoreVersion: (id: string, versionId: string, b: { reason?: string; discardChanges: boolean; revision: number }) => post<DocVersions>(`/documents/${id}/versions/${versionId}/restore`, b),
  access: (id: string) => get<DocAccess>(`/documents/${id}/access`),
  grant: (id: string, b: { principalType: GrantPrincipal; principalId: string; level: DocAccessLevel; deny?: boolean; expiresAt?: string | null; note?: string }) => post<DocAccess>(`/documents/${id}/grants`, b),
  removeGrant: (id: string, grantId: string) => del<DocAccess>(`/documents/${id}/grants/${grantId}`),
  files: (id: string) => get<DocFile[]>(`/documents/${id}/files`),
  uploadFile: (id: string, file: File) => uploadFile<DocFile>(`/documents/${id}/files`, file),
  removeFile: (id: string, fileId: string) => del(`/documents/${id}/files/${fileId}`),
  // review and workflow
  workflows: () => get<DocWorkflows>('/document-workflows'),
  createWorkflow: (b: SaveWorkflow) => post<DocWorkflow>('/document-workflows', b),
  updateWorkflow: (id: string, b: SaveWorkflow) => put<DocWorkflow>(`/document-workflows/${id}`, b),
  removeWorkflow: (id: string) => del(`/document-workflows/${id}`),
  review: (id: string) => get<DocumentReview>(`/documents/${id}/review`),
  submit: (id: string, b: { changeSummary: string; changeReason?: string; major: boolean; revision: number }) => post<DocumentReview>(`/documents/${id}/submit`, b),
  approve: (id: string, comment?: string) => post<DocumentReview>(`/documents/${id}/approve`, { comment }),
  requestChanges: (id: string, comment: string) => post<DocumentReview>(`/documents/${id}/request-changes`, { comment }),
  withdraw: (id: string, comment?: string) => post<DocumentReview>(`/documents/${id}/withdraw`, { comment }),
  inbox: () => get<DocumentInbox>('/documents/inbox'),
  // asking for access
  gate: (id: string) => get<DocumentGate>(`/documents/${id}/gate`),
  requestAccess: (id: string, b: { level: DocAccessLevel; reason: string; durationDays: number | null }) => post<AccessRequest>(`/documents/${id}/access-requests`, b),
  accessRequests: (id: string) => get<AccessRequest[]>(`/documents/${id}/access-requests`),
  decideAccess: (requestId: string, b: { approve: boolean; level?: DocAccessLevel; durationDays?: number | null; note?: string }) => post<AccessRequest>(`/access-requests/${requestId}/decide`, b),
  cancelAccess: (requestId: string) => post<AccessRequest>(`/access-requests/${requestId}/cancel`),
  // diagrams, PDF and overview
  renderDiagram: (source: string) => post<{ svg: string; width: number; height: number; nodes: number; edges: number }>('/documents/diagrams/render', { source }),
  exportPdf: (id: string, versionId?: string | null) => post<ReportExport>(`/documents/${id}/export`, { versionId: versionId ?? null }),
  exportStatus: (id: string, exportId: string) => get<ReportExport>(`/documents/${id}/exports/${exportId}`),
  dashboard: () => get<DocumentDashboard>('/documents/dashboard'),
  // sensitive values
  secrets: (id: string) => get<SecretList>(`/documents/${id}/secrets`),
  saveSecret: (id: string, secretId: string | null, b: { label: string; value?: string; note?: string; class: SecretClass }) => secretId ? put<SecretList>(`/documents/${id}/secrets/${secretId}`, b) : post<SecretList>(`/documents/${id}/secrets`, b),
  removeSecret: (id: string, secretId: string) => del<SecretList>(`/documents/${id}/secrets/${secretId}`),
  reveal: (id: string, secretId: string, stepUp?: string) => post<SecretReveal>(`/documents/${id}/secrets/${secretId}/reveal`, { stepUp }),
  stepUp: (code: string) => post<StepUpToken>('/documents/step-up', { code }),
  security: () => get<DocSecurity>('/document-security'),
  setRevealSeconds: (seconds: number) => put<DocSecurity>('/document-security/reveal-duration', { seconds }),
  rotateKey: () => post<DocSecurity>('/document-security/rotate-key'),
  verifyAudit: () => post<ChainStatus>('/document-security/verify-audit'),
  // requirements and coverage
  requirements: (id: string) => get<Requirement[]>(`/documents/${id}/requirements`),
  addRequirements: (id: string, titles: string[]) => post<Requirement[]>(`/documents/${id}/requirements`, { titles }),
  updateRequirement: (id: string, rid: string, b: { title: string; detail?: string | null; priority?: Priority }) => put<Requirement[]>(`/documents/${id}/requirements/${rid}`, b),
  removeRequirement: (id: string, rid: string) => del<Requirement[]>(`/documents/${id}/requirements/${rid}`),
  coverage: (id: string) => get<Coverage>(`/documents/${id}/coverage`),
  // activity and audit
  activity: (id: string) => get<DocActivity[]>(`/documents/${id}/activity`),
  audit: (id: string, cursor?: string, action?: string) => get<DocAuditPage>(`/documents/${id}/audit`, { cursor, action }),
  exportAudit: (id: string) => download(`/documents/${id}/audit/export`, `document-audit.csv`),
};

export const apiDocApi = {
  overview: (id: string, versionId?: string | null) => get<ApiOverview>(`/documents/${id}/api`, { versionId: versionId ?? undefined }),
  addDefinition: (id: string, b: SaveDefinition) => post<ApiOverview>(`/documents/${id}/api/definitions`, b),
  updateDefinition: (id: string, defId: string, b: SaveDefinition) => put<ApiOverview>(`/documents/${id}/api/definitions/${defId}`, b),
  removeDefinition: (id: string, defId: string) => del<ApiOverview>(`/documents/${id}/api/definitions/${defId}`),
  endpoints: (id: string, f: { definitionId?: string; q?: string; method?: string; tag?: string; versionId?: string | null; cursor?: string; limit?: number }) => get<EndpointPage>(`/documents/${id}/api/endpoints`, { ...f, versionId: f.versionId ?? undefined }),
  endpoint: (id: string, endpointId: string, versionId?: string | null) => get<EndpointDetail>(`/documents/${id}/api/endpoints/${endpointId}`, { versionId: versionId ?? undefined }),
  addEndpoint: (id: string, b: SaveEndpoint) => post<EndpointDetail>(`/documents/${id}/api/endpoints`, b),
  updateEndpoint: (id: string, endpointId: string, b: SaveEndpoint) => put<EndpointDetail>(`/documents/${id}/api/endpoints/${endpointId}`, b),
  removeEndpoint: (id: string, endpointId: string) => del(`/documents/${id}/api/endpoints/${endpointId}`),
  import: (id: string, b: { content: string; fileName: string; definitionId?: string | null; newDefinitionName?: string | null; mode: 'merge' | 'replace'; dryRun: boolean }) => post<ApiImportResult>(`/documents/${id}/api/import`, b),
  export: (id: string, format: 'openapi' | 'postman', definitionId: string, versionId: string | null, fileName: string) =>
    download(`/documents/${id}/api/export?format=${format}&definitionId=${definitionId}${versionId ? `&versionId=${versionId}` : ''}`, fileName),
  changes: (id: string, from: string, to: string) => get<ApiChanges>(`/documents/${id}/api/changes`, { from, to }),
  search: (q: string, projectId?: string) => get<EndpointHit[]>('/api-search', { q, projectId }),
};
