// Mirrors the API contracts in ProjectManagement.Application (camelCase, enums as strings).

export type Role = 'Guest' | 'Member' | 'Manager' | 'Admin' | 'Owner';
export type WorkspaceType = 'Personal' | 'Organization';
export type ProjectStatus = 'Planning' | 'Active' | 'OnHold' | 'Completed' | 'Cancelled' | 'Archived';
export type Priority = 'Low' | 'Medium' | 'High' | 'Critical';
export type StatusCategory = 'Todo' | 'Active' | 'Done' | 'Cancelled';
export type StageStatus = 'Pending' | 'InProgress' | 'Completed' | 'Delayed';
export type ProjectHealth = 'OnTrack' | 'AtRisk' | 'Delayed' | 'Completed' | 'Cancelled' | 'Archived';
export type SubscriptionStatus = 'Trial' | 'Active' | 'PastDue' | 'Cancelled' | 'Expired';
export type NotificationType = 'TaskAssigned' | 'Mention' | 'Comment' | 'DueSoon' | 'Overdue' | 'Invitation' | 'Subscription' | 'Security' | 'ReportReady' | 'Issue';

export interface ApiErrorItem { code: string; message: string; field?: string | null }
export interface Paged<T> { items: T[]; page: number; pageSize: number; totalItems: number; totalPages: number }

export interface User { id: string; email: string; displayName: string; emailVerified: boolean; isPlatformAdmin: boolean; timeZone: string; mfaEnabled?: boolean;
  /** An administrator created this account: the first password is temporary and has to be replaced before anything else works. */
  mustChangePassword?: boolean }
export interface AuthResponse { accessToken: string; expiresAt: string; user: User; refreshToken: string | null }
export interface MfaChallenge { mfaRequired: true; challenge: string }
export interface MfaStatus { enabled: boolean; enabledAt: string | null; recoveryCodesLeft: number }
export interface MfaSetup { secret: string; otpAuthUri: string }
export interface Session { id: string; createdAt: string; lastSeenAt: string; ipAddress: string | null; userAgent: string | null; isCurrent: boolean }

export interface Workspace { id: string; name: string; slug: string; type: WorkspaceType; role: Role; description: string | null; planCode: string; memberCount: number }
export interface PlanSummary { code: string; name: string; status: SubscriptionStatus; trialEnd: string | null; periodEnd: string | null; cancelAtPeriodEnd: boolean; downgraded: boolean }
export interface CurrentWorkspace {
  id: string; name: string; slug: string; type: WorkspaceType; role: Role; description: string | null;
  permissions: string[]; plan: PlanSummary; entitlements: Record<string, number>;
  /** Level per module for the signed-in user: 0 none, 1 view, 2 edit, 3 full. */
  modules: Record<string, number>;
  reportCount?: number;
}
export interface AccessBlocked { workspaceId: string; code: string; message: string }
export interface ConsentDocument { type: string; version: number; title: string; body: string; publishedAt: string | null }
export interface AppContext {
  user: User; workspaces: Workspace[]; current: CurrentWorkspace | null; fingerprint: string;
  blocked?: AccessBlocked | null; pendingConsent?: ConsentDocument[] | null;
}

// ---- single sign-on, SCIM and outside sign-in
export interface ExternalProvider { id: 'google' | 'microsoft' | 'github' | 'apple'; name: string }
export interface SsoDiscovery { sso: boolean; name: string | null; enforced: boolean }
export interface UserLogin { id: string; provider: string; name: string; email: string | null; createdAt: string; lastUsedAt: string | null }
export type SsoProtocol = 'Oidc' | 'Saml';
export interface SsoConnection {
  protocol: SsoProtocol; name: string; enabled: boolean; enforceForDomains: boolean; autoProvision: boolean; defaultRole: Role;
  authority: string | null; clientId: string | null; hasClientSecret: boolean; samlEntityId: string | null; samlSsoUrl: string | null; hasSamlCertificate: boolean;
  certificateSubject: string | null; certificateExpiresAt: string | null; lastUsedAt: string | null;
}
export interface SsoDomain { id: string; domain: string; txtName: string; txtValue: string; verified: boolean; verifiedAt: string | null; lastCheckedAt: string | null }
export interface ScimToken { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; revoked: boolean }
export interface SsoSettings {
  entitled: boolean; canManage: boolean; connection: SsoConnection | null; domains: SsoDomain[]; scimTokens: ScimToken[];
  serviceProvider: { oidcRedirectUri: string; samlEntityId: string; samlAcsUrl: string; samlMetadataUrl: string; scimBaseUrl: string };
}
export interface SsoConnectionInput {
  protocol: SsoProtocol; name: string; enabled: boolean; enforceForDomains: boolean; autoProvision: boolean; defaultRole: Role;
  authority?: string | null; clientId?: string | null; clientSecret?: string | null; samlEntityId?: string | null; samlSsoUrl?: string | null; samlCertificate?: string | null;
}

