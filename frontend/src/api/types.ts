// Mirrors the API contracts in ProjectManagement.Application (camelCase, enums as strings).

export type Role = 'Guest' | 'Member' | 'Manager' | 'Admin' | 'Owner';
export type WorkspaceType = 'Personal' | 'Organization';
export type ProjectStatus = 'Planning' | 'Active' | 'OnHold' | 'Completed' | 'Cancelled' | 'Archived';
export type Priority = 'Low' | 'Medium' | 'High' | 'Critical';
export type StatusCategory = 'Todo' | 'Active' | 'Done' | 'Cancelled';
export type StageStatus = 'Pending' | 'InProgress' | 'Completed' | 'Delayed';
export type ProjectHealth = 'OnTrack' | 'AtRisk' | 'Delayed' | 'Completed' | 'Cancelled' | 'Archived';
export type SubscriptionStatus = 'Trial' | 'Active' | 'PastDue' | 'Cancelled' | 'Expired';
export type NotificationType = 'TaskAssigned' | 'Mention' | 'Comment' | 'DueSoon' | 'Overdue' | 'Invitation' | 'Subscription' | 'Security' | 'ReportReady' | 'Issue' | 'Approval' | 'ServiceLevel' | 'Message' | 'Reminder' | 'Nudge' | 'Briefing' | 'PortfolioDigest' | 'Document' | 'Meeting' | 'TaskUpdated' | 'ProjectUpdated' | 'CertificationExpiry' | 'AgentAlert' | 'AgentDigest' | 'TimesheetReminder' | 'Support';

export interface ApiErrorItem { code: string; message: string; field?: string | null }
export interface Paged<T> { items: T[]; page: number; pageSize: number; totalItems: number; totalPages: number }

export interface User { id: string; email: string; displayName: string; emailVerified: boolean; isPlatformAdmin: boolean; timeZone: string; mfaEnabled?: boolean; hasAvatar?: boolean;
  /** An administrator created this account: the first password is temporary and has to be replaced before anything else works. */
  mustChangePassword?: boolean }
export interface AuthResponse { accessToken: string; expiresAt: string; user: User; refreshToken: string | null }
export interface MfaChallenge { mfaRequired: true; challenge: string }
export interface MfaStatus { enabled: boolean; enabledAt: string | null; recoveryCodesLeft: number }
export interface MfaSetup { secret: string; otpAuthUri: string }
export interface Session { id: string; createdAt: string; lastSeenAt: string; ipAddress: string | null; userAgent: string | null; isCurrent: boolean; authMethod?: string | null }
export interface Passkey { id: string; name: string; createdAt: string; lastUsedAt: string | null; backedUp: boolean }
/** WebAuthn options as the server sends them: bytes are base64url text. */
export interface PasskeyOptions {
  challenge: string; timeout?: number; rpId?: string; rp?: { id?: string; name: string }; user?: { id: string; name: string; displayName: string };
  excludeCredentials?: { id: string; type: PublicKeyCredentialType; transports?: AuthenticatorTransport[] }[];
  allowCredentials?: { id: string; type: PublicKeyCredentialType; transports?: AuthenticatorTransport[] }[];
  [k: string]: unknown;
}
export interface PasskeyChallenge { challengeId: string; options: PasskeyOptions }

