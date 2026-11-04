using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Api.Realtime;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Realtime sync: every committed change of a thing open screens show is published as a compact event (type, id, project, op, changed field
/// names, actor - never values), routed only to the groups allowed to hear of it, and kept numbered for the catch-up after sleep/offline.
/// Fictional people and projects only.
/// </summary>
[Collection("api")]
public class RealtimeSyncTests(ApiFactory factory)
{
    private sealed record World(TestClient Owner, TestClient Dev, TestClient Guest, Guid Project, Guid Hidden);

    private async Task<World> Setup()
    {
        var owner = await TestClient.RegisterAsync(factory, "Rhea Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var dev = await owner.AddMemberAsync(factory, TenantRole.Member, "Dev Sharma");
        var guest = await owner.AddMemberAsync(factory, TenantRole.Guest, "Gita Guest");
        var project = await owner.CreateProjectAsync("Orbit");
        var hidden = await owner.CreateProjectAsync("Nebula");
        Assert.True((await owner.Post($"/api/v1/projects/{project}/members", new { userId = guest.UserId })).Ok);
        return new World(owner, dev, guest, project, hidden);
    }

    private static string S(JsonNode? n) => n!.GetValue<string>();
    private List<ChangeEvent> Published(Guid tenant) => factory.Changes.Published.Where(c => c.TenantId == tenant).ToList();
    private static SyncEvent Sync(ChangeEvent c) => RealtimeDispatcher.ToSync(c, DateTime.UtcNow);

    [Fact]
    public async Task A_task_edit_publishes_its_type_op_changed_fields_project_and_actor_to_that_project_only()
    {
        var w = await Setup();
        var task = Guid.Parse(S((await w.Owner.CreateTaskAsync(w.Project, "Wire the gateway"))["id"]));
        var created = Assert.Single(Published(w.Owner.WorkspaceId), c => c.EntityId == task && c.Op == "created");
        Assert.Equal("task", created.Type);
        Assert.Equal("task.created", created.Action);   // the activity's own action name is kept
        Assert.Equal(w.Project, created.ProjectId);
        Assert.Equal(w.Owner.UserId, created.ActorId);

        var current = (await w.Owner.Get($"/api/v1/tasks/{task}")).Data!["task"]!;
        var version = current["version"]!.GetValue<int>();
        var due = AppDay.Today.AddDays(3).ToString("yyyy-MM-dd");
        var put = await w.Owner.Put($"/api/v1/tasks/{task}", new { title = "Wire the gateway", priority = "High", statusId = current["statusId"]?.GetValue<string>(), dueDate = due, version });
        Assert.True(put.Ok, put.ToString());
        var updated = Published(w.Owner.WorkspaceId).Last(c => c.EntityId == task && c.Op == "updated");
        Assert.Contains("priority", updated.Fields!);
        Assert.Contains("dueDate", updated.Fields!);
        Assert.DoesNotContain("updatedAt", updated.Fields!);
        Assert.Null(updated.Audience);

        // Sent to the project's readers (people limited to some projects join it per project) and to those who read every project.
        var groups = SyncGroups.For(Sync(updated));
        Assert.Equal([SyncGroups.Project(w.Owner.WorkspaceId, w.Project), SyncGroups.AllProjects(w.Owner.WorkspaceId)], groups);
    }

    [Fact]
    public async Task Comments_and_action_items_carry_their_project_and_deletes_say_deleted()
    {
        var w = await Setup();
        var task = Guid.Parse(S((await w.Owner.CreateTaskAsync(w.Project, "Review the RAML"))["id"]));
        Assert.True((await w.Owner.Post($"/api/v1/tasks/{task}/comments", new { body = "Looks fine to me" })).Ok);
        var comment = Published(w.Owner.WorkspaceId).Last(c => c.Type == "comment");
        Assert.Equal(w.Project, comment.ProjectId);
        Assert.Equal(task, comment.ParentId);
        Assert.Equal(w.Owner.UserId, comment.ActorId);

        var item = await w.Owner.Post($"/api/v1/projects/{w.Project}/action-items", new { title = "Send the sign-off mail", assigneeId = w.Dev.UserId, priority = "High" });
        Assert.True(item.Ok, item.ToString());
        var itemId = Guid.Parse(S(item.Data!["id"]));
        var made = Published(w.Owner.WorkspaceId).Last(c => c.EntityId == itemId);
        Assert.Equal("actionItem", made.Type);
        Assert.Equal(w.Project, made.ProjectId);

        Assert.True((await w.Owner.Delete($"/api/v1/tasks/{task}")).Ok);
        Assert.Contains(Published(w.Owner.WorkspaceId), c => c.EntityId == task && c.Op == "deleted");
    }

    [Fact]
    public async Task Personal_things_go_only_to_their_person()
    {
        var w = await Setup();
        var local = ZoneTime.ToLocal(DateTime.UtcNow.AddHours(3), ZoneTime.Find("Asia/Kolkata"));
        var made = await w.Dev.Post("/api/v1/reminders", new { title = "Call the vendor about the EMI file", when = new { at = ZoneTime.Write(local), timeZone = "Asia/Kolkata" } });
        Assert.True(made.Ok, made.ToString());
        var reminder = Published(w.Owner.WorkspaceId).Last(c => c.Type == "reminder");
        Assert.Equal([w.Dev.UserId], reminder.Audience!);
        Assert.Equal([ChatGroups.User(w.Owner.WorkspaceId, w.Dev.UserId)], SyncGroups.For(Sync(reminder)));
    }

    [Fact]
    public async Task Events_never_leave_their_workspace()
    {
        var a = await Setup();
        var b = await Setup();
        await a.Owner.CreateTaskAsync(a.Project, "Only in A");
        await b.Owner.CreateTaskAsync(b.Project, "Only in B");
        foreach (var c in factory.Changes.Published.Where(c => c.TenantId == a.Owner.WorkspaceId || c.TenantId == b.Owner.WorkspaceId).ToList())
        {
            var other = c.TenantId == a.Owner.WorkspaceId ? b.Owner.WorkspaceId : a.Owner.WorkspaceId;
            Assert.All(SyncGroups.For(Sync(c)), g => { Assert.Contains(c.TenantId.ToString("N"), g); Assert.DoesNotContain(other.ToString("N"), g); });
            if (c.ProjectId is { } p) Assert.True(p == a.Project || p == a.Hidden || p == b.Project || p == b.Hidden);
            if (c.ProjectId is { } q) Assert.Equal(c.TenantId == a.Owner.WorkspaceId, q == a.Project || q == a.Hidden);
        }
    }

    [Fact]
    public async Task Catch_up_returns_what_was_missed_filtered_by_each_readers_reach()
    {
        var w = await Setup();
        var other = await Setup();
        var log = factory.Services.GetRequiredService<IRealtimeLog>();
        var start = (await w.Guest.Get("/api/v1/realtime/changes")).Data!["version"]!.GetValue<long>();

        var before = factory.Changes.Published.Count;
        var visible = Guid.Parse(S((await w.Owner.CreateTaskAsync(w.Project, "Guest can see this"))["id"]));
        var hidden = Guid.Parse(S((await w.Owner.CreateTaskAsync(w.Hidden, "Guest cannot see this"))["id"]));
        var local = ZoneTime.ToLocal(DateTime.UtcNow.AddHours(3), ZoneTime.Find("Asia/Kolkata"));
        Assert.True((await w.Owner.Post("/api/v1/reminders", new { title = "Owner's own reminder", when = new { at = ZoneTime.Write(local), timeZone = "Asia/Kolkata" } })).Ok);
        await other.Owner.CreateTaskAsync(other.Project, "Another workspace");
        // The test host records instead of sending; hand the recorded changes to the log the way the dispatcher does.
        foreach (var t in factory.Changes.Published.Skip(before).GroupBy(c => c.TenantId))
            await log.AppendAsync(t.Key, t.Select(Sync).ToList());

        static List<JsonNode> Items(ApiResult r) => r.Data!["changes"]!.AsArray().Select(x => x!).ToList();
        var guest = await w.Guest.Get($"/api/v1/realtime/changes?since={start}");
        Assert.False(guest.Data!["reset"]!.GetValue<bool>());
        var seen = Items(guest);
        Assert.Contains(seen, x => S(x["id"]) == visible.ToString());
        Assert.DoesNotContain(seen, x => S(x["id"]) == hidden.ToString());      // a project the guest is not in
        Assert.DoesNotContain(seen, x => S(x["type"]) == "reminder");           // someone else's reminder
        Assert.All(seen, x => Assert.Equal(w.Owner.WorkspaceId.ToString(), S(x["tenantId"])));
        Assert.All(seen, x => Assert.True(x["version"]!.GetValue<long>() > start));
        Assert.True(guest.Data!["version"]!.GetValue<long>() > start);

        var owner = Items(await w.Owner.Get($"/api/v1/realtime/changes?since={start}"));
        Assert.Contains(owner, x => S(x["id"]) == hidden.ToString());
        Assert.Contains(owner, x => S(x["type"]) == "reminder");

        // Nothing new since the latest version; a version older than what is kept asks the app to reload instead.
        var latest = guest.Data!["version"]!.GetValue<long>();
        Assert.Empty(Items(await w.Guest.Get($"/api/v1/realtime/changes?since={latest}")));
        Assert.True((await w.Guest.Get("/api/v1/realtime/changes?since=1")).Data!["reset"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Changes_are_numbered_in_order_and_a_gap_is_reported()
    {
        var log = new InMemoryRealtimeLog(TimeProvider.System);
        var tenant = Guid.NewGuid();
        var e = new SyncEvent("task", Guid.NewGuid(), null, tenant, "updated", 0, ["title"], null, "task.updated", null, DateTime.UtcNow);
        var first = await log.AppendAsync(tenant, [e, e]);
        Assert.Equal(first[0].Version + 1, first[1].Version);
        var (list, version, complete) = await log.SinceAsync(tenant, first[0].Version, 100);
        Assert.True(complete);
        Assert.Equal(first[1].Version, Assert.Single(list).Version);
        Assert.Equal(first[1].Version, version);
        for (var i = 0; i < InMemoryRealtimeLog.Keep + 5; i++) await log.AppendAsync(tenant, [e]);
        Assert.False((await log.SinceAsync(tenant, first[0].Version, 100)).Complete);
    }
}