export interface OrgSecurity { requireMfa: boolean; ipAllowlistEnabled: boolean; ipRanges: string[]; myIp: string | null; entitled: boolean }
export interface MyConsent { upToDate: boolean; pending: ConsentDocument[] }

export interface Member { userId: string; displayName: string; email: string; role: Role; joinedAt: string; jobRole: string | null }
export interface Invitation { id: string; email: string; role: Role; status: string; expiresAt: string; createdAt: string; invitedBy: string | null; jobRole: string | null; reportsTo: string | null }
export interface InvitationLookup { workspaceName: string; email: string; role: Role; invitedBy: string | null; expired: boolean; accepted: boolean; jobRole: string | null }
export interface PermissionMatrix {
  roles: Role[]; permissions: string[]; locked: string[]; matrix: Record<string, Record<string, boolean>>; canEdit: boolean;
  /** People this matrix does not decide for: their job role has its own access settings ("Name (Job role)"). */
  notAppliedTo?: string[] | null;
}
/** Where a person's access comes from: Owner and Admin have everything; JobRole means their job role's access settings decide; AccessLevel means the defaults of their access level do. */
export type AccessSource = 'Owner' | 'Admin' | 'JobRole' | 'AccessLevel';
export interface EffectiveAccess { userId: string; name: string; email: string; accessLevel: Role; jobRole: string | null; source: AccessSource; modules: Record<string, number>; permissions: string[] }
export interface EffectiveAccessList { people: EffectiveAccess[]; byJobRole: number; byAccessLevel: number }

export interface UserRef { id: string; name: string }
export interface Team { id: string; name: string; description: string | null; memberCount: number; projectCount: number; lead: UserRef | null }
export interface TeamMember { userId: string; name: string; email: string; isLead: boolean; openTasks: number }
export interface TeamDetail { team: Team; members: TeamMember[] }

/** What a project is for; chosen when it is created. */
export type ProjectType = 'NewProject' | 'ChangeRequest' | 'Enhancement' | 'Migration' | 'Integration' | 'Upgrade' | 'Maintenance' | 'Compliance' | 'Other';
/** How a project is planned: Phased (stages and milestones), Agile (sprints and a backlog) or Hybrid (both). It decides which planning views the project shows. */
export type DeliveryMethod = 'Hybrid' | 'Phased' | 'Agile';
export interface ProjectStats { total: number; done: number; inProgress: number; todo: number; cancelled: number; overdue: number }
export interface Project {
  id: string; key: string; name: string; description: string | null; status: ProjectStatus; priority: Priority;
  owner: UserRef | null; teamId: string | null; teamName: string | null; startDate: string | null; dueDate: string | null;
  progress: number; health: ProjectHealth; stats: ProjectStats; memberCount: number; version: number; position: number; enforceDependencies: boolean;
  projectGroupId: string | null; projectGroupName: string | null; projectType: ProjectType; deliveryMethod: DeliveryMethod;
}
/** A follow-up for a project, with an owner, a due date and a priority (on the project's Actions tab and the Portfolio page). */
export type ActionItemStatus = 'Open' | 'InProgress' | 'Completed';
export interface ActionItem {
  id: string; projectId: string; key: string; number: number; title: string; details: string | null; assignee: UserRef | null; dueDate: string | null; priority: Priority; status: ActionItemStatus;
  isOverdue: boolean; createdAt: string; createdBy: UserRef | null; completedAt: string | null; completedBy: UserRef | null;
  can: { edit: boolean; delete: boolean; complete: boolean };
}
export interface ActionItemInput { title: string; details?: string | null; assigneeId?: string | null; dueDate?: string | null; priority?: string }
/** One of the workspace's project groups; every project belongs to one. */
export interface ProjectGroup { id: string; name: string; description: string | null; order: number; isActive: boolean; projectCount: number; activeProjectCount: number }

