using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Reports;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Every kind of work together: project tasks, test issues, action items and operational work in one My work list, one workload,
/// one search, one calendar and one timesheet; plus the effective-access view, delivery methods and milestone stages.
/// </summary>
[Collection("api")]
public class WorkItemTests(ApiFactory factory)
{
    private static string Iso(int daysFromToday) => DateOnly.FromDateTime(DateTime.UtcNow).AddDays(daysFromToday).ToString("yyyy-MM-dd");
    private static Guid Id(ApiResult r) => Guid.Parse(r.Data!["id"]!.GetValue<string>());
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private sealed record World(TestClient Owner, TestClient Manager, TestClient Dev, TestClient Other, Guid Project, string Key);

    private async Task<World> Setup()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var manager = await owner.AddMemberAsync(factory, TenantRole.Manager, "Maya Manager");
        var dev = await owner.AddMemberAsync(factory, TenantRole.Member, "Dev Developer");
        var other = await owner.AddMemberAsync(factory, TenantRole.Member, "Olly Other");
        var project = await owner.CreateProjectAsync("Atlas");
        var key = S((await owner.Get($"/api/v1/projects/{project}")).Data!["project"]!["key"]);
        return new World(owner, manager, dev, other, project, key);
    }

    private static async Task<string> TypeId(TestClient c, string name) =>
        S((await c.Get("/api/v1/work-types?includeInactive=true")).Data!.AsArray().Single(t => S(t!["name"]) == name)!["id"]);

    private static async Task<Guid> Work(TestClient c, string title, Guid? assignee = null, string? due = null) =>
        Id(await c.Post("/api/v1/work-tasks", new { title, workTypeId = await TypeId(c, "Bug Fix"), assigneeId = assignee, dueDate = due }));

    private static async Task<Guid> Action(TestClient c, Guid project, string title, Guid? assignee = null, string? due = null) =>
        Id(await c.Post($"/api/v1/projects/{project}/action-items", new { title, assigneeId = assignee, dueDate = due }));

    private static async Task<Guid> Issue(TestClient c, Guid project, string title, Guid assignee)
    {
        var stage = Guid.Parse(S((await c.Get($"/api/v1/projects/{project}/stages")).Data!.AsArray()[1]!["id"]));
        var res = await c.Post($"/api/v1/projects/{project}/issues", new { stageId = stage, title, severity = "High", assigneeId = assignee });
        Assert.True(res.Ok, res.ToString());
        return Guid.Parse(S(res.Data!["issue"]!["id"]));
    }

    private static async Task<JsonArray> MyWork(TestClient c, string query = "") => (await c.Get($"/api/v1/my-work{query}")).Data!.AsArray();

    // ------------------------------------------------------------------ my work

    [Fact]
    public async Task My_work_lists_every_kind_assigned_to_me_on_one_status_scale()
    {
        var w = await Setup();
        await w.Owner.CreateTaskAsync(w.Project, "Build login", new { title = "Build login", priority = "High", assigneeId = w.Dev.UserId, dueDate = Iso(2) });
        await Issue(w.Owner, w.Project, "Login fails on Safari", w.Dev.UserId);
        await Action(w.Owner, w.Project, "Get the sign-off", w.Dev.UserId, Iso(1));
        await Work(w.Owner, "Fix the nightly export", w.Dev.UserId, Iso(5));
        var done = await Action(w.Owner, w.Project, "Already sorted", w.Dev.UserId);
        Assert.True((await w.Owner.Put($"/api/v1/projects/{w.Project}/action-items/{done}/status", new { status = "Completed" })).Ok);
        await Work(w.Owner, "Somebody else's", w.Other.UserId);

        var mine = await MyWork(w.Dev);
        var kinds = mine.Select(x => S(x!["kind"])).ToList();
        Assert.Equal(["ActionItem", "Task", "Operational", "Issue"], kinds);           // soonest due first, the undated issue last
        Assert.Contains(mine, x => S(x!["key"]) == $"{w.Key}-I1" && S(x["category"]) == "Todo" && S(x["status"]) == "Observed");
        Assert.Contains(mine, x => S(x!["key"]).StartsWith("AI-") && S(x["projectName"]) == "Atlas");
        Assert.Contains(mine, x => S(x!["key"]).StartsWith("WT-") && S(x["typeName"]) == "Bug Fix");
        Assert.DoesNotContain(mine, x => S(x!["title"]) == "Already sorted");          // finished work only on request
        Assert.Contains(await MyWork(w.Dev, "?open=false"), x => S(x!["title"]) == "Already sorted");

        var onlyOps = await MyWork(w.Dev, "?kinds=Operational");
        Assert.Equal("Fix the nightly export", S(Assert.Single(onlyOps)!["title"]));
        Assert.Equal(422, (int)(await w.Dev.Get("/api/v1/my-work?kinds=Nonsense")).Status);
    }

    [Fact]
    public async Task Kinds_a_job_role_cannot_open_never_appear_in_my_work_or_search()
    {
        var w = await Setup();
        await w.Owner.CreateTaskAsync(w.Project, "Visible task", new { title = "Visible task", priority = "Low", assigneeId = w.Dev.UserId });
        await Work(w.Owner, "Hidden operational work", w.Dev.UserId);
        Assert.Equal(2, (await MyWork(w.Dev)).Count);

        var role = Id(await w.Owner.Post("/api/v1/org/roles", new { name = "Delivery only" }));
        Assert.Equal(HttpStatusCode.NoContent, (await w.Owner.Put($"/api/v1/org/members/{w.Dev.UserId}/role", new { roleId = role })).Status);
        var modules = new[] { "projects", "tasks", "work", "calendar", "teams", "members", "organization", "reports", "activity", "audit", "billing" }
            .ToDictionary(m => m, m => m is "projects" or "tasks" ? 2 : 0);
        Assert.True((await w.Owner.Put($"/api/v1/org/roles/{role}/access", new { modules, actions = new Dictionary<string, bool>() })).Ok);

        Assert.Equal("Task", S(Assert.Single(await MyWork(w.Dev))!["kind"]));
        Assert.DoesNotContain((await w.Dev.Get("/api/v1/search?q=hidden")).Data!["hits"]!.AsArray(), h => S(h!["type"]) == "work");
    }

    // ------------------------------------------------------------------ action items are work tasks

    [Fact]
    public async Task Action_items_share_the_work_number_sequence_but_stay_out_of_the_operational_list()
    {
        var w = await Setup();
        var op = await Work(w.Owner, "First operational");
        var action = await Action(w.Owner, w.Project, "A follow-up", w.Dev.UserId);

        var listed = (await w.Owner.Get($"/api/v1/projects/{w.Project}/action-items")).Data!.AsArray().Single()!;
        Assert.Equal("AI-2", S(listed["key"]));                                                  // after WT-1, in the same sequence
        Assert.Equal("WT-1", S((await w.Owner.Get($"/api/v1/work-tasks/{op}")).Data!["key"]));
        Assert.DoesNotContain((await w.Owner.Get("/api/v1/work-tasks")).Data!["items"]!.AsArray(), x => S(x!["id"]) == action.ToString());
        Assert.Equal(404, (int)(await w.Owner.Get($"/api/v1/work-tasks/{action}")).Status);       // action items follow their project's rules, not Work's

        var note = (await w.Dev.Get("/api/v1/notifications")).Data!["items"]!.AsArray().Single(n => S(n!["title"]).Contains("A follow-up"))!;
        Assert.Equal($"/projects/{w.Project}?tab=actions&action={action}", S(note["link"]));
    }

    // ------------------------------------------------------------------ time on work tasks

    [Fact]
    public async Task Time_can_be_logged_on_work_tasks_and_appears_in_the_timesheet_but_not_in_project_time()
    {
        var w = await Setup();
        var work = await Work(w.Owner, "Production support", w.Dev.UserId);
        var task = Guid.Parse(S((await w.Owner.CreateTaskAsync(w.Project, "Build it", new { title = "Build it", priority = "Low", assigneeId = w.Dev.UserId }))["id"]));

        Assert.Equal(HttpStatusCode.Created, (await w.Dev.Post($"/api/v1/work-tasks/{work}/time", new { minutes = 30, note = "call" })).Status);
        Assert.Equal(HttpStatusCode.Created, (await w.Dev.Post($"/api/v1/tasks/{task}/time", new { minutes = 60 })).Status);
        var running = await w.Dev.Post($"/api/v1/work-tasks/{work}/timer/start");
        Assert.True(running.Ok, running.ToString());
        Assert.Equal("work", S(running.Data!["kind"]));
        Assert.True((await w.Dev.Post("/api/v1/timer/stop")).Ok);

        var sheet = (await w.Dev.Get("/api/v1/time")).Data!;
        var entries = sheet["entries"]!.AsArray();
        Assert.Equal(2, entries.Count(e => S(e!["kind"]) == "work" && S(e["taskKey"]) == "WT-1"));
        Assert.Contains(entries, e => S(e!["kind"]) == "task" && S(e["taskKey"]).EndsWith("-1"));
        Assert.True((await w.Dev.Get($"/api/v1/work-tasks/{work}")).Data!["loggedMinutes"]!.GetValue<int>() >= 31);

        // Someone who neither raised it nor has it cannot log time on it; project time counts project tasks only.
        Assert.Equal(403, (int)(await w.Other.Post($"/api/v1/work-tasks/{work}/time", new { minutes = 15 })).Status);
        Assert.Equal(60, (await w.Owner.Get($"/api/v1/projects/{w.Project}/time")).Data!["totalMinutes"]!.GetValue<int>());
    }

    // ------------------------------------------------------------------ workload

    [Fact]
    public async Task Workload_counts_every_kind_per_person_in_the_scopes_the_caller_has()
    {
        var w = await Setup();
        Assert.Equal(HttpStatusCode.NoContent, (await w.Owner.Put($"/api/v1/org/members/{w.Dev.UserId}/reports-to", new { reportsToUserId = w.Manager.UserId })).Status);
        await w.Owner.CreateTaskAsync(w.Project, "Late task", new { title = "Late task", priority = "Low", assigneeId = w.Dev.UserId, dueDate = Iso(-2) });
        await Work(w.Owner, "Support ticket", w.Dev.UserId, Iso(3));
        await Action(w.Owner, w.Project, "Chase the vendor", w.Dev.UserId);

        var mgr = (await w.Manager.Get("/api/v1/workload")).Data!;
        Assert.Equal("Reports", S(mgr["scope"]));
        Assert.Equal(["Reports", "Me"], mgr["available"]!.AsArray().Select(S).ToArray());
        var dev = mgr["members"]!.AsArray().Single()!;
        Assert.Equal(3, dev["open"]!.GetValue<int>());
        Assert.Equal(1, dev["overdue"]!.GetValue<int>());
        Assert.Equal(1, dev["openByKind"]!["operational"]!.GetValue<int>());
        Assert.Equal(1, dev["openByKind"]!["actionItems"]!.GetValue<int>());
        Assert.Equal(3, (await w.Manager.Get($"/api/v1/workload/{w.Dev.UserId}")).Data!["openTasks"]!.AsArray().Count);

        var owner = (await w.Owner.Get("/api/v1/workload")).Data!;
        Assert.Equal("Everyone", S(owner["scope"]));
        Assert.Contains(owner["members"]!.AsArray(), m => S(m!["name"]) == "Dev Developer");
        Assert.Equal(403, (int)(await w.Dev.Get("/api/v1/workload?scope=Everyone")).Status);
        Assert.Equal(404, (int)(await w.Dev.Get($"/api/v1/workload/{w.Other.UserId}")).Status);

        // The legacy direct-reports address answers the same reporting-line view, now across every kind.
        Assert.Equal(3, (await w.Manager.Get("/api/v1/my-team")).Data!["members"]!.AsArray().Single()!["open"]!.GetValue<int>());
        Assert.Equal(3, (await w.Manager.Get("/api/v1/direct-reports")).Data!["members"]!.AsArray().Single()!["open"]!.GetValue<int>());
    }

    // ------------------------------------------------------------------ search, calendar, dashboard

    [Fact]
    public async Task Search_calendar_and_the_dashboard_include_action_items_and_operational_work()
    {
        var w = await Setup();
        var op = await Work(w.Owner, "Rotate the certificates", w.Dev.UserId, Iso(1));
        await Action(w.Owner, w.Project, "Confirm the go-live window", w.Dev.UserId, Iso(2));

        var byKey = (await w.Dev.Get("/api/v1/search?q=WT-1")).Data!["hits"]!.AsArray();
        Assert.Contains(byKey, h => S(h!["type"]) == "work" && S(h["id"]) == op.ToString());
        Assert.Contains((await w.Dev.Get("/api/v1/search?q=go-live")).Data!["hits"]!.AsArray(), h => S(h!["type"]) == "action");

        var cal = (await w.Dev.Get($"/api/v1/calendar?from={Iso(0)}&to={Iso(10)}&mine=true")).Data!.AsArray().Select(e => S(e!["type"])).ToList();
        Assert.Contains("work", cal);
        Assert.Contains("action", cal);

        var dash = (await w.Dev.Get("/api/v1/dashboard")).Data!;
        Assert.Equal(2, dash["counts"]!["myOpen"]!.GetValue<int>());
        Assert.Equal(2, dash["myWork"]!.AsArray().Count);
    }

    // ------------------------------------------------------------------ comments

    [Fact]
    public async Task People_mentioned_in_a_work_task_comment_are_told()
    {
        var w = await Setup();
        var work = await Work(w.Owner, "Investigate the slowdown", w.Dev.UserId);
        Assert.Equal(HttpStatusCode.Created, (await w.Dev.Post($"/api/v1/work-tasks/{work}/comments", new { body = "@Olly Other can you check the logs?", mentionUserIds = new[] { w.Other.UserId } })).Status);
        var note = (await w.Other.Get("/api/v1/notifications")).Data!["items"]!.AsArray().Single(n => S(n!["title"]).StartsWith("You were mentioned on WT-1"))!;
        Assert.Equal($"/operations?task={work}", S(note["link"]));
    }

    // ------------------------------------------------------------------ one export path

    [Fact]
    public async Task Work_tasks_are_a_generated_report_written_by_the_same_writer_as_the_instant_export()
    {
        var w = await Setup();
        await Work(w.Owner, "=HYPERLINK(\"http://evil\")");
        var res = await w.Owner.Post("/api/v1/reports/exports", new { kind = "WorkTasks", format = "Csv" });
        Assert.Equal(HttpStatusCode.Accepted, res.Status);
        await factory.Services.GetRequiredService<ReportExportProcessor>().ProcessPendingAsync();
        var file = await w.Owner.Raw($"/api/v1/reports/exports/{Id(res)}/file");
        Assert.Equal(HttpStatusCode.OK, file.StatusCode);
        var csv = Encoding.UTF8.GetString(await file.Content.ReadAsByteArrayAsync());
        Assert.Contains("Key,Title,Work type", csv);
        Assert.Contains("'=HYPERLINK", csv);
        Assert.DoesNotContain(",=HYPERLINK", csv);

        // Someone without Work management cannot ask for it.
        var role = Id(await w.Owner.Post("/api/v1/org/roles", new { name = "No work" }));
        Assert.Equal(HttpStatusCode.NoContent, (await w.Owner.Put($"/api/v1/org/members/{w.Manager.UserId}/role", new { roleId = role })).Status);
        var modules = new[] { "projects", "tasks", "work", "calendar", "teams", "members", "organization", "reports", "activity", "audit", "billing" }
            .ToDictionary(m => m, m => m is "work" ? 0 : m is "reports" ? 1 : 1);
        Assert.True((await w.Owner.Put($"/api/v1/org/roles/{role}/access", new { modules, actions = new Dictionary<string, bool>() })).Ok);
        Assert.Equal(403, (int)(await w.Manager.Post("/api/v1/reports/exports", new { kind = "WorkTasks", format = "Csv" })).Status);
    }

    // ------------------------------------------------------------------ one access model, visible

    [Fact]
    public async Task Effective_access_names_the_one_rule_that_decides_each_person_and_the_matrix_lists_who_it_skips()
    {
        var w = await Setup();
        var role = Id(await w.Owner.Post("/api/v1/org/roles", new { name = "Viewer" }));
        Assert.Equal(HttpStatusCode.NoContent, (await w.Owner.Put($"/api/v1/org/members/{w.Dev.UserId}/role", new { roleId = role })).Status);
        var modules = new[] { "projects", "tasks", "work", "calendar", "teams", "members", "organization", "reports", "activity", "audit", "billing" }
            .ToDictionary(m => m, m => m is "projects" or "tasks" ? 1 : 0);
        Assert.True((await w.Owner.Put($"/api/v1/org/roles/{role}/access", new { modules, actions = new Dictionary<string, bool>() })).Ok);

        var eff = (await w.Owner.Get("/api/v1/org/access/effective")).Data!;
        string SourceOf(string name) => S(eff["people"]!.AsArray().Single(p => S(p!["name"]) == name)!["source"]);
        Assert.Equal("Owner", SourceOf("Olivia Owner"));
        Assert.Equal("JobRole", SourceOf("Dev Developer"));
        Assert.Equal("AccessLevel", SourceOf("Olly Other"));
        Assert.Equal(1, eff["byJobRole"]!.GetValue<int>());
        var dev = eff["people"]!.AsArray().Single(p => S(p!["name"]) == "Dev Developer")!;
        Assert.Equal(0, dev["modules"]!["work"]!.GetValue<int>());
        Assert.DoesNotContain(dev["permissions"]!.AsArray(), p => S(p) == "tasks.create");

        Assert.Contains("Dev Developer (Viewer)", (await w.Owner.Get("/api/v1/workspace/permissions")).Data!["notAppliedTo"]!.AsArray().Select(S));
        Assert.Equal(403, (int)(await w.Other.Get("/api/v1/org/access/effective")).Status);
    }

    // ------------------------------------------------------------------ delivery method and milestone stages

    [Fact]
    public async Task Projects_have_a_delivery_method_and_a_milestone_can_mark_one_of_its_stages()
    {
        var w = await Setup();
        var project = (await w.Owner.Get($"/api/v1/projects/{w.Project}")).Data!["project"]!;
        Assert.Equal("Hybrid", S(project["deliveryMethod"]));
        var updated = await w.Owner.Put($"/api/v1/projects/{w.Project}", new { name = "Atlas", priority = "Medium", status = "Planning", version = project["version"]!.GetValue<int>(), deliveryMethod = "Agile" });
        Assert.True(updated.Ok, updated.ToString());
        Assert.Equal("Agile", S(updated.Data!["project"]!["deliveryMethod"]));
        var created = await w.Owner.Post("/api/v1/projects", new { name = "Phased one", priority = "Low", deliveryMethod = "Phased" });
        Assert.Equal("Phased", S(created.Data!["project"]!["deliveryMethod"]));

        var stage = (await w.Owner.Get($"/api/v1/projects/{w.Project}/stages")).Data!.AsArray()[2]!;
        var ms = await w.Owner.Post($"/api/v1/projects/{w.Project}/milestones", new { name = "Design approved", status = "Pending", stageId = S(stage["id"]) });
        Assert.True(ms.Ok, ms.ToString());
        Assert.Equal(S(stage["name"]), S(ms.Data!.AsArray().Single()!["stageName"]));

        var otherStage = S((await w.Owner.Get($"/api/v1/projects/{S(created.Data!["project"]!["id"])}/stages")).Data!.AsArray()[1]!["id"]);
        var wrong = await w.Owner.Post($"/api/v1/projects/{w.Project}/milestones", new { name = "Wrong", status = "Pending", stageId = otherStage });
        Assert.Equal(422, (int)wrong.Status);
        Assert.Equal("stageId", S(wrong.Json!["errors"]![0]!["field"]));
    }
}
