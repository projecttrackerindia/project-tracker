using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Application.Features.WorkItems;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
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
    WorkItemService workItems, ProjectStatusService status, WorkloadService workload, ILogger<AiToolbox> log)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };
    private const int ListCap = 40;

    public const string FindWork = "find_work", ListProjects = "list_projects", ProjectReport = "project_report", TeamWorkload = "team_workload",
        ListPeople = "list_people", MyWorkSummary = "my_work_summary",
        CreateTask = "propose_create_task", CreateWork = "propose_create_work", CreateActionItem = "propose_create_action_item",
        CreateReminder = "propose_reminder", SendReport = "propose_send_report";

    public static readonly string[] WriteTools = [CreateTask, CreateWork, CreateActionItem, CreateReminder, SendReport];

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
        };
        if (!actionsAllowed) return tools;
        tools.AddRange(
        [
            new(CreateTask, "Propose a new task on a project. The person sees a card and confirms before anything is created.",
                """
                {"type":"object","properties":{"project":{"type":"string"},"title":{"type":"string"},"description":{"type":"string"},
                 "assignee":{"type":"string","description":"A person's name or \"me\"."},"priority":{"type":"string","enum":["Low","Medium","High","Critical"]},
                 "due_date":{"type":"string","description":"yyyy-mm-dd"}},"required":["project","title"]}
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
            DueFrom: Date(a, "due_from"), DueTo: Date(a, "due_to"), Overdue: Bool(a, "overdue") ?? false, Q: Str(a, "text"), Limit: 200), WorkItemScope.Caller, ct);
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

    private async Task<AiToolOutcome> ProposeTaskAsync(JsonElement a, CancellationToken ct)
    {
        await RequireLevelAsync(Modules.Tasks, "create tasks", ct);
        var project = await ProjectAsync(Str(a, "project") ?? throw new AiToolException("Say which project."), ct);
        var title = Title(a);
        var assignee = Str(a, "assignee") is { } w ? await PersonAsync(w, ct) : null;
        var priority = PriorityOf(a);
        var due = Date(a, "due_date");
        var payload = new { projectId = project.Id, projectKey = project.Key, title, description = Str(a, "description"), assigneeId = assignee?.Id, assigneeName = assignee?.Name, priority, dueDate = due };
        var summary = $"In {project.Key}{Join(assignee is null ? null : $"assigned to {assignee.Name}", $"{priority} priority", due is null ? null : $"due {Day(due)}")}";
        return Propose("create_task", $"Create task “{title}”", summary, payload, Str(a, "description"));
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
        var payload = new { title, description = Str(a, "description"), workTypeId = type.Id, workType = type.Name, projectId = project?.Id, projectKey = project?.Key, assigneeId = assignee?.Id, assigneeName = assignee?.Name, priority, dueDate = due };
        var summary = $"{type.Name}{Join(project is null ? null : $"related to {project.Key}", assignee is null ? null : $"assigned to {assignee.Name}", $"{priority} priority", due is null ? null : $"due {Day(due)}")}";
        return Propose("create_work", $"Create work “{title}”", summary, payload, Str(a, "description"));
    }

    private async Task<AiToolOutcome> ProposeActionItemAsync(JsonElement a, CancellationToken ct)
    {
        var project = await ProjectAsync(Str(a, "project") ?? throw new AiToolException("Say which project."), ct);
        var title = Title(a);
        var assignee = Str(a, "assignee") is { } w ? await PersonAsync(w, ct) : null;
        var priority = PriorityOf(a);
        var due = Date(a, "due_date");
        var payload = new { projectId = project.Id, projectKey = project.Key, title, details = Str(a, "details"), assigneeId = assignee?.Id, assigneeName = assignee?.Name, priority, dueDate = due };
        var summary = $"On {project.Key}{Join(assignee is null ? null : $"for {assignee.Name}", due is null ? null : $"due {Day(due)}")}";
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

    private sealed record Person(Guid Id, string Name, string Email, string Role, string? JobRole);
    private List<Person>? _people;

    private async Task<List<Person>> PeopleAsync(CancellationToken ct)
    {
        if (ctx.Role == TenantRole.Guest) throw new AiToolException("Guests cannot look up other people.");
        return _people ??= (await db.TenantMembers.AsNoTracking().Where(m => m.Role != TenantRole.Guest && m.User!.IsActive)
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

    private sealed record ProjectRef(Guid Id, string Key, string Name);

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
            0 => throw new AiToolException($"No project matches “{t}”. Use list_projects to see them."),
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
