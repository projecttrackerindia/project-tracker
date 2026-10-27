using System.Net;
using System.Text.Json.Nodes;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// The one Work API (/api/v1/work-items, v2): every kind of work - project tasks, issues, action items and tickets - listed, opened,
/// created, changed, commented on ("log 2h" logs time) and deleted through one shape, with each kind's own rules still deciding.
/// </summary>
[Collection("api")]
public class WorkItemsApiTests(ApiFactory factory)
{
    private const string Url = "/api/v1/work-items";
    private static string Iso(int daysFromToday) => AppDay.Today.AddDays(daysFromToday).ToString("yyyy-MM-dd");
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static Guid Id(ApiResult r) => Guid.Parse(S(r.Data!["id"]));

    private sealed record World(TestClient Owner, TestClient Dev, TestClient Other, TestClient Guest, Guid Project, string BugFix);

    private async Task<World> Setup()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var dev = await owner.AddMemberAsync(factory, TenantRole.Member, "Dev Developer");
        var other = await owner.AddMemberAsync(factory, TenantRole.Member, "Olly Other");
        var guest = await owner.AddMemberAsync(factory, TenantRole.Guest, "Gus Guest");
        var project = await owner.CreateProjectAsync("Payment Engine");
        Assert.True((await owner.Post($"/api/v1/projects/{project}/members", new { userId = dev.UserId })).Ok);
        var types = (await owner.Get("/api/v1/work-types?includeInactive=true")).Data!.AsArray();
        var bugFix = S(types.First(t => S(t!["name"]) == "Bug Fix")!["id"]);
        return new World(owner, dev, other, guest, project, bugFix);
    }

    private static async Task<ApiResult> New(TestClient c, object body)
    {
        var r = await c.Post(Url, body);
        Assert.True(r.Status == HttpStatusCode.Created, r.ToString());
        return r;
    }

    [Fact]
    public async Task Every_kind_is_created_through_one_endpoint_and_comes_back_in_one_shape()
    {
        var w = await Setup();
        var task = await New(w.Owner, new { kind = "task", projectId = w.Project, title = "Wire the refund API", assigneeId = w.Dev.UserId, priority = "High", dueDate = Iso(3) });
        var issue = await New(w.Owner, new { kind = "issue", projectId = w.Project, title = "Refund total is off by one", description = "Seen on the staging build", priority = "Critical" });
        var action = await New(w.Owner, new { kind = "action", projectId = w.Project, title = "Get the bank's sign-off", assigneeId = w.Dev.UserId, dueDate = Iso(2) });
        var ticket = await New(w.Owner, new { kind = "ticket", workTypeId = w.BugFix, title = "Printer on floor 2", projectId = w.Project, priority = "Low" });

        Assert.Equal("task", S(task.Data!["kind"]));
        Assert.Matches(@"^[A-Z0-9]+-\d+$", S(task.Data["key"]));
        Assert.Equal("Dev Developer", S(task.Data["assignee"]!["name"]));
        Assert.Equal(Iso(3), S(task.Data["dueDate"]));
        Assert.Equal("High", S(task.Data["priority"]));
        Assert.Equal("Payment Engine", S(task.Data["projectName"]));
        Assert.Equal(S(task.Data["id"]), S(task.Data["detail"]!["id"]));   // the kind's own full record

        Assert.Equal("issue", S(issue.Data!["kind"]));
        Assert.Contains("-I", S(issue.Data["key"]));
        Assert.Equal("Seen on the staging build", S(issue.Data["description"]));
        Assert.Equal("Critical", S(issue.Data["priority"]));
        Assert.Equal("Observed", S(issue.Data["status"]));

        Assert.Equal("action", S(action.Data!["kind"]));
        Assert.StartsWith("AI-", S(action.Data["key"]));
        Assert.Equal("Open", S(action.Data["status"]));

        Assert.Equal("ticket", S(ticket.Data!["kind"]));
        Assert.StartsWith("WT-", S(ticket.Data["key"]));
        Assert.Equal("To Do", S(ticket.Data["status"]));
        Assert.Equal("Payment Engine", S(ticket.Data["projectName"]));
        Assert.Equal("app", S(ticket.Data["channel"]));   // where it came from: made in the app
        Assert.Null(task.Data["channel"]);

        // Unknown kinds and missing projects are refused clearly.
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await w.Owner.Post(Url, new { kind = "epic", title = "x" })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await w.Owner.Post(Url, new { kind = "task", title = "No project" })).Status);

        // The list has all four; filters by kind, mine, project and q.
        var all = (await w.Owner.Get($"{Url}?status=all")).Data!["items"]!.AsArray();
        Assert.Equal(new[] { "action", "issue", "task", "ticket" }, all.Select(x => S(x!["kind"])).OrderBy(x => x).ToArray());
        var tasksAndTickets = (await w.Owner.Get($"{Url}?kind=task,ticket")).Data!["items"]!.AsArray();
        Assert.Equal(new[] { "task", "ticket" }, tasksAndTickets.Select(x => S(x!["kind"])).OrderBy(x => x).ToArray());
        var mine = (await w.Dev.Get($"{Url}?mine=true")).Data!["items"]!.AsArray();
        Assert.Equal(new[] { "action", "task" }, mine.Select(x => S(x!["kind"])).OrderBy(x => x).ToArray());
        var found = (await w.Owner.Get($"{Url}?q=refund")).Data!["items"]!.AsArray();
        Assert.Equal(2, found.Count);
        Assert.Equal(422, (int)(await w.Owner.Get($"{Url}?kind=epic")).Status);
    }

    [Fact]
    public async Task The_list_pages_through_the_merged_order_and_filters_by_status_overdue_and_team()
    {
        var w = await Setup();
        for (var i = 0; i < 5; i++) await New(w.Owner, new { kind = "task", projectId = w.Project, title = $"Task {i}", dueDate = Iso(i + 1) });
        var late = await New(w.Owner, new { kind = "ticket", workTypeId = w.BugFix, title = "Late ticket", dueDate = Iso(-2), assigneeId = w.Dev.UserId });
        var page1 = (await w.Owner.Get($"{Url}?limit=4")).Data!;
        var page2 = (await w.Owner.Get($"{Url}?limit=4&offset=4")).Data!;
        Assert.Equal(4, page1["items"]!.AsArray().Count);
        Assert.True(page1["hasMore"]!.GetValue<bool>());
        Assert.Equal(2, page2["items"]!.AsArray().Count);
        Assert.False(page2["hasMore"]!.GetValue<bool>());
        Assert.Equal("Late ticket", S(page1["items"]![0]!["title"]));   // soonest due first
        Assert.Empty(page1["items"]!.AsArray().Select(x => S(x!["id"])).Intersect(page2["items"]!.AsArray().Select(x => S(x!["id"]))));

        var overdue = (await w.Owner.Get($"{Url}?overdue=true")).Data!["items"]!.AsArray();
        Assert.Equal(S(late.Data!["id"]), S(Assert.Single(overdue)!["id"]));
        Assert.True(overdue[0]!["isOverdue"]!.GetValue<bool>());

        // Close the ticket: gone from open, there under closed.
        var v = late.Data["version"]!.GetValue<int>();
        Assert.True((await w.Owner.Patch($"{Url}/{S(late.Data["id"])}", new { version = v, status = "Completed" })).Ok);
        Assert.DoesNotContain((await w.Owner.Get($"{Url}?kind=ticket")).Data!["items"]!.AsArray(), x => S(x!["id"]) == S(late.Data["id"]));
        Assert.Contains((await w.Owner.Get($"{Url}?kind=ticket&status=closed")).Data!["items"]!.AsArray(), x => S(x!["id"]) == S(late.Data["id"]));

        // team: a team id (its members' work), or "mine".
        var team = await w.Owner.Post("/api/v1/teams", new { name = "Support" });
        Assert.True(team.Ok, team.ToString());
        var teamId = S(team.Data!["team"]!["id"]);
        Assert.True((await w.Owner.Post($"/api/v1/teams/{teamId}/members", new { userId = w.Dev.UserId })).Ok);
        var teamItems = (await w.Owner.Get($"{Url}?team={teamId}&status=all")).Data!["items"]!.AsArray();
        Assert.Equal("Late ticket", S(Assert.Single(teamItems)!["title"]));
        Assert.Equal(400, (int)(await w.Owner.Get($"{Url}?offset=490&limit=50")).Status);
    }

    [Fact]
    public async Task Patch_changes_only_the_fields_sent_and_refuses_a_stale_version()
    {
        var w = await Setup();
        var task = await New(w.Owner, new { kind = "task", projectId = w.Project, title = "Wire the refund API", description = "Keep me", priority = "Low" });
        var id = S(task.Data!["id"]);
        var v = task.Data["version"]!.GetValue<int>();

        var r = await w.Owner.Patch($"{Url}/{id}", new { version = v, priority = "High", dueDate = Iso(4), assigneeId = w.Dev.UserId });
        Assert.True(r.Ok, r.ToString());
        Assert.Equal("High", S(r.Data!["priority"]));
        Assert.Equal(Iso(4), S(r.Data["dueDate"]));
        Assert.Equal("Keep me", S(r.Data["description"]));          // not sent, not changed
        Assert.Equal("Wire the refund API", S(r.Data["title"]));
        Assert.Equal("Dev Developer", S(r.Data["assignee"]!["name"]));
        Assert.True(r.Data["version"]!.GetValue<int>() > v);

        // The version read before is stale now.
        var stale = await w.Owner.Patch($"{Url}/{id}", new { version = v, title = "Lost update" });
        Assert.Equal(HttpStatusCode.Conflict, stale.Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await w.Owner.Patch($"{Url}/{id}", new { title = "No version" })).Status);

        // null clears; status by the column's name.
        var cleared = await w.Owner.Patch($"{Url}/{id}", new { version = r.Data["version"]!.GetValue<int>(), dueDate = (string?)null, dueDateReason = "Waiting on the client", status = "In Progress" });
        Assert.True(cleared.Ok, cleared.ToString());
        Assert.Null(cleared.Data!["dueDate"]);
        Assert.Equal("In Progress", S(cleared.Data["status"]));

        // An issue: severity, status and the new dates in one patch; the version moves on.
        var issue = await New(w.Owner, new { kind = "issue", projectId = w.Project, title = "Refund total", assigneeId = w.Dev.UserId });
        var iv = issue.Data!["version"]!.GetValue<int>();
        var ir = await w.Owner.Patch($"{Url}/{S(issue.Data["id"])}", new { version = iv, priority = "Critical", status = "InProgress", dueDate = Iso(1) });
        Assert.True(ir.Ok, ir.ToString());
        Assert.Equal("Critical", S(ir.Data!["priority"]));
        Assert.Equal("In Progress", S(ir.Data["status"]));
        Assert.Equal(Iso(1), S(ir.Data["dueDate"]));
        Assert.Equal(iv + 1, ir.Data["version"]!.GetValue<int>());
        Assert.Equal(HttpStatusCode.Conflict, (await w.Owner.Patch($"{Url}/{S(issue.Data["id"])}", new { version = iv, title = "Stale" })).Status);

        // An action item and a ticket.
        var action = await New(w.Owner, new { kind = "action", projectId = w.Project, title = "Sign-off" });
        var ar = await w.Owner.Patch($"{Url}/{S(action.Data!["id"])}", new { version = action.Data["version"]!.GetValue<int>(), status = "Completed" });
        Assert.True(ar.Ok, ar.ToString());
        Assert.Equal("Completed", S(ar.Data!["status"]));
        var ticket = await New(w.Owner, new { kind = "ticket", workTypeId = w.BugFix, title = "Printer" });
        var tr = await w.Owner.Patch($"{Url}/{S(ticket.Data!["id"])}", new { version = ticket.Data["version"]!.GetValue<int>(), status = "InProgress", title = "Printer on floor 2" });
        Assert.True(tr.Ok, tr.ToString());
        Assert.Equal("In Progress", S(tr.Data!["status"]));
        Assert.Equal("Printer on floor 2", S(tr.Data["title"]));
    }

    [Fact]
    public async Task One_activity_stream_has_comments_time_changes_and_log_2h_logs_time()
    {
        var w = await Setup();
        var task = await New(w.Owner, new { kind = "task", projectId = w.Project, title = "Wire the refund API", assigneeId = w.Owner.UserId });
        var id = S(task.Data!["id"]);

        var c1 = await w.Owner.Post($"{Url}/{id}/comments", new { body = "Started on the client" });
        Assert.Equal(HttpStatusCode.Created, c1.Status);
        Assert.Null(c1.Data!["time"]);
        Assert.Equal("Olivia Owner", S(c1.Data["comment"]!["actor"]!["name"]));

        var c2 = await w.Owner.Post($"{Url}/{id}/comments", new { body = "log 2h wiring the webhook" });
        Assert.Equal(HttpStatusCode.Created, c2.Status);
        Assert.Equal(120, c2.Data!["time"]!["minutes"]!.GetValue<int>());
        Assert.Null(c2.Data["timeProblem"]);

        var c3 = await w.Owner.Post($"{Url}/{id}/comments", new { body = "log a while" });
        Assert.Null(c3.Data!["time"]);
        Assert.NotNull(c3.Data["timeProblem"]);

        var v = task.Data["version"]!.GetValue<int>();
        Assert.True((await w.Owner.Patch($"{Url}/{id}", new { version = v, title = "Wire the refund API v2" })).Ok);

        var detail = (await w.Owner.Get($"{Url}/{id}")).Data!;
        var activity = detail["activity"]!.AsArray();
        Assert.Equal(3, activity.Count(a => S(a!["type"]) == "comment"));
        var time = Assert.Single(activity, a => S(a!["type"]) == "time");
        Assert.Equal(120, time!["minutes"]!.GetValue<int>());
        Assert.Equal(120, detail["loggedMinutes"]!.GetValue<int>());
        Assert.Contains(activity, a => S(a!["type"]) == "change");
        // newest first
        var times = activity.Select(a => DateTime.Parse(S(a!["at"]))).ToList();
        Assert.Equal(times.OrderByDescending(x => x).ToList(), times);

        // The time is on the task's own time endpoint too (the one time service did it).
        var own = (await w.Owner.Get($"/api/v1/tasks/{id}/time")).Data!;
        Assert.Equal(120, own["totalMinutes"]!.GetValue<int>());

        // Comments on an issue and an action item (new in v2) land in the same stream; time cannot be logged on them.
        var issue = await New(w.Owner, new { kind = "issue", projectId = w.Project, title = "Refund total" });
        var ic = await w.Owner.Post($"{Url}/{S(issue.Data!["id"])}/comments", new { body = "log 1h checking" });
        Assert.Equal(HttpStatusCode.Created, ic.Status);
        Assert.Null(ic.Data!["time"]);
        Assert.Contains("issues", S(ic.Data["timeProblem"]));
        var issueActivity = (await w.Owner.Get($"{Url}/{S(issue.Data["id"])}")).Data!["activity"]!.AsArray();
        Assert.Contains(issueActivity, a => S(a!["type"]) == "comment" && S(a["body"]) == "log 1h checking");
        Assert.Contains(issueActivity, a => S(a!["type"]) == "change");   // "raised", from the issue's history

        var ticket = await New(w.Owner, new { kind = "ticket", workTypeId = w.BugFix, title = "Printer", assigneeId = w.Owner.UserId });
        var tc = await w.Owner.Post($"{Url}/{S(ticket.Data!["id"])}/comments", new { body = "log 30m swapped the toner" });
        Assert.Equal(30, tc.Data!["time"]!["minutes"]!.GetValue<int>());
        Assert.Equal(30, (await w.Owner.Get($"{Url}/{S(ticket.Data["id"])}")).Data!["loggedMinutes"]!.GetValue<int>());
    }

    [Fact]
    public async Task Each_kind_keeps_its_own_rules_on_who_may_see_change_and_delete()
    {
        var w = await Setup();
        var task = await New(w.Owner, new { kind = "task", projectId = w.Project, title = "Secret roadmap" });
        var id = S(task.Data!["id"]);
        // The guest is not on the project: the item does not exist for them.
        Assert.Equal(HttpStatusCode.NotFound, (await w.Guest.Get($"{Url}/{id}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await w.Guest.Patch($"{Url}/{id}", new { version = 1, title = "x" })).Status);
        Assert.DoesNotContain((await w.Guest.Get($"{Url}?status=all")).Data?["items"]?.AsArray() ?? [], x => S(x!["id"]) == id);

        // Another workspace never sees it.
        var stranger = await TestClient.RegisterAsync(factory, "Stranger");
        await stranger.CreateOrgAsync();
        Assert.Equal(HttpStatusCode.NotFound, (await stranger.Get($"{Url}/{id}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await stranger.Delete($"{Url}/{id}")).Status);

        // A ticket raised by the owner and not assigned to Olly: Olly (a member) may not change or delete it.
        var ticket = await New(w.Owner, new { kind = "ticket", workTypeId = w.BugFix, title = "Printer" });
        var tid = S(ticket.Data!["id"]);
        Assert.Equal(HttpStatusCode.Forbidden, (await w.Other.Patch($"{Url}/{tid}", new { version = ticket.Data["version"]!.GetValue<int>(), title = "Mine now" })).Status);

        // Delete: the task goes to the bin (soft delete), the issue is removed, both disappear from the list and the item.
        Assert.Equal(HttpStatusCode.NoContent, (await w.Owner.Delete($"{Url}/{id}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await w.Owner.Get($"{Url}/{id}")).Status);
        var issue = await New(w.Owner, new { kind = "issue", projectId = w.Project, title = "Refund total" });
        Assert.Equal(HttpStatusCode.NoContent, (await w.Owner.Delete($"{Url}/{S(issue.Data!["id"])}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await w.Owner.Get($"{Url}/{S(issue.Data["id"])}")).Status);
        Assert.Equal(HttpStatusCode.NoContent, (await w.Owner.Delete($"{Url}/{tid}")).Status);
        Assert.DoesNotContain((await w.Owner.Get($"{Url}?status=all")).Data!["items"]!.AsArray(), x => S(x!["id"]) == tid);
    }

    [Fact]
    public async Task The_old_per_kind_endpoints_still_work_on_the_same_rows()
    {
        var w = await Setup();
        var task = await New(w.Owner, new { kind = "task", projectId = w.Project, title = "Wire the refund API" });
        var old = await w.Owner.Get($"/api/v1/tasks/{S(task.Data!["id"])}");
        Assert.True(old.Ok, old.ToString());
        Assert.Equal("Wire the refund API", S(old.Data!["task"]!["title"]));
        var viaOld = await w.Owner.CreateTaskAsync(w.Project, "Made the old way");
        var viaNew = (await w.Owner.Get($"{Url}/{S(viaOld["id"])}")).Data!;
        Assert.Equal("task", S(viaNew["kind"]));
        Assert.Equal(S(viaOld["key"]), S(viaNew["key"]));

        var ticket = await w.Owner.Post("/api/v1/work-tasks", new { title = "Old-style ticket", workTypeId = w.BugFix });
        Assert.True(ticket.Ok, ticket.ToString());
        Assert.Equal("ticket", S((await w.Owner.Get($"{Url}/{S(ticket.Data!["id"])}")).Data!["kind"]));
        var issues = await w.Owner.Post($"/api/v1/projects/{w.Project}/issues", new { title = "Old-style issue" });
        Assert.True(issues.Ok, issues.ToString());
        Assert.Equal("issue", S((await w.Owner.Get($"{Url}/{S(issues.Data!["issue"]!["id"])}")).Data!["kind"]));
        var action = await w.Owner.Post($"/api/v1/projects/{w.Project}/action-items", new { title = "Old-style action" });
        Assert.True(action.Ok, action.ToString());
        Assert.Equal("action", S((await w.Owner.Get($"{Url}/{S(action.Data!["id"])}")).Data!["kind"]));
    }
}