export interface Workspace { id: string; name: string; slug: string; type: WorkspaceType; role: Role; description: string | null; planCode: string; memberCount: number }
export interface PlanSummary { code: string; name: string; status: SubscriptionStatus; trialEnd: string | null; periodEnd: string | null; cancelAtPeriodEnd: boolean; downgraded: boolean }
export interface CurrentWorkspace {
  id: string; name: string; slug: string; type: WorkspaceType; role: Role; description: string | null;
  permissions: string[]; plan: PlanSummary; entitlements: Record<string, number>;
  /** Level per module for the signed-in user: 0 none, 1 view, 2 edit, 3 full. */
  modules: Record<string, number>;
  reportCount?: number;
  /** The workspace's default time zone (IANA); null = the platform default. Each person's own zone wins. */
  timeZone?: string | null;
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

export interface OrgSecurity { requireMfa: boolean; ipAllowlistEnabled: boolean; ipRanges: string[]; myIp: string | null; entitled: boolean;
  /** 0 = the platform's rule. */ minPasswordLength?: number; /** 0 = the platform's session length. */ sessionHours?: number; allowedSignIn?: string[] | null; platformMinPasswordLength?: number }
/** One sign-in of my account: from which browser and network, how, and whether it is still signed in. */
export interface SignIn { id: string; at: string; lastSeenAt: string; device: string; network: string | null; authMethod: string | null; current: boolean; active: boolean; newDevice: boolean; reportedAt: string | null }
export type SecurityIssue = 'no-two-step' | 'weak-password' | 'old-password' | 'inactive';
export interface MemberSecurity { userId: string; name: string; email: string; role: string; twoStep: boolean; passkeys: number; passwordChangedAt: string | null; passwordLength: number | null; lastSignInAt: string | null; issues: SecurityIssue[]; remindedAt: string | null }
export interface SecurityOverview { members: number; withoutTwoStep: number; weakPasswords: number; oldPasswords: number; people: MemberSecurity[] }
export interface MyConsent { upToDate: boolean; pending: ConsentDocument[] }

export interface Member { userId: string; displayName: string; email: string; role: Role; joinedAt: string; jobRole: string | null; hasAvatar?: boolean }

export interface TeamRef { id: string; name: string; isLead: boolean }
export interface MemberProfile {
  userId: string; displayName: string; email: string; hasAvatar: boolean; role: Role;
  jobRole: string | null; jobRoleColor: string | null; teams: TeamRef[]; reportsTo: { id: string; name: string } | null;
  joinedAt: string; open: number; overdue: number; doneLast30Days: number; doneTotal: number; isMe: boolean; canMessage: boolean; certificationBadges?: {name:string;issuer:string;expiresOn:string|null;verificationStatus:string}[];
}
export interface Invitation { id: string; email: string; role: Role; status: string; expiresAt: string; createdAt: string; invitedBy: string | null; jobRole: string | null; reportsTo: string | null }
export interface InvitationLookup { workspaceName: string; email: string; role: Role; invitedBy: string | null; expired: boolean; accepted: boolean; jobRole: string | null }
export interface PermissionMatrix {
  roles: Role[]; permissions: string[]; locked: string[]; matrix: Record<string, Record<string, boolean>>; canEdit: boolean;
  /** People this matrix does not decide for: their job role has its own access settings ("Name (Job role)"). */
  notAppliedTo?: string[] | null;
}
/** Where a person's access comes from: Owner and Admin have everything; JobRole means their job role's access settings decide; AccessLevel means the defaults of their access level do. */
export type AccessSource = 'Owner' | 'Admin' | 'JobRole' | 'AccessLevel';
export interface EffectiveAccess { userId: string; name: string; email: string; accessLevel: Role; jobRole: string | null; source: AccessSource; modules: Record<string, number>; permissions: string[]; projectReach: 'everything' | 'teams' | 'added'; projects: number; teams: string[] }
export interface EffectiveAccessList { people: EffectiveAccess[]; byJobRole: number; byAccessLevel: number }

export interface UserRef { id: string; name: string }
export interface Team { id: string; name: string; description: string | null; memberCount: number; projectCount: number; lead: UserRef | null; parentTeamId?: string | null }
export interface TeamMember { userId: string; name: string; email: string; isLead: boolean; openTasks: number }
export interface TeamDetail { team: Team; members: TeamMember[] }

/** What a project is for; chosen when it is created. */
export type ProjectType = 'NewProject' | 'ChangeRequest' | 'Enhancement' | 'Migration' | 'Integration' | 'Upgrade' | 'Maintenance' | 'Compliance' | 'Other';
/** How a project is planned: Phased (stages and milestones), Agile (sprints and a backlog) or Hybrid (both). It decides which planning views the project shows. */
export type DeliveryMethod = 'Hybrid' | 'Phased' | 'Agile';
export interface ProjectStats { total: number; done: number; inProgress: number; todo: number; cancelled: number; overdue: number }
export interface Project {
  stageScheduleMode?: 'Manual' | 'FixedDeadline' | 'FollowSchedule';
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
export interface StatusProjectRef { id: string; key: string; name: string; status: ProjectStatus; health: ProjectHealth; progress: number; active: number }
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
  durationDays?: number | null;
  id: string; name: string; order: number; plannedStart: string | null; plannedEnd: string | null; actualStart: string | null; actualEnd: string | null;
  status: StageStatus; effectiveStatus: StageStatus; owner: UserRef | null; assignee: UserRef | null; description: string | null;
  /** Top-level tasks under this stage (cancelled ones excluded) and how many of them are done. */
  taskTotal: number; taskDone: number;
  /** The stage before this one is not completed yet, so this one cannot be started or completed. `lockedBy` names that stage. */
  locked: boolean; lockedBy: string | null;
  /** Issues found in this stage: the open (unresolved) ones keep it from completing. */
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
export interface AppNotification { id: string; type: NotificationType; title: string; body: string | null; link: string | null; isRead: boolean; createdAt: string; browser: boolean; needsYou?: boolean; archived?: boolean;
  /** Snoozed until (UTC), while it waits to come back. */ snoozedUntil?: string | null;
  /** When it belongs in the inbox: arrival, or the end of its snooze. */ shownAt?: string | null;
  /** What can be done from it without opening it. */ actions?: NotificationAction[] }
export type NotificationAction = 'done' | 'take' | 'reply' | 'approve' | 'reject' | 'snooze';
/** Unread overall and in each lane of the inbox. */
export interface NotificationCounts { unread: number; needsYou: number; forInfo: number; snoozed?: number }
export interface NotificationPreference { type: NotificationType; label: string; description: string; inApp: boolean; email: boolean; browser: boolean; locked: boolean }
export interface TestEmailResult { provider: string; delivered: boolean; message: string }

export interface WorkloadItem { userId: string; name: string; open: number; overdue: number; done: number }
export interface Dashboard {
  counts: {
    myDueToday: number; myCompletedToday: number; myOpen: number; myOverdue: number; activeProjects: number; completedProjects: number;
    totalProjects: number; openTasks: number; overdueTasks: number; members: number; overallProgress: number; myLoggedMinutesThisWeek: number;
  };
  myTasks: Task[]; projects: Project[]; activity: Activity[];
  /** My next open work of every kind (project tasks, issues, action items, operational work). */
  myWork: WorkItem[];
}
export interface CalendarEvent {
  type: 'task' | 'action' | 'work' | 'project' | 'stage' | 'milestone' | 'meeting'; id: string; title: string; date: string; status: string | null; category: StatusCategory | null;
  overdue: boolean; projectId: string | null; projectName: string | null; priority: Priority | null;
  /** When a meeting session starts (UTC); null for anything that only has a date. */
  startsAt?: string | null;
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

/** `perSeat`: the price, storage and AI credits are per person (the features hold the per-person values). */
export interface Plan { id: string; code: string; name: string; description: string | null; priceMonthly: number | null; currency: string; features: Record<string, number>; isCurrent: boolean; sortOrder: number; perSeat?: boolean }
export interface Usage { key: string; label: string; used: number; limit: number }
export interface Invoice { id: string; number: string; planCode: string; amount: number; currency: string; status: string; description: string; issuedAt: string }
export interface HostedCheckout { provider: string; keyId: string; subscriptionId: string; name: string; description: string; amountMinor: number; currency: string }
export interface SeatsInfo { perSeat: boolean; purchased: number; inUse: number; period: 'monthly' | 'yearly'; renewal: import('../lib/pricing').Quote | null }
export interface BillingOverview { plan: PlanSummary; usage: Usage[]; invoices: Invoice[]; trialAvailable: boolean; plans: Plan[]; canManage: boolean; paymentProvider?: string; payment?: HostedCheckout | null; seats?: SeatsInfo | null; policy?: import('../lib/pricing').PricingPolicy | null; upi?: UpiPayment | null }
/** A plan paid by scanning a UPI QR: one account's QR at a time; the payer gives the UTR and an administrator confirms it. */
export type UpiStatus = 'awaiting' | 'submitted' | 'confirmed' | 'rejected' | 'failed' | 'cancelled';
export interface UpiPayment { id: string; reference: string; amount: number; currency: string; description: string; planCode: string; payeeName: string; upiId: string; bankLabel: string | null; upiUri: string; status: UpiStatus; utr: string | null; attempt: number; otherQrAvailable: boolean; expiresAt: string; createdAt: string; decisionNote: string | null }
export interface AdminUpiPayment { id: string; tenantId: string; workspace: string; planCode: string; seats: number; period: string; amount: number; currency: string; reference: string; upiId: string; bankLabel: string | null; status: UpiStatus; utr: string | null; attempt: number; failureReason: string | null; createdAt: string; submittedAt: string | null; submittedByEmail: string | null; decidedAt: string | null; decisionNote: string | null }
/** Meeting-bot workers (apps/meetbot) and the line of sessions waiting for one. */
export interface MeetingBotWorker { workerId: string; host: string | null; version: string | null; capacity: number; active: number; draining: boolean; lastSeenAt: string; online: boolean }
export interface MeetingBotOverview { configured: boolean; capacity: number; active: number; waiting: number; inCall: number; failedToday: number; workers: MeetingBotWorker[] }
export interface UpiAccountHealth { upiId: string; bankLabel: string | null; enabled: boolean; inUse: boolean; recentFailures: number; confirmed: number; lastConfirmedAt: string | null; lastFailedAt: string | null }

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
export interface AdminPlan { id: string; code: string; name: string; description: string | null; priceMonthly: number | null; currency: string; isActive: boolean; sortOrder: number; features: Record<string, number>; perSeat?: boolean }
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
  /** Set for a supporting document of an issue. */
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
  /** Time that can be charged to a client. */
  billable: boolean;
  /** In a week that is submitted for approval or approved: it cannot change. */
  locked: boolean;
}
export interface TaskTime { entries: TimeEntry[]; totalMinutes: number; estimatedHours: number | null; myTimer: TimeEntry | null; billableByDefault: boolean }
export interface Timesheet { from: string; to: string; user: { id: string; name: string }; entries: TimeEntry[]; totalMinutes: number; byDay: { date: string; minutes: number }[]; billableMinutes: number }

// ---- timesheet approval
export type TimesheetStatus = 'NotSubmitted' | 'Submitted' | 'Approved' | 'Rejected';
export interface TimesheetWeek {
  weekStart: string; weekEnd: string; userId: string; status: TimesheetStatus; totalMinutes: number; billableMinutes: number; note: string | null;
  submittedAt: string | null; reviewer: UserRef | null; reviewedAt: string | null; reviewNote: string | null; locked: boolean;
  canSubmit: boolean; canWithdraw: boolean; canReview: boolean; id: string | null; entitled: boolean;
}
export interface ApprovalRow {
  id: string | null; user: UserRef; weekStart: string; status: TimesheetStatus; totalMinutes: number; billableMinutes: number; note: string | null;
  submittedAt: string | null; reviewer: UserRef | null; reviewedAt: string | null; reviewNote: string | null;
}
export interface Approvals { weekStart: string; entitled: boolean; week: ApprovalRow[]; pending: ApprovalRow[] }

// ---- the week grid
export type GridKind = 'task' | 'work';
export interface GridCell { date: string; minutes: number; entries: number; running: boolean; note: string | null; allNotes?: string | null }
export interface GridRow { kind: GridKind; targetId: string; key: string; title: string; projectId: string | null; projectName: string | null; billable: boolean; cells: GridCell[]; totalMinutes: number }
export interface GridDay { date: string; minutes: number; targetMinutes: number; weekend: boolean; leave: boolean; leaveNote: string | null; future: boolean; meetings: number; meetingMinutes: number }
export type GridSuggestionReason = 'lastWeek' | 'assigned' | 'touched' | 'timer';
export interface GridSuggestion { kind: GridKind; targetId: string; key: string; title: string; projectId: string | null; projectName: string | null; reason: GridSuggestionReason }
export interface TimesheetGrid {
  weekStart: string; weekEnd: string; user: UserRef; mine: boolean; editable: boolean; locked: boolean; status: TimesheetStatus; days: GridDay[]; rows: GridRow[];
  suggestions: GridSuggestion[]; totalMinutes: number; billableMinutes: number; targetMinutes: number; overtimeMinutes: number; missingDays: number; running: TimeEntry | null;
}
export interface GridCellChange { kind: GridKind; targetId: string; date: string; minutes: number; note?: string | null; addAsNew?: boolean }
export interface GridCellError { kind: GridKind; targetId: string; date: string; message: string }
/** "Draft my week": proposed cells (nothing saved) and, per day, the time there was or why the day was left alone. */
export interface DraftCell { kind: GridKind; targetId: string; key: string; title: string; projectName: string | null; date: string; minutes: number; why: string }
export interface DraftDay { date: string; availableMinutes: number; meetingMinutes: number; skipped: string | null }
export interface WeekDraft { weekStart: string; cells: DraftCell[]; days: DraftDay[] }
export interface SaveGridResult { grid: TimesheetGrid; saved: number; errors: GridCellError[] }
/** Something time can go to, as chosen for an entry read from plain words. */
export interface TimeTarget { kind: GridKind; targetId: string; key: string; title: string; projectName: string | null }
/** One entry read from "2h on PAY-12 yesterday, 30m standup": how the work was found, other choices, and what still needs fixing. */
export interface ParsedTimeEntry {
  text: string; minutes: number; date: string; target: TimeTarget | null; note: string | null; match: 'key' | 'title' | 'ai' | 'none';
  options: TimeTarget[]; problem: string | null;
}
export interface ParsedTime { text: string; entries: ParsedTimeEntry[]; dayMinutes: number; usedAi: boolean; model: string | null; transcript: string | null; language: string | null }
export interface LogTimeWordsEntry { kind: GridKind; targetId: string; date: string; minutes: number; note: string | null }
export interface LogTimeWordsResult { saved: number; minutes: number; entries: TimeEntry[]; errors: GridCellError[] }
export interface InsightWeek { weekStart: string; loggedMinutes: number; billableMinutes: number; targetMinutes: number; overtimeMinutes: number; leaveDays: number; missingDays: number; status: TimesheetStatus }
export interface TimesheetInsights {
  user: UserRef; from: string; to: string; weeks: InsightWeek[]; byProject: { label: string; projectId: string | null; minutes: number }[]; byWeekday: { day: number; averageMinutes: number }[];
  loggedMinutes: number; billableMinutes: number; targetMinutes: number; overtimeMinutes: number; utilisation: number | null; billableShare: number | null; sameDayShare: number | null;
  streak: number; missingDays: string[];
}
export interface BulkReviewResult { approved: number; failed: { id: string; message: string }[] }

// ---- capacity and cost
export interface MemberRate { userId: string; name: string; email: string; role: Role; weeklyCapacityHours: number; standardCapacity: boolean; costRate: number | null; billRate: number | null }
export interface Rates { currency: string; entitled: boolean; canEdit: boolean; members: MemberRate[]; currencies: { code: string; name: string }[] }
export interface UtilisationPerson {
  userId: string; name: string; capacityMinutes: number; loggedMinutes: number; billableMinutes: number; projectMinutes: number; operationalMinutes: number;
  utilisation: number | null; billableShare: number | null; cost: number | null; billableValue: number | null;
}
export interface Utilisation {
  from: string; to: string; scope: WorkloadScope; available: WorkloadScope[]; currency: string; showMoney: boolean; entitled: boolean; workingDays: number;
  people: UtilisationPerson[]; totals: UtilisationPerson;
}
export interface ProjectFinancials {
  projectId: string; currency: string; entitled: boolean; canEdit: boolean; showMoney: boolean; isBillable: boolean; budgetHours: number | null; budgetAmount: number | null;
  billRate: number | null; loggedMinutes: number; billableMinutes: number; cost: number | null; billableValue: number | null; hoursUsed: number | null; budgetUsed: number | null;
  forecastHours: number | null; forecastCost: number | null; peopleWithoutCostRate: number;
  byPerson: { userId: string; name: string; minutes: number; billableMinutes: number; cost: number | null; billableValue: number | null }[];
}
export interface ProjectTime { totalMinutes: number; estimatedHours: number | null; byPerson: { userId: string; name: string; minutes: number }[]; topTasks: { taskId: string; key: string; title: string; minutes: number; estimatedHours: number | null }[] }

// ---- automation
/** Event triggers run when a task changes; DueSoon, Overdue and Stale are checked every few minutes (with `triggerDays`). */
export type AutomationTrigger = 'TaskCreated' | 'StatusChanged' | 'PriorityChanged' | 'DueSoon' | 'Overdue' | 'Stale';
export type AutomationAction = 'SetPriority' | 'SetAssignee' | 'MoveToStatus' | 'AddLabel' | 'Notify' | 'AddComment';
export type AutomationTarget = 'User' | 'Reporter' | 'Assignee';
/** One thing a rule does. Workspace rules name a status by category (the project's first status in it). */
export interface AutomationStep {
  action: AutomationAction; actionPriority: string | null; actionStatusId: string | null; actionStatusCategory: StatusCategory | null; actionLabelId: string | null;
  actionTarget: AutomationTarget; actionUserId: string | null; actionText: string | null;
}
export interface AutomationRule extends AutomationStep {
  id: string; projectId: string | null; name: string; isEnabled: boolean; trigger: AutomationTrigger; whenStatusId: string | null; whenPriority: string | null;
  whenStatusCategory: StatusCategory | null; triggerDays: number | null; moreActions: AutomationStep[];
  summary: string; runCount: number; lastRunAt: string | null;
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
export type ReportKind = 'Project' | 'Workload' | 'Timesheet' | 'WorkTasks' | 'WorkspaceExport' | 'Document';
export type ReportFormat = 'Csv' | 'Xlsx' | 'Pdf' | 'Zip';

// ---- integrations
export interface CalendarFeed { enabled: boolean; url: string | null; createdAt: string | null; lastUsedAt: string | null }
export interface InboundMailbox {
  configured: boolean; enabled: boolean; address: string | null; webhookUrl: string | null; workTypeId: string | null; priority: Priority;
  received: number; lastReceivedAt: string | null; lastError: string | null; canManage: boolean;
}
export type GitProvider = 'GitHub' | 'AzureDevOps';
export interface GitConnection { id: string; provider: GitProvider; name: string; webhookUrl: string; closeOnKeyword: boolean; received: number; lastReceivedAt: string | null; lastError: string | null; createdAt: string }
export interface DevLink {
  id: string; provider: GitProvider; kind: 'commit' | 'pull_request' | 'branch'; externalId: string; title: string; url: string; repository: string | null; author: string | null; state: string | null; occurredAt: string;
  /** Pull requests seen by the GitHub App: the branch, checks, review, size and risk. */
  branch?: string | null; checksState?: 'success' | 'failure' | 'pending' | null; reviewState?: 'approved' | 'changes_requested' | null; draft?: boolean;
  additions?: number | null; deletions?: number | null; changedFiles?: number | null; riskScore?: number | null; riskReasons?: string[] | null; mergedAt?: string | null; awaitingReview?: boolean;
}
/** The ProjectTracker GitHub App in this workspace. */
export interface GitHubStatusRules { opened: string | null; approved: string | null; merged: string | null; reopenOnRevert: boolean }
export interface GitHubAppStatus {
  configured: boolean; installed: boolean; account: string | null; accountType: string | null; selection: string | null; repositories: string[];
  rules: GitHubStatusRules; riskyPaths: string[]; closeOnKeyword: boolean; received: number; lastEventAt: string | null; lastError: string | null; manageUrl: string | null; suspended: boolean;
}
export interface GitHubBranch { name: string; url: string; repository: string }
export interface PullReviewItem { linkId: string; repository: string; number: string; title: string; url: string; author: string | null; waitingSince: string; days: number; taskKey: string | null; checksState: string | null; riskScore: number | null; role: 'reviewer' | 'author' }
export interface ReviewQueue { waitingOnMe: number; oldestDays: number | null; items: PullReviewItem[]; gitHubLinked: boolean }
export interface ReleaseNotePr { repository: string; number: string; title: string; url: string; author: string | null; mergedAt: string }
export interface ReleaseNotes { from: string; to: string; tasks: { key: string; title: string; pullRequests: ReleaseNotePr[] }[]; unlinked: ReleaseNotePr[]; markdown: string }
export interface DeliveryWeek { weekStart: string; deploys: number; failed: number; leadTimeHours: number | null; merged: number }
export interface DeliveryMetrics { days: number; leadTimeHours: number | null; leadTimeBasis: string; deploysPerWeek: number; changeFailureRate: number | null; restoreHours: number | null; weeks: DeliveryWeek[]; notes: string[]; repositories: string[] }
export interface GoogleConnectionStatus { transcriptAccess?: boolean; inboxEnabled?: boolean; inboxAccess?: boolean; mailEnabled?: boolean; mailSendAccess?: boolean; calendarAccess?: boolean; connected: boolean; googleEmail: string | null; connectedAt: string | null; lastError: string | null }
export interface MeetingParticipant { userId: string | null; name: string; email: string; role: 'Organizer' | 'Attendee'; rsvpStatus: 'NeedsAction' | 'Accepted' | 'Declined' | 'Tentative' }
export interface Meeting {
  id: string; projectId: string; title: string; description: string | null; startTime: string; endTime: string; timeZone: string;
  recurrenceRule?: string | null; calendarUrl?: string | null;
  status: 'Scheduled' | 'Cancelled' | 'Completed'; meetUri: string; organizerUserId: string; organizerName: string; participants: MeetingParticipant[];
  /** A stand-up: a summary of the project's work is posted to its chat after each session. */
  isScrum?: boolean;
}
/** A meeting for the workspace as a whole (no project), as the people invited see it. */
export interface WorkspaceMeetingDetail {
  id: string; title: string; description: string | null; startTime: string; endTime: string; timeZone: string; status: 'Scheduled' | 'Cancelled' | 'Completed';
  meetUri: string; calendarUrl: string | null; recurrenceRule: string | null; isScrum: boolean; organizerUserId: string; organizerName: string; canManage: boolean;
  attendees: MeetingParticipant[];
}
export interface StandupItem { key: string; taskId: string; title: string; who: string | null; due: string | null }
/** The stand-up summary card posted to a project chat (a 'Meeting' message whose JSON has kind "standup"). */
export interface StandupCard {
  kind: 'standup'; meetingId: string; title: string; projectName: string; day: string; doneCount: number; doingCount: number; overdueCount: number;
  done: StandupItem[]; doing: StandupItem[]; overdue: StandupItem[];
}
/** The parsed shape of a chat message whose kind is 'Meeting' (body is JSON, not text - see ChatService.PostMeetingCardAsync). */
export interface MeetingCard {
  meetingId: string; title: string; startTimeUtc: string; endTimeUtc: string; timeZone: string; meetUri: string; participantCount: number; status: 'Scheduled' | 'Cancelled' | 'Completed';
}
export interface DataPolicy {
  activityRetentionDays: number | null; notificationRetentionDays: number | null; chatRetentionDays: number | null; auditRetentionDays: number | null;
  planActivityDays: number; lastPurgedAt: string | null; canManage: boolean;
}
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
  /** Things worth checking that do not stop the import (e.g. the file was not UTF-8). */
  warnings?: string[] | null;
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
  /** Outgoing filters (empty: none). Status filters apply to status changes only. */
  filterProjects?: string[]; filterPriorities?: Priority[]; filterStatuses?: string[];
  /** The last 7 days. */
  health?: { total: number; succeeded: number; failed: number; successRate: number | null; averageMs: number | null } | null;
  disableAfter?: number;
  /** Json: signed events for your own systems. Slack / Teams: a ready-made message for a channel. */
  format: WebhookFormat;
}
export type WebhookFormat = 'Json' | 'Slack' | 'Teams';
export interface WebhookDelivery {
  id: string; eventType: string; status: 'Pending' | 'Succeeded' | 'Failed'; attempts: number; responseStatus: number | null; error: string | null;
  createdAt: string; deliveredAt: string | null; nextAttemptAt: string | null;
  durationMs?: number | null; replayOf?: string | null;
}
export interface WebhookDeliveryPage { items: WebhookDelivery[]; total: number; page: number; pageSize: number }
export interface WebhookDeliveryDetail { delivery: WebhookDelivery; payload: string; responseSnippet: string | null }
export interface WebhookEventInfo { event: string; group: string; groupLabel: string; sample: unknown }
export interface WebhookHealth {
  days: number; total: number; succeeded: number; failed: number; pending: number; successRate: number | null; averageMs: number | null; p95Ms: number | null;
  series: { day: string; total: number; failed: number; averageMs: number | null }[]; lastError: string | null; lastFailureAt: string | null;
  consecutiveFailures: number; warnAfter: number; disableAfter: number; warned: boolean;
}
/** Incoming webhooks: an address other systems post to, turned into a ticket, a task or a reminder. */
export type IncomingTarget = 'ticket' | 'task' | 'reminder';
export interface IncomingMapping {
  title?: string | null; description?: string | null; priority?: string | null; priorityMap?: Record<string, string> | null;
  dedupeKey?: string | null; assignee?: string | null; resolveWhen?: string | null; resolveValues?: string | null;
}
export interface IncomingWebhook {
  id: string; name: string; url: string; target: IncomingTarget; projectId: string | null; projectName: string | null; workTypeId: string | null; workTypeName: string | null;
  assigneeId: string | null; assigneeName: string | null; defaultPriority: Priority; mapping: IncomingMapping; mergeMinutes: number; isActive: boolean; requiresSecret: boolean;
  actingUserId: string; actingName: string | null; received: number; createdCount: number; mergedCount: number; lastReceivedAt: string | null; lastError: string | null; hasSample: boolean; createdAt: string;
}
export interface IncomingField { path: string; placeholder: string; value: string }
export interface IncomingPreview { title: string; description: string | null; priority: Priority; dedupeKey: string; assignee: string | null; resolves: boolean; problems: string[]; fields: IncomingField[] }
export interface IncomingEvent { id: string; receivedAt: string; status: 'created' | 'merged' | 'resolved' | 'ignored' | 'rejected' | 'failed'; title: string | null; dedupeKey: string | null;
  targetType: string | null; targetId: string | null; targetKey: string | null; error: string | null; count: number | null }
export interface SaveIncomingWebhook {
  name?: string; target?: IncomingTarget; projectId?: string | null; workTypeId?: string | null; assigneeId?: string | null; defaultPriority?: Priority;
  mapping?: IncomingMapping; mergeMinutes?: number; isActive?: boolean; requireSecret?: boolean; raiseAsMe?: boolean;
}

// ---- work of every kind: My work, workload
/** Task: a project task. Issue: an issue. ActionItem: a project follow-up. Operational: work outside projects. */
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
  reminders?: { waiting: number; late: number; sentSinceStart: number; lagP95Seconds: number; lastRunAt: string | null } | null;
}

// ---- go-live checklist
export interface GoLiveCheck { id: string; title: string; status: 'ok' | 'warn' | 'fail'; detail: string; fix: string | null }
export interface GoLive { verdict: 'ready' | 'almost' | 'not-ready'; failing: number; warnings: number; checks: GoLiveCheck[] }
export interface AdminTestEmailResult { sent: boolean; provider: string; to: string; error: string | null }

// ------------------------------------------------------------------ chat
/** Project: the team chat of one project (who is in it follows the project). */
export type ConversationType = 'Direct' | 'Group' | 'Project';
/** active = using the app, away = open but idle (5+ minutes without activity), offline = not connected. */
export type PresenceStatus = 'active' | 'away' | 'offline';
export interface ChatPerson { userId: string; name: string; email: string; online: boolean; status?: PresenceStatus; hasAvatar?: boolean }
export interface ChatMember { userId: string; name: string; role: 'Member' | 'Admin'; lastReadAt: string; online: boolean; status?: PresenceStatus; hasAvatar?: boolean;
  /** Their own status line and do-not-disturb. */ statusEmoji?: string | null; statusText?: string | null; dnd?: boolean }
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
export interface ChatAttachment { id: string; fileName: string; contentType: string; sizeBytes: number; isImage: boolean;
  /** A voice note: what was said, the language heard and how long it is. */ isVoice?: boolean; transcript?: string | null; transcriptLanguage?: string | null; durationSeconds?: number | null }
/** Something made from a message. */
export interface ChatLink { kind: 'task' | 'ticket' | 'reminder' | 'page'; id: string; key: string | null; title: string }
export interface ChatPollOption { index: number; text: string; votes: number; mine: boolean; names: string[] }
export interface ChatPoll { id: string; question: string; options: ChatPollOption[]; multiple: boolean; closesAt: string | null; closedAt: string | null; decision: string | null; voters: number; canClose: boolean }
export interface ChatFile { id: string; fileName: string; contentType: string; sizeBytes: number; isImage: boolean; messageId: string; senderId: string | null; senderName: string; createdAt: string }
export interface ChatFilePage { items: ChatFile[]; hasMore: boolean }
export interface ChatReaction { emoji: string; count: number; mine: boolean; names: string[] }
export interface ChatMessage {
  id: string; conversationId: string; senderId: string | null; senderName: string | null; kind: 'User' | 'System' | 'Meeting' | 'Poll'; body: string;
  replyTo: ChatReplyPreview | null; createdAt: string; editedAt: string | null; isDeleted: boolean;
  attachments?: ChatAttachment[] | null; reactions?: ChatReaction[] | null;
  /** A reply inside a thread (not shown in the conversation); on a thread's first message, how many replies and when the last came. */
  threadRootId?: string | null; threadReplies?: number; threadLastAt?: string | null;
  pinnedAt?: string | null; pinnedBy?: string | null; saved?: boolean;
  /** It asks the signed-in person something they have not answered yet. */ asksMe?: boolean;
  poll?: ChatPoll | null; linked?: ChatLink[] | null;
}
export interface ChatThreadView { root: ChatMessage; replies: ChatMessage[] }
export interface ChatSavedItem { message: ChatMessage; conversationName: string; savedAt: string }
export interface ChatSeenBy { seen: { userId: string; name: string; at: string }[]; notYet: string[] }
export interface ChatQuestion { messageId: string; conversationId: string; conversationName: string; senderName: string | null; snippet: string; at: string; threadRootId: string | null }
export interface ChatStatus { emoji: string | null; text: string | null; clearAt: string | null; dndUntil: string | null; dnd: boolean }
export interface ChatScheduled { id: string; conversationId: string; conversationName: string; body: string; sendAt: string; status: 'Scheduled' | 'Sent' | 'Cancelled' | 'Failed'; threadRootId: string | null; error: string | null }
export interface ChatUnfurl { key: string; kind: 'task' | 'page'; id: string; title: string; status: string | null; statusColor: string | null; assignee: string | null; due: string | null; done: boolean; link: string }
export interface ChatCatchUpItem { text: string; messageId: string | null; conversationId: string | null; conversationName: string | null; owner?: string | null; due?: string | null }
export interface ChatCatchUp { summary: string; decisions: ChatCatchUpItem[]; questions: ChatCatchUpItem[]; actions: ChatCatchUpItem[]; conversations: number; messages: number; model: string | null }
export interface ChatCitation { n: number; messageId: string; conversationId: string; conversationName: string; senderName: string | null; at: string; snippet: string; threadRootId: string | null }
export interface ChatAskAnswer { answer: string; citations: ChatCitation[]; searched: number; found: boolean; model: string | null }
export interface ChatExtract { kind: 'task' | 'ticket' | 'reminder' | 'page'; title: string; description: string; due: string | null; priority: string | null; assigneeId: string | null; assigneeName: string | null; projectId: string | null; byAi: boolean }
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
  /** Service-level clocks, when a target applies to it. */
  sla: WorkSla | null;
}
export type SlaState = 'OnTrack' | 'AtRisk' | 'Breached' | 'Met' | 'Missed' | 'Paused' | 'Stopped';
export interface SlaClock { dueAt: string; metAt: string | null; state: SlaState }
export interface WorkSla { response: SlaClock | null; resolution: SlaClock | null; state: SlaState }
export interface SlaTarget { priority: Priority; responseMinutes: number | null; resolutionMinutes: number | null }
export interface SlaSettings { entitled: boolean; canManage: boolean; defaults: SlaTarget[]; overrides: { workTypeId: string; workType: string; targets: SlaTarget[] }[] }
export interface WorkSlaSummary { tracked: number; met: number; missed: number; compliance: number | null; openBreached: number; openAtRisk: number; responseTracked: number; responseMet: number }
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
  sla: WorkSlaSummary | null;
}

