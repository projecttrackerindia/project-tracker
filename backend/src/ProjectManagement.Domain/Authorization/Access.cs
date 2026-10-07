using System.Text.Json;

namespace ProjectManagement.Domain;

/// <summary>How much of a module a job role can use. Not every module offers every level (see <see cref="ModuleDef.Levels"/>).</summary>
public static class AccessLevel
{
    public const int None = 0;   // menu hidden, API refuses
    public const int View = 1;   // read only
    public const int Edit = 2;   // create / change
    public const int Full = 3;   // also delete / manage
}

public record ModuleDef(string Id, string Label, string Description, int[] Levels, IReadOnlyDictionary<int, string> Hints, int DefaultLevel = 0)
{
    public int Max => Levels.Max();
    /// <summary>The highest level this module offers that is not above <paramref name="level"/> (so 2 on a None/View/Full module becomes 1).</summary>
    public int Snap(int level) => Levels.Where(l => l <= level).DefaultIfEmpty(0).Max();
}

public record ActionDef(string Key, string Label, string Description, bool Delegable);

/// <summary>
/// The menus / areas an organization can grant per job role. A role's access profile stores one level per module plus a few
/// explicit yes/no overrides for individual actions. Owners and Admins are never narrowed by a profile.
/// </summary>
public static class Modules
{
    public const string Projects = "projects", Tasks = "tasks", Calendar = "calendar", Teams = "teams", Members = "members",
        Work = "work", Organization = "organization", Reports = "reports", Activity = "activity", Audit = "audit", Billing = "billing", Documents = "documents";

    public static readonly ModuleDef[] All =
    [
        new(Projects, "Projects", "Project list, board, timeline and project details.", [0, 1, 2, 3], new Dictionary<int, string>
            { [0] = "Menu hidden", [1] = "See projects", [2] = "Create and edit projects, manage labels", [3] = "Also delete projects and manage workflows" }),
        new(Tasks, "Tasks", "My Tasks and the tasks inside projects.", [0, 1, 2, 3], new Dictionary<int, string>
            { [0] = "Cannot see tasks", [1] = "See tasks", [2] = "Create, edit, move and comment on tasks", [3] = "Also delete tasks and comments" }),
        new(Work, "Work management", "Work tasks: bug fixes, support, analysis and other operational work that is not a project task, and their reports.", [0, 1, 2, 3], new Dictionary<int, string>
            { [0] = "Menu hidden", [1] = "See work tasks", [2] = "Create, edit and comment on work tasks", [3] = "Also delete work tasks and manage the work types" }),
        // A job-role profile saved before documents existed has no entry for them: those roles can read documents, not write them.
        new(Documents, "Documents", "BRDs, API documentation, test plans and other documents, linked to projects and tasks.", [0, 1, 2, 3], new Dictionary<int, string>
            { [0] = "Menu hidden", [1] = "Read documents", [2] = "Write and edit documents", [3] = "Also delete documents" }, DefaultLevel: 1),
        new(Calendar, "Calendar", "Due dates and stages on a calendar.", [0, 1], new Dictionary<int, string>
            { [0] = "Menu hidden", [1] = "See the calendar" }),
        new(Teams, "Teams", "Teams and who belongs to them.", [0, 1, 2], new Dictionary<int, string>
            { [0] = "Menu hidden", [1] = "See teams", [2] = "Create teams and manage their members" }),
        new(Members, "Members", "The member list and invitations.", [0, 1, 2, 3], new Dictionary<int, string>
            { [0] = "Menu hidden", [1] = "See members", [2] = "Invite people", [3] = "Also change access levels and remove members" }),
        new(Organization, "Organization", "The organization chart.", [0, 1], new Dictionary<int, string>
            { [0] = "Menu hidden", [1] = "See the chart (editing is a separate switch)" }),
        new(Reports, "Reports", "Reports, workload and CSV export.", [0, 1], new Dictionary<int, string>
            { [0] = "Menu hidden", [1] = "See reports" }),
        new(Activity, "Activity", "The workspace activity feed.", [0, 1], new Dictionary<int, string>
            { [0] = "Menu hidden", [1] = "See activity" }),
        new(Audit, "Audit log", "Security and administration history.", [0, 1], new Dictionary<int, string>
            { [0] = "Menu hidden", [1] = "See the audit log" }),
        new(Billing, "Billing", "Plan, usage and invoices.", [0, 1, 3], new Dictionary<int, string>
            { [0] = "Menu hidden", [1] = "See plan and invoices", [3] = "Manage the subscription" }),
    ];

