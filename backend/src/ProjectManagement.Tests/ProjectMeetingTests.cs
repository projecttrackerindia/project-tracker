using System.Net;
using Microsoft.EntityFrameworkCore;
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

    [Fact]
    public async Task Scheduling_and_then_cancelling_posts_a_meeting_card_into_the_projects_chat()
    {
        var owner = await TestClient.RegisterAsync(factory, "Prasanna");
        await owner.CreateOrgAsync();
        var project = await owner.CreateProjectAsync("Payment Engine");
        await ConnectGoogleAsync(owner);
        var opened = await owner.Post($"/api/v1/chat/projects/{project}/open");
        Assert.True(opened.Ok, opened.ToString());
        var conversationId = opened.Data!["id"]!.GetValue<string>();

        var created = await owner.Post($"/api/v1/projects/{project}/meetings/start", new { title = "Payment Engine Discussion" });
        Assert.Equal(HttpStatusCode.Created, created.Status);
        var meetingId = created.Data!["id"]!.GetValue<string>();

        var afterSchedule = await owner.Get($"/api/v1/chat/conversations/{conversationId}/messages");
        Assert.True(afterSchedule.Ok, afterSchedule.ToString());
        var scheduledCard = afterSchedule.Data!["items"]!.AsArray().First(m => m!["kind"]!.GetValue<string>() == "Meeting");
        var scheduledBody = System.Text.Json.Nodes.JsonNode.Parse(scheduledCard!["body"]!.GetValue<string>())!;
        Assert.Equal(meetingId, scheduledBody["meetingId"]!.GetValue<string>());
        Assert.Equal("Payment Engine Discussion", scheduledBody["title"]!.GetValue<string>());
        Assert.Equal("Scheduled", scheduledBody["status"]!.GetValue<string>());

        var cancel = await owner.Post($"/api/v1/meetings/{meetingId}/cancel");
        Assert.Equal(HttpStatusCode.NoContent, cancel.Status);

        var afterCancel = await owner.Get($"/api/v1/chat/conversations/{conversationId}/messages");
        var cards = afterCancel.Data!["items"]!.AsArray().Where(m => m!["kind"]!.GetValue<string>() == "Meeting").ToList();
        Assert.Equal(2, cards.Count);   // the original "scheduled" card, plus a new "cancelled" one - never edited in place
        var cancelledBody = System.Text.Json.Nodes.JsonNode.Parse(cards.First(c => System.Text.Json.Nodes.JsonNode.Parse(c!["body"]!.GetValue<string>())!["status"]!.GetValue<string>() == "Cancelled")!["body"]!.GetValue<string>())!;
        Assert.Equal("Cancelled", cancelledBody["status"]!.GetValue<string>());
    }

    [Fact]
    public async Task Rescheduling_moves_the_meeting_and_an_ordinary_member_cannot_do_it()
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

        var newStart = DateTimeOffset.UtcNow.AddDays(2);
        var denied = await member.Post($"/api/v1/meetings/{meetingId}/reschedule", new { startTime = newStart, endTime = newStart.AddMinutes(30) });
        Assert.Equal(HttpStatusCode.Forbidden, denied.Status);

        var res = await owner.Post($"/api/v1/meetings/{meetingId}/reschedule", new { startTime = newStart, endTime = newStart.AddMinutes(30) });
        Assert.True(res.Ok, res.ToString());
        // DateTimeOffset (not DateTime): its equality compares the instant regardless of which offset the two sides happen to be expressed
        // in, where plain DateTime would wrongly fail here since the response round-trips through this machine's local offset.
        Assert.True((newStart - res.Data!["startTime"]!.GetValue<DateTimeOffset>()).Duration() < TimeSpan.FromSeconds(1));

        var backwards = await owner.Post($"/api/v1/meetings/{meetingId}/reschedule", new { startTime = newStart, endTime = newStart.AddMinutes(-5) });
        Assert.Equal("VALIDATION_FAILED", backwards.ErrorCode);
    }

    [Fact]
    public async Task Adding_and_removing_a_participant_updates_the_meeting_and_rejects_someone_outside_the_project()
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("PRO");
        var project = await owner.CreateProjectAsync("Employee Portal");
        await ConnectGoogleAsync(owner);
        var teammate = await owner.AddMemberAsync(factory, Domain.Enums.TenantRole.Member, "Naveen");
        await owner.Post($"/api/v1/projects/{project}/members", new { userId = teammate.UserId });
        var outsider = await owner.AddMemberAsync(factory, Domain.Enums.TenantRole.Member, "Outsider");
        var created = await owner.Post($"/api/v1/projects/{project}/meetings/start", new { participantUserIds = Array.Empty<string>() });
        var meetingId = created.Data!["id"]!.GetValue<string>();
        Assert.Single(created.Data["participants"]!.AsArray());   // organizer only, since an empty list was requested explicitly

        var rejected = await owner.Post($"/api/v1/meetings/{meetingId}/participants", new { userId = outsider.UserId });
        Assert.Equal("VALIDATION_FAILED", rejected.ErrorCode);

        var add = await owner.Post($"/api/v1/meetings/{meetingId}/participants", new { userId = teammate.UserId });
        Assert.True(add.Ok, add.ToString());
        Assert.Equal(2, add.Data!["participants"]!.AsArray().Count);

        var dupe = await owner.Post($"/api/v1/meetings/{meetingId}/participants", new { userId = teammate.UserId });
        Assert.Equal("ALREADY_INVITED", dupe.ErrorCode);

        var remove = await owner.Delete($"/api/v1/meetings/{meetingId}/participants/{teammate.UserId}");
        Assert.True(remove.Ok, remove.ToString());
        Assert.Single(remove.Data!["participants"]!.AsArray());

        var removeOrganizer = await owner.Delete($"/api/v1/meetings/{meetingId}/participants/{owner.UserId}");
        Assert.Equal("ORGANIZER_REQUIRED", removeOrganizer.ErrorCode);
    }

    [Fact]
    public async Task Rsvp_status_is_synchronized_from_google_when_the_meeting_is_read_and_never_written_locally()
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("PRO");
        var project = await owner.CreateProjectAsync("Employee Portal");
        await ConnectGoogleAsync(owner);
        var teammate = await owner.AddMemberAsync(factory, Domain.Enums.TenantRole.Member, "Sridhar");
        await owner.Post($"/api/v1/projects/{project}/members", new { userId = teammate.UserId });
        var created = await owner.Post($"/api/v1/projects/{project}/meetings/start", new { });
        var meetingId = created.Data!["id"]!.GetValue<string>();
        var eventId = factory.WithDb(db => db.ProjectMeetings.IgnoreQueryFilters().First(m => m.Id == Guid.Parse(meetingId)).GoogleCalendarEventId);

        var before = await owner.Get($"/api/v1/meetings/{meetingId}");
        var teammateBefore = before.Data!["participants"]!.AsArray().First(p => p!["userId"]!.GetValue<string>() == teammate.UserId.ToString());
        Assert.Equal("NeedsAction", teammateBefore!["rsvpStatus"]!.GetValue<string>());

        // The teammate "accepts" directly on Google's side (a calendar invite reply) - never through a Project Tracker endpoint of our own.
        factory.GoogleCalendar.SetResponseStatus(eventId, teammate.Email, "accepted");

        var after = await owner.Get($"/api/v1/meetings/{meetingId}");
        var teammateAfter = after.Data!["participants"]!.AsArray().First(p => p!["userId"]!.GetValue<string>() == teammate.UserId.ToString());
        Assert.Equal("Accepted", teammateAfter!["rsvpStatus"]!.GetValue<string>());

        // And the same holds through the list endpoint, not only the single-meeting read.
        var list = await owner.Get($"/api/v1/projects/{project}/meetings");
        var fromList = list.Data!.AsArray().First(m => m!["id"]!.GetValue<string>() == meetingId)!["participants"]!.AsArray().First(p => p!["userId"]!.GetValue<string>() == teammate.UserId.ToString());
        Assert.Equal("Accepted", fromList!["rsvpStatus"]!.GetValue<string>());
    }

    [Fact]
    public async Task A_meeting_is_completely_invisible_to_a_different_tenant_even_by_its_own_id()
    {
        var ownerA = await TestClient.RegisterAsync(factory, "Tenant A Owner");
        await ownerA.CreateOrgAsync();
        var projectA = await ownerA.CreateProjectAsync("Tenant A Project");
        await ConnectGoogleAsync(ownerA);
        var meetingA = await ownerA.Post($"/api/v1/projects/{projectA}/meetings/start", new { });
        var meetingAId = meetingA.Data!["id"]!.GetValue<string>();

        var ownerB = await TestClient.RegisterAsync(factory, "Tenant B Owner");
        await ownerB.CreateOrgAsync();
        var projectB = await ownerB.CreateProjectAsync("Tenant B Project");

        // Tenant B cannot read tenant A's meeting directly by id (the generic tenant query filter, not a bespoke check, is what hides it).
        var directRead = await ownerB.Get($"/api/v1/meetings/{meetingAId}");
        Assert.Equal(HttpStatusCode.NotFound, directRead.Status);

        // Nor can tenant B act on it.
        Assert.Equal(HttpStatusCode.NotFound, (await ownerB.Post($"/api/v1/meetings/{meetingAId}/cancel")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await ownerB.Post($"/api/v1/meetings/{meetingAId}/reschedule", new { startTime = DateTimeOffset.UtcNow.AddDays(1), endTime = DateTimeOffset.UtcNow.AddDays(1).AddMinutes(30) })).Status);

        // Nor does tenant A's meeting ever appear in tenant B's own (empty) project meeting list.
        var listB = await ownerB.Get($"/api/v1/projects/{projectB}/meetings");
        Assert.Empty(listB.Data!.AsArray());

        // And tenant A still sees it perfectly normally.
        var ownReadA = await ownerA.Get($"/api/v1/meetings/{meetingAId}");
        Assert.True(ownReadA.Ok, ownReadA.ToString());
    }
}
