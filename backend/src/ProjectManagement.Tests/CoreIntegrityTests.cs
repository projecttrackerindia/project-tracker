using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Integrity rules that must hold under concurrency and for every caller: archived projects stay read-only, keys and numbers stay unique.</summary>
[Collection("api")]
public class CoreIntegrityTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private async Task<(TestClient Owner, Guid Project)> Setup(string plan = "BUSINESS")
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();
        if (plan != "FREE") await owner.UpgradeAsync(plan);
        var project = await owner.CreateProjectAsync("Atlas");
        return (owner, project);
    }

    [Fact]
    public async Task An_archived_project_refuses_task_edits_moves_deletes_comments_and_files()
    {
        var (c, project) = await Setup();
        var task = await c.CreateTaskAsync(project, "Before archiving");
        var taskId = Guid.Parse(S(task["id"]));
        var statusId = S(task["statusId"]);
        var version = task["version"]!.GetValue<int>();
        Assert.True((await c.Send(HttpMethod.Patch, $"/api/v1/projects/{project}/move", new { status = "Archived" })).Ok);

        var update = await c.Put($"/api/v1/tasks/{taskId}", new { title = "Changed", priority = "High", statusId, version });
        Assert.Equal(HttpStatusCode.Conflict, update.Status);
        Assert.Equal("PROJECT_ARCHIVED", update.ErrorCode);
        var move = await c.Send(HttpMethod.Patch, $"/api/v1/tasks/{taskId}/move", new { statusId });
        Assert.Equal("PROJECT_ARCHIVED", move.ErrorCode);
        var comment = await c.Post($"/api/v1/tasks/{taskId}/comments", new { body = "Too late" });
        Assert.Equal("PROJECT_ARCHIVED", comment.ErrorCode);
        var delete = await c.Delete($"/api/v1/tasks/{taskId}");
        Assert.Equal("PROJECT_ARCHIVED", delete.ErrorCode);
        var upload = await c.Upload($"/api/v1/projects/{project}/tasks/{taskId}/attachments", "Spec.pdf", [.. "%PDF-1.4\n%test file\n"u8.ToArray()]);
        Assert.Equal(HttpStatusCode.Conflict, upload.Status);
        Assert.Equal("PROJECT_ARCHIVED", upload.ErrorCode);

        // Nothing changed.
        var after = (await c.Get($"/api/v1/tasks/{taskId}")).Data!["task"]!;
        Assert.Equal("Before archiving", S(after["title"]));
        Assert.Equal(0, after["commentCount"]!.GetValue<int>());
    }

    [Fact]
    public async Task Plan_limits_count_the_whole_workspace_even_for_someone_limited_to_their_teams()
    {
        var (owner, project) = await Setup();
        var member = await owner.AddMemberAsync(factory, ProjectManagement.Domain.Enums.TenantRole.Manager, "Team-limited manager");
        Assert.True((await owner.Put("/api/v1/workspace/project-visibility", new { mode = "teams" })).Ok);
        // Two projects exist (one the member cannot see); the plan allows two.
        await owner.CreateProjectAsync("Hidden from the member");
        factory.WithDb(db =>
        {
            db.TenantFeatureOverrides.Add(new ProjectManagement.Domain.Entities.TenantFeatureOverride { TenantId = owner.WorkspaceId, FeatureKey = "PROJECT_LIMIT", Value = 2, Reason = "test" });
            db.SaveChanges(); return 0;
        });
        var over = await member.Post("/api/v1/projects", new { name = "One too many", priority = "Medium" });
        Assert.Equal(HttpStatusCode.Forbidden, over.Status);
        Assert.Equal("PLAN_LIMIT_REACHED", over.ErrorCode);
    }

    [Fact]
    public async Task A_project_key_stays_taken_by_projects_the_caller_cannot_see_or_that_were_deleted()
    {
        var (owner, _) = await Setup();
        var res = await owner.Post("/api/v1/projects", new { name = "Original", key = "ORIG", priority = "Medium" });
        Assert.True(res.Ok, res.ToString());
        var original = Guid.Parse(S(res.Data!["project"]!["id"]));
        Assert.Equal(HttpStatusCode.NoContent, (await owner.Delete($"/api/v1/projects/{original}")).Status);

        var again = await owner.Post("/api/v1/projects", new { name = "Reuse", key = "ORIG", priority = "Medium" });
        Assert.Equal(HttpStatusCode.Conflict, again.Status);
        Assert.Equal("KEY_TAKEN", again.ErrorCode);
        // An automatic key skips it too.
        var auto = await owner.Post("/api/v1/projects", new { name = "Orig", priority = "Medium" });
        Assert.True(auto.Ok, auto.ToString());
        Assert.NotEqual("ORIG", S(auto.Data!["project"]!["key"]));

        // The database refuses a second project with the same key in a workspace, whatever the code above did.
        Assert.ThrowsAny<DbUpdateException>(() => factory.WithDb(db =>
        {
            var copy = db.Projects.IgnoreQueryFilters().AsNoTracking().First(p => p.Id == original);
            copy.Id = Guid.NewGuid(); copy.IsDeleted = false;
            db.Projects.Add(copy);
            return db.SaveChanges();
        }));
    }

    [Fact]
    public async Task A_person_can_never_have_two_running_timers()
    {
        var (owner, project) = await Setup();
        var a = Guid.Parse(S((await owner.CreateTaskAsync(project, "A"))["id"]));
        var b = Guid.Parse(S((await owner.CreateTaskAsync(project, "B"))["id"]));
        await Task.WhenAll(owner.Post($"/api/v1/tasks/{a}/timer/start"), owner.Post($"/api/v1/tasks/{b}/timer/start"));
        Assert.Equal(1, factory.WithDb(db => db.TimeEntries.IgnoreQueryFilters().Count(e => e.UserId == owner.UserId && e.StartedAt != null && e.EndedAt == null)));

        // The database refuses a second one too.
        Assert.ThrowsAny<DbUpdateException>(() => factory.WithDb(db =>
        {
            db.TimeEntries.Add(new TimeEntry { TenantId = owner.WorkspaceId, UserId = owner.UserId, TaskId = a, ProjectId = project, WorkDate = DateOnly.FromDateTime(DateTime.UtcNow), StartedAt = DateTime.UtcNow });
            return db.SaveChanges();
        }));
    }

    [Fact]
    public async Task Starting_two_sprints_at_once_leaves_one_running()
    {
        var (owner, project) = await Setup("PRO");
        async Task<Guid> Sprint(string name)
        {
            var res = await owner.Post($"/api/v1/projects/{project}/sprints", new { name, startDate = DateTime.UtcNow.ToString("yyyy-MM-dd"), endDate = DateTime.UtcNow.AddDays(13).ToString("yyyy-MM-dd") });
            Assert.True(res.Ok, res.ToString());
            return Guid.Parse(S(res.Data!["id"]));
        }
        var one = await Sprint("One"); var two = await Sprint("Two");
        var results = await Task.WhenAll(owner.Post($"/api/v1/projects/{project}/sprints/{one}/start"), owner.Post($"/api/v1/projects/{project}/sprints/{two}/start"));
        Assert.Single(results, r => r.Ok);
        Assert.Equal(1, factory.WithDb(db => db.Sprints.IgnoreQueryFilters().Count(s => s.ProjectId == project && s.Status == ProjectManagement.Domain.Enums.SprintStatus.Active)));

        // Planning into the running sprint from two requests at once counts both.
        var running = results[0].Ok ? one : two;
        var t1 = Guid.Parse(S((await owner.CreateTaskAsync(project, "T1"))["id"]));
        var t2 = Guid.Parse(S((await owner.CreateTaskAsync(project, "T2"))["id"]));
        await Task.WhenAll(owner.Post($"/api/v1/projects/{project}/sprints/{running}/tasks", new { taskIds = new[] { t1 } }),
            owner.Post($"/api/v1/projects/{project}/sprints/{running}/tasks", new { taskIds = new[] { t2 } }));
        Assert.Equal(2, factory.WithDb(db => db.Sprints.IgnoreQueryFilters().Single(s => s.Id == running).CommittedTasks));
    }

    [Fact]
    public async Task Tasks_created_while_a_csv_import_runs_do_not_make_it_fail()
    {
        var (owner, project) = await Setup();
        var csv = "Title\n" + string.Join("\n", Enumerable.Range(1, 40).Select(i => $"Imported {i}")) + "\n";
        var import = owner.Upload($"/api/v1/projects/{project}/import", "tasks.csv", Encoding.UTF8.GetBytes(csv), new Dictionary<string, string>());
        // Someone keeps adding tasks by hand while the file is imported.
        var typing = Task.Run(async () =>
        {
            for (var i = 1; i <= 5; i++)
            {
                var res = await owner.Post($"/api/v1/projects/{project}/tasks", new { title = $"Typed {i}", priority = "Medium" });
                Assert.True(res.Ok, res.ToString());
            }
        });
        var imported = await import;
        Assert.True(imported.Ok, imported.ToString());
        await typing;
        var numbers = factory.WithDb(db => db.Tasks.IgnoreQueryFilters().Where(t => t.ProjectId == project).Select(t => t.Number).ToList());
        Assert.Equal(45, numbers.Count);
        Assert.Equal(numbers.Count, numbers.Distinct().Count());
    }
}
