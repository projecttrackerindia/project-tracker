using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Agent;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Watching the agents: alerts (rules over the last day, at most one notice a day per problem), what they cost in AI credits and when the credits
/// run out, a monthly cap per project agent, earned autonomy from how the team decided (with dismissal reasons), the Monday summary, and sending
/// the bot to a Teams or Meet call by its link.
/// </summary>
[Collection("api")]
public class AgentAlertsAndCostTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private async Task<(TestClient Owner, Guid Project)> SetupAsync(string name)
    {
        factory.Ai.Reset(); factory.Ai.Configured = true;
        var owner = await TestClient.RegisterAsync(factory, $"{name} Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        var project = await owner.CreateProjectAsync(name);
        Assert.True((await owner.Put($"/api/v1/projects/{project}/agent", new { enabled = true })).Ok);
        return (owner, project);
    }

    private Guid Run(TestClient owner, Guid project, string status, int credits, string? error = null) => factory.WithDb(db =>
    {
        var run = new AgentRun { TenantId = owner.WorkspaceId, ProjectId = project, Trigger = "schedule", Status = status, Credits = credits, StartedAt = DateTime.UtcNow.AddMinutes(-30),
            FinishedAt = DateTime.UtcNow.AddMinutes(-29), Error = error };
        db.AgentRuns.Add(run); db.SaveChanges(); return run.Id;
    });

    [Fact]
    public async Task Earned_autonomy_comes_from_unchanged_approvals_and_dismissals_record_why()
    {
        var (owner, project) = await SetupAsync("Earned Desk");
        var runId = Run(owner, project, "done", 4);
        factory.WithDb(db =>
        {
            for (var i = 0; i < 32; i++)
                db.AgentFindings.Add(new AgentFinding { TenantId = owner.WorkspaceId, ProjectId = project, RunId = runId, Kind = AgentFindingKind.CreateActionItem, Status = AgentFindingStatus.Applied,
                    Title = $"Send the notes {i}", Confidence = 90, DecidedBy = owner.UserId, DecidedAt = DateTime.UtcNow.AddDays(-1) });
            // Task updates are never carried out alone, however often they are approved.
            for (var i = 0; i < 31; i++)
                db.AgentFindings.Add(new AgentFinding { TenantId = owner.WorkspaceId, ProjectId = project, RunId = runId, Kind = AgentFindingKind.UpdateTask, Status = AgentFindingStatus.Applied,
                    Title = $"Move {i}", Confidence = 90, DecidedBy = owner.UserId, DecidedAt = DateTime.UtcNow.AddDays(-1) });
            db.AgentFindings.Add(new AgentFinding { TenantId = owner.WorkspaceId, ProjectId = project, RunId = runId, Kind = AgentFindingKind.Suggestion, Status = AgentFindingStatus.Proposed,
                Title = "Add a retry queue", Confidence = 60 });
            db.SaveChanges(); return 0;
        });
        var waiting = factory.WithDb(db => db.AgentFindings.IgnoreQueryFilters().Single(f => f.ProjectId == project && f.Title == "Add a retry queue").Id);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post($"/api/v1/agent/findings/{waiting}/dismiss", new { reason = "because" })).Status);
        var dismissed = await owner.Post($"/api/v1/agent/findings/{waiting}/dismiss", new { reason = "duplicate" });
        Assert.True(dismissed.Ok, dismissed.ToString());
        Assert.Equal("duplicate", S(dismissed.Data!["dismissReason"]));

        var report = (await owner.Get($"/api/v1/projects/{project}/agent/autonomy")).Data!;
        var hint = Assert.Single(report["hints"]!.AsArray());
        Assert.Equal("CreateActionItem", S(hint!["kind"]));
        Assert.Equal(100, hint["rate"]!.GetValue<int>());
        var suggestion = report["kinds"]!.AsArray().First(k => S(k!["kind"]) == "Suggestion")!;
        Assert.Equal("duplicate", S(suggestion["reasons"]![0]!["reason"]));
        Assert.False(report["kinds"]!.AsArray().First(k => S(k!["kind"]) == "UpdateTask")!["suggested"]!.GetValue<bool>());
        Assert.Single((await owner.Get("/api/v1/ai/tracker/autonomy-hints")).Data!.AsArray());
        Assert.Contains((await owner.Get("/api/v1/ai/tracker/fleet")).Data!["dismissReasons"]!.AsArray(), r => S(r!["reason"]) == "duplicate");

        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post($"/api/v1/projects/{project}/agent/autonomy/UpdateTask/accept", new { })).Status);
        var accepted = await owner.Post($"/api/v1/projects/{project}/agent/autonomy/CreateActionItem/accept", new { });
        Assert.True(accepted.Ok, accepted.ToString());
        Assert.Empty(accepted.Data!["hints"]!.AsArray());
        var settings = (await owner.Get($"/api/v1/projects/{project}/agent")).Data!;
        Assert.Equal(4, settings["autonomyLevel"]!.GetValue<int>());
        Assert.Equal(new[] { "CreateActionItem" }, settings["autoApplyKinds"]!.AsArray().Select(S).ToArray());   // only that kind, not the level-4 defaults
    }

    [Fact]
    public async Task Alerts_fire_once_a_day_per_problem_and_credits_caps_and_the_weekly_summary_add_up()
    {
        var (owner, project) = await SetupAsync("Watch Desk");
        var admin = await owner.AddMemberAsync(factory, TenantRole.Admin, "Meera");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Kiran");
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Get("/api/v1/ai/tracker/alerts")).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.Get("/api/v1/ai/tracker/cost")).Status);
        for (var i = 0; i < 3; i++) Run(owner, project, "failed", 0, "The AI service did not answer.");
        Run(owner, project, "done", 8);
        factory.WithDb(db =>
        {
            for (var i = 0; i < 2; i++)
                db.AgentMeetingBots.Add(new AgentMeetingBot { TenantId = owner.WorkspaceId, ProjectId = project, MeetingId = Guid.NewGuid(), SessionStartUtc = DateTime.UtcNow.AddHours(-3 - i),
                    SessionEndUtc = DateTime.UtcNow.AddHours(-2 - i), Kind = "bot", Status = "failed", WebhookToken = Guid.NewGuid().ToString("N"), Error = "Nobody let the bot into the meeting." });
            var account = new AiCreditAccount { TenantId = owner.WorkspaceId, PeriodStart = new DateTime(DateTime.UtcNow.Year, DateTime.UtcNow.Month, 1, 0, 0, 0, DateTimeKind.Utc), Spent = 12 };
            db.AiCreditAccounts.Add(account);
            db.AiCreditReservations.Add(new AiCreditReservation { TenantId = owner.WorkspaceId, AccountId = account.Id, UserId = owner.UserId, OperationId = Guid.NewGuid(), Amount = 8, Charged = 8,
                Feature = "project_agent", Status = "settled", ExpiresAt = DateTime.UtcNow, SettledAt = DateTime.UtcNow.AddHours(-1) });
            db.AiCreditReservations.Add(new AiCreditReservation { TenantId = owner.WorkspaceId, AccountId = account.Id, UserId = owner.UserId, OperationId = Guid.NewGuid(), Amount = 4, Charged = 4,
                Feature = "workspace", Status = "settled", ExpiresAt = DateTime.UtcNow, SettledAt = DateTime.UtcNow.AddHours(-2) });
            db.SaveChanges(); return 0;
        });

        var alerts = (await owner.Get("/api/v1/ai/tracker/alerts")).Data!;
        var keys = alerts["active"]!.AsArray().Select(a => S(a!["key"])).ToList();
        Assert.Contains("bot_failures", keys);
        Assert.Contains("reading_failures", keys);
        Assert.True(alerts["settings"]!["enabled"]!.GetValue<bool>());
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Put("/api/v1/ai/tracker/alerts",
            new { enabled = true, minSuccessRate = 80, maxP95Seconds = 30, botFailures = 0, readingFailures = 3, creditDays = 5, weeklyDigest = true })).Status);

        // The cap: this project's agent used 8 credits this month; at a cap of 5 it stops and says so.
        var capped = await owner.Put($"/api/v1/projects/{project}/agent", new { enabled = true, monthlyCreditCap = 5 });
        Assert.True(capped.Ok, capped.ToString());
        Assert.Equal(8, capped.Data!["creditsThisMonth"]!.GetValue<int>());
        Assert.Contains("project_caps", (await owner.Get("/api/v1/ai/tracker/alerts")).Data!["active"]!.AsArray().Select(a => S(a!["key"])));

        var cost = (await owner.Get("/api/v1/ai/tracker/cost")).Data!;
        Assert.Equal(14, cost["days"]!.AsArray().Count);
        Assert.Equal(8, cost["features"]!.AsArray().First(f => S(f!["group"]) == "agent")!["credits"]!.GetValue<long>());
        Assert.Equal(4, cost["features"]!.AsArray().First(f => S(f!["group"]) == "assistant")!["credits"]!.GetValue<long>());
        var row = cost["projects"]!.AsArray().First(p => S(p!["key"]) != "" && p!["credits"]!.GetValue<int>() == 8)!;
        Assert.Equal(5, row["cap"]!.GetValue<int>());

        // The background check tells owners and admins once; a second check the same day says nothing new.
        async Task<int> NotifyAsync()
        {
            using var scope = factory.Services.CreateScope();
            await WorkspaceExecutionPrincipal.ConfigureAsync(scope.ServiceProvider, owner.UserId, owner.WorkspaceId, null, default);
            factory.WithDb(db => { db.AgentWorkspaceSettings.IgnoreQueryFilters().Where(w => w.TenantId == owner.WorkspaceId).ExecuteUpdate(u => u.SetProperty(w => w.AlertsCheckedAt, (DateTime?)null)); return 0; });
            return await scope.ServiceProvider.GetRequiredService<AgentAlertService>().NotifyAsync(default);
        }
        Assert.True(await NotifyAsync() > 0);
        Assert.True(factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Any(n => n.UserId == admin.UserId && n.Type == NotificationType.AgentAlert && n.Title.Contains("missed 2 sessions"))));
        Assert.False(factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Any(n => n.UserId == member.UserId && n.Type == NotificationType.AgentAlert)));
        Assert.Equal(0, await NotifyAsync());

        // Switched off: nothing.
        Assert.True((await owner.Put("/api/v1/ai/tracker/alerts", new { enabled = false, minSuccessRate = 80, maxP95Seconds = 30, botFailures = 2, readingFailures = 3, creditDays = 5, weeklyDigest = true })).Ok);
        Assert.Equal(0, await NotifyAsync());

        // The Monday summary, previewed and sent to me now.
        var digest = (await owner.Get("/api/v1/ai/tracker/digest")).Data!;
        Assert.False(digest["quiet"]!.GetValue<bool>());
        Assert.Contains(digest["lines"]!.AsArray(), l => S(l).StartsWith("Project agent: 4 readings", StringComparison.Ordinal));
        Assert.Contains(digest["lines"]!.AsArray(), l => S(l).StartsWith("AI credits: 12 used", StringComparison.Ordinal));
        Assert.Equal(1, (await owner.Post("/api/v1/ai/tracker/digest/send", new { })).Data!["sent"]!.GetValue<int>());
        Assert.True(factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Any(n => n.UserId == owner.UserId && n.Type == NotificationType.AgentDigest)));
    }

    [Fact]
    public void Credits_forecast_runs_out_before_renewal_only_at_a_real_pace()
    {
        var now = new DateTime(2026, 10, 20, 9, 0, 0, DateTimeKind.Utc);
        var f = AgentCostService.Forecast(new AiCreditBalance("2026-10", 1000, 900, 0, 100, false), 140, now);
        Assert.Equal(20, f.DailyAverage);
        Assert.Equal(5, f.DaysLeft);
        Assert.Equal(new DateOnly(2026, 10, 25), f.RunsOutOn);
        Assert.True(f.RunsOutBeforeReset);
        Assert.Equal(new DateOnly(2026, 11, 1), f.ResetsOn);
        Assert.False(AgentCostService.Forecast(new AiCreditBalance("2026-10", 1000, 10, 0, 990, false), 14, now).RunsOutBeforeReset);
        Assert.Null(AgentCostService.Forecast(new AiCreditBalance("2026-10", -1, 10, 0, -1, true), 140, now).DaysLeft);
        Assert.Null(AgentCostService.Forecast(new AiCreditBalance("2026-10", 1000, 0, 0, 1000, false), 0, now).DaysLeft);
    }

    [Fact]
    public void Outlook_online_meetings_with_a_Teams_or_Meet_link_are_found_and_other_events_ignored()
    {
        var from = new DateTime(2026, 10, 20, 9, 0, 0, DateTimeKind.Utc);
        var json = JsonSerializer.Serialize(new
        {
            value = new object[]
            {
                new { id = "AAMk1", subject = "PAY stand-up", isCancelled = false, start = new { dateTime = "2026-10-20T09:05:00.0000000", timeZone = "UTC" },
                    end = new { dateTime = "2026-10-20T09:20:00.0000000", timeZone = "UTC" }, onlineMeeting = new { joinUrl = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d" } },
                new { id = "AAMk2", subject = "Lunch", isCancelled = false, start = new { dateTime = "2026-10-20T09:06:00", timeZone = "UTC" }, end = new { dateTime = "2026-10-20T10:00:00", timeZone = "UTC" } },
                new { id = "AAMk3", subject = "Cancelled sync", isCancelled = true, start = new { dateTime = "2026-10-20T09:07:00", timeZone = "UTC" },
                    end = new { dateTime = "2026-10-20T09:30:00", timeZone = "UTC" }, onlineMeeting = new { joinUrl = "https://teams.microsoft.com/l/meetup-join/abc" } },
                new { id = "AAMk4", subject = "Phishing", isCancelled = false, start = new { dateTime = "2026-10-20T09:08:00", timeZone = "UTC" },
                    end = new { dateTime = "2026-10-20T09:30:00", timeZone = "UTC" }, onlineMeetingUrl = "https://evil.example/join" },
                new { id = "AAMk5", subject = "PAY review", isCancelled = false, start = new { dateTime = "2026-10-20T09:09:00", timeZone = "UTC" },
                    end = new { dateTime = "2026-10-20T09:40:00", timeZone = "UTC" }, onlineMeetingUrl = "https://meet.google.com/abc-defg-hij" },
            },
        });
        var found = MicrosoftOnlineMeetings.Parse(json, from, from.AddMinutes(15));
        Assert.Equal(new[] { "PAY stand-up", "PAY review" }, found.Select(f => f.Title).ToArray());
        Assert.Equal("ms:AAMk1", found[0].EventId);
        Assert.Equal(new DateTime(2026, 10, 20, 9, 5, 0, DateTimeKind.Utc), found[0].Start);
        Assert.Equal("Microsoft Teams", MicrosoftOnlineMeetings.Platform(found[0].MeetUrl));
        Assert.Equal("Google Meet", MicrosoftOnlineMeetings.Platform(found[1].MeetUrl));
        Assert.False(MicrosoftOnlineMeetings.Joinable("http://teams.microsoft.com/l/meetup-join/x"));
    }

    [Fact]
    public async Task The_bot_can_be_sent_to_a_Teams_call_by_its_link()
    {
        var (owner, project) = await SetupAsync("Link Desk");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member, "Lata");
        const string teams = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_NDk4%40thread.v2/0?context=%7b%22Tid%22%3a%22t%22%7d";
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post($"/api/v1/projects/{project}/agent/join-link", new { url = "https://zoom.us/j/123", minutes = 30 })).Status);
        Assert.Contains((await member.Post($"/api/v1/projects/{project}/agent/join-link", new { url = teams, minutes = 30 })).Status, new[] { HttpStatusCode.Forbidden, HttpStatusCode.NotFound });
        var sent = await owner.Post($"/api/v1/projects/{project}/agent/join-link", new { url = teams, title = "Customer sync", minutes = 30 });
        Assert.True(sent.Ok, sent.ToString());
        Assert.Equal("Microsoft Teams", S(sent.Data!["platform"]));
        Assert.Equal("Customer sync", S(sent.Data["title"]));
        var payload = factory.WithDb(db => db.AgentMeetingBots.IgnoreQueryFilters().Single(b => b.ProjectId == project && b.Kind == "bot").JoinPayload);
        Assert.Contains("teams.microsoft.com/l/meetup-join", payload);
        Assert.Equal(HttpStatusCode.Conflict, (await owner.Post($"/api/v1/projects/{project}/agent/join-link", new { url = teams, minutes = 30 })).Status);
    }
}
