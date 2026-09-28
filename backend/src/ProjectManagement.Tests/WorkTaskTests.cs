using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Project types, and work tasks: operational work kept apart from a project's own tasks.</summary>
[Collection("api")]
public class WorkTaskTests(ApiFactory factory)
{
    private static string Iso(int daysFromToday) => DateOnly.FromDateTime(DateTime.UtcNow).AddDays(daysFromToday).ToString("yyyy-MM-dd");
    private static byte[] Pdf() => "%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF"u8.ToArray();
    private static Guid Id(ApiResult r) => Guid.Parse(r.Data!["id"]!.GetValue<string>());
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private sealed record World(TestClient Owner, TestClient Admin, TestClient Manager, TestClient Dev, TestClient Other, TestClient Guest, Guid Project);

    private async Task<World> Setup()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var admin = await owner.AddMemberAsync(factory, TenantRole.Admin, "Ada Admin");
        var manager = await owner.AddMemberAsync(factory, TenantRole.Manager, "Maya Manager");
        var dev = await owner.AddMemberAsync(factory, TenantRole.Member, "Dev Developer");
        var other = await owner.AddMemberAsync(factory, TenantRole.Member, "Olly Other");
        var guest = await owner.AddMemberAsync(factory, TenantRole.Guest, "Gus Guest");
        var project = await owner.CreateProjectAsync("Payment Engine");
        return new World(owner, admin, manager, dev, other, guest, project);
    }

    private static async Task<string> TypeId(TestClient c, string name)
    {
        var list = (await c.Get("/api/v1/work-types?includeInactive=true")).Data!.AsArray();
        return S(list.Single(t => S(t!["name"]) == name)!["id"]);
    }

    private static async Task<ApiResult> Create(TestClient c, string title, string type = "Bug Fix", object? extra = null)
    {
        var body = new JsonObject { ["title"] = title, ["workTypeId"] = await TypeId(c, type) };
        if (extra is not null) foreach (var (k, v) in System.Text.Json.JsonSerializer.SerializeToNode(extra, new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web))!.AsObject().ToList()) body[k] = v?.DeepClone();
        return await c.Post("/api/v1/work-tasks", body);
    }

    private static async Task<JsonArray> Items(TestClient c, string query = "") => (await c.Get($"/api/v1/work-tasks?{query}")).Data!["items"]!.AsArray();

    private static async Task<string> ProjectStatus(TestClient c, Guid project) => S((await c.Get($"/api/v1/projects/{project}")).Data!["project"]!["status"]);

    private static async Task Complete(TestClient c, Guid project)
    {
        var version = (await c.Get($"/api/v1/projects/{project}")).Data!["project"]!["version"]!.GetValue<int>();
        var r = await c.Put($"/api/v1/projects/{project}", new { name = "Payment Engine", priority = "Medium", status = "Completed", version });
        Assert.True(r.Ok, r.ToString());
    }

    // ------------------------------------------------------------------ project type

    [Fact]
    public async Task A_new_project_needs_a_project_type_and_it_is_kept_and_shown_wherever_the_project_is()
    {
        var w = await Setup();
        w.Owner.AutoProjectType = false;
        var none = await w.Owner.Post("/api/v1/projects", new { name = "No type", priority = "Medium" });
        Assert.Equal(422, (int)none.Status);
        Assert.Equal("projectType", S(none.Json["errors"]![0]!["field"]));
        var bad = await w.Owner.Post("/api/v1/projects", new { name = "Bad type", priority = "Medium", projectType = "Nonsense" });
        Assert.False(bad.Ok);

        var made = await w.Owner.Post("/api/v1/projects", new { name = "Employee Portal - Approval Workflow", priority = "Medium", projectType = "Enhancement" });
        Assert.True(made.Ok, made.ToString());
        var id = Guid.Parse(S(made.Data!["project"]!["id"]));
        Assert.Equal("Enhancement", S(made.Data!["project"]!["projectType"]));
        Assert.Equal("Enhancement", S((await w.Owner.Get($"/api/v1/projects/{id}")).Data!["project"]!["projectType"]));
        Assert.Equal("Enhancement", S((await w.Owner.Get("/api/v1/projects?pageSize=50")).Data!["items"]!.AsArray().Single(p => S(p!["id"]) == id.ToString())!["projectType"]));

        // the Project Status page carries it too
        var status = await w.Owner.Get($"/api/v1/project-status/projects/{id}");
        Assert.Equal("Enhancement", S(status.Data!["project"]!["projectType"]));

        // it can be changed later, and the list filters by it
        var version = (await w.Owner.Get($"/api/v1/projects/{id}")).Data!["project"]!["version"]!.GetValue<int>();
        var edit = await w.Owner.Put($"/api/v1/projects/{id}", new { name = "Employee Portal - Approval Workflow", priority = "Medium", status = "Planning", version, projectType = "Migration" });
        Assert.True(edit.Ok, edit.ToString());
        Assert.Equal("Migration", S(edit.Data!["project"]!["projectType"]));
        var migrations = (await w.Owner.Get("/api/v1/projects?projectType=Migration&pageSize=50")).Data!["items"]!.AsArray();
        Assert.Single(migrations);
        Assert.Empty((await w.Owner.Get("/api/v1/projects?projectType=Upgrade&pageSize=50")).Data!["items"]!.AsArray());

        // an update that does not mention it leaves it alone
        var v2 = (await w.Owner.Get($"/api/v1/projects/{id}")).Data!["project"]!["version"]!.GetValue<int>();
        var keep = await w.Owner.Put($"/api/v1/projects/{id}", new { name = "Employee Portal - Approval Workflow", priority = "High", status = "Planning", version = v2 });
        Assert.Equal("Migration", S(keep.Data!["project"]!["projectType"]));
    }

    // ------------------------------------------------------------------ work types

    [Fact]
    public async Task Work_types_start_as_the_standard_set_and_the_workspace_can_manage_them()
    {
        var w = await Setup();
        var list = (await w.Dev.Get("/api/v1/work-types")).Data!.AsArray();
        Assert.Equal(14, list.Count);
        Assert.Equal("Bug Fix", S(list[0]!["name"]));
        Assert.Equal("Other", S(list[13]!["name"]));

        // only the people who manage work types can change the list
        Assert.Equal(403, (int)(await w.Dev.Post("/api/v1/work-types", new { name = "Hotfix" })).Status);
        Assert.Equal(403, (int)(await w.Manager.Post("/api/v1/work-types", new { name = "Hotfix" })).Status);
        var added = await w.Admin.Post("/api/v1/work-types", new { name = "  Hotfix  ", description = "Emergency production fix" });
        Assert.True(added.Ok, added.ToString());
        Assert.Equal("Hotfix", S(added.Data!["name"]));
        Assert.Equal(15, (await w.Dev.Get("/api/v1/work-types")).Data!.AsArray().Count);
        Assert.Equal(422, (int)(await w.Admin.Post("/api/v1/work-types", new { name = "hotfix" })).Status);   // names are unique, ignoring case
        Assert.Equal(422, (int)(await w.Admin.Post("/api/v1/work-types", new { name = " " })).Status);

        // rename
        var hotfix = Id(added);
        Assert.Equal("Emergency fix", S((await w.Admin.Put($"/api/v1/work-types/{hotfix}", new { name = "Emergency fix" })).Data!["name"]));

        // reorder: the new order comes back
        var ids = (await w.Admin.Get("/api/v1/work-types")).Data!.AsArray().Select(t => S(t!["id"])).Reverse().ToList();
        Assert.True((await w.Admin.Put("/api/v1/work-types/order", new { ids })).Ok);
        Assert.Equal(ids, (await w.Admin.Get("/api/v1/work-types")).Data!.AsArray().Select(t => S(t!["id"])).ToList());
        Assert.Equal(422, (int)(await w.Admin.Put("/api/v1/work-types/order", new { ids = ids.Take(3).ToList() })).Status);

        // an unused type can be deleted; one that work uses can only be deactivated
        Assert.True((await w.Admin.Delete($"/api/v1/work-types/{hotfix}")).Ok);
        var bug = await TypeId(w.Dev, "Bug Fix");
        Assert.True((await Create(w.Dev, "Fix the totals")).Ok);
        var inUse = await w.Admin.Delete($"/api/v1/work-types/{bug}");
        Assert.Equal(409, (int)inUse.Status);
        Assert.Equal("WORK_TYPE_IN_USE", S(inUse.Json["errors"]![0]!["code"]));

        var off = await w.Admin.Put($"/api/v1/work-types/{bug}", new { name = "Bug Fix", isActive = false });
        Assert.False(off.Data!["isActive"]!.GetValue<bool>());
        Assert.DoesNotContain((await w.Dev.Get("/api/v1/work-types")).Data!.AsArray(), t => S(t!["name"]) == "Bug Fix");
        Assert.Contains((await w.Admin.Get("/api/v1/work-types?includeInactive=true")).Data!.AsArray(), t => S(t!["name"]) == "Bug Fix");
        var refused = await w.Dev.Post("/api/v1/work-tasks", new { title = "Another bug", workTypeId = bug });
        Assert.Equal(422, (int)refused.Status);
        Assert.Equal("workTypeId", S(refused.Json["errors"]![0]!["field"]));
        // the task that already has it keeps it, and can still be edited
        var existing = (await Items(w.Dev)).Single();
        var edit = await w.Dev.Put($"/api/v1/work-tasks/{S(existing!["id"])}", new { title = "Fix the totals!", workTypeId = bug, priority = "Medium", status = "ToDo", version = existing["version"]!.GetValue<int>() });
        Assert.True(edit.Ok, edit.ToString());
    }

    [Fact]
    public async Task Guests_have_no_access_to_work_management()
    {
        var w = await Setup();
        Assert.Equal(403, (int)(await w.Guest.Get("/api/v1/work-tasks")).Status);
        Assert.Equal(403, (int)(await w.Guest.Get("/api/v1/work-types")).Status);
        Assert.Equal(403, (int)(await w.Guest.Post("/api/v1/work-tasks", new { title = "Nope" })).Status);
    }

    // ------------------------------------------------------------------ work tasks

    [Fact]
    public async Task A_work_task_is_created_with_a_type_and_can_have_a_related_project_an_assignee_a_priority_and_a_due_date()
    {
        var w = await Setup();
        var made = await Create(w.Dev, "  Fix production issue in payment calculation ", "Bug Fix",
            new { relatedProjectId = w.Project, assigneeId = w.Other.UserId, priority = "High", dueDate = Iso(3), description = "Rounding is wrong on refunds" });
        Assert.True(made.Ok, made.ToString());
        var d = made.Data!;
        Assert.Equal("Fix production issue in payment calculation", S(d["title"]));
        Assert.Equal("WT-1", S(d["key"]));
        Assert.Equal("Bug Fix", S(d["workType"]));
        Assert.Equal("ToDo", S(d["status"]));
        Assert.Equal("High", S(d["priority"]));
        Assert.Equal(w.Project.ToString(), S(d["relatedProject"]!["id"]));
        Assert.Equal("Payment Engine", S(d["relatedProject"]!["name"]));
        Assert.Equal(w.Other.UserId.ToString(), S(d["assignee"]!["id"]));
        Assert.Equal(w.Dev.UserId.ToString(), S(d["reporter"]!["id"]));
        Assert.Equal(Iso(3), S(d["dueDate"]));

        Assert.Equal("WT-2", S((await Create(w.Dev, "Second")).Data!["key"]));   // running numbers
        Assert.Equal(2, (await Items(w.Owner)).Count);

        // validation
        Assert.Equal(422, (int)(await w.Dev.Post("/api/v1/work-tasks", new { title = "No type" })).Status);
        Assert.Equal(422, (int)(await Create(w.Dev, "  ")).Status);
        Assert.Equal(422, (int)(await Create(w.Dev, new string('x', 201))).Status);
        Assert.Equal(422, (int)(await Create(w.Dev, "Backwards", "Bug Fix", new { startDate = Iso(5), dueDate = Iso(1) })).Status);
        Assert.Equal(422, (int)(await Create(w.Dev, "Ghost project", "Bug Fix", new { relatedProjectId = Guid.NewGuid() })).Status);
        Assert.Equal(422, (int)(await Create(w.Dev, "For a guest", "Bug Fix", new { assigneeId = w.Guest.UserId })).Status);
        Assert.Equal(422, (int)(await w.Dev.Post("/api/v1/work-tasks", new { title = "Bad type", workTypeId = Guid.NewGuid() })).Status);
    }

    [Fact]
    public async Task A_work_task_does_not_need_a_project()
    {
        var w = await Setup();
        var made = await Create(w.Dev, "Prepare monthly operational report", "Report Preparation");
        Assert.True(made.Ok, made.ToString());
        Assert.Equal(JsonValueKind.Null, made.Data!["relatedProject"]?.GetValueKind() ?? JsonValueKind.Null);
        Assert.Single(await Items(w.Owner, "noProject=true"));
        Assert.Empty(await Items(w.Owner, $"relatedProjectId={w.Project}"));
    }

    [Fact]
    public async Task Work_on_a_completed_project_never_reopens_it_and_never_shows_up_among_its_tasks()
    {
        var w = await Setup();
        await w.Owner.CreateTaskAsync(w.Project, "Build the engine");
        await Complete(w.Owner, w.Project);
        Assert.Equal("Completed", await ProjectStatus(w.Owner, w.Project));
        var before = (await w.Owner.Get($"/api/v1/projects/{w.Project}")).Data!["project"]!;

        var made = await Create(w.Dev, "Fix production issue in payment calculation", "Bug Fix", new { relatedProjectId = w.Project, priority = "High" });
        Assert.True(made.Ok, made.ToString());
        var id = Id(made);
        Assert.Equal("Completed", await ProjectStatus(w.Owner, w.Project));

        // move it through its own flow: the project is untouched all along
        foreach (var status in new[] { "InProgress", "OnHold", "InProgress", "Completed" })
        {
            var r = await w.Dev.Put($"/api/v1/work-tasks/{id}/status", new { status });
            Assert.True(r.Ok, r.ToString());
            Assert.Equal("Completed", await ProjectStatus(w.Owner, w.Project));
        }
        var after = (await w.Owner.Get($"/api/v1/projects/{w.Project}")).Data!["project"]!;
        Assert.Equal(before["version"]!.GetValue<int>(), after["version"]!.GetValue<int>());
        Assert.Equal(before["progress"]!.GetValue<int>(), after["progress"]!.GetValue<int>());
        Assert.Equal(before["stats"]!["total"]!.GetValue<int>(), after["stats"]!["total"]!.GetValue<int>());

        // the project's task list holds only its own tasks; the project's history is not filled with work activity
        var tasks = (await w.Owner.Get($"/api/v1/projects/{w.Project}/tasks?pageSize=50")).Data!["items"]!.AsArray();
        Assert.Single(tasks);
        Assert.DoesNotContain((await w.Owner.Get($"/api/v1/projects/{w.Project}/activity?pageSize=50")).Data!["items"]!.AsArray(), a => S(a!["summary"]).Contains("WT-"));

        // an archived project can be referenced too
        var project2 = await w.Owner.CreateProjectAsync("Legacy CRM");
        var v = (await w.Owner.Get($"/api/v1/projects/{project2}")).Data!["project"]!["version"]!.GetValue<int>();
        Assert.True((await w.Owner.Put($"/api/v1/projects/{project2}", new { name = "Legacy CRM", priority = "Medium", status = "Archived", version = v })).Ok);
        Assert.True((await Create(w.Dev, "Look into the old data", "Issue Analysis", new { relatedProjectId = project2 })).Ok);
    }

    [Fact]
    public async Task Completing_and_reopening_a_work_task_sets_and_clears_the_completion_time()
    {
        var w = await Setup();
        var id = Id(await Create(w.Dev, "Analyse the API timeout", "Issue Analysis"));
        Assert.Equal(JsonValueKind.Null, (await w.Dev.Get($"/api/v1/work-tasks/{id}")).Data!["completedAt"]?.GetValueKind() ?? JsonValueKind.Null);
        var done = await w.Dev.Put($"/api/v1/work-tasks/{id}/status", new { status = "Completed" });
        Assert.NotNull(done.Data!["completedAt"]);
        Assert.Equal("Completed", S(done.Data["status"]));
        var reopened = await w.Dev.Put($"/api/v1/work-tasks/{id}/status", new { status = "InProgress" });
        Assert.Equal(JsonValueKind.Null, reopened.Data!["completedAt"]?.GetValueKind() ?? JsonValueKind.Null);
    }

    [Fact]
    public async Task Work_tasks_can_be_searched_filtered_sorted_and_paged()
    {
        var w = await Setup();
        var payments = w.Project; var portal = await w.Owner.CreateProjectAsync("Employee Portal");
        await Create(w.Dev, "Fix login issue", "Bug Fix", new { relatedProjectId = portal, assigneeId = w.Dev.UserId, priority = "High", dueDate = Iso(-2) });
        await Create(w.Dev, "Prepare August data", "Data Preparation", new { relatedProjectId = payments, assigneeId = w.Other.UserId, priority = "Medium", dueDate = Iso(4) });
        var done = Id(await Create(w.Dev, "Generate audit report", "Report Preparation", new { assigneeId = w.Manager.UserId, priority = "Low", dueDate = Iso(9) }));
        await w.Manager.Put($"/api/v1/work-tasks/{done}/status", new { status = "Completed" });
        await Create(w.Dev, "Analyse API timeout", "Issue Analysis", new { relatedProjectId = portal, priority = "Critical" });

        static List<string> Titles(JsonArray a) => a.Select(t => S(t!["title"])).ToList();
        Assert.Equal(4, (await Items(w.Owner)).Count);
        Assert.Equal(["Fix login issue"], Titles(await Items(w.Owner, $"workTypeId={await TypeId(w.Owner, "Bug Fix")}")));
        Assert.Equal(2, (await Items(w.Owner, $"relatedProjectId={portal}")).Count);
        Assert.Equal(["Prepare August data"], Titles(await Items(w.Owner, $"assigneeId={w.Other.UserId}")));
        Assert.Equal(["Analyse API timeout"], Titles(await Items(w.Owner, "priority=Critical")));
        Assert.Equal(["Generate audit report"], Titles(await Items(w.Owner, "status=Completed")));
        Assert.Equal(3, (await Items(w.Owner, "open=true")).Count);
        Assert.Equal(["Fix login issue"], Titles(await Items(w.Owner, "overdue=true")));
        Assert.Equal(["Prepare August data"], Titles(await Items(w.Owner, $"dueFrom={Iso(1)}&dueTo={Iso(5)}")));
        Assert.Equal(["Analyse API timeout"], Titles(await Items(w.Owner, "q=timeout")));
        Assert.Equal(["Fix login issue"], Titles(await Items(w.Owner, "q=WT-1")));
        Assert.Equal(["Fix login issue"], Titles(await Items(w.Dev, "mine=true")));
        Assert.Equal(["Generate audit report"], Titles(await Items(w.Manager, "mine=true")));

        // default order: open first, soonest due first (undated last); finished ones at the end
        Assert.Equal(["Fix login issue", "Prepare August data", "Analyse API timeout", "Generate audit report"], Titles(await Items(w.Owner)));
        Assert.Equal(["Analyse API timeout", "Fix login issue", "Generate audit report", "Prepare August data"], Titles(await Items(w.Owner, "sort=title")));
        Assert.Equal(["Prepare August data", "Generate audit report", "Fix login issue", "Analyse API timeout"], Titles(await Items(w.Owner, "sort=-title")));
        Assert.Equal("Analyse API timeout", Titles(await Items(w.Owner, "sort=priority"))[0]);
        Assert.Equal("Data Preparation", S((await Items(w.Owner, "sort=type"))[1]!["workType"]));

        var page = (await w.Owner.Get("/api/v1/work-tasks?pageSize=2&page=2")).Data!;
        Assert.Equal(2, page["items"]!.AsArray().Count);
        Assert.Equal(4, page["totalItems"]!.GetValue<int>());
    }

    [Fact]
    public async Task Who_may_change_or_delete_a_work_task()
    {
        var w = await Setup();
        var id = Id(await Create(w.Dev, "Fix the totals", "Bug Fix", new { assigneeId = w.Other.UserId }));
        var bugType = await TypeId(w.Dev, "Bug Fix");
        var body = (int version) => new { title = "Fix the totals (edited)", workTypeId = bugType, priority = "High", status = "InProgress", version };

        // people see everything but a member may only change what is theirs (assigned to them or raised by them); a manager can change any
        var seen = (await w.Other.Get($"/api/v1/work-tasks/{id}")).Data!;
        Assert.True(seen["can"]!["edit"]!.GetValue<bool>());
        var unrelated = await w.Owner.AddMemberAsync(factory, TenantRole.Member, "Una Related");
        Assert.False((await unrelated.Get($"/api/v1/work-tasks/{id}")).Data!["can"]!["edit"]!.GetValue<bool>());
        Assert.Equal(403, (int)(await unrelated.Put($"/api/v1/work-tasks/{id}/status", new { status = "Completed" })).Status);
        Assert.Equal(403, (int)(await unrelated.Put($"/api/v1/work-tasks/{id}", body(1))).Status);

        Assert.True((await w.Other.Put($"/api/v1/work-tasks/{id}", body(1))).Ok);      // the assignee
        Assert.True((await w.Manager.Put($"/api/v1/work-tasks/{id}", body(2))).Ok);    // anyone's, with the edit permission
        var stale = await w.Dev.Put($"/api/v1/work-tasks/{id}", body(1));               // the person who raised it, but with an old version
        Assert.Equal(409, (int)stale.Status);
        Assert.Equal("VERSION_CONFLICT", S(stale.Json["errors"]![0]!["code"]));
        Assert.True((await w.Dev.Put($"/api/v1/work-tasks/{id}", body(3))).Ok);

        // delete: the manager can; the assignee cannot; the person who raised it can
        Assert.Equal(403, (int)(await w.Other.Delete($"/api/v1/work-tasks/{id}")).Status);
        var second = Id(await Create(w.Dev, "Second"));
        Assert.True((await w.Dev.Delete($"/api/v1/work-tasks/{second}")).Ok);
        Assert.True((await w.Manager.Delete($"/api/v1/work-tasks/{id}")).Ok);
        Assert.Equal(404, (int)(await w.Owner.Get($"/api/v1/work-tasks/{id}")).Status);
        Assert.Empty(await Items(w.Owner));
    }

    [Fact]
    public async Task Assigning_a_work_task_notifies_the_assignee_and_every_change_is_in_its_history()
    {
        var w = await Setup();
        var id = Id(await Create(w.Dev, "Sort out access", "Configuration Change", new { assigneeId = w.Other.UserId, dueDate = Iso(2) }));
        var note = (await w.Other.Get("/api/v1/notifications")).Data!["items"]!.AsArray().Single(n => S(n!["title"]).Contains("Sort out access"))!;
        Assert.Contains("/work", S(note["link"]));
        Assert.DoesNotContain((await w.Dev.Get("/api/v1/notifications")).Data!["items"]!.AsArray(), n => S(n!["title"]).Contains("Sort out access"));

        var v = (await w.Dev.Get($"/api/v1/work-tasks/{id}")).Data!["version"]!.GetValue<int>();
        Assert.True((await w.Dev.Put($"/api/v1/work-tasks/{id}", new { title = "Sort out access", workTypeId = await TypeId(w.Dev, "Configuration Change"), assigneeId = w.Manager.UserId, priority = "Critical", status = "InProgress", dueDate = Iso(6), version = v })).Ok);
        Assert.Contains((await w.Manager.Get("/api/v1/notifications")).Data!["items"]!.AsArray(), n => S(n!["title"]).Contains("Sort out access"));

        var history = (await w.Owner.Get($"/api/v1/work-tasks/{id}/history")).Data!.AsArray().Select(a => S(a!["summary"])).ToList();
        Assert.Contains(history, s => s.Contains("Created work task WT-1"));
        Assert.Contains(history, s => s.Contains("To Do → In Progress"));
        Assert.Contains(history, s => s.Contains("priority Medium → Critical") && s.Contains("assignee"));
        Assert.Contains(history, s => s.Contains("due date"));
    }

    [Fact]
    public async Task Work_tasks_have_their_own_comments_and_files()
    {
        var w = await Setup();
        var id = Id(await Create(w.Dev, "Data correction for July", "Data Correction", new { assigneeId = w.Other.UserId }));
        var url = $"/api/v1/work-tasks/{id}";

        // comments
        var c = await w.Other.Post($"{url}/comments", new { body = "Started on this" });
        Assert.True(c.Ok, c.ToString());
        Assert.Equal(422, (int)(await w.Other.Post($"{url}/comments", new { body = "  " })).Status);
        Assert.Contains((await w.Dev.Get("/api/v1/notifications")).Data!["items"]!.AsArray(), n => S(n!["title"]).Contains("New comment"));
        var commentId = Id(c);
        Assert.True((await w.Other.Put($"{url}/comments/{commentId}", new { body = "Started on this today" })).Ok);
        Assert.Equal(403, (int)(await w.Dev.Put($"{url}/comments/{commentId}", new { body = "Hijack" })).Status);
        var listed = (await w.Owner.Get($"{url}/comments")).Data!.AsArray();
        Assert.Equal("Started on this today", S(listed.Single()!["body"]));
        Assert.NotNull(listed.Single()!["editedAt"]);
        Assert.Equal(1, (await w.Owner.Get(url)).Data!["commentCount"]!.GetValue<int>());
        Assert.True((await w.Manager.Delete($"{url}/comments/{commentId}")).Ok);   // a manager can moderate
        Assert.Empty((await w.Owner.Get($"{url}/comments")).Data!.AsArray());

        // files
        var up = await w.Other.Upload($"{url}/attachments", "correction-sheet.pdf", Pdf());
        Assert.True(up.Ok, up.ToString());
        var fileId = Id(up);
        Assert.Equal(422, (int)(await w.Other.Upload($"{url}/attachments", "evil.pdf", "MZ not a pdf"u8.ToArray())).Status);
        Assert.Equal(403, (int)(await w.Guest.Upload($"{url}/attachments", "x.pdf", Pdf())).Status);
        Assert.Equal(1, (await w.Owner.Get(url)).Data!["attachmentCount"]!.GetValue<int>());
        Assert.Equal("correction-sheet.pdf", S((await w.Owner.Get($"{url}/attachments")).Data!.AsArray().Single()!["fileName"]));
        var download = await w.Owner.Raw($"/api/v1/work-attachments/{fileId}/download");
        Assert.Equal(System.Net.HttpStatusCode.OK, download.StatusCode);
        Assert.Equal(Pdf(), await download.Content.ReadAsByteArrayAsync());
        Assert.Equal(403, (int)(await w.Guest.Get($"/api/v1/work-attachments/{fileId}/download")).Status);
        Assert.True((await w.Other.Delete($"/api/v1/work-attachments/{fileId}")).Ok);
        Assert.Empty((await w.Owner.Get($"{url}/attachments")).Data!.AsArray());
    }

    // ------------------------------------------------------------------ reports

    [Fact]
    public async Task The_summary_counts_open_overdue_and_finished_work_by_type_person_and_project()
    {
        var w = await Setup();
        await Create(w.Dev, "Late bug", "Bug Fix", new { relatedProjectId = w.Project, assigneeId = w.Dev.UserId, dueDate = Iso(-3) });
        await Create(w.Dev, "Soon bug", "Bug Fix", new { relatedProjectId = w.Project, assigneeId = w.Dev.UserId, dueDate = Iso(2) });
        await Create(w.Dev, "Loose end", "Ad-hoc");
        var done = Id(await Create(w.Dev, "Done data", "Data Preparation", new { assigneeId = w.Other.UserId }));
        await w.Other.Put($"/api/v1/work-tasks/{done}/status", new { status = "Completed" });

        var s = (await w.Dev.Get("/api/v1/work-tasks/summary")).Data!;
        Assert.Equal(3, s["open"]!.GetValue<int>());
        Assert.Equal(1, s["overdue"]!.GetValue<int>());
        Assert.Equal(1, s["dueThisWeek"]!.GetValue<int>());
        Assert.Equal(1, s["unassigned"]!.GetValue<int>());
        Assert.Equal(1, s["completedInPeriod"]!.GetValue<int>());
        Assert.Equal(4, s["createdInPeriod"]!.GetValue<int>());
        Assert.Equal(2, s["mineOpen"]!.GetValue<int>());
        Assert.Equal(1, s["mineOverdue"]!.GetValue<int>());
        var bug = s["byType"]!.AsArray().Single(t => S(t!["name"]) == "Bug Fix")!;
        Assert.Equal(2, bug["open"]!.GetValue<int>());
        Assert.Equal(1, bug["overdue"]!.GetValue<int>());
        Assert.Contains(s["byPerson"]!.AsArray(), p => S(p!["name"]) == "Unassigned");
        Assert.Contains(s["byProject"]!.AsArray(), p => S(p!["name"]) == "Payment Engine" && p["open"]!.GetValue<int>() == 2);
        Assert.Contains(s["byProject"]!.AsArray(), p => S(p!["name"]) == "No related project");
        Assert.Equal(30, s["perDay"]!.AsArray().Count);
    }

    [Fact]
    public async Task The_filtered_list_can_be_exported_as_csv_that_cannot_run_as_a_formula()
    {
        var w = await Setup();
        await Create(w.Dev, "=HYPERLINK(\"http://evil\")", "Bug Fix", new { relatedProjectId = w.Project });
        await Create(w.Dev, "Plain, with comma", "Ad-hoc");
        var res = await w.Owner.Raw("/api/v1/work-tasks/export?workTypeId=" + await TypeId(w.Owner, "Bug Fix"));
        Assert.Equal(System.Net.HttpStatusCode.OK, res.StatusCode);
        Assert.Contains("csv", res.Content.Headers.ContentType!.MediaType);
        var text = Encoding.UTF8.GetString(await res.Content.ReadAsByteArrayAsync()).TrimStart('﻿');
        Assert.StartsWith("Key,Title,Work type", text);
        Assert.Contains("'=HYPERLINK", text);
        Assert.DoesNotContain("Plain, with comma", text);
        Assert.Contains("Payment Engine", text);
    }
}