// ---- the Project Status page
export interface StatusProjectRef { id: string; key: string; name: string; status: ProjectStatus; health: ProjectHealth; progress: number }
export interface StatusGroup { id: string; name: string; isActive: boolean; count: number; projects: StatusProjectRef[] }
export interface StatusBlocker { key: string; title: string; statusName: string }
export interface StatusTask {
  id: string; key: string; title: string; parentTaskId: string | null; startDate: string | null; dueDate: string | null; originalDueDate: string | null; delayedDays: number;
  statusName: string; statusCategory: StatusCategory; statusColor: string; assignee: UserRef | null; overdueDays: number; revisions: number; blockedBy: StatusBlocker[];
}
/** A change of a delivery date: the project's own or a task's, with who / when / from / to / why. */
export interface TimelineChange {
  id: string; scope: 'Project' | 'Task'; taskId: string | null; taskKey: string | null; title: string; previous: string | null; revised: string | null; daysShifted: number | null;
  reason: string | null; dependency: string | null; changedBy: UserRef | null; changedAt: string; currentStatus: string; currentCategory: StatusCategory | null;
}
export interface StatusProject {
  id: string; key: string; name: string; description: string | null; groupName: string | null; startDate: string | null; dueDate: string | null; originalDueDate: string | null;
  delayedDays: number; status: ProjectStatus; health: ProjectHealth; progress: number; owner: UserRef | null; stats: ProjectStats; projectType: ProjectType;
}
export interface ProjectStatusReport { project: StatusProject; tasks: StatusTask[]; changes: TimelineChange[]; delayedTasks: number; blockedTasks: number }
export interface WorkflowStatus { id: string; name: string; order: number; category: StatusCategory; color: string }
export interface Stage {
  id: string; name: string; order: number; plannedStart: string | null; plannedEnd: string | null; actualStart: string | null; actualEnd: string | null;
  status: StageStatus; effectiveStatus: StageStatus; owner: UserRef | null; assignee: UserRef | null; description: string | null;
  /** Top-level tasks under this stage (cancelled ones excluded) and how many of them are done. */
  taskTotal: number; taskDone: number;
  /** The stage before this one is not completed yet, so this one cannot be started or completed. `lockedBy` names that stage. */
  locked: boolean; lockedBy: string | null;
  /** Test issues found in this stage: the open (unresolved) ones keep it from completing. */
  openIssues: number; totalIssues: number;
}
/** What the timeline shows for a stage: its status, or Locked while it waits for the stage before it. */
export type StageDisplayStatus = StageStatus | 'Locked';
export interface TimelineTemplate {
  key: string; name: string; description: string; isDefault: boolean; stages: string[];
  /** One of the workspace's own timelines (editable). `id` and `weights` (each stage's share of the duration) are set for those. */
  isCustom?: boolean; id?: string | null; weights?: number[] | null;
}
export interface ProjectMember { userId: string; name: string; email: string; role: Role | null }
export interface ProjectDetail { project: Project; statuses: WorkflowStatus[]; stages: Stage[]; members: ProjectMember[] }
export interface Label { id: string; name: string; color: string }

export interface Task {
  id: string; projectId: string; projectKey: string; projectName: string; number: number; key: string; title: string; description: string | null;
  statusId: string; statusName: string; statusCategory: StatusCategory; statusColor: string; priority: Priority;
  assignee: UserRef | null; reporter: UserRef | null; startDate: string | null; dueDate: string | null;
  estimatedHours: number | null; actualHours: number | null; position: number; parentTaskId: string | null;
  subtaskTotal: number; subtaskDone: number; commentCount: number; labels: Label[];
  completedAt: string | null; createdAt: string; updatedAt: string | null; version: number; isOverdue: boolean;
  milestoneId: string | null; milestoneName: string | null; dependsOnCount: number; blocksCount: number; isBlocked: boolean;
  sprintId: string | null; sprintName: string | null; checklistTotal: number; checklistDone: number;
  canEdit: boolean;
  /** The project timeline stage (phase) this task belongs to; null for tasks that predate stages. */
  stageId: string | null; stageName: string | null;
}
export interface TaskDetail { task: Task; subtasks: Task[] }
export interface Comment { id: string; taskId: string; author: UserRef; body: string; parentCommentId: string | null; createdAt: string; editedAt: string | null; canEdit: boolean; canDelete: boolean }

