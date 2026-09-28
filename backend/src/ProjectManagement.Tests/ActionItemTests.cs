using System.Text.Json.Nodes;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Action items of a project: follow-ups with an owner, a due date and a priority, next to the project's status.</summary>
[Collection("api")]
public class ActionItemTests(ApiFactory factory)
{
    private static string Iso(int daysFromToday) => DateOnly.FromDateTime(DateTime.UtcNow).AddDays(daysFromToday).ToString("yyyy-MM-dd");

    private sealed record World(TestClient Owner, TestClient Manager, TestClient Dev, TestClient Other, TestClient Guest, Guid Project);

    private async Task<World> Setup()
    {
        var owner = await TestClient.RegisterAsync(factory, "Olivia Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var manager = await owner.AddMemberAsync(factory, TenantRole.Manager, "Maya Manager");
        var dev = await owner.AddMemberAsync(factory, TenantRole.Member, "Dev Developer");
        var other = await owner.AddMemberAsync(factory, TenantRole.Member, "Olly Other");
        var guest = await owner.AddMemberAsync(factory, TenantRole.Guest, "Gus Guest");
        var project = await owner.CreateProjectAsync("Atlas");
        Assert.True((await owner.Post($"/api/v1/projects/{project}/members", new { userId = guest.UserId })).Ok);
        return new World(owner, manager, dev, other, guest, project);
    }

    private static string Url(Guid project) => $"/api/v1/projects/{project}/action-items";
    private static Guid Id(ApiResult r) => Guid.Parse(r.Data!["id"]!.GetValue<string>());
    private static async Task<JsonArray> List(TestClient c, Guid project) => (await c.Get(Url(project))).Data!.AsArray();

    // ------------------------------------------------------------------ add, list, order

    [Fact]
    public async Task Action_items_are_added_with_an_owner_a_due_date_and_a_priority_and_listed_with_the_open_ones_first()
    {
        var w = await Setup();
        var a = await w.Owner.Post(Url(w.Project), new { title = "  Get the client's sign-off  ", details = "Send the mock-ups first", assigneeId = w.Dev.UserId, dueDate = Iso(5), priority = "High" });
        Assert.True(a.Ok, a.ToString());
        Assert.Equal("Get the client's sign-off", a.Data!["title"]!.GetValue<string>());
        Assert.Equal("Dev Developer", a.Data["assignee"]!["name"]!.GetValue<string>());
        Assert.Equal(Iso(5), a.Data["dueDate"]!.GetValue<string>());
        Assert.Equal("High", a.Data["priority"]!.GetValue<string>());
        Assert.Equal("Open", a.Data["status"]!.GetValue<string>());
        Assert.Equal("Olivia Owner", a.Data["createdBy"]!["name"]!.GetValue<string>());
        Assert.False(a.Data["isOverdue"]!.GetValue<bool>());

        var undated = Id(await w.Owner.Post(Url(w.Project), new { title = "Confirm the vendor date", priority = "Critical" }));
        var soon = Id(await w.Owner.Post(Url(w.Project), new { title = "Book the demo room", dueDate = Iso(2) }));
        var done = Id(await w.Owner.Post(Url(w.Project), new { title = "Send the agenda", dueDate = Iso(1) }));
        Assert.True((await w.Owner.Put($"{Url(w.Project)}/{done}/status", new { status = "Completed" })).Ok);

        // Open items by due date (undated last), then the finished one.
        Assert.Equal(new[] { "Book the demo room", "Get the client's sign-off", "Confirm the vendor date", "Send the agenda" }, (await List(w.Owner, w.Project)).Select(x => x!["title"]!.GetValue<string>()).ToArray());
        _ = undated; _ = soon;
    }

    [Fact]
    public async Task Completing_stamps_who_and_when_reopening_clears_it_and_an_open_item_past_its_date_is_overdue()
    {
        var w = await Setup();
        var late = Id(await w.Owner.Post(Url(w.Project), new { title = "Chase the invoice", dueDate = Iso(-3), assigneeId = w.Dev.UserId }));
        Assert.True((await List(w.Owner, w.Project))[0]!["isOverdue"]!.GetValue<bool>());

        var done = await w.Dev.Put($"{Url(w.Project)}/{late}/status", new { status = "Completed" });      // the person it is assigned to may tick it off
        Assert.True(done.Ok, done.ToString());
        Assert.Equal("Completed", done.Data!["status"]!.GetValue<string>());
        Assert.Equal("Dev Developer", done.Data["completedBy"]!["name"]!.GetValue<string>());
        Assert.NotNull(done.Data["completedAt"]);
        Assert.False(done.Data["isOverdue"]!.GetValue<bool>());                                            // finished: no longer overdue

        var reopened = await w.Owner.Put($"{Url(w.Project)}/{late}", new { title = "Chase the invoice", priority = "Medium", status = "InProgress", dueDate = Iso(-3), assigneeId = w.Dev.UserId });
        Assert.True(reopened.Ok, reopened.ToString());
        Assert.Equal("InProgress", reopened.Data!["status"]!.GetValue<string>());
        Assert.Null(reopened.Data["completedAt"]);
        Assert.Null(reopened.Data["completedBy"]);
        Assert.True(reopened.Data["isOverdue"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Everything_can_be_edited_and_cleared_and_a_bad_request_says_what_is_wrong()
    {
        var w = await Setup();
        var item = Id(await w.Owner.Post(Url(w.Project), new { title = "Old title", details = "Old", assigneeId = w.Dev.UserId, dueDate = Iso(4), priority = "Low" }));
        var edited = await w.Owner.Put($"{Url(w.Project)}/{item}", new { title = "New title", details = "", assigneeId = (Guid?)null, dueDate = (string?)null, priority = "Critical", status = "InProgress" });
        Assert.True(edited.Ok, edited.ToString());
        Assert.Equal("New title", edited.Data!["title"]!.GetValue<string>());
        Assert.Null(edited.Data["details"]);
        Assert.Null(edited.Data["assignee"]);
        Assert.Null(edited.Data["dueDate"]);
        Assert.Equal("Critical", edited.Data["priority"]!.GetValue<string>());

        var noTitle = await w.Owner.Post(Url(w.Project), new { title = "   " });
        Assert.Equal(422, (int)noTitle.Status);
        Assert.Equal("title", noTitle.Json!["errors"]![0]!["field"]!.GetValue<string>());
        Assert.Equal(422, (int)(await w.Owner.Post(Url(w.Project), new { title = new string('x', 201) })).Status);
        Assert.Equal(422, (int)(await w.Owner.Post(Url(w.Project), new { title = "Ok", assigneeId = Guid.NewGuid() })).Status);            // not in this workspace
        var toGuest = await w.Owner.Post(Url(w.Project), new { title = "Ok", assigneeId = w.Guest.UserId });
        Assert.Equal(422, (int)toGuest.Status);                                                                                         // guests cannot be given work
    }

    // ------------------------------------------------------------------ who may do what

    [Fact]
    public async Task People_who_can_create_tasks_add_items_and_only_the_creator_the_assignee_and_managers_can_change_them()
    {
        var w = await Setup();
        // A guest can read but not add; somebody outside the project (a guest who was never added) does not even see the list.
        Assert.True((await w.Guest.Get(Url(w.Project))).Ok);
        var denied = await w.Guest.Post(Url(w.Project), new { title = "Nope" });
        Assert.Equal(403, (int)denied.Status);
        Assert.Equal("PERMISSION_DENIED", denied.ErrorCode);
        var stranger = await w.Owner.AddMemberAsync(factory, TenantRole.Guest, "Sam Stranger");
        Assert.Equal(404, (int)(await stranger.Get(Url(w.Project))).Status);

        // A member adds one and may change and delete it.
        var mine = Id(await w.Dev.Post(Url(w.Project), new { title = "Dev's follow-up", assigneeId = w.Other.UserId }));
        var can = (await List(w.Dev, w.Project))[0]!["can"]!;
        Assert.True(can["edit"]!.GetValue<bool>() && can["delete"]!.GetValue<bool>() && can["complete"]!.GetValue<bool>());

        // The person it is assigned to can change it (but not delete it); an unrelated member can do neither.
        var theirs = new { title = "Dev's follow-up (updated)", priority = "High", status = "InProgress", assigneeId = w.Other.UserId };
        Assert.True((await w.Other.Put($"{Url(w.Project)}/{mine}", theirs)).Ok);
        Assert.Equal(403, (int)(await w.Other.Delete($"{Url(w.Project)}/{mine}")).Status);
        var third = await w.Owner.AddMemberAsync(factory, TenantRole.Member, "Third Member");
        Assert.Equal(403, (int)(await third.Put($"{Url(w.Project)}/{mine}", theirs)).Status);
        Assert.Equal(403, (int)(await third.Put($"{Url(w.Project)}/{mine}/status", new { status = "Completed" })).Status);
        Assert.Equal(403, (int)(await third.Delete($"{Url(w.Project)}/{mine}")).Status);
        Assert.False((await List(third, w.Project))[0]!["can"]!["edit"]!.GetValue<bool>());

        // A manager can change and delete anyone's; the creator can delete their own.
        Assert.True((await w.Manager.Put($"{Url(w.Project)}/{mine}/status", new { status = "Completed" })).Ok);
        Assert.Equal(204, (int)(await w.Manager.Delete($"{Url(w.Project)}/{mine}")).Status);
        var again = Id(await w.Dev.Post(Url(w.Project), new { title = "Another" }));
        Assert.Equal(204, (int)(await w.Dev.Delete($"{Url(w.Project)}/{again}")).Status);
        Assert.Empty(await List(w.Owner, w.Project));
    }

    [Fact]
    public async Task An_archived_project_keeps_its_action_items_read_only()
    {
        var w = await Setup();
        var item = Id(await w.Owner.Post(Url(w.Project), new { title = "Before archiving" }));
        Assert.True((await w.Owner.Send(HttpMethod.Patch, $"/api/v1/projects/{w.Project}/move", new { status = "Archived" })).Ok);
        var blocked = await w.Owner.Post(Url(w.Project), new { title = "After archiving" });
        Assert.Equal(409, (int)blocked.Status);
        Assert.Equal("PROJECT_ARCHIVED", blocked.ErrorCode);
        Assert.Equal(409, (int)(await w.Owner.Put($"{Url(w.Project)}/{item}/status", new { status = "Completed" })).Status);
        var listed = await List(w.Owner, w.Project);
        Assert.Single(listed);
        Assert.False(listed[0]!["can"]!["edit"]!.GetValue<bool>());
    }

    // ------------------------------------------------------------------ notifications and history

    [Fact]
    public async Task The_person_an_item_is_assigned_to_is_told_and_it_shows_in_the_projects_activity()
    {
        var w = await Setup();
        var item = Id(await w.Owner.Post(Url(w.Project), new { title = "Sort out access", assigneeId = w.Dev.UserId, dueDate = Iso(3) }));
        var note = (await w.Dev.Get("/api/v1/notifications")).Data!["items"]!.AsArray().Single(n => n!["title"]!.GetValue<string>().Contains("Sort out access"))!;
        Assert.StartsWith("Action item assigned to you", note["title"]!.GetValue<string>());
        Assert.Equal($"/project-status?project={w.Project}&actions=1", note["link"]!.GetValue<string>());
        Assert.Contains("Atlas", note["body"]!.GetValue<string>());

        // Handing it to somebody else tells them; assigning it to yourself tells nobody.
        Assert.True((await w.Owner.Put($"{Url(w.Project)}/{item}", new { title = "Sort out access", priority = "Medium", status = "Open", assigneeId = w.Other.UserId })).Ok);
        Assert.Contains((await w.Other.Get("/api/v1/notifications")).Data!["items"]!.AsArray(), n => n!["title"]!.GetValue<string>().Contains("Sort out access"));
        var mine = Id(await w.Other.Post(Url(w.Project), new { title = "Self assigned", assigneeId = w.Other.UserId }));
        Assert.DoesNotContain((await w.Other.Get("/api/v1/notifications")).Data!["items"]!.AsArray(), n => n!["title"]!.GetValue<string>().Contains("Self assigned"));

        Assert.True((await w.Owner.Put($"{Url(w.Project)}/{item}/status", new { status = "Completed" })).Ok);
        Assert.Equal(204, (int)(await w.Owner.Delete($"{Url(w.Project)}/{item}")).Status);
        var activity = (await w.Owner.Get($"/api/v1/projects/{w.Project}/activity")).Data!["items"]!.AsArray().Select(a => a!["summary"]!.GetValue<string>()).ToArray();
        Assert.Contains(activity, s => s.Contains("Added action item “Sort out access”"));
        Assert.Contains(activity, s => s.Contains("Open → Completed"));
        Assert.Contains(activity, s => s.Contains("Deleted action item “Sort out access”"));
        _ = mine;
    }

    // ------------------------------------------------------------------ a task's start date, phase and name are recorded too

    [Fact]
    public async Task Changing_a_tasks_start_date_phase_or_name_is_recorded_in_the_activity()
    {
        var w = await Setup();
        var stages = (await w.Owner.Get($"/api/v1/projects/{w.Project}/stages")).Data!.AsArray().ToDictionary(s => s!["name"]!.GetValue<string>(), s => Guid.Parse(s!["id"]!.GetValue<string>()));
        var statuses = (await w.Owner.Get($"/api/v1/projects/{w.Project}/statuses")).Data!.AsArray();
        var todo = Guid.Parse(statuses[0]!["id"]!.GetValue<string>());
        var created = await w.Owner.CreateTaskAsync(w.Project, "Build login", new { title = "Build login", priority = "Medium", startDate = Iso(1), stageId = stages["Requirements & Planning"] });
        var task = Guid.Parse(created["id"]!.GetValue<string>());

        var version = (await w.Owner.Get($"/api/v1/tasks/{task}")).Data!["task"]!["version"]!.GetValue<int>();
        var res = await w.Owner.Put($"/api/v1/tasks/{task}", new
        {
            title = "Build login and SSO", priority = "Medium", statusId = todo, startDate = Iso(4), version, stageId = stages["Development"],
        });
        Assert.True(res.Ok, res.ToString());
        var activity = (await w.Owner.Get($"/api/v1/projects/{w.Project}/activity")).Data!["items"]!.AsArray().Select(a => a!["summary"]!.GetValue<string>()).ToArray();
        Assert.Contains(activity, s => s.Contains("start date") && s.Contains(DateOnly.Parse(Iso(1)).ToString("dd MMM yyyy")) && s.Contains(DateOnly.Parse(Iso(4)).ToString("dd MMM yyyy")));
        Assert.Contains(activity, s => s.Contains("phase Requirements & Planning → Development"));
        Assert.Contains(activity, s => s.Contains("renamed") && s.Contains("Build login and SSO"));
    }
}
