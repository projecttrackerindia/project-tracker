using System.Net;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>"Schedule a scrum call" with no project: a Google Meet for the workspace, inviting from its active non-guest members.</summary>
[Collection("api")]
public class WorkspaceMeetingTests(ApiFactory factory)
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

    private async Task ConnectGoogleAsync(TestClient c)
    {
        var start = await c.Get("/api/v1/integrations/google/connect");
        Assert.True(start.Ok, start.ToString());
        var authorize = new Uri(start.Data!["url"]!.GetValue<string>());
        var state = QueryValue(authorize, "state");
        var code = factory.GoogleCalendar.IssueCode($"{c.Email}");
        using var noRedirect = factory.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        noRedirect.DefaultRequestHeaders.Add("Cookie", start.Headers["Set-Cookie"].Split((char)59)[0]);
        using var cb = await noRedirect.GetAsync($"/api/v1/integrations/google/callback?code={code}&state={state}");
        Assert.Equal(HttpStatusCode.Redirect, cb.StatusCode);
    }

    private static object Body(params Guid[] people)
    {
        var start = DateTimeOffset.UtcNow.AddDays(2);
        return new { title = "Daily stand-up", description = "Yesterday, today, blockers", startTime = start, endTime = start.AddMinutes(15), timeZone = "Asia/Kolkata",
            participantUserIds = people, repeat = new { frequency = "Daily", occurrences = 10 } };
    }

    [Fact]
    public async Task A_scrum_call_can_be_scheduled_without_a_project_and_notifies_the_invited_members()
    {
        var owner = await TestClient.RegisterAsync(factory, "Prasanna");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("PRO");
        var teammate = await owner.AddMemberAsync(factory, TenantRole.Member, "Sridhar");
        var guest = await owner.AddMemberAsync(factory, TenantRole.Guest, "Outside Vendor");
        await ConnectGoogleAsync(owner);

        var people = await owner.Get("/api/v1/meetings/participants");
        Assert.True(people.Ok, people.ToString());
        var ids = people.Data!.AsArray().Select(p => p!["userId"]!.GetValue<string>()).ToList();
        Assert.Contains(teammate.UserId.ToString(), ids);
        Assert.DoesNotContain(guest.UserId.ToString(), ids);

        var res = await owner.Post("/api/v1/meetings/schedule", Body(teammate.UserId));
        Assert.Equal(HttpStatusCode.Created, res.Status);
        Assert.StartsWith("https://meet.google.com/", res.Data!["meetUri"]!.GetValue<string>());
        Assert.Equal(2, res.Data["participantCount"]!.GetValue<int>());
        Assert.Contains("FREQ=DAILY", res.Data["recurrenceRule"]!.GetValue<string>());

        factory.WithDb(db =>
        {
            var note = db.Notifications.IgnoreQueryFilters().Where(n => n.UserId == teammate.UserId && n.Type == NotificationType.Meeting).ToList();
            Assert.Single(note);
            Assert.Contains("Daily stand-up", note[0].Body);
            Assert.Contains("Asia/Kolkata", note[0].Body);
            return 0;
        });
    }

    [Fact]
    public async Task Guests_and_outsiders_cannot_be_invited_and_guests_cannot_schedule()
    {
        var owner = await TestClient.RegisterAsync(factory);
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("PRO");
        var guest = await owner.AddMemberAsync(factory, TenantRole.Guest, "Guest");
        var outsider = await TestClient.RegisterAsync(factory, "Elsewhere");
        await ConnectGoogleAsync(owner);

        var withGuest = await owner.Post("/api/v1/meetings/schedule", Body(guest.UserId));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, withGuest.Status);
        var withOutsider = await owner.Post("/api/v1/meetings/schedule", Body(outsider.UserId));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, withOutsider.Status);

        var byGuest = await guest.Post("/api/v1/meetings/schedule", Body());
        Assert.False(byGuest.Ok, byGuest.ToString());
        Assert.Equal(HttpStatusCode.Forbidden, byGuest.Status);
    }

    [Fact]
    public async Task A_workspace_series_shows_on_the_invitees_calendar_and_the_organizer_can_cancel_it()
    {
        var owner = await TestClient.RegisterAsync(factory, "Organizer");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("PRO");
        var teammate = await owner.AddMemberAsync(factory, TenantRole.Member, "Invited");
        var other = await owner.AddMemberAsync(factory, TenantRole.Member, "Not invited");
        await ConnectGoogleAsync(owner);

        // Monday 7 June 2027, 09:30 in Kolkata; five weekday sessions (7-11 June).
        var start = new DateTimeOffset(2027, 6, 7, 4, 0, 0, TimeSpan.Zero);
        var res = await owner.Post("/api/v1/meetings/schedule", new { title = "Team stand-up", startTime = start, endTime = start.AddMinutes(15), timeZone = "Asia/Kolkata",
            participantUserIds = new[] { teammate.UserId }, repeat = new { frequency = "Weekdays", occurrences = 5 }, scrum = true });
        Assert.Equal(HttpStatusCode.Created, res.Status);
        var id = res.Data!["id"]!.GetValue<string>();

        var events = (await teammate.Get("/api/v1/calendar?from=2027-06-01&to=2027-06-30")).Data!.AsArray()
            .Where(e => e!["type"]!.GetValue<string>() == "meeting" && e["title"]!.GetValue<string>() == "Team stand-up").ToList();
        Assert.Equal(new[] { "2027-06-07", "2027-06-08", "2027-06-09", "2027-06-10", "2027-06-11" }, events.Select(e => e!["date"]!.GetValue<string>()).ToArray());

        var detail = await teammate.Get($"/api/v1/meetings/workspace/{id}");
        Assert.True(detail.Ok, detail.ToString());
        Assert.False(detail.Data!["canManage"]!.GetValue<bool>());
        Assert.True(detail.Data["isScrum"]!.GetValue<bool>());
        Assert.Equal(HttpStatusCode.NotFound, (await other.Get($"/api/v1/meetings/workspace/{id}")).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await teammate.Post($"/api/v1/meetings/workspace/{id}/cancel", new { })).Status);

        Assert.Equal(HttpStatusCode.NoContent, (await owner.Post($"/api/v1/meetings/workspace/{id}/cancel", new { })).Status);
        var after = (await teammate.Get("/api/v1/calendar?from=2027-06-01&to=2027-06-30")).Data!.AsArray();
        Assert.DoesNotContain(after, e => e!["title"]!.GetValue<string>() == "Team stand-up");
    }

    [Fact]
    public async Task A_stand_up_posts_its_summary_to_the_project_chat_on_demand_and_after_a_session()
    {
        var owner = await TestClient.RegisterAsync(factory, "Scrum Master");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("PRO");
        var project = await owner.CreateProjectAsync("Payments Core");
        await owner.CreateTaskAsync(project, "Overdue reconciliation", new { title = "Overdue reconciliation", priority = "High", dueDate = DateOnly.FromDateTime(DateTime.UtcNow.AddDays(-3)) });
        await ConnectGoogleAsync(owner);

        var start = DateTimeOffset.UtcNow.AddDays(1);
        var res = await owner.Post($"/api/v1/projects/{project}/meetings/schedule", new { title = "Payments Core Scrum", startTime = start, endTime = start.AddMinutes(15), timeZone = "Asia/Kolkata", scrum = true });
        Assert.True(res.Ok, res.ToString());
        var meetingId = Guid.Parse(res.Data!["id"]!.GetValue<string>());

        var card = await owner.Post($"/api/v1/meetings/{meetingId}/standup-summary", new { });
        Assert.True(card.Ok, card.ToString());
        Assert.Equal("standup", card.Data!["kind"]!.GetValue<string>());
        Assert.Equal(1, card.Data["overdueCount"]!.GetValue<int>());
        Assert.Equal("Overdue reconciliation", card.Data["overdue"]![0]!["title"]!.GetValue<string>());

        // The session ended half an hour ago: the background run posts that day's summary once, however often it runs.
        factory.WithDb(db =>
        {
            var m = db.ProjectMeetings.IgnoreQueryFilters().Single(x => x.Id == meetingId);
            m.StartTimeUtc = DateTime.UtcNow.AddMinutes(-45); m.EndTimeUtc = DateTime.UtcNow.AddMinutes(-30);
            db.SaveChanges();
            return 0;
        });
        int Posts() => factory.WithDb(db => db.ChatMessages.IgnoreQueryFilters().Count(x => x.Body.Contains("\"kind\":\"standup\"") && x.Body.Contains(meetingId.ToString())));
        var before = Posts();
        using (var scope = factory.Services.CreateScope())
        {
            var first = await scope.ServiceProvider.GetRequiredService<ProjectManagement.Application.Features.ProjectMeetings.StandupSummaryService>().RunAsync();
            Assert.True(first >= 1);
        }
        using (var scope = factory.Services.CreateScope())
            await scope.ServiceProvider.GetRequiredService<ProjectManagement.Application.Features.ProjectMeetings.StandupSummaryService>().RunAsync();
        Assert.Equal(before + 1, Posts());
    }
}
