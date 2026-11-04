using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Infrastructure.Persistence;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// A deleted project or task takes its traces with it: action items, reminders, notifications, agent proposals and search hits vanish from
/// every list (Today, My work, the meeting review, Portfolio, the bell, search, Aura) - soft only, nothing removed - and the one-off clean-up
/// of older data (orphans and action items saved twice) does the same for what was left before.
/// </summary>
[Collection("api")]
public class DeletedWorkTracesTests(ApiFactory factory)
{
    private static readonly NodaTime.DateTimeZone Kolkata = ZoneTime.Find("Asia/Kolkata");
    private static string Local(DateTime utc) => ZoneTime.Write(ZoneTime.ToLocal(utc, Kolkata));
    private static string S(JsonNode? n) => n!.GetValue<string>();
    private static string Iso(int days) => AppDay.Today.AddDays(days).ToString("yyyy-MM-dd");

    private sealed record World(TestClient Owner, TestClient Dev, Guid Project);

    private async Task<World> Setup(string name)
    {
        var owner = await TestClient.RegisterAsync(factory, "Odile Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var dev = await owner.AddMemberAsync(factory, TenantRole.Member, "Devan Dev");
        var project = await owner.CreateProjectAsync(name);
        Assert.True((await owner.Post($"/api/v1/projects/{project}/members", new { userId = dev.UserId })).Ok);
        return new World(owner, dev, project);
    }

    /// <summary>Every list a trace could linger in, as each person sees it: none may mention <paramref name="marker"/>.</summary>
    private static async Task AssertGoneEverywhere(string marker, params TestClient[] people)
    {
        var urls = new[]
        {
            "api/v1/work-items?mine=true&status=all&limit=200", "api/v1/work-items?kind=action&status=all&limit=200", "api/v1/my-work", "api/v1/me/work",
            "api/v1/work-tasks?pageSize=100", "api/v1/notifications", "api/v1/today/signals", $"api/v1/search?q={marker}", "api/v1/ai/portfolio/brief",
            $"api/v1/calendar?from={Iso(-30)}&to={Iso(30)}",
        };
        var leaks = new List<string>();
        foreach (var who in people)
        {
            foreach (var url in urls)
            {
                var res = await who.Get(url);
                if (res.Status == HttpStatusCode.InternalServerError) leaks.Add($"GET /{url} -> 500");
                if ((res.Data?.ToJsonString() ?? "").Contains(marker, StringComparison.OrdinalIgnoreCase)) leaks.Add($"{who.Email} GET /{url} still shows {marker}");
            }
            var review = await who.Post("/api/v1/meet/review", new { scope = "all" });
            if ((review.Data?["items"]?.ToJsonString() ?? "").Contains(marker, StringComparison.OrdinalIgnoreCase)) leaks.Add($"{who.Email} review(all) still shows {marker}");
            var reminders = (await who.Get("/api/v1/reminders")).Data?["open"]?.ToJsonString() ?? "";
            if (reminders.Contains(marker, StringComparison.OrdinalIgnoreCase)) leaks.Add($"{who.Email} open reminders still show {marker}");
        }
        Assert.True(leaks.Count == 0, string.Join("\n", leaks));
    }

    [Fact]
    public async Task Deleting_a_project_hides_its_action_items_tasks_reminders_notifications_and_proposals_everywhere()
    {
        var w = await Setup("Quokka Launch");
        var marker = "Quokka" + Guid.NewGuid().ToString("N")[..8];
        var task = await w.Owner.CreateTaskAsync(w.Project, $"{marker} brochure", new { title = $"{marker} brochure", priority = "Medium", assigneeId = w.Dev.UserId, dueDate = Iso(2) });
        var action = await w.Owner.Post($"/api/v1/projects/{w.Project}/action-items", new { title = $"{marker} follow-up", assigneeId = w.Dev.UserId, dueDate = Iso(1) });
        Assert.True(action.Ok, action.ToString());
        var actionId = S(action.Data!["id"]);
        var fire = DateTime.UtcNow.AddHours(3);
        Assert.True((await w.Dev.Post("/api/v1/reminders", new { title = $"{marker} chase", targetType = "ActionItem", targetId = actionId, when = new { at = Local(fire), timeZone = "Asia/Kolkata" } })).Ok);
        Assert.True((await w.Dev.Post("/api/v1/reminders", new { title = $"{marker} nudge", targetType = "Task", targetId = S(task["id"]), when = new { at = Local(fire), timeZone = "Asia/Kolkata" } })).Ok);
        var findingId = factory.WithDb(db =>
        {
            var f = new AgentFinding { TenantId = w.Owner.WorkspaceId, ProjectId = w.Project, TaskId = Guid.Parse(S(task["id"])), Title = $"Move {marker} delivery date", Kind = AgentFindingKind.Delay };
            db.AgentFindings.Add(f);
            db.Notifications.Add(new Notification { TenantId = w.Owner.WorkspaceId, UserId = w.Owner.UserId, Type = NotificationType.ProjectUpdated, Title = $"{marker} moved", Link = $"/projects/{w.Project}?tab=actions&action={actionId}", InApp = true });
            db.SaveChanges();
            return f.Id;
        });
        // Before: it is there.
        Assert.Contains((await w.Dev.Get("/api/v1/work-items?mine=true&status=all&limit=200")).Data!["items"]!.AsArray(), i => S(i!["id"]) == actionId);

        Assert.Equal(HttpStatusCode.NoContent, (await w.Owner.Delete($"/api/v1/projects/{w.Project}")).Status);

        await AssertGoneEverywhere(marker, w.Owner, w.Dev);
        // Soft only: the rows are still there, marked.
        var (deleted, reminderStates, archived, finding) = factory.WithDb(db => (
            db.WorkTasks.IgnoreQueryFilters().Single(x => x.Id == Guid.Parse(actionId)).IsDeleted,
            db.Reminders.IgnoreQueryFilters().Where(r => r.UserId == w.Dev.UserId && r.Title.StartsWith(marker)).Select(r => new { r.State, r.LockToken }).ToList(),
            db.Notifications.IgnoreQueryFilters().Where(n => n.TenantId == w.Owner.WorkspaceId && n.Title == $"{marker} moved").Select(n => n.ArchivedAt).Single(),
            db.AgentFindings.IgnoreQueryFilters().Any(f => f.Id == findingId)));
        Assert.True(deleted);
        Assert.Equal(2, reminderStates.Count);
        Assert.All(reminderStates, r => { Assert.Equal(ReminderState.Cancelled, r.State); Assert.Equal(ReminderSync.Orphaned, r.LockToken); });
        Assert.NotNull(archived);
        Assert.True(finding);
    }

    [Fact]
    public async Task Deleting_a_task_hides_its_reminders_notifications_and_proposals_and_undo_brings_the_task_back()
    {
        var w = await Setup("Wombat Rollout");
        var marker = "Wombat" + Guid.NewGuid().ToString("N")[..8];
        var task = await w.Owner.CreateTaskAsync(w.Project, $"{marker} signage", new { title = $"{marker} signage", priority = "Medium", assigneeId = w.Dev.UserId, dueDate = Iso(2) });
        var taskId = Guid.Parse(S(task["id"]));
        Assert.True((await w.Dev.Post("/api/v1/reminders", new { title = $"{marker} check", targetType = "Task", targetId = taskId, when = new { at = Local(DateTime.UtcNow.AddHours(3)), timeZone = "Asia/Kolkata" } })).Ok);
        factory.WithDb(db =>
        {
            db.AgentFindings.Add(new AgentFinding { TenantId = w.Owner.WorkspaceId, ProjectId = w.Project, TaskId = taskId, Title = $"Move {marker} delivery date", Kind = AgentFindingKind.Delay });
            db.Notifications.Add(new Notification { TenantId = w.Owner.WorkspaceId, UserId = w.Dev.UserId, Type = NotificationType.TaskAssigned, Title = $"{marker} is yours", Link = $"/projects/{w.Project}?task={taskId}", InApp = true });
            return db.SaveChanges();
        });
        Assert.Contains((await w.Owner.Get($"/api/v1/projects/{w.Project}/agent/findings?status=all")).Data!["items"]!.AsArray(), f => S(f!["title"]).Contains(marker));

        Assert.Equal(HttpStatusCode.NoContent, (await w.Owner.Delete($"/api/v1/tasks/{taskId}")).Status);

        await AssertGoneEverywhere(marker, w.Owner, w.Dev);
        Assert.DoesNotContain((await w.Owner.Get($"/api/v1/projects/{w.Project}/agent/findings?status=all")).Data!["items"]!.AsArray(), f => S(f!["title"]).Contains(marker));
        // The project itself is untouched.
        Assert.Equal(HttpStatusCode.OK, (await w.Owner.Get($"/api/v1/projects/{w.Project}")).Status);
    }

    [Fact]
    public async Task The_cleanup_hides_orphans_left_by_older_deletes_and_keeps_only_the_oldest_copy_of_a_duplicated_action_item()
    {
        var w = await Setup("Numbat Ops");
        var isPostgres = factory.WithDb(db => db.Database.IsNpgsql());
        if (!isPostgres) return;   // the clean-up is PostgreSQL SQL (the production engine); CI runs this on PostgreSQL

        var marker = "Numbat" + Guid.NewGuid().ToString("N")[..8];
        var first = await w.Owner.Post($"/api/v1/projects/{w.Project}/action-items", new { title = $"{marker} send minutes", assigneeId = w.Dev.UserId, dueDate = Iso(3) });
        var second = await w.Owner.Post($"/api/v1/projects/{w.Project}/action-items", new { title = $"{marker} send minutes", assigneeId = w.Dev.UserId, dueDate = Iso(3) });
        var different = await w.Owner.Post($"/api/v1/projects/{w.Project}/action-items", new { title = $"{marker} book room", assigneeId = w.Dev.UserId, dueDate = Iso(3) });
        Assert.True(first.Ok && second.Ok && different.Ok);
        var firstId = Guid.Parse(S(first.Data!["id"]));
        var secondId = Guid.Parse(S(second.Data!["id"]));
        var differentId = Guid.Parse(S(different.Data!["id"]));

        // A second project deleted the old way: only the project row was marked, its action item and task were left behind.
        var old = await w.Owner.CreateProjectAsync("Bilby Legacy");
        var orphan = await w.Owner.Post($"/api/v1/projects/{old}/action-items", new { title = $"{marker} orphan", assigneeId = w.Dev.UserId });
        var orphanId = Guid.Parse(S(orphan.Data!["id"]));
        var orphanTask = Guid.Parse(S((await w.Owner.CreateTaskAsync(old, $"{marker} orphan task"))["id"]));
        var tenant = w.Owner.WorkspaceId;
        factory.WithDb(db =>
        {
            db.Notifications.Add(new Notification { TenantId = tenant, UserId = w.Dev.UserId, Type = NotificationType.ProjectUpdated, Title = $"{marker} legacy", Link = $"/projects/{old}?tab=actions&action={orphanId}", InApp = true });
            db.SaveChanges();
            return db.Database.ExecuteSqlRaw($"UPDATE \"Projects\" SET \"IsDeleted\" = TRUE, \"DeletedAt\" = now() WHERE \"Id\" = '{old}'");
        });

        // Run it twice: it is idempotent.
        for (var run = 0; run < 2; run++)
            factory.WithDb(db => { foreach (var sql in DeletedWorkCleanupSql.Statements(tenant)) db.Database.ExecuteSqlRaw(sql.Replace("{", "{{").Replace("}", "}}")); return 0; });

        var rows = factory.WithDb(db => db.WorkItems.IgnoreQueryFilters().Where(x => new[] { firstId, secondId, differentId, orphanId, orphanTask }.Contains(x.Id))
            .ToDictionary(x => x.Id, x => x.IsDeleted));
        Assert.False(rows[firstId]);       // the oldest copy stays
        Assert.True(rows[secondId]);       // the later copy is soft-deleted
        Assert.False(rows[differentId]);   // another title is not a copy
        Assert.True(rows[orphanId]);
        Assert.True(rows[orphanTask]);
        Assert.Equal(5, rows.Count);       // nothing removed
        Assert.NotNull(factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Single(n => n.TenantId == tenant && n.Title == $"{marker} legacy").ArchivedAt));

        var mine = (await w.Dev.Get("/api/v1/work-items?mine=true&status=all&limit=200")).Data!["items"]!.AsArray();
        Assert.Single(mine, i => S(i!["title"]) == $"{marker} send minutes");
    }

