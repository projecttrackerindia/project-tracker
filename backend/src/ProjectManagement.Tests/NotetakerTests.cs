using System.Net;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Agent;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>The notetaker: settings, sending it, minutes guards, and the bot's signed-in accounts (platform administrators only).</summary>
[Collection("api")]
public class NotetakerTests(ApiFactory factory)
{
    [Fact]
    public async Task Settings_and_join_are_validated()
    {
        var me = await TestClient.RegisterAsync(factory, "Nina Notes");
        await me.CreateOrgAsync();
        var project = await me.CreateProjectAsync("Atlas");
        var overview = await me.Get("/api/v1/me/notetaker");
        Assert.True(overview.Ok, overview.ToString());
        Assert.Contains(overview.Data!["projects"]!.AsArray(), p => p!["id"]!.GetValue<string>() == project.ToString());
        Assert.Empty(overview.Data!["sessions"]!.AsArray());

        Assert.Equal(422, (int)(await me.Put("/api/v1/me/notetaker/settings", new { projectId = (Guid?)null, autoJoin = true, autoMinutes = true })).Status);
        var saved = await me.Put("/api/v1/me/notetaker/settings", new { projectId = project, autoJoin = true, autoMinutes = false });
        Assert.True(saved.Ok, saved.ToString());
        Assert.False(saved.Data!["autoMinutes"]!.GetValue<bool>());

        Assert.Equal(422, (int)(await me.Post("/api/v1/me/notetaker/join", new { url = "https://example.com/call", minutes = 60 })).Status);
        Assert.Equal(422, (int)(await me.Post("/api/v1/me/notetaker/join", new { url = "https://meet.google.com/abc-defg-hij", minutes = 5 })).Status);
        // The project agent must be on (or the bot is not set up in tests): a clear conflict, never a server error.
        Assert.Equal(HttpStatusCode.Conflict, (await me.Post("/api/v1/me/notetaker/join", new { url = "https://meet.google.com/abc-defg-hij", minutes = 60 })).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await me.Get($"/api/v1/me/notetaker/sessions/{Guid.NewGuid()}/minutes")).Status);

        // Only platform administrators manage the bot's Google accounts.
        Assert.Equal(HttpStatusCode.Forbidden, (await me.Get("/api/v1/admin/meeting-bots/identities")).Status);
    }

    [Fact]
    public void Exported_cookies_keep_only_signed_in_google_cookies()
    {
        var json = """
        [{"name":"SID","value":"a","domain":".google.com","path":"/","expirationDate":1999999999.5,"httpOnly":true,"secure":true,"sameSite":"no_restriction"},
         {"name":"other","value":"b","domain":".example.com","path":"/"},
         {"name":"OSID","value":"c","domain":"meet.google.com","sameSite":"lax"}]
        """;
        var cookies = MeetingBotIdentityService.Normalize(json);
        Assert.Equal(2, cookies.Count);
        Assert.Equal("None", cookies[0]!["sameSite"]!.GetValue<string>());
        Assert.Equal(2000000000d, cookies[0]!["expires"]!.GetValue<double>());
        Assert.Throws<ValidationException>(() => MeetingBotIdentityService.Normalize("""[{"name":"NID","value":"x","domain":".google.com"}]"""));
        Assert.Throws<ValidationException>(() => MeetingBotIdentityService.Normalize("not json"));
    }
}
