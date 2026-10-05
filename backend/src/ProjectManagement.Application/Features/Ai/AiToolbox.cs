using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Application.Features.WorkItems;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Ai;

/// <summary>A change the assistant suggested, kept with everything needed to carry it out once the person confirms it.</summary>
public sealed record AiProposal(string Id, string Kind, string Title, string Summary, string PayloadJson, string Status = "proposed", string? Link = null, string? Error = null,
    string? Preview = null)
{
    public AiActionDto ToDto() => new(Id, Kind, Title, Summary, Status, Link, Error, Preview);
}

/// <summary>What a tool gave back: the text the model reads, a short label for the page ("Looked through 12 work items"), and any proposal.</summary>
public sealed record AiToolOutcome(string Content, string Label, int? Count = null, AiProposal? Proposal = null, bool IsError = false);

/// <summary>A tool could not do what was asked; the message goes back to the model so it can correct itself or tell the person.</summary>
public sealed class AiToolException(string message) : Exception(message);

/// <summary>
/// The assistant's hands. Every tool goes through the same services the app's own pages use, so what the assistant can read is exactly what
/// the signed-in person can read - nothing is ever fetched with wider access. Tools only read; changes are <em>proposals</em> that wait for
/// the person to confirm them (see <see cref="AiActionRunner"/>), so text hidden in a task title or an attachment can never make the
/// assistant change anything on its own.
/// </summary>
public class AiToolbox(IAppDbContext db, ICurrentContext ctx, AppClock clock, PermissionService permissions, ProjectAccess access,
    WorkItemService workItems, ProjectStatusService status, WorkloadService workload, ProjectGroupService groups, AiAnalysis analysis, TaskService tasks, WorkTaskService workTasks, ProjectService projects, ILogger<AiToolbox> log)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull, Converters = { new JsonStringEnumConverter() } };
    private const int ListCap = 40;

    public const string FindWork = "find_work", ListProjects = "list_projects", ProjectReport = "project_report", TeamWorkload = "team_workload",
        ListPeople = "list_people", MyWorkSummary = "my_work_summary",
        CreateTask = "propose_create_task", CreateWork = "propose_create_work", CreateActionItem = "propose_create_action_item",
        CreateReminder = "propose_reminder", SendReport = "propose_send_report", CreateProject = "propose_create_project", InviteMember = "propose_invite_member",
        UpdateProject = "propose_update_project", WorkloadBalance = "workload_balance", SuggestAssignee = "suggest_assignee", HistoryInsights = "history_insights", UpdateWork = "propose_update_work";

    public static readonly string[] WriteTools = [CreateTask, CreateWork, CreateActionItem, CreateReminder, SendReport, CreateProject, InviteMember, UpdateWork, UpdateProject];

    // ------------------------------------------------------------------ what the model is told it can use

    public IReadOnlyList<AiToolDef> Definitions(bool actionsAllowed)
    {
        var tools = new List<AiToolDef>
        {
            new(FindWork, "Find work items (project tasks, test issues, action items and operational work) the person can see. Use filters rather than reading everything.",
                """
                {"type":"object","properties":{
                 "assignee":{"type":"string","description":"A person's name, or \"me\"."},
                 "project":{"type":"string","description":"A project key or name."},
                 "kinds":{"type":"array","items":{"type":"string","enum":["Task","Issue","ActionItem","Operational"]}},
                 "overdue":{"type":"boolean","description":"Only work that is past its due date."},
                 "open_only":{"type":"boolean","description":"Leave out finished work. Default true."},
                 "unassigned":{"type":"boolean","description":"Only work that nobody is assigned to."},
                 "due_from":{"type":"string","description":"yyyy-mm-dd"},"due_to":{"type":"string","description":"yyyy-mm-dd"},
                 "text":{"type":"string","description":"Words to look for in titles."}},
                 "required":[]}
                """),
            new(ListProjects, "List the active projects the person can see with status, health and progress.", """{"type":"object","properties":{},"required":[]}"""),
            new(ProjectReport, "A project's status report: dates, progress, late and blocked tasks and every change of delivery date with its reason.",
                """{"type":"object","properties":{"project":{"type":"string","description":"A project key or name."}},"required":["project"]}"""),
            new(TeamWorkload, "Open, overdue and recently finished work per person, for the people the person may see.",
                """{"type":"object","properties":{"scope":{"type":"string","enum":["reports","everyone","me"],"description":"Whose workload. Default: the widest the person may see."}},"required":[]}"""),
            new(ListPeople, "The people in the workspace with their access level and job role (to find who to assign work to).", """{"type":"object","properties":{},"required":[]}"""),
            new(MyWorkSummary, "How much open, overdue and recently finished work the person has.", """{"type":"object","properties":{},"required":[]}"""),
            new(WorkloadBalance, "Analyse workload: per person open, overdue, due this week, estimated hours left against weekly capacity and recent pace, with who is overloaded, who has room and a rebalancing idea. Use before recommending who should take work.",
                """{"type":"object","properties":{"scope":{"type":"string","enum":["reports","everyone","me"],"description":"Whose workload. Default: the widest the person may see."}},"required":[]}"""),
            new(SuggestAssignee, "Rank the best people for a piece of work from their current load, lateness, experience on the project and similar work finished before. Use for 'who should do this' and when assigning unassigned work.",
                """
                {"type":"object","properties":{"title":{"type":"string","description":"What the work is."},"project":{"type":"string","description":"Optional project key or name."},
                 "estimate_hours":{"type":"number"},"due_date":{"type":"string","description":"yyyy-mm-dd"}},"required":["title"]}
                """),
            new(HistoryInsights, "What past data says: on-time delivery rate, cycle time, estimate accuracy, weekly pace, projects with the most overdue work, who delivers on time (where the person may see it). Use to forecast, find causes and ground recommendations.",
                """{"type":"object","properties":{"project":{"type":"string","description":"Optional project key or name; default all the person can see."},"days":{"type":"integer","description":"Look-back window, 14 to 365. Default 90."}},"required":[]}"""),
        };
        if (!actionsAllowed) return tools;
        tools.AddRange(
        [
            new(UpdateWork, "Propose changing existing work by its key (ATL-12 for a project task, WT-3 operational work, AI-4 an action item): status, assignee (or \"none\"), due date, priority, and/or add a comment. A later due date needs a reason. The person confirms first.",
                """
                {"type":"object","properties":{"key":{"type":"string"},"status":{"type":"string","description":"A status name, e.g. In Progress, Done, On Hold."},
                 "assignee":{"type":"string","description":"A person's name, \"me\" or \"none\"."},"due_date":{"type":"string","description":"yyyy-mm-dd"},"start_date":{"type":"string","description":"yyyy-mm-dd"},
                 "title":{"type":"string"},"description":{"type":"string","description":"The full new description (replaces the old one)."},"estimate_hours":{"type":"number"},
                 "priority":{"type":"string","enum":["Low","Medium","High","Critical"]},"comment":{"type":"string"},"reason":{"type":"string","description":"Why the due date moves later."}},"required":["key"]}
                """),
            new(UpdateProject, "Propose changing an existing project: name, description, priority, status (Planning, Active, OnHold, Completed, Cancelled), owner, start date, due date. A later due date needs a reason. The person confirms first.",
                """
                {"type":"object","properties":{"project":{"type":"string","description":"A project key or name."},"name":{"type":"string"},
                 "description":{"type":"string","description":"The full new description (replaces the old one)."},
                 "priority":{"type":"string","enum":["Low","Medium","High","Critical"]},"status":{"type":"string"},"owner":{"type":"string","description":"A person's name or \"me\"."},
                 "start_date":{"type":"string","description":"yyyy-mm-dd"},"due_date":{"type":"string","description":"yyyy-mm-dd"},
                 "reason":{"type":"string","description":"Why the due date moves later."}},"required":["project"]}
                """),
            new(CreateProject, "Propose a new project (use it when the project the person means does not exist yet; add tasks to it after they confirm). The person confirms first.",
                """
                {"type":"object","properties":{"name":{"type":"string"},"description":{"type":"string"},
                 "project_type":{"type":"string","enum":["NewProject","ChangeRequest","Enhancement","Migration","Integration","Upgrade","Maintenance","Compliance","Other"],"description":"Default NewProject."},
                 "group":{"type":"string","description":"Optional: the name of a project group. Default: the first active group."},
                 "owner":{"type":"string","description":"A person's name or \"me\". Default: me."},"priority":{"type":"string","enum":["Low","Medium","High","Critical"]},
                 "start_date":{"type":"string","description":"yyyy-mm-dd"},"due_date":{"type":"string","description":"yyyy-mm-dd"}},"required":["name"]}
                """),
            new(InviteMember, "Propose inviting a person who is not in the workspace yet, by e-mail (you cannot create accounts yourself). The person confirms first.",
                """{"type":"object","properties":{"email":{"type":"string"},"role":{"type":"string","enum":["Guest","Member","Manager"],"description":"Default Member."}},"required":["email"]}""" ),
            new(CreateTask, "Propose a new task on a project. The person sees a card and confirms before anything is created.",
                """
                {"type":"object","properties":{"project":{"type":"string"},"title":{"type":"string"},"description":{"type":"string"},
                 "assignee":{"type":"string","description":"A person's name or \"me\"."},"priority":{"type":"string","enum":["Low","Medium","High","Critical"]},
                 "start_date":{"type":"string","description":"yyyy-mm-dd"},"due_date":{"type":"string","description":"yyyy-mm-dd"},"estimate_hours":{"type":"number"},
                 "comment":{"type":"string","description":"A first comment to post on the task once it exists, e.g. the plan, context or acceptance criteria."}},"required":["project","title"]}
                """),
            new(CreateWork, "Propose a new operational work item (a bug fix, support request, analysis...) not tied to a project timeline. The person confirms first.",
                """
                {"type":"object","properties":{"title":{"type":"string"},"description":{"type":"string"},"work_type":{"type":"string","description":"The name of a work type, e.g. Bug Fix."},
                 "project":{"type":"string","description":"Optional related project."},"assignee":{"type":"string"},
                 "priority":{"type":"string","enum":["Low","Medium","High","Critical"]},"due_date":{"type":"string","description":"yyyy-mm-dd"}},"required":["title","work_type"]}
                """),
            new(CreateActionItem, "Propose a follow-up (action item) on a project, for example from meeting notes. The person confirms first.",
                """
                {"type":"object","properties":{"project":{"type":"string"},"title":{"type":"string"},"details":{"type":"string"},"assignee":{"type":"string"},
                 "due_date":{"type":"string","description":"yyyy-mm-dd"},"priority":{"type":"string","enum":["Low","Medium","High","Critical"]}},"required":["project","title"]}
                """),
            new(CreateReminder, "Propose a reminder. The person confirms first.",
                """{"type":"object","properties":{"text":{"type":"string"},"at":{"type":"string","description":"Local date and time, yyyy-mm-ddTHH:mm"},"for_person":{"type":"string","description":"Optional: a colleague to remind instead of the person."}},"required":["text","at"]}"""),
            new(SendReport, "Propose emailing a written report to people in the workspace (default: the person themselves). The person confirms first. Write the full report in 'body'.",
                """
                {"type":"object","properties":{"title":{"type":"string"},"body":{"type":"string","description":"The report in Markdown."},
                 "recipients":{"type":"array","items":{"type":"string"},"description":"Names, or \"me\". Default: me."}},"required":["title","body"]}
                """),
        ]);
        return tools;
    }

    // ------------------------------------------------------------------ running one

    public async Task<AiToolOutcome> ExecuteAsync(string name, string inputJson, string? timeZone, bool actionsAllowed, CancellationToken ct)
    {
        try
        {
            using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(inputJson) ? "{}" : inputJson);
            var a = doc.RootElement;
            if (a.ValueKind != JsonValueKind.Object) throw new AiToolException("The tool input must be a JSON object.");
            if (WriteTools.Contains(name) && !actionsAllowed) throw new AiToolException("This workspace's plan does not let the assistant propose changes.");
            return name switch
            {
                FindWork => await FindWorkAsync(a, ct),
                ListProjects => await ListProjectsAsync(ct),
                ProjectReport => await ProjectReportAsync(a, ct),
                TeamWorkload => await TeamWorkloadAsync(a, ct),
                ListPeople => await ListPeopleAsync(ct),
                MyWorkSummary => await MyWorkSummaryAsync(ct),
                WorkloadBalance => await WorkloadBalanceAsync(a, ct),
                SuggestAssignee => await SuggestAssigneeAsync(a, ct),
                HistoryInsights => await HistoryInsightsAsync(a, ct),
                UpdateWork => await ProposeUpdateAsync(a, ct),
                UpdateProject => await ProposeUpdateProjectAsync(a, ct),
                CreateProject => await ProposeProjectAsync(a, ct),
                InviteMember => await ProposeInviteAsync(a, ct),
                CreateTask => await ProposeTaskAsync(a, ct),
                CreateWork => await ProposeWorkAsync(a, ct),
                CreateActionItem => await ProposeActionItemAsync(a, ct),
                CreateReminder => await ProposeReminderAsync(a, timeZone, ct),
                SendReport => await ProposeReportAsync(a, ct),
                _ => throw new AiToolException($"There is no tool called {name}."),
            };
        }
        catch (AiToolException ex) { return new AiToolOutcome(ex.Message, "A lookup did not work", IsError: true); }
        catch (JsonException) { return new AiToolOutcome("The tool input was not valid JSON.", "A lookup did not work", IsError: true); }
        catch (AppException ex) { return new AiToolOutcome(ex.Message, "Not allowed", IsError: true); }   // permission, not found: the person's own access decides
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            log.LogWarning(ex, "The AI tool {Tool} failed", name);
            return new AiToolOutcome("That lookup failed. Tell the person you could not read it.", "A lookup failed", IsError: true);
        }
    }

    // ------------------------------------------------------------------ reading

    private async Task<AiToolOutcome> FindWorkAsync(JsonElement a, CancellationToken ct)
    {
        var assignee = Str(a, "assignee") is { } who ? (await PersonAsync(who, ct)).Id : (Guid?)null;
        var project = Str(a, "project") is { } pr ? (await ProjectAsync(pr, ct)).Id : (Guid?)null;
        var kinds = Strs(a, "kinds").Select(k => Enum.TryParse<WorkItemKind>(k, true, out var kk) ? (WorkItemKind?)kk : null).Where(k => k is not null).Select(k => k!.Value).Distinct().ToList();
        var items = await workItems.ListAsync(new WorkItemQuery(Kinds: kinds.Count > 0 ? kinds : null, AssigneeId: assignee, OpenOnly: Bool(a, "open_only") ?? true, ProjectId: project,
            DueFrom: Date(a, "due_from"), DueTo: Date(a, "due_to"), Overdue: Bool(a, "overdue") ?? false, Q: Str(a, "text"), Limit: 200, Unassigned: Bool(a, "unassigned") ?? false), WorkItemScope.Caller, ct);
        if (items.Count == 0) return new AiToolOutcome("No work items match.", "Looked through the work you can see", 0);
        var shown = items.Take(ListCap).Select(i =>
            $"{i.Kind} {i.Key} | {Clean(i.Title)} | {i.Status} | {i.Priority} | due {Day(i.DueDate)}{(i.IsOverdue ? " OVERDUE" : "")} | {i.Assignee?.Name ?? "unassigned"} | {i.ProjectKey ?? "-"}");
        var head = items.Count > ListCap ? $"{items.Count} match; the first {ListCap}:" : $"{items.Count} match:";
        return new AiToolOutcome(head + "\n" + string.Join("\n", shown), $"Looked through {items.Count} work item{(items.Count == 1 ? "" : "s")}", items.Count);
    }

    private async Task<AiToolOutcome> ListProjectsAsync(CancellationToken ct)
    {
        var groups = await status.GroupsAsync(ct);
        var rows = groups.SelectMany(g => g.Projects.Select(p => $"{p.Key} | {Clean(p.Name)} | {p.Status} | health {p.Health} | {p.Progress}% | {Clean(g.Name)}")).ToList();
        return rows.Count == 0 ? new AiToolOutcome("There are no active projects.", "Read the portfolio", 0)
            : new AiToolOutcome($"{rows.Count} projects (key | name | status | health | progress | group):\n" + string.Join("\n", rows.Take(80)), $"Read the portfolio ({rows.Count} project{(rows.Count == 1 ? "" : "s")})", rows.Count);
    }

    private async Task<AiToolOutcome> ProjectReportAsync(JsonElement a, CancellationToken ct)
    {
        var project = await ProjectAsync(Str(a, "project") ?? throw new AiToolException("Say which project."), ct);
        var report = await status.ReportAsync(project.Id, ct);
        var p = report.Project;
        var data = new
        {
            today = clock.Today,
            project = new { p.Key, p.Name, status = p.Status, health = p.Health, p.Progress, p.StartDate, p.DueDate, p.OriginalDueDate, p.DelayedDays, owner = p.Owner?.Name, p.Stats },
            report.DelayedTasks, report.BlockedTasks,
            lateOrBlocked = report.Tasks.Where(t => t.OverdueDays > 0 || t.DelayedDays > 0 || t.BlockedBy.Count > 0).Take(25)
                .Select(t => new { t.Key, title = Clean(t.Title), status = t.StatusName, t.DueDate, t.OverdueDays, t.DelayedDays, t.Revisions, assignee = t.Assignee?.Name, blockedBy = t.BlockedBy.Select(b => b.Key) }),
            dateChanges = report.Changes.Take(12).Select(c => new { c.Scope, c.TaskKey, c.Previous, c.Revised, c.DaysShifted, reason = Clean(c.Reason ?? ""), c.Dependency }),
        };
        return new AiToolOutcome(JsonSerializer.Serialize(data, Json), $"Read the status report of {p.Key}", 1);
    }

    private async Task<AiToolOutcome> TeamWorkloadAsync(JsonElement a, CancellationToken ct)
    {
        WorkloadScope? scope = Str(a, "scope")?.ToLowerInvariant() switch { "reports" => WorkloadScope.Reports, "everyone" => WorkloadScope.Everyone, "me" => WorkloadScope.Me, _ => null };
        var w = await workload.GetAsync(scope, ct);
        var rows = w.Members.Select(m => $"{Clean(m.Name)} | {Clean(m.JobRole ?? "-")} | open {m.Open} | overdue {m.Overdue} | due this week {m.DueThisWeek} | done in last 30 days {m.DoneLast30Days}").ToList();
        var head = $"Workload ({w.Scope}): {w.Totals.People} people, {w.Totals.Open} open, {w.Totals.Overdue} overdue.";
        return new AiToolOutcome(head + "\n" + string.Join("\n", rows.Take(60)), $"Checked workload ({w.Members.Count} {(w.Members.Count == 1 ? "person" : "people")})", w.Members.Count);
    }

    private async Task<AiToolOutcome> WorkloadBalanceAsync(JsonElement a, CancellationToken ct)
    {
        WorkloadScope? scope = Str(a, "scope")?.ToLowerInvariant() switch { "reports" => WorkloadScope.Reports, "everyone" => WorkloadScope.Everyone, "me" => WorkloadScope.Me, _ => null };
        var (text, n) = await analysis.WorkloadBalanceAsync(scope, ct);
        return new AiToolOutcome(text, $"Analysed workload ({n} {(n == 1 ? "person" : "people")})", n);
    }

    private async Task<AiToolOutcome> SuggestAssigneeAsync(JsonElement a, CancellationToken ct)
    {
        var title = Str(a, "title") ?? throw new AiToolException("Say what the work is.");
        var project = Str(a, "project") is { } pr ? await ProjectAsync(pr, ct) : null;
        var (text, n) = await analysis.SuggestAssigneeAsync(title, project is { } p && p.Id != Guid.Empty ? p.Id : null, project?.Key, a.TryGetProperty("estimate_hours", out var e) && e.ValueKind == JsonValueKind.Number ? e.GetDouble() : null, Date(a, "due_date"), ct);
        return new AiToolOutcome(text, "Compared who fits best", n);
    }

    private async Task<AiToolOutcome> HistoryInsightsAsync(JsonElement a, CancellationToken ct)
    {
        var project = Str(a, "project") is { } pr ? await ProjectAsync(pr, ct) : null;
        var days = a.TryGetProperty("days", out var d) && d.ValueKind == JsonValueKind.Number ? d.GetInt32() : 90;
        var (text, n) = await analysis.HistoryInsightsAsync(project is { } p && p.Id != Guid.Empty ? p.Id : null, project is null ? null : $"{project.Key} {project.Name}", days, ct);
        return new AiToolOutcome(text, project is null ? "Studied past delivery" : $"Studied past delivery of {project.Key}", n);
    }

    private async Task<AiToolOutcome> ListPeopleAsync(CancellationToken ct)
    {
        var people = await PeopleAsync(ct);
        return new AiToolOutcome($"{people.Count} people (name | access | job role):\n" + string.Join("\n", people.Take(150).Select(p => $"{Clean(p.Name)} | {p.Role} | {Clean(p.JobRole ?? "-")}")),
            $"Looked up {people.Count} people", people.Count);
    }

    private async Task<AiToolOutcome> MyWorkSummaryAsync(CancellationToken ct)
    {
        var me = ctx.RequireUserId();
        var counts = await workItems.CountsAsync([me], WorkItemScope.Caller, ct);
        var c = counts.GetValueOrDefault(me);
        return new AiToolOutcome(c is null ? "No work." : $"Open {c.Open}, overdue {c.Overdue}, due this week {c.DueThisWeek}, finished in the last 30 days {c.DoneLast30Days}. Open by kind: tasks {c.OpenByKind.Tasks}, issues {c.OpenByKind.Issues}, action items {c.OpenByKind.ActionItems}, operational {c.OpenByKind.Operational}.",
            "Checked your work", 1);
    }

    // ------------------------------------------------------------------ proposing (nothing is changed here)

    private static readonly System.Text.RegularExpressions.Regex ItemKey = new(@"^([A-Z][A-Z0-9]*)-(\d+)$", System.Text.RegularExpressions.RegexOptions.Compiled);

    private async Task<AiToolOutcome> ProposeUpdateAsync(JsonElement a, CancellationToken ct)
    {
        var key = (Str(a, "key") ?? throw new AiToolException("Say which work item by its key, for example ATL-12.")).Trim().ToUpperInvariant();
        var m = ItemKey.Match(key);
        if (!m.Success) throw new AiToolException("A key looks like ATL-12 (task), WT-3 (operational work) or AI-4 (action item). Test issues cannot be changed from here.");
        var prefix = m.Groups[1].Value; var number = int.Parse(m.Groups[2].Value);
        var assigneeText = Str(a, "assignee");
        var unassign = assigneeText is not null && assigneeText.Equals("none", StringComparison.OrdinalIgnoreCase);
        var assignee = assigneeText is null || unassign ? null : await PersonAsync(assigneeText, ct);
        var due = Date(a, "due_date");
        Priority? priority = Enum.TryParse<Priority>(Str(a, "priority"), true, out var pr) ? pr : null;
        var statusText = Str(a, "status"); var comment = Str(a, "comment"); var reason = Str(a, "reason");
        var newTitle = Str(a, "title"); var newDescription = Str(a, "description"); var start = Date(a, "start_date");
        var hours = a.TryGetProperty("estimate_hours", out var eh) && eh.ValueKind == JsonValueKind.Number ? eh.GetDecimal() : (decimal?)null;
        if (statusText is null && assigneeText is null && due is null && priority is null && comment is null && newTitle is null && newDescription is null && start is null && hours is null)
            throw new AiToolException("Say what to change: status, assignee, dates, priority, title, description, estimate or a comment.");
        if (newTitle is { Length: > 200 }) throw new AiToolException("A title is at most 200 characters.");
        if (comment is { Length: > 2000 }) throw new AiToolException("Keep the comment under 2,000 characters.");

        var changes = new List<string>();
        string target, title, link; Guid id;
        string? statusName = null;
        if (prefix is "WT" or "AI")
        {
            await RequireLevelAsync(Modules.Work, "change work items", ct);
            var kind = prefix == "AI" ? WorkTaskKind.ActionItem : WorkTaskKind.Operational;
            id = await db.WorkTasks.AsNoTracking().Where(w => w.Number == number && w.Kind == kind).Select(w => w.Id).FirstOrDefaultAsync(ct);
            if (id == Guid.Empty) throw new AiToolException($"There is no work item {key}.");
            var w = await workTasks.GetAsync(id, ct);   // the person's own access decides whether they can open it
            if (!w.Can.Edit) throw new AiToolException($"The person cannot edit {key}.");
            target = "work"; title = w.Title; link = $"/operations?task={id}";
            if (statusText is not null)
            {
                var wanted = statusText.Replace(" ", "").Replace("-", "");
                if (wanted.Equals("Done", StringComparison.OrdinalIgnoreCase) || wanted.Equals("Complete", StringComparison.OrdinalIgnoreCase)) wanted = "Completed";
                if (!Enum.TryParse<WorkTaskStatus>(wanted, true, out var ws)) throw new AiToolException("A status here is one of: To Do, In Progress, On Hold, Completed, Cancelled.");
                statusName = ws.ToString(); changes.Add($"status {w.Status} → {ws}");
            }
            if (comment is not null && comment.Length < 1) comment = null;
            if (assignee is not null || unassign) changes.Add($"assignee {w.Assignee?.Name ?? "none"} → {(unassign ? "none" : assignee!.Name)}");
            if (due is not null) changes.Add($"due {Day(w.DueDate)} → {Day(due)}");
            if (priority is not null) changes.Add($"priority {w.Priority} → {priority}");
        }
        else
        {
            await RequireLevelAsync(Modules.Tasks, "change tasks", ct);
            id = await access.VisibleTasks().AsNoTracking().Where(t => t.Number == number && t.Project!.Key == prefix).Select(t => t.Id).FirstOrDefaultAsync(ct);
            if (id == Guid.Empty) throw new AiToolException($"There is no task {key} that the person can see.");
            var t = (await tasks.GetAsync(id, ct)).Task;
            if (!t.CanEdit) throw new AiToolException($"The person cannot edit {key}.");
            target = "task"; title = t.Title; link = $"/projects/{t.ProjectId}?task={id}";
            if (statusText is not null)
            {
                var names = await db.WorkflowStatuses.AsNoTracking().Where(x => x.ProjectId == t.ProjectId).OrderBy(x => x.Order).Select(x => x.Name).ToListAsync(ct);
                statusName = names.FirstOrDefault(n => n.Equals(statusText.Trim(), StringComparison.OrdinalIgnoreCase)) ?? names.FirstOrDefault(n => n.Contains(statusText.Trim(), StringComparison.OrdinalIgnoreCase))
                    ?? throw new AiToolException($"{prefix} has these statuses: {string.Join(", ", names)}.");
                changes.Add($"status {t.StatusName} → {statusName}");
            }
            if (assignee is not null || unassign) changes.Add($"assignee {t.Assignee?.Name ?? "none"} → {(unassign ? "none" : assignee!.Name)}");
            if (due is not null)
            {
                if (t.DueDate is { } old && due > old && string.IsNullOrWhiteSpace(reason)) throw new AiToolException("Moving a due date later needs a reason. Ask the person why, then pass it as 'reason'.");
                changes.Add($"due {Day(t.DueDate)} → {Day(due)}");
            }
            if (priority is not null) changes.Add($"priority {t.Priority} → {priority}");
        }
        if (newTitle is not null) changes.Add($"title → “{newTitle}”");
        if (newDescription is not null) changes.Add("description rewritten");
        if (start is not null) changes.Add($"start → {Day(start)}");
        if (hours is not null) changes.Add($"estimate → {hours}h");
        if (comment is not null) changes.Add($"comment “{(comment.Length > 80 ? comment[..80] + "…" : comment)}”");
        var payload = new { target, id, key, title, statusName, assigneeId = assignee?.Id, assigneeName = assignee?.Name, unassign, dueDate = due, startDate = start, priority = priority?.ToString(), comment, reason, newTitle, newDescription, estimateHours = hours };
        return Propose("update_work", $"Update {key}: {title}", string.Join("; ", changes), payload, newDescription ?? comment);
    }

    private async Task<AiToolOutcome> ProposeUpdateProjectAsync(JsonElement a, CancellationToken ct)
    {
        if (!await permissions.HasAsync(Permissions.ProjectsEdit, ct)) throw new AiToolException("The person's role does not allow them to edit projects.");
        var pr = await ProjectAsync(Str(a, "project") ?? throw new AiToolException("Say which project."), ct);
        if (pr.IsPending) throw new AiToolException($"“{pr.Name}” has not been created yet. Ask the person to confirm its creation first, then change it.");
        var cur = (await projects.GetAsync(pr.Id, ct)).Project;
        var name = Str(a, "name"); var description = Str(a, "description"); var due = Date(a, "due_date"); var start = Date(a, "start_date"); var reason = Str(a, "reason");
        Priority? priority = Enum.TryParse<Priority>(Str(a, "priority"), true, out var pp) ? pp : null;
        ProjectStatus? statusValue = null;
        if (Str(a, "status") is { } st)
        {
            if (!Enum.TryParse<ProjectStatus>(st.Replace(" ", ""), true, out var ps) || ps == ProjectStatus.Archived) throw new AiToolException("A project status is one of: Planning, Active, OnHold, Completed, Cancelled.");
            statusValue = ps;
        }
        var owner = Str(a, "owner") is { } w ? await PersonAsync(w, ct) : null;
        if (name is null && description is null && due is null && start is null && priority is null && statusValue is null && owner is null) throw new AiToolException("Say what to change: name, description, priority, status, owner or dates.");
        if (name is { Length: > 120 or < 2 }) throw new AiToolException("A project name is 2 to 120 characters.");
        var newStart = start ?? cur.StartDate; var newDue = due ?? cur.DueDate;
        if (newStart is { } s0 && newDue is { } d0 && d0 < s0) throw new AiToolException("The due date is before the start date.");
        if (due is { } nd && cur.DueDate is { } od && nd > od && string.IsNullOrWhiteSpace(reason)) throw new AiToolException("Moving a project's due date later needs a reason. Ask the person why, then pass it as 'reason'.");

        var changes = new List<string>();
        if (name is not null) changes.Add($"name → “{name}”");
        if (description is not null) changes.Add("description rewritten");
        if (priority is not null) changes.Add($"priority {cur.Priority} → {priority}");
        if (statusValue is not null) changes.Add($"status {cur.Status} → {statusValue}");
        if (owner is not null) changes.Add($"owner {cur.Owner?.Name ?? "none"} → {owner.Name}");
        if (start is not null) changes.Add($"start {Day(cur.StartDate)} → {Day(start)}");
        if (due is not null) changes.Add($"due {Day(cur.DueDate)} → {Day(due)}");
        var payload = new { id = pr.Id, key = pr.Key, projectName = cur.Name, name, description, priority = priority?.ToString(), status = statusValue?.ToString(), ownerId = owner?.Id, ownerName = owner?.Name, startDate = start, dueDate = due, reason };
        return Propose("update_project", $"Update project {pr.Key}: {cur.Name}", string.Join("; ", changes), payload, description);
    }

    private async Task<AiToolOutcome> ProposeProjectAsync(JsonElement a, CancellationToken ct)
    {
        if (!await permissions.HasAsync(Permissions.ProjectsCreate, ct)) throw new AiToolException("The person's role does not allow them to create projects.");
        var name = (Str(a, "name") ?? throw new AiToolException("Give the project a name.")).Trim();
        if (name.Length is < 2 or > 120) throw new AiToolException("A project name is 2 to 120 characters.");
        if (await db.Projects.AsNoTracking().AnyAsync(p => p.Name.ToLower() == name.ToLower(), ct))
            throw new AiToolException($"A project called “{name}” already exists. Use it instead of creating another.");
        var typeText = Str(a, "project_type") ?? "NewProject";
        if (!Enum.TryParse<ProjectType>(typeText, true, out var type)) throw new AiToolException($"project_type must be one of {string.Join(", ", Enum.GetNames<ProjectType>())}.");
        await groups.EnsureDefaultAsync(ct);
        var active = await db.ProjectGroups.AsNoTracking().Where(g => g.IsActive).OrderBy(g => g.Order).Select(g => new { g.Id, g.Name }).ToListAsync(ct);
        if (active.Count == 0) throw new AiToolException("There is no active project group to put the project in.");
        var wanted = Str(a, "group");
        var group = (wanted is null ? null : active.FirstOrDefault(g => g.Name.Equals(wanted, StringComparison.OrdinalIgnoreCase)) ?? active.FirstOrDefault(g => g.Name.Contains(wanted, StringComparison.OrdinalIgnoreCase)))
            ?? (wanted is null ? active[0] : throw new AiToolException($"Choose one of these project groups: {string.Join(", ", active.Select(g => g.Name))}."));
        var owner = Str(a, "owner") is { } w ? await PersonAsync(w, ct) : null;
        var priority = PriorityOf(a);
        var start = Date(a, "start_date"); var due = Date(a, "due_date");
        if (start is { } s0 && due is { } d0 && d0 < s0) throw new AiToolException("The due date is before the start date.");
        _pendingProjects.Add(name);
        var payload = new { name, description = Str(a, "description"), projectType = type.ToString(), projectGroupId = group.Id, groupName = group.Name, ownerId = owner?.Id, ownerName = owner?.Name, priority, startDate = start, dueDate = due };
        var summary = $"{type}{Join($"in group {group.Name}", owner is null ? null : $"owned by {owner.Name}", $"{priority} priority", start is null ? null : $"starts {Day(start)}", due is null ? null : $"due {Day(due)}")}";
        return Propose("create_project", $"Create project “{name}”", summary, payload, Str(a, "description"));
    }

    private async Task<AiToolOutcome> ProposeInviteAsync(JsonElement a, CancellationToken ct)
    {
        if (!await permissions.HasAsync(Permissions.MembersInvite, ct)) throw new AiToolException("The person's role does not allow them to invite people.");
        var emailText = (Str(a, "email") ?? throw new AiToolException("An e-mail address is needed to invite someone. Ask the person for it.")).Trim();
        if (!System.Text.RegularExpressions.Regex.IsMatch(emailText, @"^[^@\s]+@[^@\s]+\.[^@\s]+$") || emailText.Length > 200) throw new AiToolException("That does not look like an e-mail address.");
        var role = Str(a, "role") ?? "Member";
        if (!Enum.TryParse<TenantRole>(role, true, out var parsed) || parsed is not (TenantRole.Guest or TenantRole.Member or TenantRole.Manager))
            throw new AiToolException("An invitation can be for a Guest, Member or Manager. Owners and admins are set up by hand.");
        var normalized = Text.NormalizeEmail(emailText);
        var tid = ctx.RequireTenantId();
        if (await (from m in db.TenantMembers join u in db.Users on m.UserId equals u.Id where m.TenantId == tid && u.NormalizedEmail == normalized select m.Id).AnyAsync(ct))
            throw new AiToolException("That person is already a member of this workspace.");
        var payload = new { email = emailText, role = parsed.ToString() };
        return Propose("invite_member", $"Invite {emailText}", $"As {parsed}; they get an e-mail to join this workspace", payload);
    }

    private async Task<AiToolOutcome> ProposeTaskAsync(JsonElement a, CancellationToken ct)
    {
        await RequireLevelAsync(Modules.Tasks, "create tasks", ct);
        var project = await ProjectAsync(Str(a, "project") ?? throw new AiToolException("Say which project."), ct);
        var title = Title(a);
        var assignee = Str(a, "assignee") is { } w ? await PersonAsync(w, ct) : null;
        var priority = PriorityOf(a);
        var due = Date(a, "due_date");
        var start = Date(a, "start_date");
        if (start is { } s0 && due is { } d0 && d0 < s0) throw new AiToolException("The due date is before the start date.");
        var hours = a.TryGetProperty("estimate_hours", out var eh) && eh.ValueKind == JsonValueKind.Number ? eh.GetDecimal() : (decimal?)null;
        var comment = Str(a, "comment");
        var payload = new { projectId = project.IsPending ? (Guid?)null : project.Id, projectKey = project.Key, projectName = project.Name, title, description = Str(a, "description"), assigneeId = assignee?.Id, assigneeName = assignee?.Name, priority, startDate = start, dueDate = due, estimateHours = hours, comment };
        var summary = $"In {project.Label}{Join(assignee is null ? null : $"assigned to {assignee.Name}", $"{priority} priority", start is null ? null : $"starts {Day(start)}", due is null ? null : $"due {Day(due)}", hours is null ? null : $"{hours}h estimate", comment is null ? null : "with a first comment")}";
        return Propose("create_task", $"Create task “{title}”", summary, payload, Str(a, "description") ?? comment);
    }

    private async Task<AiToolOutcome> ProposeWorkAsync(JsonElement a, CancellationToken ct)
    {
        await RequireLevelAsync(Modules.Work, "create work items", ct);
        var title = Title(a);
        var types = await db.WorkTypes.AsNoTracking().Where(t => t.IsActive).OrderBy(t => t.Order).Select(t => new { t.Id, t.Name }).ToListAsync(ct);
        var wanted = (Str(a, "work_type") ?? "").Trim();
        var type = types.FirstOrDefault(t => t.Name.Equals(wanted, StringComparison.OrdinalIgnoreCase)) ?? types.FirstOrDefault(t => t.Name.Contains(wanted, StringComparison.OrdinalIgnoreCase) && wanted.Length > 0)
            ?? throw new AiToolException($"Choose one of these work types: {string.Join(", ", types.Select(t => t.Name))}.");
        var project = Str(a, "project") is { } pr ? await ProjectAsync(pr, ct) : null;
        var assignee = Str(a, "assignee") is { } w ? await PersonAsync(w, ct) : null;
        var priority = PriorityOf(a);
        var due = Date(a, "due_date");
        var payload = new { title, description = Str(a, "description"), workTypeId = type.Id, workType = type.Name, projectId = project is { IsPending: false } ? project.Id : (Guid?)null, projectKey = project?.Key, projectName = project?.Name, assigneeId = assignee?.Id, assigneeName = assignee?.Name, priority, dueDate = due };
        var summary = $"{type.Name}{Join(project is null ? null : $"related to {project.Label}", assignee is null ? null : $"assigned to {assignee.Name}", $"{priority} priority", due is null ? null : $"due {Day(due)}")}";
        return Propose("create_work", $"Create work “{title}”", summary, payload, Str(a, "description"));
    }

    private async Task<AiToolOutcome> ProposeActionItemAsync(JsonElement a, CancellationToken ct)
    {
        var project = await ProjectAsync(Str(a, "project") ?? throw new AiToolException("Say which project."), ct);
        var title = Title(a);
        var assignee = Str(a, "assignee") is { } w ? await PersonAsync(w, ct) : null;
        var priority = PriorityOf(a);
        var due = Date(a, "due_date");
        var payload = new { projectId = project.IsPending ? (Guid?)null : project.Id, projectKey = project.Key, projectName = project.Name, title, details = Str(a, "details"), assigneeId = assignee?.Id, assigneeName = assignee?.Name, priority, dueDate = due };
        var summary = $"On {project.Label}{Join(assignee is null ? null : $"for {assignee.Name}", due is null ? null : $"due {Day(due)}")}";
        return Propose("create_action_item", $"Add action item “{title}”", summary, payload, Str(a, "details"));
    }

    private async Task<AiToolOutcome> ProposeReminderAsync(JsonElement a, string? timeZone, CancellationToken ct)
    {
        var text = (Str(a, "text") ?? throw new AiToolException("Say what to remind about.")).Trim();
        if (text.Length is < 2 or > 200) throw new AiToolException("A reminder is 2 to 200 characters.");
        if (!ZoneTime.TryParseLocal(Str(a, "at"), out var local)) throw new AiToolException("Give the time as yyyy-mm-ddTHH:mm, in the person's own time.");
        var zone = ZoneTime.IsKnown(timeZone) ? timeZone!.Trim() : "UTC";
        if (ZoneTime.ToUtc(local, ZoneTime.Find(zone)) <= clock.Now) throw new AiToolException("That time has already passed; choose a later one.");
        var other = Str(a, "for_person") is { } w && !w.Equals("me", StringComparison.OrdinalIgnoreCase) ? await PersonAsync(w, ct) : null;
        var payload = new { title = text, at = ZoneTime.Write(local), timeZone = zone, forUserId = other?.Id, forName = other?.Name };
        return Propose("reminder", $"Remind {(other is null ? "you" : other.Name)}: “{text}”", $"{local:ddd d MMM yyyy, HH:mm}", payload);
    }

    private async Task<AiToolOutcome> ProposeReportAsync(JsonElement a, CancellationToken ct)
    {
        var title = (Str(a, "title") ?? throw new AiToolException("Give the report a title.")).Trim();
        var body = (Str(a, "body") ?? throw new AiToolException("Write the report in 'body'.")).Trim();
        if (title.Length is < 3 or > 120) throw new AiToolException("The title is 3 to 120 characters.");
        if (body.Length is < 20 or > 20_000) throw new AiToolException("The report must be 20 to 20,000 characters.");
        var names = Strs(a, "recipients");
        var people = new List<Person>();
        foreach (var n in names.Count == 0 ? ["me"] : names) { var p = await PersonAsync(n, ct); if (people.All(x => x.Id != p.Id)) people.Add(p); }
        if (people.Count > 10) throw new AiToolException("A report can go to at most 10 people at a time.");
        var payload = new { title, body, recipientIds = people.Select(p => p.Id), recipientNames = people.Select(p => p.Name) };
        return Propose("send_report", $"Email report “{title}”", $"To {string.Join(", ", people.Select(p => p.Id == ctx.UserId ? "you" : p.Name))}", payload, body);
    }

    private static AiToolOutcome Propose(string kind, string title, string summary, object payload, string? preview = null)
    {
        var p = new AiProposal(Guid.NewGuid().ToString("N")[..8], kind, title, summary, JsonSerializer.Serialize(payload, Json),
            Preview: string.IsNullOrWhiteSpace(preview) ? null : preview.Length > 4000 ? preview[..4000] + "…" : preview);
        return new AiToolOutcome($"Proposed: {title} ({summary}). The person will see a card and decide; it has NOT been done. Do not say it is done.", "Prepared a suggestion for you to confirm", 1, p);
    }

    // ------------------------------------------------------------------ finding people and projects by what the person said

    /// <summary>A couple of plain facts about this workspace, so the assistant knows what it is working with (an empty one, a one-person one).</summary>
    public Task<string> OrgFactsAsync(CancellationToken ct) => analysis.OverviewAsync(ct);

    private sealed record Person(Guid Id, string Name, string Email, string Role, string? JobRole);
    private List<Person>? _people;

    private async Task<List<Person>> PeopleAsync(CancellationToken ct)
    {
        if (ctx.Role == TenantRole.Guest) throw new AiToolException("Guests cannot look up other people.");
        var tid = ctx.RequireTenantId();   // TenantMember is not filtered by workspace on its own: without this, people from every organization come back
        return _people ??= (await db.TenantMembers.AsNoTracking().Where(m => m.TenantId == tid && m.Role != TenantRole.Guest && m.User!.IsActive)
            .Select(m => new { m.UserId, m.User!.DisplayName, m.User.Email, m.Role, JobRole = db.OrgRoles.Where(r => r.Id == m.OrgRoleId).Select(r => r.Name).FirstOrDefault() })
            .Take(500).ToListAsync(ct)).Select(m => new Person(m.UserId, m.DisplayName, m.Email, m.Role.ToString(), m.JobRole)).ToList();
    }

    private async Task<Person> PersonAsync(string text, CancellationToken ct)
    {
        var t = text.Trim();
        var me = ctx.RequireUserId();
        if (t.Equals("me", StringComparison.OrdinalIgnoreCase) || t.Equals("myself", StringComparison.OrdinalIgnoreCase) || t.Equals("i", StringComparison.OrdinalIgnoreCase))
            return (await PeopleAsync(ct)).FirstOrDefault(p => p.Id == me) ?? throw new AiToolException("You are not listed as a member who can be assigned work.");
        var people = await PeopleAsync(ct);
        if (Guid.TryParse(t, out var id)) return people.FirstOrDefault(p => p.Id == id) ?? throw new AiToolException("No such person in this workspace.");
        var exact = people.Where(p => p.Name.Equals(t, StringComparison.OrdinalIgnoreCase) || p.Email.Equals(t, StringComparison.OrdinalIgnoreCase)).ToList();
        var found = exact.Count > 0 ? exact : people.Where(p => p.Name.Contains(t, StringComparison.OrdinalIgnoreCase)).ToList();
        return found.Count switch
        {
            1 => found[0],
            0 => throw new AiToolException($"No one is called “{t}”. Use list_people to see who is here."),
            _ => throw new AiToolException($"“{t}” could be {string.Join(", ", found.Take(6).Select(p => p.Name))}. Ask which one."),
        };
    }

    private sealed record ProjectRef(Guid Id, string Key, string Name)
    {
        /// <summary>A project proposed earlier in this same answer: it does not exist until the person confirms it, and the work is attached to it by name then.</summary>
        public bool IsPending => Id == Guid.Empty;
        public string Label => IsPending ? $"the new project “{Name}”" : Key;
    }
    private readonly List<string> _pendingProjects = [];

    private async Task<ProjectRef> ProjectAsync(string text, CancellationToken ct)
    {
        var t = text.Trim();
        var all = await access.VisibleProjects().AsNoTracking().Select(p => new ProjectRef(p.Id, p.Key, p.Name)).Take(500).ToListAsync(ct);
        if (Guid.TryParse(t, out var id)) return all.FirstOrDefault(p => p.Id == id) ?? throw new AiToolException("No such project.");
        var exact = all.Where(p => p.Key.Equals(t, StringComparison.OrdinalIgnoreCase) || p.Name.Equals(t, StringComparison.OrdinalIgnoreCase)).ToList();
        var found = exact.Count > 0 ? exact : all.Where(p => p.Name.Contains(t, StringComparison.OrdinalIgnoreCase)).ToList();
        return found.Count switch
        {
            1 => found[0],
            0 when _pendingProjects.FirstOrDefault(n => n.Equals(t, StringComparison.OrdinalIgnoreCase)) is { } pending => new ProjectRef(Guid.Empty, "NEW", pending),
            0 => throw new AiToolException($"No project matches “{t}”. Use list_projects to see them, or propose creating it with propose_create_project first."),
            _ => throw new AiToolException($"“{t}” could be {string.Join(", ", found.Take(6).Select(p => $"{p.Key} ({p.Name})"))}. Ask which one."),
        };
    }

    private async Task RequireLevelAsync(string module, string what, CancellationToken ct)
    {
        if (await permissions.LevelAsync(module, ct) < AccessLevel.Edit) throw new AiToolException($"The person's role does not allow them to {what}.");
    }

    // ------------------------------------------------------------------ reading arguments

    private static string? Str(JsonElement a, string name) =>
        a.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(v.GetString()) ? v.GetString()!.Trim() : null;

    private static bool? Bool(JsonElement a, string name) => a.TryGetProperty(name, out var v) && v.ValueKind is JsonValueKind.True or JsonValueKind.False ? v.GetBoolean() : null;

    private static List<string> Strs(JsonElement a, string name) =>
        a.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Array ? v.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => x.GetString()!.Trim()).Where(x => x.Length > 0).Take(20).ToList() : [];

    private static DateOnly? Date(JsonElement a, string name) => DateOnly.TryParse(Str(a, name), out var d) ? d : null;

    private static string Title(JsonElement a)
    {
        var t = (Str(a, "title") ?? throw new AiToolException("A title is needed.")).Trim();
        return t.Length is < 3 or > 200 ? throw new AiToolException("The title must be 3 to 200 characters.") : t;
    }

    private static Priority PriorityOf(JsonElement a) => Enum.TryParse<Priority>(Str(a, "priority"), true, out var p) ? p : Priority.Medium;

    private static string Day(DateOnly? d) => d?.ToString("yyyy-MM-dd") ?? "none";

    private static string Join(params string?[] parts) => parts.Where(p => !string.IsNullOrEmpty(p)).ToList() is { Count: > 0 } l ? " — " + string.Join(", ", l) : "";

    /// <summary>One line of someone else's words: no line breaks (so it cannot pose as a new instruction line), no pipes, at most 140 characters.</summary>
    private static string Clean(string s)
    {
        var t = s.Replace("\r", " ").Replace("\n", " ").Replace("|", "/").Trim();
        return t.Length > 140 ? t[..140] + "…" : t;
    }
}
