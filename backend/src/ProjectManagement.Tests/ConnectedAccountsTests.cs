using System.Net;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Connected accounts: meetings go where the organizer's calendar is (Google Meet, an Outlook event with Teams, or our own call that the
/// agent joins), each feature of an account is switched off on its own, and Slack carries a person's notifications once they link it.
/// </summary>
[Collection("api")]
public class ConnectedAccountsTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n?.GetValue<string>() ?? "";
    private MicrosoftProductivityOptions Ms => factory.Services.GetRequiredService<IOptions<MicrosoftProductivityOptions>>().Value;
    private void EnableMicrosoft() { Ms.Enabled = true; Ms.CalendarsEnabled = true; Ms.MeetingsEnabled = true; Ms.ClientId = "12345678-1234-1234-1234-123456789012"; Ms.ClientSecret = "fake-secret"; Ms.RedirectUri = "https://testhost/api/v1/integrations/microsoft/callback"; Ms.AuthorityTenant = "organizations"; }
    private void ResetMicrosoft() { Ms.Enabled = false; Ms.CalendarsEnabled = false; Ms.ClientId = null; Ms.ClientSecret = null; Ms.RedirectUri = null; factory.MicrosoftProductivity.Reset(); }

    private static Dictionary<string, string> Query(string url) => new Uri(url).Query.TrimStart('?').Split('&').Select(p => p.Split('=', 2)).ToDictionary(p => p[0], p => Uri.UnescapeDataString(p[1]));

    private async Task ConnectMicrosoftAsync(TestClient c, string scopes = "User.Read Mail.Send Calendars.ReadWrite")
    {
        var start = await c.Get("/api/v1/integrations/microsoft/connect?meetings=true&returnUrl=/account/integrations");
        Assert.True(start.Ok, start.ToString());
        var q = Query(start.Data!["url"]!.GetValue<string>());
        Assert.Contains("Calendars.ReadWrite", q["scope"]);
        using var browser = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        browser.DefaultRequestHeaders.Add("Cookie", start.Headers!["Set-Cookie"].Split(';')[0]);
        using var result = await browser.GetAsync("/api/v1/integrations/microsoft/callback?state=" + q["state"] + "&code=" + factory.MicrosoftProductivity.IssueCode(c.Email, scopes));
        Assert.EndsWith("/account/integrations?microsoft=connected", result.Headers.Location!.ToString());
    }

    private async Task ConnectGoogleAsync(TestClient c, string extra = "", string? scopes = null)
    {
        var start = await c.Get("/api/v1/integrations/google/connect" + extra);
        Assert.True(start.Ok, start.ToString());
        var state = Query(start.Data!["url"]!.GetValue<string>())["state"];
        using var browser = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        browser.DefaultRequestHeaders.Add("Cookie", start.Headers!["Set-Cookie"].Split(';')[0]);
        using var cb = await browser.GetAsync($"/api/v1/integrations/google/callback?code={(scopes is null ? factory.GoogleCalendar.IssueCode(c.Email) : factory.GoogleCalendar.IssueCode(c.Email, scopes))}&state={state}");
        Assert.Equal(HttpStatusCode.Redirect, cb.StatusCode);
    }

    private async Task<(TestClient Owner, TestClient Mate, Guid Project)> TeamAsync(string name)
    {
        var owner = await TestClient.RegisterAsync(factory, "Meera");
        await owner.CreateOrgAsync(); await owner.UpgradeAsync("PRO");
        var project = await owner.CreateProjectAsync(name);
        var mate = await owner.AddMemberAsync(factory, TenantRole.Member, "Ravi");
        Assert.True((await owner.Post($"/api/v1/projects/{project}/members", new { userId = mate.UserId })).Ok);
        return (owner, mate, project);
    }

    [Fact]
    public async Task Someone_who_connected_Outlook_gets_Teams_meetings_with_real_invitations_RSVPs_moves_and_cancellation()
    {
        var (owner, mate, project) = await TeamAsync("Atlas");
        EnableMicrosoft();
        try
        {
            await ConnectMicrosoftAsync(owner);
            var accounts = (await owner.Get("/api/v1/me/connected-accounts")).Data!;
            Assert.True(accounts["microsoft"]!["meetingsAccess"]!.GetValue<bool>());
            Assert.Equal("microsoft", S(accounts["meetings"]!["provider"]));
            Assert.Contains("Teams", S(accounts["meetings"]!["reason"]));

            var start = DateTimeOffset.UtcNow.AddDays(2).AddMinutes(-DateTimeOffset.UtcNow.Minute);
            var made = await owner.Post($"/api/v1/projects/{project}/meetings/schedule", new { title = "Atlas review", startTime = start, endTime = start.AddHours(1), timeZone = "Asia/Kolkata" });
            Assert.Equal(HttpStatusCode.Created, made.Status);
            Assert.Equal("microsoft", S(made.Data!["provider"]));
            Assert.Equal("Microsoft Teams meeting", S(made.Data["providerName"]));
            Assert.StartsWith("https://teams.microsoft.com/l/meetup-join/", S(made.Data["meetUri"]));
            var ev = Assert.Single(factory.MicrosoftProductivity.Events.Values);
            Assert.True(ev["isOnlineMeeting"]!.GetValue<bool>());
            Assert.Equal("teamsForBusiness", S(ev["onlineMeetingProvider"]));
            Assert.Equal("India Standard Time", S(ev["start"]!["timeZone"]));   // a Windows zone name, which Outlook understands everywhere
            Assert.Contains(ev["attendees"]!.AsArray(), a => S(a!["emailAddress"]!["address"]) == mate.Email);
            Assert.Contains(factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => n.UserId == mate.UserId).Select(n => n.Title).ToList()), t => t.Contains("scheduled a Microsoft Teams meeting"));

            // Ravi accepts in Outlook: the meeting shows it.
            factory.MicrosoftProductivity.Responses[mate.Email] = "accepted";
            var listed = (await owner.Get($"/api/v1/projects/{project}/meetings")).Data!.AsArray().Single()!;
            Assert.Equal("Accepted", S(listed["participants"]!.AsArray().First(p => S(p!["userId"]) == mate.UserId.ToString())!["rsvpStatus"]));

            var id = S(made.Data["id"]);
            var moved = await owner.Post($"/api/v1/meetings/{id}/reschedule", new { startTime = start.AddHours(3), endTime = start.AddHours(4) });
            Assert.True(moved.Ok, moved.ToString());
            Assert.Equal(ToIst(start.AddHours(3)), S(ev["start"]!["dateTime"])[..16]);

            // Outlook refusing a change is said plainly, naming Teams.
            factory.MicrosoftProductivity.EventsFail = true;
            var refused = await owner.Post($"/api/v1/meetings/{id}/cancel");
            Assert.Equal("TEAMS_MEET_CANCEL_FAILED", refused.ErrorCode);
            Assert.Contains("Microsoft Teams meeting", refused.ToString());
            factory.MicrosoftProductivity.EventsFail = false;

            Assert.True((await owner.Post($"/api/v1/meetings/{id}/cancel")).Ok);
            Assert.Single(factory.MicrosoftProductivity.CancelledEvents);

            // Switching Teams meetings off keeps mail; new meetings then become Project Tracker calls.
            var off = await owner.Post("/api/v1/integrations/microsoft/features/meetings/off");
            Assert.True(off.Ok, off.ToString());
            Assert.False(off.Data!["meetingsAccess"]!.GetValue<bool>());
            Assert.True(off.Data["mailSendAccess"]!.GetValue<bool>());
            Assert.Equal("ours", S((await owner.Get("/api/v1/me/connected-accounts")).Data!["meetings"]!["provider"]));
        }
        finally { ResetMicrosoft(); }
    }

    private static string ToIst(DateTimeOffset t) => t.ToOffset(TimeSpan.FromHours(5.5)).ToString("yyyy-MM-dd'T'HH:mm");

    [Fact]
    public async Task With_no_calendar_connected_a_meeting_is_our_own_call_that_everyone_joins_together()
    {
        var (owner, mate, project) = await TeamAsync("Orion");
        var start = DateTimeOffset.UtcNow.AddMinutes(30);
        var made = await owner.Post($"/api/v1/projects/{project}/meetings/schedule", new { title = "Orion stand-up", startTime = start, endTime = start.AddMinutes(30), timeZone = "Asia/Kolkata" });
        Assert.Equal(HttpStatusCode.Created, made.Status);
        Assert.Equal("ours", S(made.Data!["provider"]));
        Assert.Equal("Project Tracker call", S(made.Data["providerName"]));
        var meetingId = S(made.Data["id"]);
        Assert.Equal($"/calls/meeting/{meetingId}", S(made.Data["meetUri"]));
        Assert.Contains(factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => n.UserId == mate.UserId).Select(n => n.Title).ToList()), t => t.Contains("scheduled a Project Tracker call"));

        // Whoever opens it first starts it; the next person joins the same call.
        var first = await owner.Post($"/api/v1/calls/meeting/{meetingId}");
        Assert.True(first.Ok, first.ToString());
        var second = await mate.Post($"/api/v1/calls/meeting/{meetingId}");
        Assert.True(second.Ok, second.ToString());
        Assert.Equal(S(first.Data!["id"]), S(second.Data!["id"]));
        Assert.Equal(1, factory.WithDb(db => db.CallRooms.IgnoreQueryFilters().Count(c => c.MeetingId == Guid.Parse(meetingId))));
        Assert.True((await mate.Post($"/api/v1/calls/{S(second.Data["id"])}/join")).Ok);

        // Someone outside the project cannot open it.
        var stranger = await owner.AddMemberAsync(factory, TenantRole.Guest, "Guest");
        Assert.Equal(HttpStatusCode.NotFound, (await stranger.Post($"/api/v1/calls/meeting/{meetingId}")).Status);

        // A series of our own calls can be moved here (there is no outside calendar to do it in).
        var series = await owner.Post($"/api/v1/projects/{project}/meetings/schedule", new { title = "Weekly", startTime = start.AddDays(1), endTime = start.AddDays(1).AddMinutes(30), timeZone = "UTC", repeat = new { frequency = "Weekly", occurrences = 4 } });
        Assert.True((await owner.Post($"/api/v1/meetings/{S(series.Data!["id"])}/reschedule", new { startTime = start.AddDays(2), endTime = start.AddDays(2).AddMinutes(30) })).Ok);
    }

    [Fact]
    public async Task A_person_chooses_where_their_meetings_go_and_cannot_choose_a_service_they_have_not_connected()
    {
        var (owner, _, project) = await TeamAsync("Vega");
        var refused = await owner.Put("/api/v1/me/connected-accounts", new { meetingService = "google" });
        Assert.Equal("GOOGLE_NOT_CONNECTED", refused.ErrorCode);
        Assert.Equal("MICROSOFT_NOT_CONNECTED", (await owner.Put("/api/v1/me/connected-accounts", new { meetingService = "teams" })).ErrorCode);

        await ConnectGoogleAsync(owner);
        var auto = (await owner.Get("/api/v1/me/connected-accounts")).Data!;
        Assert.Equal("auto", S(auto["meetingService"]));
        Assert.Equal("google", S(auto["meetings"]!["provider"]));

        // Google is connected, but they prefer our own calls (the agent joins those without a lobby).
        var saved = await owner.Put("/api/v1/me/connected-accounts", new { meetingService = "ours" });
        Assert.True(saved.Ok, saved.ToString());
        Assert.Equal("ours", S(saved.Data!["meetings"]!["provider"]));
        var start = DateTimeOffset.UtcNow.AddDays(1);
        var made = await owner.Post($"/api/v1/projects/{project}/meetings/schedule", new { title = "Ours", startTime = start, endTime = start.AddHours(1), timeZone = "UTC" });
        Assert.Equal("ours", S(made.Data!["provider"]));
        // The form can still pick a service for one meeting.
        var meet = await owner.Post($"/api/v1/projects/{project}/meetings/schedule", new { title = "On Meet", startTime = start, endTime = start.AddHours(1), timeZone = "UTC", service = "google" });
        Assert.Equal("google", S(meet.Data!["provider"]));
        Assert.StartsWith("https://meet.google.com/", S(meet.Data["meetUri"]));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Put("/api/v1/me/connected-accounts", new { meetingService = "zoom" })).Status);
    }

    [Fact]
    public async Task Stopping_one_Google_feature_keeps_the_others_and_stopping_the_last_one_disconnects()
    {
        var owner = await TestClient.RegisterAsync(factory); await owner.CreateOrgAsync();
        await ConnectGoogleAsync(owner);
        // Google returns what was granted: Calendar and Meet from before, plus the transcripts asked for now.
        await ConnectGoogleAsync(owner, "?transcripts=true", "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/meetings.space.created https://www.googleapis.com/auth/meetings.space.readonly");
        var status = (await owner.Get("/api/v1/integrations/google/status")).Data!;
        Assert.True(status["calendarAccess"]!.GetValue<bool>()); Assert.True(status["transcriptAccess"]!.GetValue<bool>());

        var off = await owner.Post("/api/v1/integrations/google/features/transcripts/off");
        Assert.True(off.Ok, off.ToString());
        Assert.False(off.Data!["transcriptAccess"]!.GetValue<bool>());
        Assert.True(off.Data["calendarAccess"]!.GetValue<bool>());   // Calendar and Meet keep working

        // Reconnecting for calendar does not quietly bring transcripts back (Google returns every permission ever granted).
        await ConnectGoogleAsync(owner, "", "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/meetings.space.created https://www.googleapis.com/auth/meetings.space.readonly");
        Assert.False((await owner.Get("/api/v1/integrations/google/status")).Data!["transcriptAccess"]!.GetValue<bool>());

        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post("/api/v1/integrations/google/features/drive/off")).Status);
        var last = await owner.Post("/api/v1/integrations/google/features/calendar/off");
        Assert.False(last.Data!["connected"]!.GetValue<bool>());
    }

    [Fact]
    public async Task A_person_links_Slack_and_gets_what_needs_them_as_direct_messages_and_can_unlink()
    {
        var owner = await TestClient.RegisterAsync(factory, "Asha"); await owner.CreateOrgAsync(); await owner.UpgradeAsync("BUSINESS");
        factory.WithDb(db => { db.TenantFeatureOverrides.Add(new TenantFeatureOverride { TenantId = owner.WorkspaceId, FeatureKey = FeatureKeys.SlackIntegration, Value = 1 }); db.SaveChanges(); return 0; });
        var mate = await owner.AddMemberAsync(factory, TenantRole.Member, "Kiran");

        // Before the workspace connects Slack, a person cannot link.
        Assert.Equal("SLACK_NOT_CONNECTED", (await mate.Get("/api/v1/integrations/slack/me/connect")).ErrorCode);
        var team = "T" + Guid.NewGuid().ToString("N")[..10];
        var install = await owner.Post("/api/v1/integrations/slack/connect");
        var installState = Query(install.Data!["url"]!.GetValue<string>())["state"];
        using (var browser = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false }))
        {
            browser.DefaultRequestHeaders.Add("Cookie", install.Headers!["Set-Cookie"].Split(';')[0]);
            using var done = await browser.GetAsync($"/api/v1/integrations/slack/callback?state={installState}&code={factory.Slack.IssueCode(team)}");
            Assert.Equal(HttpStatusCode.Redirect, done.StatusCode);
        }

        async Task<string> LinkAsync(TestClient who, string slackTeam, string slackUser)
        {
            var start = await who.Get("/api/v1/integrations/slack/me/connect");
            Assert.True(start.Ok, start.ToString());
            var q = Query(start.Data!["url"]!.GetValue<string>());
            Assert.Equal("openid profile email", q["scope"]);
            Assert.Equal(team, q["team"]);
            Assert.EndsWith("/api/v1/integrations/slack/me/callback", q["redirect_uri"]);
            using var browser = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
            browser.DefaultRequestHeaders.Add("Cookie", start.Headers!["Set-Cookie"].Split(';')[0]);
            using var back = await browser.GetAsync($"/api/v1/integrations/slack/me/callback?state={q["state"]}&code={factory.Slack.IssueUserCode(slackTeam, slackUser, "Kiran Das")}");
            return back.Headers.Location!.ToString();
        }

        // Signed in to a different Slack workspace: refused.
        Assert.EndsWith("slack=team", await LinkAsync(mate, "T-OTHER", "U-KIRAN"));
        Assert.EndsWith("slack=connected", await LinkAsync(mate, team, "U-KIRAN"));
        var accounts = (await mate.Get("/api/v1/me/connected-accounts")).Data!;
        Assert.True(accounts["slack"]!["linked"]!.GetValue<bool>());
        Assert.Equal("Kiran Das", S(accounts["slack"]!["name"]));
        Assert.Equal("needs", S(accounts["slack"]!["messages"]));   // linking is asking for it
        // The same Slack person cannot be linked by someone else here.
        Assert.EndsWith("slack=taken", await LinkAsync(owner, team, "U-KIRAN"));

        // Something that needs Kiran goes to Slack; a mere update does not (until they choose everything).
        var project = await owner.CreateProjectAsync("Nova");
        Assert.True((await owner.Post($"/api/v1/projects/{project}/members", new { userId = mate.UserId })).Ok);
        var task = await owner.Post($"/api/v1/projects/{project}/tasks", new { title = "Send the go-live checklist", assigneeId = mate.UserId });
        Assert.True(task.Ok, task.ToString());
        factory.WithDb(db => { Assert.Contains(db.Notifications.IgnoreQueryFilters().Where(n => n.UserId == mate.UserId), n => n.SlackPending && n.Type == NotificationType.TaskAssigned); return 0; });
        while (factory.Slack.DirectMessages.TryDequeue(out _)) { }
        var sent = await factory.Services.GetRequiredService<SlackMessageDispatcher>().RunAsync();
        Assert.True(sent >= 1);
        Assert.Contains(factory.Slack.DirectMessages, m => m.User == "U-KIRAN" && m.Text.Contains("Send the go-live checklist") && m.Text.Contains("Open in Project Tracker"));
        factory.WithDb(db => { Assert.DoesNotContain(db.Notifications.IgnoreQueryFilters().Where(n => n.UserId == mate.UserId), n => n.SlackPending); return 0; });
        Assert.Equal(0, await factory.Services.GetRequiredService<SlackMessageDispatcher>().RunAsync());   // sent once

        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await mate.Put("/api/v1/me/connected-accounts", new { slackMessages = "sometimes" })).Status);
        Assert.Equal("all", S((await mate.Put("/api/v1/me/connected-accounts", new { slackMessages = "all" })).Data!["slack"]!["messages"]));

        Assert.Equal(HttpStatusCode.NoContent, (await mate.Delete("/api/v1/integrations/slack/me")).Status);
        var after = (await mate.Get("/api/v1/me/connected-accounts")).Data!;
        Assert.False(after["slack"]!["linked"]!.GetValue<bool>());
        Assert.Equal("off", S(after["slack"]!["messages"]));
        Assert.Equal("SLACK_NOT_LINKED", (await mate.Put("/api/v1/me/connected-accounts", new { slackMessages = "needs" })).ErrorCode);
    }
}