/** Whether everyone sees every project of the workspace, or people see their own teams' projects and the ones they were added to. */
export interface ProjectVisibility { mode: 'organization' | 'teams'; teams: number; peopleWithoutTeam: number }

/** A team the signed-in person may look at as a whole (dashboard, reports, Portfolio). */
export interface LensTeam { id: string; name: string; projects: number; members: number }

export interface SignInDevice { enabled: boolean; devices: number; signInDevices: number; planAllows: boolean }
export interface DeviceLoginStart { requestId: string; secret: string; number: number; expiresAt: string }
export interface DeviceLoginPending { id: string; choices: number[]; device: string; ip: string | null; createdAt: string; expiresAt: string }

// ---- e-mail: the administrator's view, and "stop emails like this"
export interface EmailLogRow { id: string; to: string; subject: string; kind: string | null; status: 'Queued' | 'Sent' | 'Failed' | 'Suppressed'; attempts: number; createdAt: string; sentAt: string | null; error: string | null }
export interface EmailOverview { provider: string; sent24h: number; failed24h: number; queued: number; suppressed: number; recent: EmailLogRow[] }
export interface EmailBlocked { id: string; email: string; reason: string; detail: string | null; createdAt: string }
export interface EmailDomainCheck { domain: string; checks: { id: string; title: string; status: 'ok' | 'warn' | 'fail'; detail: string; fix: string | null }[] }
export interface UnsubscribeInfo { label: string; alreadyOff: boolean }

