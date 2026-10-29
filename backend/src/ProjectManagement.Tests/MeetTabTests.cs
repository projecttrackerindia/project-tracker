using System.Net;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Agent;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Meet, the one place for meetings: the feed and series, replies to Project Tracker calls, a reminder per session for everyone invited
/// (taken back on "no" or cancellation), the notetaker chosen per meeting (and refused with the reason when it cannot come), and the bot's
/// spoken lines travelling through the worker queue.
/// </summary>
[Collection("api")]
public class MeetTabTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n?.GetValue<string>() ?? "";

    private async Task<(TestClient Owner, TestClient Mate, Guid Project)> TeamAsync(string name)
    {
        var owner = await TestClient.RegisterAsync(factory, "Meera");
        await owner.CreateOrgAsync(); await owner.UpgradeAsync("PRO");
        var project = await owner.CreateProjectAsync(name);
        var mate = await owner.AddMemberAsync(factory, TenantRole.Member, "Ravi");
        Assert.True((await owner.Post($"/api/v1/projects/{project}/members", new { userId = mate.UserId })).Ok);
        return (owner, mate, project);
    }

    private List<Reminder> Reminders(Guid userId, Guid meetingId) =>
        factory.WithDb(db => db.Reminders.IgnoreQueryFilters().Where(r => r.UserId == userId && r.TargetId == meetingId && r.Source == ReminderSource.Meeting).ToList());

    [Fact]
    public async Task An_invitation_to_our_own_call_is_in_Meet_and_Reminders_and_a_reply_changes_both()
    {
        var (owner, mate, project) = await TeamAsync("Atlas");
        var start = DateTimeOffset.UtcNow.AddHours(3);
        var made = await owner.Post($"/api/v1/projects/{project}/meetings/schedule", new { title = "Atlas review", startTime = start, endTime = start.AddMinutes(30), timeZone = "Asia/Kolkata",
            participantUserIds = new[] { mate.UserId }, notetaker = "off" });
        Assert.Equal(HttpStatusCode.Created, made.Status);
        Assert.Equal("ours", S(made.Data!["provider"]));
        Assert.Equal("off", S(made.Data["notetaker"]));
        var id = Guid.Parse(S(made.Data["id"]));

        // The invitation opens the meeting in Meet.
        var invite = factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => n.UserId == mate.UserId && n.Type == NotificationType.Meeting).ToList()).Single();
        Assert.Equal($"/meetings?open=p:{id}", invite.Link);

        // Meet lists it for both, with each person's own reply.
        var feed = await mate.Get("/api/v1/meet");
        Assert.True(feed.Ok, feed.ToString());
        var item = feed.Data!["items"]!.AsArray().Single(i => S(i!["id"]) == id.ToString())!;
        Assert.Equal($"p:{id}", S(item["ref"]));
        Assert.Equal("NeedsAction", S(item["myRsvp"]));
        Assert.Equal($"/calls/meeting/{id}", S(item["joinUrl"]));
        Assert.Equal("Atlas", S(item["projectName"]));
        Assert.False(item["canManage"]!.GetValue<bool>());
        Assert.Equal("Organizer", S((await owner.Get("/api/v1/meet")).Data!["items"]!.AsArray().Single(i => S(i!["id"]) == id.ToString())!["myRsvp"]));

        // Everyone invited (organizer included) has a reminder ten minutes before, which opens the call.
        var mine = Assert.Single(Reminders(mate.UserId, id));
        Assert.Equal(ReminderState.Scheduled, mine.State);
        Assert.Equal(start.UtcDateTime.AddMinutes(-10), mine.NextFireAt!.Value, TimeSpan.FromSeconds(1));
        Assert.Equal($"/calls/meeting/{id}", mine.Link);
        Assert.Single(Reminders(owner.UserId, id));

        // "No" takes the reminder back and tells the organizer; "yes" brings it back.
        var no = await mate.Post($"/api/v1/meet/p/{id}/rsvp", new { response = "declined" });
        Assert.True(no.Ok, no.ToString());
        Assert.Empty(Reminders(mate.UserId, id));
        Assert.Contains(factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => n.UserId == owner.UserId).Select(n => n.Title).ToList()), t => t == "Ravi declined");
        Assert.Equal(1, (await owner.Get("/api/v1/meet")).Data!["items"]!.AsArray().Single(i => S(i!["id"]) == id.ToString())!["declined"]!.GetValue<int>());
        Assert.True((await mate.Post($"/api/v1/meet/p/{id}/rsvp", new { response = "accepted" })).Ok);
        Assert.Single(Reminders(mate.UserId, id));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await mate.Post($"/api/v1/meet/p/{id}/rsvp", new { response = "whenever" })).Status);
        Assert.Equal("ORGANIZER_REQUIRED", (await owner.Post($"/api/v1/meet/p/{id}/rsvp", new { response = "declined" })).ErrorCode);

        // Moving it moves the reminder; cancelling takes it back.
        var later = start.AddHours(2);
        Assert.True((await owner.Post($"/api/v1/meetings/{id}/reschedule", new { startTime = later, endTime = later.AddMinutes(30) })).Ok);
        Assert.Equal(later.UtcDateTime.AddMinutes(-10), Assert.Single(Reminders(mate.UserId, id).Where(r => r.State == ReminderState.Scheduled)).NextFireAt!.Value, TimeSpan.FromSeconds(1));
        Assert.True((await owner.Post($"/api/v1/meetings/{id}/cancel")).Ok);
        Assert.Empty(Reminders(mate.UserId, id).Where(r => r.State == ReminderState.Scheduled));
        Assert.DoesNotContain((await mate.Get("/api/v1/meet")).Data!["items"]!.AsArray(), i => S(i!["id"]) == id.ToString());
    }

    [Fact]
    public async Task The_reminder_goes_off_once_as_the_starts_soon_notice()
    {
        var (owner, mate, project) = await TeamAsync("Pulse");
        var start = DateTimeOffset.UtcNow.AddMinutes(8);
        var made = await owner.Post($"/api/v1/projects/{project}/meetings/schedule", new { title = "Pulse sync", startTime = start, endTime = start.AddMinutes(15), timeZone = "UTC" });
        Assert.True(made.Ok, made.ToString());
        var id = Guid.Parse(S(made.Data!["id"]));
        Assert.True(Reminders(mate.UserId, id).Single().NextFireAt <= DateTime.UtcNow.AddSeconds(5));   // under ten minutes away: at once

        for (var i = 0; i < 2; i++)
        {
            using var scope = factory.Services.CreateScope();
            await scope.ServiceProvider.GetRequiredService<ReminderEngine>().RunAsync(DateTime.UtcNow.AddSeconds(5));
        }
        var notices = factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => n.UserId == mate.UserId && n.Title.StartsWith("Starts in")).ToList());
        var notice = Assert.Single(notices);
        Assert.Equal(NotificationType.Meeting, notice.Type);
        Assert.Contains("Pulse sync", notice.Title);
        Assert.Equal(ReminderState.Fired, Reminders(mate.UserId, id).Single().State);
    }

    [Fact]
    public async Task Workspace_meetings_take_replies_and_series_show_their_next_session()
    {
        var (owner, mate, _) = await TeamAsync("Nova");
        var start = DateTimeOffset.UtcNow.AddDays(1);
        var made = await owner.Post("/api/v1/meetings/schedule", new { title = "Team stand-up", startTime = start, endTime = start.AddMinutes(15), timeZone = "UTC",
            participantUserIds = new[] { mate.UserId }, scrum = true, repeat = new { frequency = "Daily", occurrences = 5 } });
        Assert.Equal(HttpStatusCode.Created, made.Status);
        var id = Guid.Parse(S(made.Data!["id"]));
        Assert.True((await mate.Post($"/api/v1/meet/w/{id}/rsvp", new { response = "tentative" })).Ok);
        var detail = await owner.Get($"/api/v1/meetings/workspace/{id}");
        Assert.Equal("Tentative", S(detail.Data!["attendees"]!.AsArray().Single(a => S(a!["name"]) == "Ravi")!["rsvpStatus"]));

        var series = (await mate.Get("/api/v1/meet/series")).Data!.AsArray().Single(s => S(s!["id"]) == id.ToString())!;
        Assert.True(series["recurring"]!.GetValue<bool>());
        Assert.True(series["isScrum"]!.GetValue<bool>());
        Assert.Equal(5, series["sessionsLeft"]!.GetValue<int>());
        Assert.Equal($"w:{id}", S(series["ref"]));

        // The feed expands the series into its sessions.
        var feed = await mate.Get($"/api/v1/meet?from={Uri.EscapeDataString(start.AddHours(-1).ToString("o"))}&to={Uri.EscapeDataString(start.AddDays(10).ToString("o"))}");
        Assert.Equal(5, feed.Data!["items"]!.AsArray().Count(i => S(i!["id"]) == id.ToString()));

        // A notetaker keeps its notes in a project, so a meeting without one cannot ask for it.
        var refused = await owner.Post("/api/v1/meetings/schedule", new { title = "No project", startTime = start, endTime = start.AddMinutes(15), timeZone = "UTC", notetaker = "transcript" });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, refused.Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Get($"/api/v1/meet?from={Uri.EscapeDataString(start.ToString("o"))}&to={Uri.EscapeDataString(start.AddDays(200).ToString("o"))}")).Status);
    }

    [Fact]
    public async Task The_notetaker_is_chosen_per_meeting_refused_with_a_reason_and_joins_our_call_in_that_mode()
    {
        factory.Ai.Reset(); factory.Ai.Configured = true;
        try
        {
            var (owner, mate, project) = await TeamAsync("Helix");
            var start = DateTimeOffset.UtcNow.AddMinutes(30);
            object Body(string notetaker) => new { title = "Helix planning", startTime = start, endTime = start.AddMinutes(45), timeZone = "UTC", participantUserIds = new[] { mate.UserId }, notetaker };

            // The project agent is off: the form is told why, and nothing is scheduled.
            var ready = await owner.Get($"/api/v1/meet/notetaker?projectId={project}");
            Assert.False(ready.Data!["available"]!.GetValue<bool>());
            Assert.True(ready.Data["canSwitchOn"]!.GetValue<bool>());
            Assert.Contains("project's agent", S(ready.Data["reason"]));
            var refused = await owner.Post($"/api/v1/projects/{project}/meetings/schedule", Body("transcript"));
            Assert.Equal("NOTETAKER_UNAVAILABLE", refused.ErrorCode);
            Assert.Equal(0, factory.WithDb(db => db.ProjectMeetings.IgnoreQueryFilters().Count(m => m.ProjectId == project)));

            Assert.True((await owner.Put($"/api/v1/projects/{project}/agent", new { enabled = true })).Ok);
            ready = await owner.Get($"/api/v1/meet/notetaker?projectId={project}");
            Assert.True(ready.Data!["available"]!.GetValue<bool>());
            // No speech service here: transcription works, voice says why it cannot.
            Assert.False(ready.Data["voiceAvailable"]!.GetValue<bool>());
            Assert.Equal("NOTETAKER_VOICE_UNAVAILABLE", (await owner.Post($"/api/v1/projects/{project}/meetings/schedule", Body("voice"))).ErrorCode);
            Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.Post($"/api/v1/projects/{project}/meetings/schedule", Body("sometimes"))).Status);

            var made = await owner.Post($"/api/v1/projects/{project}/meetings/schedule", Body("transcript"));
            Assert.Equal(HttpStatusCode.Created, made.Status);
            Assert.Equal("transcript", S(made.Data!["notetaker"]));
            var id = Guid.Parse(S(made.Data["id"]));
            Assert.Equal("transcript", S((await mate.Get("/api/v1/meet")).Data!["items"]!.AsArray().Single(i => S(i!["id"]) == id.ToString())!["notetaker"]));

            // Opening the call brings the notetaker, filed under this meeting's session, in the mode the meeting chose.
            var call = await owner.Post($"/api/v1/calls/meeting/{id}");
            Assert.True(call.Ok, call.ToString());
            Assert.True(call.Data!["agentEnabled"]!.GetValue<bool>());
            var bot = factory.WithDb(db => db.AgentMeetingBots.IgnoreQueryFilters().Single(b => b.MeetingId == id));
            Assert.Equal("transcript", bot.Mode);
            Assert.Equal(start.UtcDateTime, bot.SessionStartUtc, TimeSpan.FromSeconds(1));
            Assert.Equal("scheduled", S((await mate.Get("/api/v1/meet")).Data!["items"]!.AsArray().Single(i => S(i!["id"]) == id.ToString())!["notes"]));

            // "No notetaker" keeps it out even though the project's agent reads meetings.
            var quiet = await owner.Post($"/api/v1/projects/{project}/meetings/schedule", Body("off"));
            var quietId = Guid.Parse(S(quiet.Data!["id"]));
            var quietCall = await owner.Post($"/api/v1/calls/meeting/{quietId}");
            Assert.False(quietCall.Data!["agentEnabled"]!.GetValue<bool>());
            Assert.Equal(0, factory.WithDb(db => db.AgentMeetingBots.IgnoreQueryFilters().Count(b => b.MeetingId == quietId)));
        }
        finally { factory.Ai.Reset(); }
    }

    [Fact]
    public async Task Spoken_lines_reach_the_worker_once_and_only_while_the_bot_is_in_the_call()
    {
        var (owner, _, project) = await TeamAsync("Echo");
        var bot = new AgentMeetingBot
        {
            TenantId = owner.WorkspaceId, ProjectId = project, MeetingId = Guid.NewGuid(), SessionStartUtc = DateTime.UtcNow.AddMinutes(-5), SessionEndUtc = DateTime.UtcNow.AddMinutes(25),
            Kind = "bot", Status = "in_call", Mode = "voice", WebhookToken = Guid.NewGuid().ToString("N"), WorkerId = "worker-voice", LeaseUntil = DateTime.UtcNow.AddMinutes(2),
            JoinPayload = "{\"meetingUrl\":\"https://meet.google.com/abc-defg-hij\",\"botName\":\"Agent\",\"voice\":true}", CreatedAt = DateTime.UtcNow,
        };
        factory.WithDb(db => { db.AgentMeetingBots.Add(bot); db.SaveChanges(); return 0; });
        using (var scope = factory.Services.CreateScope())
        {
            var queue = scope.ServiceProvider.GetRequiredService<MeetingBotQueue>();
            Assert.True(await queue.QueueSayAsync(bot.Id, "Before we wrap up: nobody owns the release date yet.", "UklGRgAAAAA=", CancellationToken.None));
            Assert.False(await queue.QueueSayAsync(bot.Id, "", "UklGRgAAAAA=", CancellationToken.None));
        }
        var poll = await BotWorkerClient.PollAsync(factory, "worker-voice", 2, [(bot.Id.ToString(), "in_call_recording")]);
        var say = poll.Bot(bot.Id.ToString())!["say"]!.AsArray();
        Assert.Equal("Before we wrap up: nobody owns the release date yet.", S(Assert.Single(say)!["text"]));
        Assert.Equal("UklGRgAAAAA=", S(say[0]!["audio"]));
        var again = await BotWorkerClient.PollAsync(factory, "worker-voice", 2, [(bot.Id.ToString(), "in_call_recording")]);
        Assert.Null(again.Bot(bot.Id.ToString())!["say"]);

        factory.WithDb(db => { db.AgentMeetingBots.IgnoreQueryFilters().Where(b => b.Id == bot.Id).ExecuteUpdate(u => u.SetProperty(b => b.Status, "done")); return 0; });
        using (var scope = factory.Services.CreateScope())
            Assert.False(await scope.ServiceProvider.GetRequiredService<MeetingBotQueue>().QueueSayAsync(bot.Id, "Too late.", "UklGRgAAAAA=", CancellationToken.None));
    }
}