export interface Activity { id: string; action: string; entityType: string; entityId: string | null; summary: string; actor: UserRef | null; projectId: string | null; createdAt: string }
export interface AuditLog { id: string; tenantId: string | null; tenantName: string | null; userId: string | null; userName: string | null; action: string; entityType: string; entityId: string | null; oldValue: string | null; newValue: string | null; ipAddress: string | null; createdAt: string }
export interface AppNotification { id: string; type: NotificationType; title: string; body: string | null; link: string | null; isRead: boolean; createdAt: string; browser: boolean }
export interface NotificationPreference { type: NotificationType; label: string; description: string; inApp: boolean; email: boolean; browser: boolean; locked: boolean }
export interface TestEmailResult { provider: string; delivered: boolean; message: string }

export interface WorkloadItem { userId: string; name: string; open: number; overdue: number; done: number }
export interface Dashboard {
  counts: {
    myDueToday: number; myCompletedToday: number; myOpen: number; myOverdue: number; activeProjects: number; completedProjects: number;
    totalProjects: number; openTasks: number; overdueTasks: number; members: number; overallProgress: number; myLoggedMinutesThisWeek: number;
  };
  myTasks: Task[]; projects: Project[]; activity: Activity[];
  /** My next open work of every kind (project tasks, test issues, action items, operational work). */
  myWork: WorkItem[];
}
export interface CalendarEvent {
  type: 'task' | 'action' | 'work' | 'project' | 'stage' | 'milestone'; id: string; title: string; date: string; status: string | null; category: StatusCategory | null;
  overdue: boolean; projectId: string | null; projectName: string | null; priority: Priority | null;
}
export interface SearchHit { type: string; id: string; title: string; subtitle: string | null; projectId: string | null; taskId: string | null }
export interface ReportSummary {
  days: number;
  totals: { total: number; completed: number; pending: number; inProgress: number; overdue: number; cancelled: number; completionRate: number };
  completedPerDay: { date: string; count: number }[];
  statusDistribution: { category: StatusCategory; count: number }[];
  projectProgress: { id: string; key: string; name: string; progress: number; health: ProjectHealth; dueDate: string | null; total: number; done: number }[];
  completedThisWeek: number; completedThisMonth: number; workload: WorkloadItem[] | null; advancedAvailable: boolean;
}

export interface Plan { id: string; code: string; name: string; description: string | null; priceMonthly: number | null; currency: string; features: Record<string, number>; isCurrent: boolean; sortOrder: number }
export interface Usage { key: string; label: string; used: number; limit: number }
export interface Invoice { id: string; number: string; planCode: string; amount: number; currency: string; status: string; description: string; issuedAt: string }
export interface BillingOverview { plan: PlanSummary; usage: Usage[]; invoices: Invoice[]; trialAvailable: boolean; plans: Plan[]; canManage: boolean }

export interface AdminStats { deletedTenants: number; users: number; activeUsers: number; tenants: number; organizations: number; personalWorkspaces: number; suspendedTenants: number; subscriptions: { planCode: string; count: number }[]; activeSessions: number }
export interface AdminTenant { id: string; name: string; slug: string; type: WorkspaceType; status: 'Active' | 'Suspended'; ownerEmail: string | null; planCode: string; subscriptionStatus: SubscriptionStatus; periodEnd: string | null; memberCount: number; createdAt: string; isDeleted: boolean; deletedAt: string | null }
export interface AdminMembership { tenantId: string; tenantName: string; type: WorkspaceType; role: Role; planCode: string; joinedAt: string; isDeleted: boolean }
export interface AdminUser {
  id: string; email: string; displayName: string; emailVerified: boolean; isActive: boolean; isPlatformAdmin: boolean;
  createdAt: string; lastLoginAt: string | null; workspaces: number; memberships: AdminMembership[];
}
export interface AdminUserDetail { user: AdminUser; activeSessions: number }
export interface AdminTenantMember { userId: string; displayName: string; email: string; role: Role; joinedAt: string }
export interface AdminTenantDetail {
  tenant: AdminTenant; description: string | null; ownerUserId: string; members: AdminTenantMember[];
  usage: { projects: number; tasks: number; teams: number; members: number; pendingInvitations: number }; limits: Record<string, number>;
}
/** The one currency every plan is priced in, and the ones it can be switched to. */
export interface BillingSettings { currency: string; currencies: { code: string; name: string }[] }
export interface AdminPlan { id: string; code: string; name: string; description: string | null; priceMonthly: number | null; currency: string; isActive: boolean; sortOrder: number; features: Record<string, number> }
export interface DevEmail { id: string; sentAt: string; to: string; subject: string; text: string | null; html: string }

