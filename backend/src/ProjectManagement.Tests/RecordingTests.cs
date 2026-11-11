using System.Net;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>"Record this meeting" from the person's own device: it needs the speech service, belongs to the person who recorded, and its minutes become tasks one tap at a time.</summary>
[Collection("api")]
public class RecordingTests(ApiFactory factory)
{
    private async Task<(TestClient Owner, Guid Project)> OrgAsync(string name)
    {
        var owner = await TestClient.RegisterAsync(factory, $"{name} Owner");
        await owner.CreateOrgAsync();
        await owner.UpgradeAsync("BUSINESS");
        return (owner, await owner.CreateProjectAsync(name));
    }

    private Guid Seed(TestClient owner, Guid project, string status = "in_call", string text = "Owner: we need to send the release deck to the client this week.\nOthers: Fine, I will book the assessor call.")
    {
        var protector = factory.Services.GetRequiredService<ISecretProtector>();
        var now = DateTime.UtcNow;
        var bot = new AgentMeetingBot
        {
            TenantId = owner.WorkspaceId, ProjectId = project, MeetingId = Guid.NewGuid(), SessionStartUtc = now.AddMinutes(-20), SessionEndUtc = now, Kind = "device", Status = status,
            WebhookToken = Guid.NewGuid().ToString("N"), Title = "Release sync", TranscriptProtected = protector.Protect(text), TranscriptLength = text.Length, NudgeCount = 2, CreatedAt = now, CreatedBy = owner.UserId,
        };
        factory.WithDb(db => { db.AgentMeetingBots.Add(bot); return db.SaveChanges(); });
        return bot.Id;
    }

    [Fact]
    public async Task Recording_needs_the_speech_service_and_a_real_meeting()
    {
        var (owner, _) = await OrgAsync("Rec");
        var status = await owner.Get("/api/v1/me/recordings/status");
        Assert.True(status.Ok, status.ToString());
        Assert.False(status.Data!["speech"]!.GetValue<bool>());
        var start = await owner.Post("/api/v1/me/recordings", new { meetingId = Guid.NewGuid() });
        Assert.Equal(HttpStatusCode.Conflict, start.Status);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Get($"/api/v1/me/recordings/{Guid.NewGuid()}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Post($"/api/v1/me/recordings/{Guid.NewGuid()}/finish", new { })).Status);
    }

    [Fact]
    public async Task A_recording_is_the_recorders_own_and_its_words_can_be_read_again()
    {
        var (owner, project) = await OrgAsync("Rec own");
        var id = Seed(owner, project);
        var lines = await owner.Get($"/api/v1/me/recordings/{id}/lines");
        Assert.True(lines.Ok, lines.ToString());
        Assert.Equal(2, lines.Data!.AsArray().Count);
        Assert.Equal("Others", lines.Data.AsArray()[1]!["who"]!.GetValue<string>());

        var other = await TestClient.RegisterAsync(factory, "Someone Else");
        await other.CreateOrgAsync();
        Assert.Equal(HttpStatusCode.NotFound, (await other.Get($"/api/v1/me/recordings/{id}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await other.Post($"/api/v1/me/recordings/{id}/finish", new { })).Status);
    }

    [Fact]
    public async Task Stopping_writes_the_minutes_and_only_the_ticked_items_become_tasks()
    {
        var (owner, project) = await OrgAsync("Rec tasks");
        factory.Ai.Reset(); factory.Ai.Configured = true;
        Assert.True((await owner.Put($"/api/v1/projects/{project}/agent", new { enabled = true })).Ok);
        factory.Ai.Answer = (_, _) => JsonSerializer.Serialize(new
        {
            summary = "The release deck goes out this week.", attendees = new[] { "Owner" }, discussion = new[] { "Release" }, decisions = Array.Empty<string>(),
            actionItems = new[] { new { task = "Send the release deck", owner = (string?)null, due = (string?)null }, new { task = "Book the assessor call", owner = (string?)null, due = (string?)null } },
            risks = Array.Empty<string>(), nextMeeting = (string?)null,
        });
        var id = Seed(owner, project);

        var tasksFirst = await owner.Post($"/api/v1/me/recordings/{id}/tasks", new { items = new[] { 0 } });
        Assert.Equal(HttpStatusCode.Conflict, tasksFirst.Status); // no minutes yet

        var done = await owner.Post($"/api/v1/me/recordings/{id}/finish", new { });
        Assert.True(done.Ok, done.ToString());
        Assert.Equal(2, done.Data!["content"]!["actionItems"]!.AsArray().Count);
        Assert.Equal("done", factory.WithDb(db => db.AgentMeetingBots.IgnoreQueryFilters().Single(b => b.Id == id).Status));

        var made = await owner.Post($"/api/v1/me/recordings/{id}/tasks", new { items = new[] { 1 } });
        Assert.True(made.Ok, made.ToString());
        Assert.Single(made.Data!["created"]!.AsArray());
        Assert.Equal(1, factory.WithDb(db => db.Tasks.IgnoreQueryFilters().Count(t => t.ProjectId == project && t.Title == "Book the assessor call")));
        Assert.Equal(0, factory.WithDb(db => db.Tasks.IgnoreQueryFilters().Count(t => t.ProjectId == project && t.Title == "Send the release deck")));
    }

    [Fact]
    public async Task Stopping_with_nothing_heard_makes_no_minutes()
    {
        var (owner, project) = await OrgAsync("Rec silent");
        var id = Seed(owner, project, text: "");
        factory.WithDb(db => { var b = db.AgentMeetingBots.IgnoreQueryFilters().Single(x => x.Id == id); b.TranscriptProtected = null; b.TranscriptLength = 0; return db.SaveChanges(); });
        var done = await owner.Post($"/api/v1/me/recordings/{id}/finish", new { });
        Assert.True(done.Ok, done.ToString());
        Assert.Null(done.Data);
        Assert.Equal("failed", factory.WithDb(db => db.AgentMeetingBots.IgnoreQueryFilters().Single(b => b.Id == id).Status));
    }
}
