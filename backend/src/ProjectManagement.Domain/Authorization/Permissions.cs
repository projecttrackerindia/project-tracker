using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Domain;

/// <summary>Capabilities (spec section 9). Roles map to capabilities; tenants may override per role.</summary>
public static class Permissions
{
    public const string OrgManage = "org.manage";
    public const string BillingManage = "billing.manage";
    public const string MembersInvite = "members.invite";
    public const string MembersManage = "members.manage";
    public const string TeamsManage = "teams.manage";
    public const string ProjectsCreate = "projects.create";
    public const string ProjectsEdit = "projects.edit";
    public const string ProjectsDelete = "projects.delete";
    /// <summary>See every team's projects even when the workspace limits people to their own teams' work. Owners and Admins by default.</summary>
    public const string ProjectsViewAll = "projects.viewall";
    public const string WorkflowManage = "workflow.manage";
    /// <summary>Add, rename, reorder, deactivate and delete the project groups projects are organized into.</summary>
    public const string ProjectGroupsManage = "projectgroups.manage";
    public const string LabelsManage = "labels.manage";
    /// <summary>Work tasks (operational work that is not a project task): create, edit anyone's, delete, and manage the list of work types.</summary>
    public const string WorkCreate = "work.create";
    public const string WorkEdit = "work.edit";
    public const string WorkDelete = "work.delete";
    public const string WorkTypesManage = "work.types.manage";
    public const string TasksCreate = "tasks.create";
    public const string TasksEdit = "tasks.edit";
    public const string TasksDelete = "tasks.delete";
    public const string TasksComment = "tasks.comment";
    public const string ReportsView = "reports.view";
    public const string AuditView = "audit.view";
    public const string PermissionsManage = "permissions.manage";
    /// <summary>Edit the organization chart: roles, who reports to whom, who sits in which role.</summary>
    public const string OrgStructure = "org.structure";
    /// <summary>Decide what each job role can see and do (the Access tab of the Organization page).</summary>
    public const string AccessManage = "access.manage";
    /// <summary>Documents: write new ones, edit anyone's (without it a person edits only documents they own), and delete.</summary>
    public const string DocsCreate = "docs.create";
    public const string DocsEdit = "docs.edit";
    public const string DocsDelete = "docs.delete";

    public static readonly string[] All =
    [
        OrgManage, OrgStructure, AccessManage, BillingManage, MembersInvite, MembersManage, TeamsManage,
        ProjectsCreate, ProjectsEdit, ProjectsDelete, ProjectsViewAll, WorkflowManage, ProjectGroupsManage, LabelsManage,
        WorkCreate, WorkEdit, WorkDelete, WorkTypesManage, TasksCreate, TasksEdit, TasksDelete, TasksComment, ReportsView, AuditView, PermissionsManage,
        DocsCreate, DocsEdit, DocsDelete,
    ];

    /// <summary>Permissions that can never be changed from their defaults.</summary>
    public static readonly string[] Locked = [PermissionsManage, OrgManage];

    private static readonly Dictionary<TenantRole, HashSet<string>> Defaults = new()
    {
        [TenantRole.Owner] = [.. All],
        [TenantRole.Admin] =
        [
            OrgManage, OrgStructure, AccessManage, MembersInvite, MembersManage, TeamsManage, ProjectsCreate, ProjectsEdit, ProjectsDelete, ProjectsViewAll,
            WorkflowManage, ProjectGroupsManage, LabelsManage, WorkCreate, WorkEdit, WorkDelete, WorkTypesManage, TasksCreate, TasksEdit, TasksDelete, TasksComment, ReportsView, AuditView,
            DocsCreate, DocsEdit, DocsDelete,
        ],
        [TenantRole.Manager] =
        [
            TeamsManage, ProjectsCreate, ProjectsEdit, WorkflowManage, LabelsManage, WorkCreate, WorkEdit, WorkDelete,
            TasksCreate, TasksEdit, TasksDelete, TasksComment, ReportsView, DocsCreate, DocsEdit, DocsDelete,
        ],
        // Members can create tasks and comment on any of them, but edit only tasks assigned to them
        // (PermissionService.RequireTaskEditAsync) - TasksEdit here would grant editing everyone's tasks.
        [TenantRole.Member] = [ProjectsCreate, LabelsManage, WorkCreate, TasksCreate, TasksComment, DocsCreate],
        [TenantRole.Guest] = [TasksComment],
    };

    public static bool DefaultAllowed(TenantRole role, string permission) =>
        Defaults.TryGetValue(role, out var set) && set.Contains(permission);
}