export interface OrgRole {
  id: string; name: string; description: string | null; color: string; parentRoleId: string | null; posX: number | null; posY: number | null;
  peopleCount: number; childCount: number; isDeleted: boolean; deletedAt: string | null; hasAccess: boolean;
}
export interface OrgPerson { userId: string; displayName: string; email: string; accessRole: Role; roleId: string | null; reportsToUserId: string | null }
export interface OrgStructure { roles: OrgRole[]; people: OrgPerson[]; canManage: boolean }

export interface AccessModule { id: string; label: string; description: string; levels: number[]; hints: Record<string, string>; grants: Record<string, string[]> }
export interface AccessAction { key: string; label: string; description: string; delegable: boolean }
export interface AccessSuggested { modules: Record<string, number>; actions: Record<string, boolean> }
export interface RoleAccess {
  roleId: string; name: string; color: string; parentRoleId: string | null; people: number; hasProfile: boolean;
  modules: Record<string, number>; actions: Record<string, boolean>; suggested: AccessSuggested | null;
}
export interface AccessMatrix {
  modules: AccessModule[]; actions: AccessAction[]; roles: RoleAccess[]; canEdit: boolean; planAllows: boolean; isOrgAdmin: boolean; myLevels: Record<string, number>;
}

export interface Attachment {
  id: string; projectId: string; taskId: string | null; taskKey: string | null; taskTitle: string | null;
  fileName: string; contentType: string; sizeBytes: number; uploadedBy: UserRef | null; createdAt: string; canDelete: boolean; isImage: boolean;
  /** Set for a supporting document of a test issue. */
  issueId: string | null;
}
/** Observed / Failed (found by a tester) → In progress (being fixed) → Fixed (awaiting retest) → Resolved (confirmed by the tester). */
export type IssueStatus = 'Observed' | 'InProgress' | 'Fixed' | 'Resolved';
export interface IssueCan { edit: boolean; assign: boolean; delete: boolean; attach: boolean; moveTo: IssueStatus[] }
export interface Issue {
  id: string; key: string; number: number; projectId: string; stageId: string | null; stageName: string | null; title: string; details: string | null;
  severity: Priority; status: IssueStatus; reporter: UserRef | null; assignee: UserRef | null; createdAt: string; resolvedAt: string | null; fileCount: number; can: IssueCan;
}
export interface IssueEvent { id: string; kind: 'reported' | 'status' | 'assigned' | 'edited'; from: IssueStatus | null; to: IssueStatus | null; note: string | null; actor: UserRef | null; at: string }
export interface IssueDetail { issue: Issue; history: IssueEvent[] }
export interface IssueInput { stageId?: string | null; title: string; details?: string | null; severity?: Priority; assigneeId?: string | null }
export interface AttachmentLimits { maxFileBytes: number; storageLimitBytes: number; storageUsedBytes: number; allowedExtensions: string[] }

export type DependencyType = 'FinishToStart' | 'StartToStart' | 'FinishToFinish' | 'StartToFinish';
export interface Milestone {
  id: string; projectId: string; name: string; description: string | null; startDate: string | null; dueDate: string | null; status: StageStatus;
  owner: UserRef | null; sortOrder: number; completedAt: string | null; taskTotal: number; taskDone: number; progress: number; isOverdue: boolean;
  /** The timeline stage this milestone is a checkpoint of (optional). */
  stageId: string | null; stageName: string | null;
}
export interface MilestoneInput { name: string; description: string | null; startDate: string | null; dueDate: string | null; status: StageStatus; ownerId: string | null; stageId?: string | null }
export interface DependencyLink {
  id: string; type: DependencyType; satisfied: boolean;
  task: { id: string; key: string; title: string; category: StatusCategory; statusName: string; dueDate: string | null };
}
export interface TaskDependencies { blockedBy: DependencyLink[]; blocks: DependencyLink[]; enforced: boolean; blockedReason: string | null }