// ---- invoices people can keep
export interface InvoiceBuyer { name: string; address: string; taxId: string }
export interface InvoiceSeller { legalName: string; address: string; taxId: string; email: string; note: string }

// ---- Documents (BRDs, API documentation, test plans ...)
export type DocumentStatus = 'Draft' | 'InReview' | 'ChangesRequested' | 'Approved' | 'Published' | 'Archived';
export type DocumentVisibility = 'Project' | 'Team' | 'Organization' | 'Private';
/** How sensitive a document's own content is, independent of who may see it (DocumentVisibility). Confidential/Restricted documents get their files encrypted at rest. */
export type DocumentClassification = 'Public' | 'Internal' | 'Confidential' | 'Restricted';
export type SectionKind = 'RichText' | 'Table';
export type LinkTarget = 'Project' | 'Task' | 'Issue' | 'WorkItem' | 'Sprint';
export type LinkRelation = 'Describes' | 'Implements' | 'Verifies' | 'References' | 'DependsOn';
export interface SectionTemplate { key: string; title: string; kind: SectionKind; hint: string | null; columns: string[] | null }
export interface DocumentType { id: string; code: string; name: string; description: string | null; icon: string; color: string; sections: SectionTemplate[]; sortOrder: number; requiredForProjects?: boolean }
/** An active project missing a document of a kind the workspace marked as required for every project. */
export interface RequiredGap { projectId: string; projectKey: string; projectName: string; missing: { id: string; code: string; name: string; color: string }[] }
export interface DocumentItem {
  id: string; key: string; number: number; title: string; typeId: string; typeCode: string; typeName: string; typeColor: string; typeIcon: string;
  projectId: string | null; projectKey: string | null; projectName: string | null; teamId: string | null; teamName: string | null;
  owner: UserRef; status: DocumentStatus; visibility: DocumentVisibility; classification: DocumentClassification; tags: string[]; updatedAt: string; createdAt: string; linkedCount: number;
  versionLabel: string; sharedCount: number;
  /** Pages: the page this one sits under, its place among siblings, and its emoji. */
  parentId?: string | null; pageOrder?: number; icon?: string | null;
  /** Confirmed still right on this date (the verified badge); out of date since this moment (its linked work changed). */
  verifiedAt?: string | null; staleSince?: string | null;
}
/** A page that links to another with [[ ]]. */
export interface Backlink { id: string; key: string; title: string; typeCode: string; typeColor: string; icon: string | null; projectId: string | null }
export interface DocumentPage { items: DocumentItem[]; nextCursor: string | null; total: number | null }
export interface DocumentSection { key: string; title: string; kind: SectionKind; sortOrder: number; content: string }
export interface DocumentDetail {
  item: DocumentItem; revision: number; versionLabel: string; sections: DocumentSection[]; can: { edit: boolean; delete: boolean; link: boolean; share: boolean; publish: boolean };
  publishedLabel: string | null; hasUnpublishedChanges: boolean; viewingPublished: boolean;
  /** Personal or secret values masked in this copy; revealed = the real values (an audited reveal, or the editor's copy). */
  maskedCount?: number; revealed?: boolean; revealSeconds?: number; canReveal?: boolean;
}
export interface DocumentFilters { projectId?: string; teamId?: string; typeId?: string; status?: string; ownerId?: string; tag?: string; q?: string; general?: boolean; scope?: string; cursor?: string; limit?: number }
export interface LinkedItem {
  linkId: string; targetType: LinkTarget; targetId: string; relation: LinkRelation; restricted: boolean; key: string; title: string; status: string;
  done: boolean; dueDate: string | null; overdue: boolean; projectId: string | null; assignee: string | null; requirementId?: string | null;
}
export interface LinkedWork { items: LinkedItem[]; total: number; done: number; overdue: number; open: number; restricted: number }
export interface LinkedDocument { linkId: string; relation: LinkRelation; document: DocumentItem }
export interface LinkedDocuments { items: LinkedDocument[]; restricted: number }