    public static ModuleDef? Find(string id) => All.FirstOrDefault(m => m.Id == id);

    /// <summary>Individual actions that can be switched on / off on top of the module levels.</summary>
    public static readonly ActionDef[] Actions =
    [
        new(Permissions.TasksComment, "Comment on tasks", "Lets a view-only role still join the conversation.", false),
        new(Permissions.TasksDelete, "Delete tasks", "Remove tasks and moderate comments.", false),
        new(Permissions.ProjectsViewAll, "See every team's projects", "When the workspace limits people to their own teams' projects, this role still sees all of them.", false),
        new(Permissions.ProjectsDelete, "Delete projects", "Remove a project and all of its tasks.", false),
        new(Permissions.LabelsManage, "Manage labels", "Create, rename and delete labels.", false),
        new(Permissions.WorkflowManage, "Manage workflows", "Change a project's task statuses.", false),
        new(Permissions.WorkDelete, "Delete work tasks", "Remove work tasks.", false),
        new(Permissions.WorkTypesManage, "Manage work types", "Add, rename, reorder and deactivate the kinds of work (Bug Fix, Data Preparation ...).", false),
        new(Permissions.ProjectGroupsManage, "Manage project groups", "Add, rename, reorder, deactivate and delete the groups projects are organized into.", false),
        new(Permissions.MembersInvite, "Invite members", "Send invitations to join the organization.", true),
        new(Permissions.MembersManage, "Manage members", "Change access levels and remove people.", true),
        new(Permissions.OrgStructure, "Edit the organization chart", "Add and remap roles, place people, set who reports to whom.", true),
        new(Permissions.AccessManage, "Manage job-role access", "Edit this page: decide what each job role can see and do.", true),
    ];

    public static bool IsDelegable(string permission) => Actions.Any(a => a.Key == permission && a.Delegable);

    /// <summary>The capabilities implied by a module being at a level (before per-action overrides).</summary>
    public static IEnumerable<string> PermissionsAt(string module, int level)
    {
        if (level >= AccessLevel.Edit)
            switch (module)
            {
                case Projects: yield return Permissions.ProjectsCreate; yield return Permissions.ProjectsEdit; yield return Permissions.LabelsManage; break;
                case Tasks: yield return Permissions.TasksCreate; yield return Permissions.TasksEdit; yield return Permissions.TasksComment; break;
                case Work: yield return Permissions.WorkCreate; yield return Permissions.WorkEdit; break;
                case Teams: yield return Permissions.TeamsManage; break;
                case Documents: yield return Permissions.DocsCreate; yield return Permissions.DocsEdit; break;
                case Members: yield return Permissions.MembersInvite; break;
            }
        if (level >= AccessLevel.Full)
            switch (module)
            {
                case Projects: yield return Permissions.ProjectsDelete; yield return Permissions.WorkflowManage; yield return Permissions.ProjectGroupsManage; break;
                case Tasks: yield return Permissions.TasksDelete; break;
                case Work: yield return Permissions.WorkDelete; yield return Permissions.WorkTypesManage; break;
                case Documents: yield return Permissions.DocsDelete; yield return Permissions.DocsWorkflow; break;
                case Members: yield return Permissions.MembersManage; break;
                case Billing: yield return Permissions.BillingManage; break;
            }
        if (level >= AccessLevel.View)
            switch (module)
            {
                case Reports: yield return Permissions.ReportsView; break;
                case Audit: yield return Permissions.AuditView; break;
            }
    }
}

