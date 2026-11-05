using System.Net;
using ProjectManagement.Application.Features.Platform;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>"Report a problem" (kept in the workspace, secrets masked, screenshot checked, admins read them) and feature flags (person, team, workspace, safe default).</summary>
[Collection("api")]
public class FeedbackAndFlagsTests(ApiFactory factory)
{
    // A 1×1 transparent PNG.
    private const string Png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

    [Fact]
    public void Secrets_are_masked() =>
        Assert.Equal("GET /api?token=••• Authorization: Bearer •••", ProblemReportService.Scrub("GET /api?token=abc123 Authorization: Bearer eyJhbGciOi.x.y"));

    [Fact]
    public async Task A_report_is_kept_with_its_context_and_only_admins_of_that_workspace_read_it()
    {
        var owner = await TestClient.RegisterAsync(factory, "Rhea Reporter");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Milo Member");
        var sent = await member.Post("/api/v1/problem-reports", new
        {
            message = "The board froze after I dragged a card", route = "/work/projects?view=board", appVersion = "2026.11.5",
            console = new[] { "TypeError: x is undefined", "fetch failed password=hunter2" }, network = new[] { "GET /api/v1/tasks 500" }, screenshot = Png, userAgent = "Fictional/1.0",
        });
        Assert.Equal(HttpStatusCode.Created, sent.Status);
        Assert.StartsWith("PR-", sent.Data!["reference"]!.GetValue<string>());

        Assert.Equal(HttpStatusCode.Forbidden, (await member.Get("/api/v1/problem-reports")).Status);
        var list = (await owner.Get("/api/v1/problem-reports")).Data!.AsArray();
        var r = Assert.Single(list)!;
        Assert.Equal("/work/projects?view=board", r["route"]!.GetValue<string>());
        Assert.True(r["hasScreenshot"]!.GetValue<bool>());
        Assert.DoesNotContain("hunter2", r.ToJsonString());
        using var shot = await owner.Raw($"/api/v1/problem-reports/{r["id"]!.GetValue<string>()}/screenshot");
        Assert.Equal(HttpStatusCode.OK, shot.StatusCode);
        Assert.Equal("image/png", shot.Content.Headers.ContentType?.MediaType);

        // Another workspace sees none of it.
        var other = await TestClient.RegisterAsync(factory, "Otto Other");
        await other.CreateOrgAsync();
        Assert.Empty((await other.Get("/api/v1/problem-reports")).Data!.AsArray());
        Assert.Equal(HttpStatusCode.NotFound, (await other.Raw($"/api/v1/problem-reports/{r["id"]!.GetValue<string>()}/screenshot")).StatusCode);

        // Not an image, or nothing said: refused.
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await member.Post("/api/v1/problem-reports", new { message = "x", screenshot = "data:image/png;base64,aGVsbG8=" })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await member.Post("/api/v1/problem-reports", new { message = " " })).Status);
    }

    [Fact]
    public async Task Flags_follow_person_then_team_then_workspace_then_the_safe_default()
    {
        var owner = await TestClient.RegisterAsync(factory, "Fia Flagger");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Max Member");
        bool Mine(ApiResult res, string key) => res.Data!["flags"]![key]!.GetValue<bool>();

        Assert.False(Mine(await member.Get("/api/v1/feature-flags/mine"), "shake-to-report"));   // safe default: off
        Assert.True(Mine(await member.Get("/api/v1/feature-flags/mine"), "whats-new"));

        Assert.Equal(HttpStatusCode.Forbidden, (await member.Put("/api/v1/feature-flags/shake-to-report", new { scope = "workspace", enabled = true })).Status);
        Assert.True((await owner.Put("/api/v1/feature-flags/shake-to-report", new { scope = "workspace", enabled = true })).Ok);
        Assert.True(Mine(await member.Get("/api/v1/feature-flags/mine"), "shake-to-report"));

        var team = await owner.Post("/api/v1/teams", new { name = "Fictional pilot team" }); Assert.True(team.Ok, team.ToString());
        var teamId = (team.Data!["team"]?["id"] ?? team.Data!["id"])!.GetValue<string>();
        Assert.True((await owner.Post($"/api/v1/teams/{teamId}/members", new { userId = member.UserId, isLead = false })).Ok);
        Assert.True((await owner.Put("/api/v1/feature-flags/shake-to-report", new { scope = "team", targetId = teamId, enabled = false })).Ok);
        Assert.False(Mine(await member.Get("/api/v1/feature-flags/mine"), "shake-to-report"));

        Assert.True((await owner.Put("/api/v1/feature-flags/shake-to-report", new { scope = "user", targetId = member.UserId, enabled = true })).Ok);
        Assert.True(Mine(await member.Get("/api/v1/feature-flags/mine"), "shake-to-report"));

        // Removing the person's setting falls back to the team.
        var list = await owner.Put("/api/v1/feature-flags/shake-to-report", new { scope = "user", targetId = member.UserId, enabled = (bool?)null });
        Assert.True(list.Ok, list.ToString());
        Assert.False(Mine(await member.Get("/api/v1/feature-flags/mine"), "shake-to-report"));
        var row = list.Data!.AsArray().First(f => f!["key"]!.GetValue<string>() == "shake-to-report")!;
        Assert.True(row["workspace"]!.GetValue<bool>());
        Assert.Single(row["overrides"]!.AsArray());

        Assert.Equal(HttpStatusCode.NotFound, (await owner.Put("/api/v1/feature-flags/nope", new { scope = "workspace", enabled = true })).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Put("/api/v1/feature-flags/whats-new", new { scope = "user", targetId = Guid.NewGuid(), enabled = false })).Status);
    }
}