// ---- Document history, sharing and files
export type DocAccessLevel = 'Viewer' | 'Editor' | 'Manager';
export type GrantPrincipal = 'User' | 'Team' | 'JobRole';
export interface DocVersion {
  id: string; label: string; major: number; minor: number; isDraft: boolean; isCurrent: boolean; changeSummary: string | null; changeReason: string | null;
  publishedAt: string | null; publishedBy: UserRef | null; restoredFrom: string | null; contentHash: string; hasChanges: boolean;
}
export interface DocVersions { items: DocVersion[]; publishedLabel: string | null; hasUnpublishedChanges: boolean; nextLabelMinor: string; nextLabelMajor: string }
export interface DocVersionContent { version: DocVersion; sections: DocumentSection[] }
export interface DiffWord { op: 'eq' | 'add' | 'del'; text: string }
export interface DiffLine { op: 'eq' | 'add' | 'del'; text: string; style: string; words: DiffWord[] | null }
export interface DiffRow { op: 'eq' | 'add' | 'del' | 'chg'; cells: string[]; changedCells: number[] | null }
export interface SectionDiff {
  key: string; title: string; kind: SectionKind; change: 'Unchanged' | 'Changed' | 'Added' | 'Removed'; lines: DiffLine[] | null; columns: string[] | null; rows: DiffRow[] | null; formattingOnly: boolean;
}
export interface VersionDiff {
  from: { id: string; label: string; isDraft: boolean }; to: { id: string; label: string; isDraft: boolean };
  sections: SectionDiff[]; changed: number; added: number; removed: number; unchanged: number;
}
export interface DocGrant {
  id: string; principalType: GrantPrincipal; principalId: string; name: string; members: number | null; level: DocAccessLevel; deny: boolean; expiresAt: string | null;
  note: string | null; by: UserRef | null; createdAt: string;
}
export interface AccessPerson { userId: string; name: string; role: string; level: DocAccessLevel; reasons: string[] }
export interface DocAccess {
  owner: UserRef; visibility: DocumentVisibility; visibilityText: string; grants: DocGrant[]; people: AccessPerson[]; peopleTotal: number; truncated: boolean;
  canManage: boolean; advancedPermissions: boolean;
}
export interface DocFile { id: string; fileName: string; contentType: string; sizeBytes: number; isImage: boolean; uploadedBy: UserRef | null; createdAt: string; canDelete: boolean }

// ---- Build artifacts (the "Build artifact" document type): one file per version, auto-versioned and auto-dated.
export interface ArtifactFile { fileName: string; contentType: string; sizeBytes: number; sha256: string; isZip: boolean }
export interface ArtifactVersion { id: string; label: string; isDraft: boolean; isCurrent: boolean; publishedAt: string | null; publishedBy: UserRef | null; file: ArtifactFile | null }
export interface ArtifactVersions { items: ArtifactVersion[]; publishedLabel: string | null; hasUnpublishedChanges: boolean; nextLabel: string }
export interface ArtifactEntryDiff { path: string; change: 'Added' | 'Removed' | 'Changed'; fromCrc32: number | null; toCrc32: number | null; fromSize: number | null; toSize: number | null }
export interface ArtifactCompare {
  from: ArtifactVersion; to: ArtifactVersion; comparableAsZip: boolean; added: number; removed: number; changed: number; unchanged: number; entries: ArtifactEntryDiff[];
  sizeChanged: boolean; hashChanged: boolean; fromSizeBytes: number; toSizeBytes: number; fromSha256: string; toSha256: string;
}