/// <summary>Feature keys used by the central entitlement system (spec section 34).</summary>
public static class FeatureKeys
{
    public const string ProjectLimit = "PROJECT_LIMIT";
    public const string TaskLimit = "TASK_LIMIT";
    public const string MaxMembers = "MAX_MEMBERS";
    public const string MaxTeams = "MAX_TEAMS";
    public const string ActivityRetentionDays = "ACTIVITY_RETENTION_DAYS";
    public const string AdvancedReports = "ADVANCED_REPORTS";
    public const string CustomWorkflows = "CUSTOM_WORKFLOWS";
    public const string AdvancedPermissions = "ADVANCED_PERMISSIONS";
    public const string AuditLog = "AUDIT_LOG";
    /// <summary>Automation rules ("when this happens, do that") on projects.</summary>
    public const string Automation = "AUTOMATION";
    /// <summary>Workspace-defined extra fields on tasks.</summary>
    public const string CustomFields = "CUSTOM_FIELDS";
    /// <summary>API keys for scripts and integrations.</summary>
    public const string ApiAccess = "API_ACCESS";
    /// <summary>Total file storage per workspace, in megabytes.</summary>
    public const string StorageLimitMb = "STORAGE_LIMIT_MB";
    /// <summary>Largest single file, in megabytes.</summary>
    public const string MaxFileSizeMb = "MAX_FILE_SIZE_MB";
    /// <summary>An organization's own access rules on top of the platform's: required two-step verification, IP allowlisting.</summary>
    public const string AdvancedSecurity = "ADVANCED_SECURITY";
    /// <summary>Timesheet approval, capacity and utilisation, cost and bill rates, project budgets.</summary>
    public const string ResourceManagement = "RESOURCE_MANAGEMENT";
    /// <summary>Response and resolution targets (SLAs) on operational work.</summary>
    public const string ServiceLevels = "SERVICE_LEVELS";
    /// <summary>The AI assistant (Claude): plain-language search, summaries, delay risk, triage and action items from notes.</summary>
    public const string AiAssistant = "AI_ASSISTANT";
    /// <summary>The most capable model level the plan may use: 1 = Quick, 2 = Standard, 3 = Deep (extended reasoning). -1 = all levels.</summary>
    public const string AiModelTier = "AI_MODEL_TIER";
    /// <summary>AI credits per calendar month: per person on per-person plans (the workspace has them pooled), per workspace otherwise (a Quick answer costs 1, Standard 4, Deep 20 by default). -1 = unlimited.</summary>
    public const string AiMonthlyCredits = "AI_MONTHLY_CREDITS";
    /// <summary>Images and documents can be attached to a question for the assistant to read.</summary>
    public const string AiAttachments = "AI_ATTACHMENTS";
    /// <summary>Files and pictures can be sent in chat (stored like every other file, within the plan's file size and storage limits).</summary>
    public const string ChatAttachments = "CHAT_ATTACHMENTS";
    /// <summary>The assistant may propose changes (create work, set reminders, send reports) for the person to confirm.</summary>
    public const string AiActions = "AI_ACTIONS";
    /// <summary>Open reminders a person may have set (their own and from others) per workspace.</summary>
    public const string ReminderLimit = "REMINDER_LIMIT";
    /// <summary>Repeating reminders a person may have per workspace.</summary>
    public const string RecurringReminderLimit = "RECURRING_REMINDER_LIMIT";
    /// <summary>An escalation ladder for overdue work: the manager, then the project owner, hear about it.</summary>
    public const string ReminderEscalation = "REMINDER_ESCALATION";
    /// <summary>The mobile app (installable on a phone, with push alerts) and signing in on a computer by approving on the phone.</summary>
    public const string MobileApp = "MOBILE_APP";
    /// <summary>Documents (BRDs, API documentation, test plans ...) a workspace may keep. -1 = unlimited.</summary>
    public const string DocumentLimit = "DOCUMENT_LIMIT";

    public const long Unlimited = -1;

    public static readonly string[] Limits = [ProjectLimit, TaskLimit, MaxMembers, MaxTeams, ActivityRetentionDays, StorageLimitMb, MaxFileSizeMb, ReminderLimit, RecurringReminderLimit, DocumentLimit, AiModelTier, AiMonthlyCredits];
    public static readonly string[] Flags = [AdvancedReports, CustomWorkflows, AdvancedPermissions, AuditLog, Automation, CustomFields, ApiAccess, AdvancedSecurity, ResourceManagement, ServiceLevels, AiAssistant, AiAttachments, AiActions, ReminderEscalation, ChatAttachments, MobileApp];
    public static readonly string[] All = [.. Limits, .. Flags];
}