    [Fact]
    public async Task Approval_links_to_a_deleted_task_or_project_are_left_out_and_other_links_stay()
    {
        var w = await Setup("Platypus Release");
        var other = await w.Owner.CreateProjectAsync("Echidna Ops");
        var task = Guid.Parse(S((await w.Owner.CreateTaskAsync(other, "Echidna cutover"))["id"]));
        var created = await w.Owner.Post("/api/v1/approvals", new
        {
            type = "ChangeRequest", title = "Platypus config change", risk = "Low",
            links = new object[]
            {
                new { kind = "task", label = "Echidna cutover", id = task.ToString(), href = $"/projects/{other}?task={task}" },
                new { kind = "project", label = "Echidna Ops", id = other.ToString(), href = $"/projects/{other}" },
                new { kind = "project", label = "Platypus Release", id = w.Project.ToString(), href = $"/projects/{w.Project}" },
                new { kind = "pr", label = "PR #42", href = "/projects" },
            },
            chain = new object[] { new { role = "Lead", userId = w.Dev.UserId } },
        });
        Assert.True(created.Ok, created.ToString());
        var id = S(created.Data!["id"]);
        string[] Labels(JsonNode? r) => r!["links"]!.AsArray().Select(l => S(l!["label"])).ToArray();
        Assert.Equal(4, Labels(created.Data).Length);

        Assert.Equal(HttpStatusCode.NoContent, (await w.Owner.Delete($"/api/v1/tasks/{task}")).Status);
        Assert.Equal(new[] { "Echidna Ops", "Platypus Release", "PR #42" }, Labels((await w.Owner.Get($"/api/v1/approvals/{id}")).Data));

        Assert.Equal(HttpStatusCode.NoContent, (await w.Owner.Delete($"/api/v1/projects/{other}")).Status);
        Assert.Equal(new[] { "Platypus Release", "PR #42" }, Labels((await w.Owner.Get($"/api/v1/approvals/{id}")).Data));
        var listed = (await w.Owner.Get("/api/v1/approvals?view=mine")).Data!["items"]!.AsArray().Single(r => S(r!["id"]) == id);
        Assert.Equal(new[] { "Platypus Release", "PR #42" }, Labels(listed));
    }
}