// ---- Document review, access requests, requirements and audit
export type ApproverKind = 'User' | 'Team' | 'JobRole' | 'ProjectOwner';
export type ApprovalRule = 'Any' | 'All';
export type ApprovalState = 'Pending' | 'Approved' | 'ChangesRequested' | 'Cancelled' | 'Published';
export interface WorkflowStepInput { name: string; kind: ApproverKind; principalId: string | null; rule: ApprovalRule; dueDays: number | null }
export interface WorkflowStep extends WorkflowStepInput { who: string }
export interface DocWorkflow { id: string; typeId: string | null; typeName: string | null; name: string; isActive: boolean; remind: boolean; steps: WorkflowStep[] }
export interface DocWorkflows { items: DocWorkflow[]; canManage: boolean; allowed: boolean; perType: boolean; reminders: boolean }
export interface SaveWorkflow { typeId: string | null; name: string; isActive: boolean; remind: boolean; steps: WorkflowStepInput[] }
export interface ApprovalPerson { userId: string; name: string; decision: string | null; comment: string | null; at: string | null }
export interface ApprovalStep { name: string; who: string; rule: ApprovalRule; dueDays: number | null; state: 'Done' | 'Current' | 'Waiting' | 'ChangesRequested' | 'Skipped'; people: ApprovalPerson[] }
export interface Approval {
  id: string; state: ApprovalState; workflowName: string; submittedBy: UserRef; submittedAt: string; summary: string; reason: string | null; major: boolean; currentStep: number;
  steps: ApprovalStep[]; canDecide: boolean; canWithdraw: boolean; dueAt: string | null; closedAt: string | null; closedNote: string | null;
}
export interface DocumentReview { workflowApplies: boolean; workflowName: string | null; stepCount: number; current: Approval | null; history: Approval[]; canSubmit: boolean }
export type AccessRequestStatus = 'Pending' | 'Approved' | 'Rejected' | 'Cancelled';
export interface AccessRequest {
  id: string; documentId: string; documentKey: string; documentTitle: string | null; requester: UserRef; level: DocAccessLevel; reason: string; durationDays: number | null; status: AccessRequestStatus;
  decidedBy: UserRef | null; decidedAt: string | null; decisionNote: string | null; grantedLevel: DocAccessLevel | null; grantedUntil: string | null; createdAt: string; canDecide: boolean; expired: boolean;
}
export interface DocumentGate { id: string; key: string; title: string | null; ownerName: string | null; teamName: string | null; canRequest: boolean; pending: AccessRequest | null; last: AccessRequest | null }
export interface ReviewItem { approvalId: string; document: DocumentItem; step: string; state: ApprovalState; submittedBy: UserRef; submittedAt: string; summary: string; dueAt: string | null; overdue: boolean }
export interface DocumentInbox { toReview: ReviewItem[]; submitted: ReviewItem[]; accessToDecide: AccessRequest[]; myAccessRequests: AccessRequest[]; waiting: number }
export interface Requirement { id: string; key: string; number: number; title: string; detail: string | null; priority: Priority; implementing: number; verifying: number }
export interface CoverageItem { linkId: string; targetType: LinkTarget; targetId: string; restricted: boolean; key: string; title: string; status: string; done: boolean; failing: boolean; assignee: string | null }
export interface CoverageRow { requirement: Requirement; state: 'Covered' | 'NoTask' | 'NoTest' | 'Failing'; implementing: CoverageItem[]; verifying: CoverageItem[] }
export interface Coverage { rows: CoverageRow[]; requirements: number; covered: number; withoutTask: number; withoutTest: number; failingTests: number; workWithoutTest: number; restricted: number }
export interface DocActivity { id: string; at: string; action: string; summary: string; by: UserRef | null }
export interface DocComment { id: string; user: UserRef; body: string; createdAt: string; editedAt: string | null; mine: boolean;
  /** A reply: the thread's first comment. A thread on selected text carries the id of its mark in the page and the words that were selected. */
  parentId?: string | null; anchorId?: string | null; quote?: string | null; resolvedAt?: string | null; resolvedBy?: string | null; canResolve?: boolean }
export interface DocAuditEntry { id: string; at: string; action: string; by: UserRef | null; ip: string | null; device: string | null; oldValue: string | null; newValue: string | null }
export interface DocAuditPage { items: DocAuditEntry[]; nextCursor: string | null }

// ---- API documentation
export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'TRACE';
export type ApiStage = 'Draft' | 'Design' | 'Development' | 'Sit' | 'Uat' | 'PreProd' | 'Production' | 'Deprecated' | 'Retired';
export const API_STAGES: { id: ApiStage; label: string }[] = [{ id: 'Draft', label: 'Draft' }, { id: 'Design', label: 'Design' }, { id: 'Development', label: 'Development' }, { id: 'Sit', label: 'SIT' }, { id: 'Uat', label: 'UAT' }, { id: 'PreProd', label: 'Pre-prod' }, { id: 'Production', label: 'Production' }, { id: 'Deprecated', label: 'Deprecated' }, { id: 'Retired', label: 'Retired' }];
export type ApiAuthScheme = 'None' | 'ApiKey' | 'Bearer' | 'Basic' | 'OAuth2';
export interface ApiParam { name: string; in: string; required: boolean; type: string | null; description: string | null; example: string | null; schema: string | null }
export interface ApiBody { contentType: string | null; required: boolean; description: string | null; schema: string | null; example: string | null }
export interface ApiResponse { status: string; description: string | null; contentType: string | null; schema: string | null; example: string | null }
export interface ApiErrorDoc { code: string; message: string | null; description: string | null }
export interface ApiSample { title: string; language: string; code: string }
export interface ApiDependency { name: string; note: string | null }
export interface EndpointDetails {
  description: string | null; auth: string; parameters: ApiParam[]; requestBody: ApiBody | null; responses: ApiResponse[];
  errors: ApiErrorDoc[]; samples: ApiSample[]; dependencies: ApiDependency[]; flow?: string | null;
}
export interface ApiDefinition {
  id: string; name: string; description: string | null; basePath: string | null; version: string | null; auth: ApiAuthScheme; authNote: string | null;
  servers: string[]; endpoints: number; sortOrder: number; stage: ApiStage;
}
export interface ApiOverview { definitions: ApiDefinition[]; endpoints: number; live: boolean; reading: string; versionId: string | null; canEdit: boolean; limit: number; used: number }
export interface EndpointItem { id: string; definitionId: string; definition: string; method: ApiMethod; path: string; summary: string; tag: string | null; deprecated: boolean; owner: UserRef | null }
export interface EndpointPage { items: EndpointItem[]; nextCursor: string | null; total: number | null }
export interface EndpointDetail { item: EndpointItem; details: EndpointDetails; readOnly: boolean; maskedCount?: number; revealed?: boolean; revealSeconds?: number; canReveal?: boolean }

// ---- DocTracker: every project's APIs (scored), documents and architecture
export interface DtEndpoint { id: string; documentId: string; definitionId: string; definition: string; method: ApiMethod; path: string; summary: string; tag: string | null; deprecated: boolean; score: number; gaps: string[]; stage: ApiStage; updatedAt: string | null }
export interface DtDefinition { id: string; documentId: string; name: string; version: string | null; stage: ApiStage; auth: ApiAuthScheme; servers: string[] }
export interface DtDocument { id: string; key: string; title: string; typeCode: string; typeName: string; typeColor: string; status: DocumentStatus; classification: DocumentClassification; updatedAt: string; isApi: boolean;
  parentId?: string | null; pageOrder?: number; icon?: string | null;
  /** A company page kept in a team's space. */ teamId?: string | null }
/** A team's space: company pages kept for one team; mine = the person is in it. */
export interface DtTeam { id: string; name: string; mine: boolean; pages: number }
export interface DtProject { id: string | null; key: string | null; name: string; endpoints: DtEndpoint[]; definitions: DtDefinition[]; documents: DtDocument[]; diagrams: number }
export interface DtCatalog { projects: DtProject[]; canCreate: boolean; isAdmin: boolean; truncated: number; teams?: DtTeam[] }
export interface DtDiagram { key: string; title: string; kind: 'architecture' | 'flow'; data: { nodes: unknown[]; edges: unknown[] } }
export interface DtArchitecture { projectId: string | null; diagrams: DtDiagram[]; notes: string | null; canEdit: boolean; updatedAt: string | null; updatedBy: string | null }
export interface SaveEndpoint { definitionId: string; method: string; path: string; summary: string; tag: string | null; deprecated: boolean; ownerId: string | null; details: EndpointDetails }
export interface SaveDefinition { name: string; description: string | null; basePath: string | null; version: string | null; auth: ApiAuthScheme; authNote: string | null; servers: string[]; stage?: ApiStage }
export interface ImportIssue { severity: 'error' | 'warning'; line: number | null; column: number | null; pointer: string | null; message: string }
export interface ApiImportResult { success: boolean; applied: boolean; format: string; definition: string; added: number; updated: number; unchanged: number; removed: number; issues: ImportIssue[]; overview: ApiOverview | null }
export interface ApiChange { level: 'Breaking' | 'Warning' | 'Info'; code: string; definition: string; method: string; path: string; message: string; where: string | null }
export interface ApiChanges { from: { versionId: string | null; label: string }; to: { versionId: string | null; label: string }; items: ApiChange[]; breaking: number; warnings: number; info: number; added: number; removed: number; modified: number }
export interface EndpointHit { documentId: string; documentKey: string; documentTitle: string; definition: string; method: ApiMethod; path: string; summary: string }

