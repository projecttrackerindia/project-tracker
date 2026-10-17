using System.Net;
using System.Text.Json.Nodes;
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
}
