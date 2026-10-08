using System.Net;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Start Meeting and Schedule Meeting (spec sections 2-3): creating a Google Meet from a project, restricted to people who can
/// already see that project, organized through the Google account of whoever clicked the button.</summary>
[Collection("api")]
public class ProjectMeetingTests(ApiFactory factory)
{
    private static string QueryValue(Uri u, string name)
    {
        foreach (var pair in u.Query.TrimStart('?').Split('&'))
        {
            var kv = pair.Split('=', 2);
            if (kv[0] == name) return Uri.UnescapeDataString(kv.ElementAtOrDefault(1) ?? "");
        }
        throw new InvalidOperationException($"No '{name}' in '{u.Query}'.");
    }

    /// <summary>Connects c's Google account through the fake provider, the same round trip GoogleCalendarIntegrationTests drives in full.</summary>
    private async Task ConnectGoogleAsync(TestClient c)
    {
        var start = await c.Get("/api/v1/integrations/google/connect");
        Assert.True(start.Ok, start.ToString());
        var authorize = new Uri(start.Data!["url"]!.GetValue<string>());
        var state = QueryValue(authorize, "state");
        var code = factory.GoogleCalendar.IssueCode($"{c.Email}");

        using var noRedirect = factory.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        using var cb = await noRedirect.GetAsync($"/api/v1/integrations/google/callback?code={code}&state={state}");
        Assert.Equal(HttpStatusCode.Redirect, cb.StatusCode);
    }

    [Fact]
    public async Task Starting_a_meeting_without_connecting_google_fails_with_a_plain_language_error()
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();
        var project = await owner.CreateProjectAsync("Payment Engine");

        var res = await owner.Post($"/api/v1/projects/{project}/meetings/start", new { });
        Assert.False(res.Ok, res.ToString());
        Assert.Equal("GOOGLE_NOT_CONNECTED", res.ErrorCode);
    }

    [Fact]
    public async Task Starting_a_meeting_defaults_to_every_project_member_and_marks_the_organizer_accepted()
    {
        var owner = await TestClient.RegisterAsync(factory, "Prasanna");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("PRO");
        var project = await owner.CreateProjectAsync("Payment Engine");
        var teammate = await owner.AddMemberAsync(factory, Domain.Enums.TenantRole.Member, "Sridhar");
        var addRes = await owner.Post($"/api/v1/projects/{project}/members", new { userId = teammate.UserId });
        Assert.True(addRes.Ok, addRes.ToString());
        await ConnectGoogleAsync(owner);

        var res = await owner.Post($"/api/v1/projects/{project}/meetings/start", new { title = "Payment Engine Phase 3 Discussion" });
        Assert.Equal(HttpStatusCode.Created, res.Status);
        Assert.Equal("Payment Engine Phase 3 Discussion", res.Data!["title"]!.GetValue<string>());
        Assert.StartsWith("https://meet.google.com/", res.Data["meetUri"]!.GetValue<string>());
        Assert.Equal("Scheduled", res.Data["status"]!.GetValue<string>());

        var participants = res.Data["participants"]!.AsArray();
        Assert.Equal(2, participants.Count); // owner (organizer) + the one teammate added to the project
        var organizerRow = participants.First(p => p!["userId"]!.GetValue<string>() == owner.UserId.ToString());
        Assert.Equal("Organizer", organizerRow!["role"]!.GetValue<string>());
        Assert.Equal("Accepted", organizerRow["rsvpStatus"]!.GetValue<string>());
        var teammateRow = participants.First(p => p!["userId"]!.GetValue<string>() == teammate.UserId.ToString());
        Assert.Equal("NeedsAction", teammateRow!["rsvpStatus"]!.GetValue<string>());
    }

    [Fact]
    public async Task Scheduling_rejects_a_participant_who_cannot_see_the_project()
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("PRO");
        var project = await owner.CreateProjectAsync("Employee Portal");
        await ConnectGoogleAsync(owner);
        var outsider = await owner.AddMemberAsync(factory, Domain.Enums.TenantRole.Member, "Not on this project");   // workspace member, but never added to the project

        var start = DateTimeOffset.UtcNow.AddDays(1);
        var res = await owner.Post($"/api/v1/projects/{project}/meetings/schedule", new
        {
            title = "TLS 1.3 UAT Validation", startTime = start, endTime = start.AddMinutes(30), timeZone = "Asia/Kolkata",
            participantUserIds = new[] { outsider.UserId },
        });
        Assert.False(res.Ok, res.ToString());
        Assert.Equal("VALIDATION_FAILED", res.ErrorCode);
    }

    [Fact]
    public async Task Scheduling_rejects_an_end_time_before_the_start_time_and_a_time_already_in_the_past()
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();
        var project = await owner.CreateProjectAsync("Employee Portal");
        await ConnectGoogleAsync(owner);
        var start = DateTimeOffset.UtcNow.AddDays(1);

        var backwards = await owner.Post($"/api/v1/projects/{project}/meetings/schedule", new { title = "x", startTime = start, endTime = start.AddMinutes(-10), timeZone = "UTC" });
        Assert.Equal("VALIDATION_FAILED", backwards.ErrorCode);

        var past = DateTimeOffset.UtcNow.AddDays(-1);
        var late = await owner.Post($"/api/v1/projects/{project}/meetings/schedule", new { title = "x", startTime = past, endTime = past.AddMinutes(30), timeZone = "UTC" });
        Assert.Equal("VALIDATION_FAILED", late.ErrorCode);
    }

    [Fact]
    public async Task The_organizer_can_cancel_but_an_ordinary_member_cannot()
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("PRO");
        var project = await owner.CreateProjectAsync("Employee Portal");
        await ConnectGoogleAsync(owner);
        var member = await owner.AddMemberAsync(factory, Domain.Enums.TenantRole.Member, "Kiran");
        await owner.Post($"/api/v1/projects/{project}/members", new { userId = member.UserId });

        var created = await owner.Post($"/api/v1/projects/{project}/meetings/start", new { });
        var meetingId = created.Data!["id"]!.GetValue<string>();

        var deniedCancel = await member.Post($"/api/v1/meetings/{meetingId}/cancel");
        Assert.Equal(HttpStatusCode.Forbidden, deniedCancel.Status);

        var cancel = await owner.Post($"/api/v1/meetings/{meetingId}/cancel");
        Assert.Equal(HttpStatusCode.NoContent, cancel.Status);

        var got = await owner.Get($"/api/v1/meetings/{meetingId}");
        Assert.Equal("Cancelled", got.Data!["status"]!.GetValue<string>());
    }

    [Fact]
    public async Task Eligible_participants_lists_the_owner_and_every_project_member()
    {
        var owner = await TestClient.RegisterAsync(factory, "Owner Person");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("PRO");
        var project = await owner.CreateProjectAsync("Employee Portal");
        var teammate = await owner.AddMemberAsync(factory, Domain.Enums.TenantRole.Member, "Naveen");
        await owner.Post($"/api/v1/projects/{project}/members", new { userId = teammate.UserId });

        var res = await owner.Get($"/api/v1/projects/{project}/meetings/participants");
        Assert.True(res.Ok, res.ToString());
        var ids = res.Data!.AsArray().Select(p => p!["userId"]!.GetValue<string>()).ToList();
        Assert.Contains(owner.UserId.ToString(), ids);
        Assert.Contains(teammate.UserId.ToString(), ids);
    }
}