export type SecretClass = 'Secret' | 'Confidential';
export interface SecretItem { id: string; label: string; note: string | null; class: SecretClass; createdAt: string; valueChangedAt: string | null; by: { id: string; displayName: string } | null }
export interface SecretList { items: SecretItem[]; canReveal: boolean; canEdit: boolean; confidentialAllowed: boolean; revealSeconds: number }
export interface SecretReveal { value: string; revealSeconds: number }
export interface StepUpToken { token: string; expiresAt: string }
export interface ChainStatus { intact: boolean; records: number; verifiedUpTo: number; verifiedAt: string | null; brokenSeq: number | null; brokenId: string | null; reason: string | null }
export interface DocSecurity { revealSeconds: number; entitled: boolean; keyVersion: number; valuesTotal: number; valuesOnOldKeys: number; lastRotatedAt: string | null; chain: ChainStatus }

export interface DashboardCount { key: string; label: string; count: number }
export interface DocumentDashboard { total: number; byStatus: DashboardCount[]; byType: DashboardCount[]; mine: number; waitingForMe: number; updatedThisWeek: number; notUpdatedIn90Days: number; unpublished: number; recent: DocumentItem[]; projectsMissingRequired?: number; requiredTypes?: number }

export interface GroupMapping { id: string; group: string; teamId: string; teamName: string }
export interface GroupMappings { items: GroupMapping[] }

export interface WorkspaceLogo { hasLogo: boolean; width: number | null; height: number | null }

export interface PersonalEmailDraft { reconciledAt?: string | null; canReconcile?: boolean; confirmedSenderEmail?: string | null; provider?: 'google' | 'microsoft'; providerRequestId?: string | null; id: string; recipient: string; subject: string; body: string; status: string; version: number; providerMessageId: string | null; acceptedAt: string | null }
export interface EmailRewriteReceipt { operationId: string; draftId: string; sourceVersion: number; style: string; status: string; credits: number; model: string | null; createdAt: string; expiresAt: string; draft?: PersonalEmailDraft | null; draftChanged?: boolean }

export interface MicrosoftConnectionStatus { enabled: boolean; configured: boolean; connected: boolean; email: string | null; mailSendAccess: boolean; inboxEnabled?: boolean; inboxAccess?: boolean; calendarsEnabled?: boolean; calendarAccess?: boolean; connectedAt?: string | null }
export interface InboxMessage { id: string; threadId: string; subject: string; sender: string; receivedAt: string | null; unread: boolean; hasAttachments: boolean; body: string | null; bodyTruncated: boolean }
export interface InboxPage { provider: string; account: string; messages: InboxMessage[]; cursor: string | null }
export interface InboxThread { provider: string; account: string; threadId: string; messages: InboxMessage[]; truncated: boolean; sourceHash: string; accessContext: string }
export interface InboxSummaryOptions { available: boolean; credits: number; maxSourceCharacters: number; retentionHours: number }
export interface InboxSummaryRequest { operationId: string; provider: string; messageId: string; sourceHash: string; credits: number; confirmed: boolean }
export interface InboxSummaryReceipt { operationId: string; provider: string; messageId: string; status: string; credits: number; createdAt: string; expiresAt: string }
export interface InboxSummary extends InboxSummaryReceipt { sourceHash: string; model: string | null; points: { text: string; messageId: string; quote: string }[]; sourceChanged: boolean }
export interface InboxAttachment { name: string; size: number; mediaType: string; inline: boolean; downloadToken: string | null; unavailableReason: string | null }
export interface InboxAttachments { files: InboxAttachment[]; truncated: boolean; maxDownloadBytes: number }

export interface PersonalCalendarProposal {
  id:string; title:string; description:string; startUtc:string; endUtc:string; timeZone:string;
  status:'draft'|'sending'|'unknown'|'verified'; version:number; confirmedAccount:string|null; verifiedAt:string|null;
}

export interface MicrosoftOwnCalendar { id: string; name: string; isDefault: boolean }
export interface MicrosoftCalendarInventory { account: string; accessContext: string; calendars: MicrosoftOwnCalendar[]; truncated: boolean }
export interface MicrosoftCalendarAvailability { account: string; accessContext: string; calendarIds: string[]; startUtc: string; endUtc: string; busy: {startUtc: string; endUtc: string}[]; checkedAt: string; scope: string }

// ------------------------------------------------------------------ project agent
export type AgentFindingKind = 'CreateTask' | 'UpdateTask' | 'CreateActionItem' | 'CreateIssue' | 'UpdateIssue' | 'Delay' | 'Suggestion' | 'Missed' | 'Decision';
export type AgentFindingStatus = 'Proposed' | 'Applied' | 'Dismissed' | 'Failed';
export type AgentSourceKind = 'ProjectMailbox' | 'PersonalMail' | 'Chat' | 'MeetingTranscript' | 'LiveMeeting' | 'Manual' | 'Slack' | 'WhatsApp';
export interface AgentRun { id: string; trigger: 'schedule' | 'meeting' | 'mail' | 'manual'; status: 'running' | 'done' | 'failed'; signalCount: number; findingCount: number; credits: number; summary: string | null; error: string | null; startedAt: string; finishedAt: string | null;
  /** It read a meeting: its minutes (MOM) can be e-mailed. */
  meeting?: boolean; minutesSentAt?: string | null }
export interface ProjectAgent {
  projectId: string; enabled: boolean; readMailbox: boolean; readChat: boolean; readMeetings: boolean; liveBot: boolean; dailyUpdates: boolean;
  /** agent+token@... - only shown to people who may set the agent up. */
  mailboxAddress: string | null; liveBotAvailable: boolean; aiAvailable: boolean; pending: number; lastRunAt: string | null; lastError: string | null;
  runsThisMonth: number; monthlyRunLimit: number; canManage: boolean; actingUserName: string | null; runs: AgentRun[];
  /** Whether *this* person allowed the agent to read their Google Meet transcripts (organizers need it). */
  transcriptAccess: boolean;
  /** The lead's notes and who-is-who (only for people who may set the agent up). */
  instructions: string | null; speakerAliases: string | null;
  /** Meet's caption language for the bot, e.g. "hi". */
  captionLanguage: string | null; autoJoinCalendar: boolean; sendMinutes: boolean;
  slackChannelId: string | null; slackAvailable: boolean; readWhatsApp: boolean; whatsAppAvailable: boolean;
  /** This person let Google Meet transcribe their meetings automatically (their own Google account; no bot needed). */
  autoTranscriptAccess: boolean;
  /** 1 observer, 2 assistant, 3 participant, 4 delegate (carries out safe items itself). */
  autonomyLevel: number; autoApplyConfidence: number; autoApplyKinds: AgentFindingKind[];
  /** Check-ins on commitments, and briefs before meetings. */
  followUps: boolean; meetingBriefs: boolean;
  /** The most AI credits the agent may use for this project a month (0 = no cap), and what it used this month. */
  monthlyCreditCap?: number; creditsThisMonth?: number;
}
export type DismissReason = 'not_needed' | 'wrong' | 'duplicate' | 'already_done' | 'not_ours' | 'other';
export interface AgentReasonCount { reason: string; label: string; count: number }
export interface AgentKindStat { kind: AgentFindingKind; decided: number; approved: number; approvedAsIs: number; edited: number; dismissed: number; rate: number | null;
  safe: boolean; automatic: boolean; suggested: boolean; reasons: AgentReasonCount[] }
export interface AgentAutonomyHint { projectId: string; projectKey: string; projectName: string; kind: AgentFindingKind; decided: number; rate: number; level: number; message: string }
export interface AgentAutonomyReport { projectId: string; level: number; minDecisions: number; minRate: number; kinds: AgentKindStat[]; hints: AgentAutonomyHint[] }
export interface AgentLinkJoin { id: string; platform: string; title: string; startUtc: string; endUtc: string; status: string }
export interface AgentPerson { id: string; name: string }
export interface AgentFinding {
  id: string; projectId: string; projectKey: string; projectName: string; runId: string; kind: AgentFindingKind; status: AgentFindingStatus;
  title: string; detail: string | null; evidence: string | null; sourceLabel: string | null; source: AgentSourceKind | null;
  taskId: string | null; taskKey: string | null; taskTitle: string | null; issueId: string | null; issueKey: string | null;
  assignee: AgentPerson | null; dueDate: string | null; priority: Priority | null; newStatus: string | null; comment: string | null; confidence: number;
  createdAt: string; decidedBy: AgentPerson | null; decidedAt: string | null; appliedEntityId: string | null; appliedKey: string | null; error: string | null;
  /** False when the quote was not found in its source. */
  grounded: boolean; edits: string | null;
  /** The assignee's answer to work the agent gave them. */
  ownerResponse: 'accepted' | 'declined' | null; ownerNote: string | null; ownerRespondedAt: string | null;
  /** Carried out by the agent itself (autonomy level 4). */
  autoApplied?: boolean;
  /** What the work looked like before the change (audit). */
  before?: string | null;
  /** It came from someone's check-in ("I need more time"). */
  commitmentId?: string | null;
  /** Why it was dismissed. */
  dismissReason?: DismissReason | null;
}
export interface AgentFindingPage { items: AgentFinding[]; pending: number; canDecide: boolean }
export interface AgentApproveEdits { title?: string; detail?: string; assigneeId?: string; clearAssignee?: boolean; dueDate?: string; clearDueDate?: boolean; priority?: Priority; newStatus?: string; comment?: string }
/** botAvailable: this installation runs Project Tracker's own meeting bot. */
export interface AgentWorkspace { botAvailable: boolean; botName: string; inCallReminders: boolean; canManage: boolean; enabledProjects: number }
export interface AgentInboxOptIn { googleAvailable: boolean; microsoftAvailable: boolean; provider: 'google' | 'microsoft' | null; enabled: boolean; scannedUntil: string | null; found: number; lastError: string | null }