// ---- time tracking
/** Time spent on a project task (kind "task", taskId set) or on operational work (kind "work", workTaskId set). taskKey and taskTitle name whichever it was. */
export interface TimeEntry {
  id: string; taskId: string | null; taskKey: string; taskTitle: string; projectId: string | null; user: { id: string; name: string }; workDate: string; minutes: number;
  note: string | null; isRunning: boolean; startedAt: string | null; canEdit: boolean; workTaskId: string | null; kind: 'task' | 'work';
}
export interface TaskTime { entries: TimeEntry[]; totalMinutes: number; estimatedHours: number | null; myTimer: TimeEntry | null }
export interface Timesheet { from: string; to: string; user: { id: string; name: string }; entries: TimeEntry[]; totalMinutes: number; byDay: { date: string; minutes: number }[] }
export interface ProjectTime { totalMinutes: number; estimatedHours: number | null; byPerson: { userId: string; name: string; minutes: number }[]; topTasks: { taskId: string; key: string; title: string; minutes: number; estimatedHours: number | null }[] }

// ---- automation
export type AutomationTrigger = 'TaskCreated' | 'StatusChanged' | 'PriorityChanged';
export type AutomationAction = 'SetPriority' | 'SetAssignee' | 'MoveToStatus' | 'AddLabel' | 'Notify' | 'AddComment';
export type AutomationTarget = 'User' | 'Reporter' | 'Assignee';
export interface AutomationRule {
  id: string; projectId: string; name: string; isEnabled: boolean; trigger: AutomationTrigger; whenStatusId: string | null; whenPriority: string | null;
  action: AutomationAction; actionPriority: string | null; actionStatusId: string | null; actionLabelId: string | null; actionTarget: AutomationTarget; actionUserId: string | null;
  actionText: string | null; summary: string; runCount: number; lastRunAt: string | null;
}
export type AutomationInput = Omit<AutomationRule, 'id' | 'projectId' | 'summary' | 'runCount' | 'lastRunAt'>;

// ---- sprints
export interface Sprint {
  id: string; projectId: string; name: string; goal: string | null; startDate: string; endDate: string; status: 'Planned' | 'Active' | 'Completed';
  startedAt: string | null; completedAt: string | null; committed: number; taskTotal: number; taskDone: number; progress: number; estimatedHours: number;
  daysLeft: number | null; isOverdue: boolean;
}
export interface BurndownPoint { date: string; remaining: number; ideal: number }
export interface SprintDetail { sprint: Sprint; burndown: BurndownPoint[] }

// ---- generated reports
export type ReportKind = 'Project' | 'Workload' | 'Timesheet' | 'WorkTasks';
export type ReportFormat = 'Csv' | 'Xlsx' | 'Pdf';
export interface ReportExport {
  id: string; kind: ReportKind; format: ReportFormat; status: 'Queued' | 'Running' | 'Ready' | 'Failed'; projectId: string | null; targetUserId: string | null; days: number;
  fileName: string | null; sizeBytes: number; error: string | null; createdAt: string; completedAt: string | null; expiresAt: string | null;
}

// ---- checklists and priorities
export interface ChecklistItem { id: string; title: string; isDone: boolean; position: number; completedAt: string | null }
export interface Checklist { items: ChecklistItem[]; total: number; done: number; progress: number }
export interface PriorityInfo { level: Priority; name: string; color: string; isCustom: boolean }

// ---- CSV import
export interface ImportError { row: number; field: string; message: string }
export interface ImportPreview {
  delimiter: string; headers: string[]; sample: string[][]; totalRows: number; suggestedMapping: Record<string, number>;
  validRows: number; invalidRows: number; errors: ImportError[]; newLabels: number;
}
export interface ImportResult { created: number; skipped: number; labelsCreated: number; errors: ImportError[] }

// ---- custom fields
export type CustomFieldType = 'Text' | 'Number' | 'Date' | 'Dropdown' | 'Checkbox';
export interface CustomField { id: string; name: string; type: CustomFieldType; options: string[]; sortOrder: number; inUse: number }
export interface CustomFieldValue { fieldId: string; value: string }

// ---- API keys
export interface ApiKey {
  id: string; name: string; prefix: string; scope: 'ReadOnly' | 'ReadWrite'; owner: string; createdAt: string; expiresAt: string | null;
  lastUsedAt: string | null; lastUsedIp: string | null; revokedAt: string | null; status: string;
}

