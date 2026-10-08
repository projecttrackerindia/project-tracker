using System.Text.Json.Nodes;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Hours on a task are rejected with a real, field-pointed message well before they could ever overflow the database column
/// (decimal(9,2)): the bug this guards against was a bare 422 with nothing shown to the person, from a raw numeric-overflow error that
/// never went through validation at all.
/// </summary>
[Collection("api")]
public class TaskValidationTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private async Task<(TestClient C, Guid Project)> Setup()
    {
        var c = await TestClient.RegisterAsync(factory);
        await c.CreateOrgAsync();
        return (c, await c.CreateProjectAsync("Atlas"));
    }

    [Fact]
    public async Task A_huge_estimate_is_refused_with_a_field_message_instead_of_overflowing_the_database()
    {
        var (c, project) = await Setup();
        var bad = await c.Post($"/api/v1/projects/{project}/tasks", new { title = "Huge", priority = "Medium", estimatedHours = 99_999_999 });
        Assert.Equal("VALIDATION_FAILED", bad.ErrorCode);
        Assert.Equal("estimatedHours", S(bad.Json!["errors"]![0]!["field"]));

        var ok = await c.Post($"/api/v1/projects/{project}/tasks", new { title = "Fine", priority = "Medium", estimatedHours = 40 });
        Assert.True(ok.Ok, ok.ToString());
    }

    [Fact]
    public async Task A_negative_or_huge_actual_hours_on_update_is_refused_the_same_way()
    {
        var (c, project) = await Setup();
        var task = await c.CreateTaskAsync(project, "Task", new { title = "Task", priority = "Medium" });
        var taskId = S(task["id"]);
        var statuses = (await c.Get($"/api/v1/projects/{project}/statuses")).Data!.AsArray();
        var statusId = S(statuses[0]!["id"]);

        var huge = await c.Put($"/api/v1/tasks/{taskId}", new { title = "Task", statusId, priority = "Medium", actualHours = 99_999_999, version = task["version"]!.GetValue<int>() });
        Assert.Equal("VALIDATION_FAILED", huge.ErrorCode);
        Assert.Equal("actualHours", S(huge.Json!["errors"]![0]!["field"]));

        var negative = await c.Put($"/api/v1/tasks/{taskId}", new { title = "Task", statusId, priority = "Medium", actualHours = -1, version = task["version"]!.GetValue<int>() });
        Assert.Equal("VALIDATION_FAILED", negative.ErrorCode);
    }
}