// ------------------------------------------------------------------ the agent as a delegate (Command Center)
export type ImpactLevel = 'none' | 'low' | 'medium' | 'high';
export interface ImpactTask { id: string; key: string; title: string; owner: string | null; oldDue: string | null; newDue: string | null; shiftDays: number; depth: number }
export interface AgentImpact {
  taskId: string; projectId: string; key: string; title: string; oldDue: string | null; newDue: string; slipDays: number; moves: ImpactTask[];
  milestones: string[]; projectDue: string | null; newFinish: string | null; projectSlipDays: number | null; people: string[]; summary: string; level: ImpactLevel;
}
export interface WhatIfTask { id: string; key: string; title: string; due: string | null; owner: string | null; dependents: number }
export type CommitmentStatus = 'open' | 'kept' | 'missed' | 'moved' | 'dropped';
export type CheckInAnswer = 'on_track' | 'done' | 'more_time' | 'blocked';
export interface AgentCommitment {
  id: string; projectId: string; projectKey: string; projectName: string; entityKey: string | null; taskId: string | null; title: string; dueDate: string;
  owner: AgentPerson; status: CommitmentStatus; quote: string | null; sourceLabel: string | null; checkInSentAt: string | null; checkInAnswer: CheckInAnswer | null;
  checkInNote: string | null; proposedDate: string | null; answeredAt: string | null; awaitingAnswer: boolean;
}
export interface BriefItem { key: string; owner: string | null; due: string | null; state: 'done' | 'overdue' | 'due_today' | 'open' | 'blocked' }
export interface MeetingBrief {
  meetingId: string; projectId: string; projectKey: string; projectName: string; title: string; startUtc: string; endUtc: string; meetUrl: string | null;
  headline: string; actionsSinceLast: number; done: number; overdue: number; blocked: number; open: number; items: BriefItem[]; blockers: string[];
  commitments: string[]; agenda: string[]; pendingDecisions: number; maybeUnnecessary: boolean; lastMeetingAt: string | null; agentAttending: boolean;
}
export interface MyMeeting {
  id: string; meetingId: string | null; projectId: string | null; projectKey: string | null; projectName: string | null; title: string; startUtc: string; endUtc: string;
  meetUrl: string | null; organizer: boolean; project: boolean; agentEnabled: boolean; agentAttending: boolean; delegationId: string | null;
  delegationStatus: 'requested' | 'attending' | 'reported' | 'cancelled' | null; overlapsWith: string[];
}
export interface AgentDelegation {
  id: string; projectId: string; projectKey: string; projectName: string; meetingId: string; title: string; startUtc: string; endUtc: string;
  status: 'requested' | 'attending' | 'reported' | 'cancelled'; instructions: string | null; automatic: boolean; botStatus: string | null; botError: string | null;
  reportSentAt: string | null; summary: string | null; outcomes: string[]; toDecide: number; canDecide: boolean; note: string | null;
}
export interface AgentPersonalSettings { autoDelegate: boolean; meetingBriefs: boolean; briefMinutes: number; checkIns: boolean; googleConnected: boolean }
export type AttentionKind = 'decide' | 'change_request' | 'check_in' | 'overdue' | 'blocking' | 'double_booked' | 'at_risk' | 'missed_commitments' | 'conflict' | 'unresolved';
export type Severity = 'high' | 'medium' | 'low';
export interface AttentionItem {
  id: string; kind: AttentionKind; severity: Severity; title: string; detail: string | null; why: string[]; link: string | null;
  projectId: string | null; projectKey: string | null; entityId: string | null; action: 'review' | 'decide' | 'check_in' | 'delegate' | 'open' | null; actionAt: string | null;
}
export interface CcCounts { attention: number; toDecide: number; dueToday: number; overdue: number; blocking: number; checkIns: number; meetingsToday: number; atRisk: number }
export interface CcChange { kind: 'done' | 'assigned' | 'decision' | 'moved' | 'auto' | 'meeting'; text: string; link: string | null; at: string; projectKey: string | null }
export interface CcHealth {
  projectId: string; key: string; name: string; level: 'low' | 'medium' | 'high' | string; score: number; reasons: string[]; progress: number; overdueTasks: number;
  dueDate: string | null; projectedFinish: string | null; slipDays: number | null; kept: number; missed: number;
}
export interface CcWork { id: string; projectId: string; key: string; title: string; due: string | null; state: 'overdue' | 'due_today' | 'open'; daysLate: number | null; waiting: string[] }
export interface CommandCenter {
  greeting: string; headline: string; since: string; counts: CcCounts; attention: AttentionItem[]; today: MyMeeting[]; changes: CcChange[]; health: CcHealth[];
  reliability: { kept: number; missed: number; open: number; moved: number }; checkIns: AgentCommitment[]; owe: CcWork[]; delegations: AgentDelegation[];
}
export interface AgentDecision {
  id: string; projectId: string; projectKey: string; projectName: string; title: string; detail: string | null; evidence: string | null; sourceLabel: string | null;
  status: string; at: string; decidedBy: AgentPerson | null; decidedAt: string | null; taskKey: string | null;
}
export interface AgentAuditEntry {
  id: string; projectId: string; projectKey: string; kind: AgentFindingKind; action: string; title: string; key: string | null; status: string; auto: boolean;
  by: AgentPerson | null; at: string | null; confidence: number; before: string | null; after: string | null; evidence: string | null; sourceLabel: string | null; error: string | null;
}

// ---- Operations
export interface RoutingRule { id: string; workTypeId: string | null; workType: string | null; mode: 'round_robin' | 'least_loaded'; members: UserRef[]; escalateTo: UserRef | null; enabled: boolean; lastAssigned: UserRef | null }
export interface RoutingRuleInput { workTypeId: string | null; mode: string; memberIds: string[]; escalateToUserId: string | null; enabled: boolean }
export interface OpsSettings { canManage: boolean; businessHoursOnly: boolean; dayStartMinutes: number; dayEndMinutes: number; workDays: number[]; timeZone: string; escalateOnBreach: boolean; escalateTo: UserRef | null; rules: RoutingRule[] }
export interface Triage { workTypeId: string | null; workType: string | null; typeReason: string | null; priority: Priority | null; priorityReason: string | null; assignee: UserRef | null; assigneeReason: string | null;
  duplicates: { id: string; key: string; title: string; status: WorkTaskStatus; assignee: UserRef | null; score: number }[]; routed: string | null }
export interface OpsBreakdown { name: string; id: string | null; open: number; completed: number; breached: number; compliance: number | null; medianResolutionHours: number | null }
export interface OpsInsights { days: number; open: number; unassigned: number; breached: number; atRisk: number; compliance: number | null; medianResolutionHours: number | null; medianResponseMinutes: number | null;
  createdInPeriod: number; completedInPeriod: number; weeks: { weekStart: string; created: number; completed: number; breached: number; compliance: number | null }[]; aging: { label: string; count: number }[];
  byType: OpsBreakdown[]; byPriority: OpsBreakdown[]; byPerson: OpsBreakdown[]; businessHours: boolean; satisfaction?: OpsSatisfaction | null }
/** How customers rated WhatsApp support (1-5), and how often the AI employee answered on its own. */
export interface OpsSatisfaction {
  asked: number; rated: number; average: number | null; satisfied: number | null; distribution: number[];
  weeks: { weekStart: string; rated: number; average: number | null }[]; byPerson: { name: string; id: string | null; rated: number; average: number | null }[];
  low: { chatId: string; contact: string; rating: number; at: string; ticketKey: string | null; with: string | null }[];
  chats: number; aiOnly: number; handedOver: number; handoverReasons: { label: string; count: number }[];
}

/** Suggestions for a new task, from finished work in the workspace; each carries the facts behind it. */
export interface TaskSuggestions {
  assignees: { userId: string; name: string; why: string }[];
  estimateLow: number | null; estimateHigh: number | null; estimate: number | null; estimateWhy: string | null;
  dueDate: string | null; dueWhy: string | null;
  priority: Priority | null; priorityWhy: string | null;
  similar: { id: string; key: string; title: string; hours: number | null; assignee: string | null }[];
}