// ---- webhooks
export interface Webhook {
  id: string; name: string; url: string; events: string[]; isActive: boolean; disabledReason: string | null; createdAt: string;
  lastDeliveryAt: string | null; lastStatus: string | null; consecutiveFailures: number;
}
export interface WebhookDelivery {
  id: string; eventType: string; status: 'Pending' | 'Succeeded' | 'Failed'; attempts: number; responseStatus: number | null; error: string | null;
  createdAt: string; deliveredAt: string | null; nextAttemptAt: string | null;
}

// ---- work of every kind: My work, workload
/** Task: a project task. Issue: a test issue. ActionItem: a project follow-up. Operational: work outside projects. */
export type WorkItemKind = 'Task' | 'Issue' | 'ActionItem' | 'Operational';
/** One piece of assigned work of any kind; `category` puts every kind's own statuses on one scale. */
export interface WorkItem {
  kind: WorkItemKind; id: string; key: string; title: string; projectId: string | null; projectKey: string | null; projectName: string | null;
  status: string; category: StatusCategory; priority: Priority; dueDate: string | null; isOverdue: boolean; assignee: UserRef | null; typeName: string | null; updatedAt: string;
}
export interface WorkKindCounts { tasks: number; issues: number; actionItems: number; operational: number; total: number }
/** One open item of a person in a workload view. */
export interface PersonWorkItem {
  id: string; projectId: string | null; projectName: string | null; key: string; title: string; statusName: string; category: StatusCategory; priority: Priority;
  dueDate: string | null; isOverdue: boolean; kind: WorkItemKind;
}
export interface WorkloadPerson {
  userId: string; name: string; email: string; jobRole: string | null; level: number; reportsTo: string | null; open: number; overdue: number;
  doneLast30Days: number; loggedMinutesLast7Days: number; nextUp: PersonWorkItem[]; dueThisWeek: number; openByKind: WorkKindCounts | null;
}
/** Reports: my reporting line. Everyone: the whole workspace (Owner, Admin, or broad reports access). Me: just me. */
export type WorkloadScope = 'Reports' | 'Everyone' | 'Me';
export interface Workload { scope: WorkloadScope; available: WorkloadScope[]; members: WorkloadPerson[]; totals: { people: number; open: number; overdue: number } }
export interface WorkloadPersonDetail { person: WorkloadPerson; openTasks: PersonWorkItem[] }

// ---- platform administration
export interface PlatformBilling {
  mrr: number; arr: number; currency: string; payingOrganizations: number; trials: number; pastDue: number; cancellingAtPeriodEnd: number;
  revenueLast30Days: number; failedPaymentsLast30Days: number;
  byPlan: { planCode: string; planName: string; organizations: number; mrr: number }[];
  recentInvoices: { number: string; organization: string; planCode: string; amount: number; currency: string; status: string; issuedAt: string }[];
  trialsEndingSoon: { tenantId: string; organization: string; planCode: string; trialEnd: string }[];
}
export interface AdminUsage {
  tenantId: string; name: string; type: string; planCode: string; members: number; projects: number; tasks: number; storageMb: number; apiKeys: number; webhooks: number;
  lastActivityAt: string | null; warnings: { metric: string; percent: number }[];
}
export interface FeatureOverride { featureKey: string; value: number; reason: string; expiresAt: string | null; createdAt: string; planValue: number }
export interface PasswordPolicy {
  minLength: number; requireLetter: boolean; requireUppercase: boolean; requireLowercase: boolean; requireDigit: boolean; requireSymbol: boolean;
  blockCommon: boolean; blockPersonalInfo: boolean; historyCount: number;
}
export interface PlatformSettings { signupsEnabled: boolean; maintenanceMode: boolean; announcement: string | null; announcementLevel: string }
export interface PlatformStatus { maintenanceMode: boolean; announcement: string | null; announcementLevel: string }
export interface SystemHealth {
  status: string; version: string; runtime: string; startedAt: string; uptimeSeconds: number;
  database: { provider: string; reachable: boolean; latencyMs: number; pendingMigrations: number; error: string | null };
  workers: { name: string; status: string; lastRunAt: string | null; intervalSeconds: number; lastError: string | null }[];
  queues: { emailsWaiting: number; emailsStuck: number; reportsWaiting: number; reportsFailed: number; webhooksWaiting: number; webhooksFailed: number };
  traffic: { requests: number; serverErrors: number; clientErrors: number; lastServerErrorAt: string | null };
  attachmentStorageMb: number;
  cache: { provider: string; reachable: boolean; latencyMs: number; error: string | null };
}