/// <summary>What one job role may do. Stored as JSON on <c>OrgRole.AccessJson</c>; null there means "use the person's access level defaults".</summary>
public sealed class AccessProfile
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public Dictionary<string, int> Levels { get; set; } = new();
    /// <summary>Explicit yes/no for individual actions, only where it differs from what the levels imply.</summary>
    public Dictionary<string, bool> Overrides { get; set; } = new();

    public int Level(string module) => Levels.TryGetValue(module, out var l) ? (Modules.Find(module)?.Snap(l) ?? 0) : (Modules.Find(module)?.DefaultLevel ?? 0);

    /// <summary>Every capability this profile grants. Locked capabilities are never handed to a job role.</summary>
    public HashSet<string> Permissions()
    {
        var set = new HashSet<string>();
        foreach (var m in Modules.All) foreach (var p in Modules.PermissionsAt(m.Id, Level(m.Id))) set.Add(p);
        foreach (var (key, allowed) in Overrides) { if (allowed) set.Add(key); else set.Remove(key); }
        foreach (var locked in Domain.Permissions.Locked) set.Remove(locked);
        return set;
    }

    /// <summary>Levels for every module plus overrides reduced to the ones that differ from the levels' defaults.</summary>
    public static AccessProfile Build(IReadOnlyDictionary<string, int> levels, IReadOnlyDictionary<string, bool> wanted)
    {
        var p = new AccessProfile();
        foreach (var m in Modules.All) p.Levels[m.Id] = m.Snap(levels.TryGetValue(m.Id, out var l) ? l : m.DefaultLevel);
        var implied = new HashSet<string>(Modules.All.SelectMany(m => Modules.PermissionsAt(m.Id, p.Levels[m.Id])));
        foreach (var a in Modules.Actions)
            if (wanted.TryGetValue(a.Key, out var allowed) && allowed != implied.Contains(a.Key)) p.Overrides[a.Key] = allowed;
        return p;
    }

    public string ToJson() => JsonSerializer.Serialize(this, Json);

    public static AccessProfile? Parse(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try { return JsonSerializer.Deserialize<AccessProfile>(json, Json); }
        catch (JsonException) { return null; }
    }
}

/// <summary>Starting points for the software-company template roles, offered as "Use suggested access" (never applied automatically).</summary>
public static class SuggestedAccess
{
    private static AccessProfile P(int projects, int tasks, int calendar, int teams, int members, int org, int reports, int activity, int audit, int billing, params string[] extra)
    {
        var levels = new Dictionary<string, int>
        {
            [Modules.Projects] = projects, [Modules.Tasks] = tasks, [Modules.Calendar] = calendar, [Modules.Teams] = teams, [Modules.Members] = members,
            [Modules.Organization] = org, [Modules.Reports] = reports, [Modules.Activity] = activity, [Modules.Audit] = audit, [Modules.Billing] = billing,
        };
        return AccessProfile.Build(levels, extra.ToDictionary(k => k, _ => true));
    }

    private static readonly Dictionary<string, AccessProfile> ByName = new(StringComparer.OrdinalIgnoreCase)
    {
        //                                proj task cal team mem org rep act aud bill
        ["CTO"] = P(3, 3, 1, 2, 1, 1, 1, 1, 1, 0),
        ["Principal Manager"] = P(3, 3, 1, 2, 1, 1, 1, 1, 0, 0),
        ["Product Manager"] = P(3, 2, 1, 1, 1, 1, 1, 1, 0, 0),
        ["Delivery Manager"] = P(3, 3, 1, 2, 1, 1, 1, 1, 0, 0),
        ["Business Analyst"] = P(2, 2, 1, 1, 0, 1, 1, 1, 0, 0),
        ["Business User"] = P(1, 1, 1, 0, 0, 1, 1, 0, 0, 0, Permissions.TasksComment),
        ["Project Lead"] = P(2, 3, 1, 1, 1, 1, 1, 1, 0, 0),
        ["Developer"] = P(1, 2, 1, 1, 0, 1, 0, 1, 0, 0),
        ["Tester (QA)"] = P(1, 2, 1, 1, 0, 1, 0, 1, 0, 0),
        ["Data Engineer"] = P(1, 2, 1, 0, 0, 1, 1, 1, 0, 0),
        ["Data Analyst"] = P(1, 2, 1, 0, 0, 1, 1, 1, 0, 0),
    };

    public static AccessProfile? For(string roleName) => ByName.GetValueOrDefault(roleName);
}
