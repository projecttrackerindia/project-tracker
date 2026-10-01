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

    public static readonly string[] All =
    [
        OrgManage, OrgStructure, AccessManage, BillingManage, MembersInvite, MembersManage, TeamsManage,
        ProjectsCreate, ProjectsEdit, ProjectsDelete, WorkflowManage, ProjectGroupsManage, LabelsManage,
        WorkCreate, WorkEdit, WorkDelete, WorkTypesManage, TasksCreate, TasksEdit, TasksDelete, TasksComment, ReportsView, AuditView, PermissionsManage,
    ];

    /// <summary>Permissions that can never be changed from their defaults.</summary>
    public static readonly string[] Locked = [PermissionsManage, OrgManage];

    private static readonly Dictionary<TenantRole, HashSet<string>> Defaults = new()
    {
        [TenantRole.Owner] = [.. All],
        [TenantRole.Admin] =
        [
            OrgManage, OrgStructure, AccessManage, MembersInvite, MembersManage, TeamsManage, ProjectsCreate, ProjectsEdit, ProjectsDelete,
            WorkflowManage, ProjectGroupsManage, LabelsManage, WorkCreate, WorkEdit, WorkDelete, WorkTypesManage, TasksCreate, TasksEdit, TasksDelete, TasksComment, ReportsView, AuditView,
        ],
        [TenantRole.Manager] =
        [
            TeamsManage, ProjectsCreate, ProjectsEdit, WorkflowManage, LabelsManage, WorkCreate, WorkEdit, WorkDelete,
            TasksCreate, TasksEdit, TasksDelete, TasksComment, ReportsView,
        ],
        // Members can create tasks and comment on any of them, but edit only tasks assigned to them
        // (PermissionService.RequireTaskEditAsync) - TasksEdit here would grant editing everyone's tasks.
        [TenantRole.Member] = [ProjectsCreate, LabelsManage, WorkCreate, TasksCreate, TasksComment],
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

    public const long Unlimited = -1;

    public static readonly string[] Limits = [ProjectLimit, TaskLimit, MaxMembers, MaxTeams, ActivityRetentionDays, StorageLimitMb, MaxFileSizeMb];
    public static readonly string[] Flags = [AdvancedReports, CustomWorkflows, AdvancedPermissions, AuditLog, Automation, CustomFields, ApiAccess, AdvancedSecurity];
    public static readonly string[] All = [.. Limits, .. Flags];
}