// ---- go-live checklist
export interface GoLiveCheck { id: string; title: string; status: 'ok' | 'warn' | 'fail'; detail: string; fix: string | null }
export interface GoLive { verdict: 'ready' | 'almost' | 'not-ready'; failing: number; warnings: number; checks: GoLiveCheck[] }
export interface AdminTestEmailResult { sent: boolean; provider: string; to: string; error: string | null }

// ------------------------------------------------------------------ chat
/** Project: the team chat of one project (who is in it follows the project). */
export type ConversationType = 'Direct' | 'Group' | 'Project';
export interface ChatPerson { userId: string; name: string; email: string; online: boolean }
export interface ChatMember { userId: string; name: string; role: 'Member' | 'Admin'; lastReadAt: string; online: boolean }
export interface ChatLastMessage { id: string; senderName: string | null; snippet: string; at: string; isMine: boolean; isSystem: boolean }
export interface Conversation {
  id: string; type: ConversationType; name: string; members: ChatMember[]; lastMessage: ChatLastMessage | null;
  unread: number; isMuted: boolean; canManage: boolean; otherUserId: string | null; lastActivityAt: string;
  /** Project chats: the project, and how many unread messages @mention the signed-in person. */
  projectId: string | null; unreadMentions: number;
}
/** A project whose team chat has news for the signed-in person. */
export interface ProjectChatUnread { projectId: string; conversationId: string; unread: number; mentions: number }
export interface ChatReplyPreview { id: string; senderName: string | null; snippet: string; isDeleted: boolean }
export interface ChatMessage {
  id: string; conversationId: string; senderId: string | null; senderName: string | null; kind: 'User' | 'System'; body: string;
  replyTo: ChatReplyPreview | null; createdAt: string; editedAt: string | null; isDeleted: boolean;
}
export interface ChatThread { items: ChatMessage[]; hasMore: boolean }
export interface ChatSearchHit { messageId: string; conversationId: string; conversationName: string; senderName: string | null; snippet: string; at: string }

// ---- Work management: operational work that is not a project task
export type WorkTaskStatus = 'ToDo' | 'InProgress' | 'OnHold' | 'Completed' | 'Cancelled';
export interface WorkType { id: string; name: string; description: string | null; order: number; isActive: boolean; taskCount: number }
export interface WorkProjectRef { id: string; key: string; name: string; status: ProjectStatus }
export interface WorkTask {
  id: string; key: string; number: number; title: string; description: string | null; workTypeId: string; workType: string; relatedProject: WorkProjectRef | null;
  assignee: UserRef | null; reporter: UserRef | null; priority: Priority; status: WorkTaskStatus; startDate: string | null; dueDate: string | null; isOverdue: boolean;
  completedAt: string | null; createdAt: string; version: number; commentCount: number; attachmentCount: number; can: { edit: boolean; delete: boolean };
  /** Time logged on it, by everyone. */
  loggedMinutes: number;
}
export interface WorkTaskInput {
  title: string; description?: string | null; workTypeId: string; relatedProjectId?: string | null; assigneeId?: string | null; priority?: string; status?: string;
  startDate?: string | null; dueDate?: string | null;
}
export interface WorkComment { id: string; workTaskId: string; author: UserRef | null; body: string; createdAt: string; editedAt: string | null; canEdit: boolean; canDelete: boolean }
export interface WorkAttachment { id: string; workTaskId: string; fileName: string; contentType: string; sizeBytes: number; uploadedBy: UserRef | null; createdAt: string; canDelete: boolean; isImage: boolean }
export interface WorkActivity { id: string; action: string; summary: string; actor: UserRef | null; createdAt: string }
export interface WorkCount { name: string; open: number; overdue: number; completed: number }
export interface WorkPersonCount { userId: string | null; name: string; open: number; overdue: number; completed: number }
export interface WorkSummary {
  from: string; to: string; open: number; overdue: number; dueThisWeek: number; unassigned: number; completedInPeriod: number; createdInPeriod: number; mineOpen: number; mineOverdue: number;
  byType: WorkCount[]; byStatus: { status: WorkTaskStatus; count: number }[]; byPerson: WorkPersonCount[]; byProject: WorkCount[]; perDay: { date: string; completed: number; created: number }[];
}
