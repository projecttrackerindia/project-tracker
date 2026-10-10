using System.Net;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

[Collection("api")]
public class SupportResolutionTests(ApiFactory factory)
{
    [Fact]
    public async Task Only_reporter_acknowledges_verified_resolution_and_reopening_invalidates_it()
    {
        var owner = await TestClient.RegisterAsync(factory, "Support reporter"); await owner.CreateOrgAsync(); await owner.UpgradeAsync("BUSINESS");
        var admin = await owner.AddMemberAsync(factory, TenantRole.Admin, "Support engineer");
        var types = (await owner.Get("/api/v1/work-types")).Data!.AsArray();
        var type = types.First(t => t!["name"]!.GetValue<string>() == "Bug Fix")!["id"]!.GetValue<string>();
        var created = await owner.Post("/api/v1/work-tasks", new { title = "Verify production fix", workTypeId = type }); Assert.True(created.Ok, created.ToString());
        var id = created.Data!["id"]!.GetValue<string>();
        var initial = (await owner.Get($"/api/v1/work-tasks/{id}/resolution")).Data!;
        var premature = await admin.Put($"/api/v1/work-tasks/{id}/resolution", new { workVersion = initial["workVersion"]!.GetValue<int>(), note = "Confirmed the regression fix with a focused reproduction." });
        Assert.Equal("SUPPORT_NOT_COMPLETED", premature.ErrorCode);
        Assert.True((await admin.Put($"/api/v1/work-tasks/{id}/status", new { status = "Completed" })).Ok);
        var complete = (await owner.Get($"/api/v1/work-tasks/{id}/resolution")).Data!;
        var proposed = await admin.Put($"/api/v1/work-tasks/{id}/resolution", new { workVersion = complete["workVersion"]!.GetValue<int>(), note = "Confirmed the regression fix with a focused reproduction." }); Assert.True(proposed.Ok, proposed.ToString());
        var version = proposed.Data!["workVersion"]!.GetValue<int>();
        Assert.True(proposed.Data["current"]!.GetValue<bool>());
        Assert.Equal(HttpStatusCode.Forbidden, (await admin.Post($"/api/v1/work-tasks/{id}/resolution/accept", new { workVersion = version })).Status);
        var accepted = await owner.Post($"/api/v1/work-tasks/{id}/resolution/accept", new { workVersion = version }); Assert.True(accepted.Ok, accepted.ToString()); Assert.NotNull(accepted.Data!["acceptedAt"]);
        var key = created.Data["key"]!.GetValue<string>();
        var evidence = await owner.Get($"/api/v1/ai/knowledge/workitem/{id}?key={key}"); Assert.True(evidence.Ok, evidence.ToString());
        Assert.Contains("Reporter-acknowledged resolution", evidence.Data!["text"]!.GetValue<string>());
        Assert.True((await admin.Put($"/api/v1/work-tasks/{id}/status", new { status = "InProgress" })).Ok);
        var stale = (await owner.Get($"/api/v1/work-tasks/{id}/resolution")).Data!; Assert.False(stale["current"]!.GetValue<bool>()); Assert.Null(stale["acceptedAt"]);
        Assert.DoesNotContain("Reporter-acknowledged resolution", (await owner.Get($"/api/v1/ai/knowledge/workitem/{id}?key={key}")).Data!["text"]!.GetValue<string>());
        Assert.Equal("SUPPORT_RESOLUTION_STALE", (await owner.Post($"/api/v1/work-tasks/{id}/resolution/accept", new { workVersion = stale["workVersion"]!.GetValue<int>() })).ErrorCode);
        var stranger = await TestClient.RegisterAsync(factory, "Foreign support reader"); await stranger.CreateOrgAsync();
        Assert.Equal(HttpStatusCode.NotFound, (await stranger.Get($"/api/v1/work-tasks/{id}/resolution")).Status);
    }
}
