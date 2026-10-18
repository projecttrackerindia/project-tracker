using System.Net;
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
}
