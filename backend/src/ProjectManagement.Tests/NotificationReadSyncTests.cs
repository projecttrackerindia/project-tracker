using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Read in one place, read everywhere: reading a conversation, opening a task, finishing a reminder or joining a call clears that person's
/// notifications about it (NotificationService.MarkReadForTargetAsync) - only theirs, only about that thing - and the counts drop with it.
/// </summary>
[Collection("api")]
public class NotificationReadSyncTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private async Task<(TestClient Ravi, TestClient Priya, TestClient Kumar)> TeamAsync()
    {
        var ravi = await TestClient.RegisterAsync(factory, "Ravi");
        await ravi.CreateOrgAsync();
        await ravi.UpgradeAsync("BUSINESS");
        return (ravi, await ravi.AddMemberAsync(factory, TenantRole.Manager, "Priya"), await ravi.AddMemberAsync(factory, TenantRole.Member, "Kumar"));
    }

    private static async Task<int> Unread(TestClient who) => (await who.Get("/api/v1/notifications/counts")).Data!["unread"]!.GetValue<int>();

    private static async Task<List<JsonNode>> UnreadAbout(TestClient who, string fragment) =>
        (await who.Get("/api/v1/notifications?unreadOnly=true&pageSize=100")).Data!["items"]!.AsArray().Select(n => n!)
            .Where(n => (n["link"]?.GetValue<string>() ?? "").Contains(fragment)).ToList();

    private Guid Seed(TestClient who, NotificationType type, string link, string? dedupe = null) => factory.WithDb(db =>
    {
        var n = new Notification { TenantId = who.WorkspaceId, UserId = who.UserId, Type = type, Title = "Seeded", Link = link, DedupeKey = dedupe, CreatedAt = DateTime.UtcNow, InApp = true };
        db.Notifications.Add(n);
        db.SaveChanges();
        return n.Id;
    });

    private bool IsRead(Guid id) => factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Single(n => n.Id == id).ReadAt != null);

    [Fact]
    public async Task Reading_a_conversation_clears_its_messages_mentions_and_thread_replies_for_that_reader_only()
    {
        var (ravi, priya, kumar) = await TeamAsync();
        var group = S((await ravi.Post("/api/v1/chat/conversations/group", new { name = "Release team", memberIds = new[] { priya.UserId, kumar.UserId } })).Data!["id"]);
        var other = S((await ravi.Post("/api/v1/chat/conversations/direct", new { userId = priya.UserId })).Data!["id"]);

        Assert.True((await ravi.Post($"/api/v1/chat/conversations/{group}/messages", new { body = "Freeze is tonight" })).Ok);
        Assert.True((await ravi.Post($"/api/v1/chat/conversations/{group}/messages", new { body = $"@[Priya]({priya.UserId}) please check the RAML" })).Ok);
        Assert.True((await ravi.Post($"/api/v1/chat/conversations/{other}/messages", new { body = "Separate topic" })).Ok);
        var thread = Seed(priya, NotificationType.Message, $"/chat/{group}?thread={Guid.NewGuid()}");   // a thread reply in the same chat

        var about = await UnreadAbout(priya, group);
        Assert.Contains(about, n => S(n["type"]) == "Message");
        Assert.Contains(about, n => S(n["type"]) == "Mention");                 // the @mention links to the same chat
        var before = await Unread(priya);
        var kumarBefore = await Unread(kumar);
        Assert.True(kumarBefore >= 1);

        Assert.True((await priya.Post($"/api/v1/chat/conversations/{group}/read")).Ok);

        Assert.Empty(await UnreadAbout(priya, group));                          // message, mention and thread reply: all read
        Assert.True(IsRead(thread));
        Assert.Single(await UnreadAbout(priya, other));                         // another conversation is untouched
        Assert.Equal(before - about.Count, await Unread(priya));                // the count drops by exactly those
        Assert.Equal(kumarBefore, await Unread(kumar));                         // and nobody else's change
        var read = (await priya.Get("/api/v1/notifications?pageSize=100")).Data!["items"]!.AsArray().Select(n => n!)
            .Where(n => (n["link"]?.GetValue<string>() ?? "").Contains(group)).ToList();
        Assert.All(read, n => Assert.True(n["isRead"]!.GetValue<bool>()));      // still listed (under Read), but read
        var emailQueued = factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Count(n => n.UserId == priya.UserId && n.Link!.Contains(group) && (n.EmailPending || n.PushPending)));
        Assert.Equal(0, emailQueued);                                           // read: no e-mail or push about it later
    }

    [Fact]
    public async Task Opening_a_task_reads_the_openers_notices_about_it_and_no_one_elses()
    {
        var (ravi, priya, kumar) = await TeamAsync();
        var project = await ravi.CreateProjectAsync("Payments");
        var task = await ravi.CreateTaskAsync(project, "Fix portal login");
        var taskId = S(task["id"]);
        var mine = Seed(ravi, NotificationType.TaskAssigned, $"/projects/{project}?task={taskId}");
        var unrelated = Seed(ravi, NotificationType.TaskAssigned, $"/projects/{project}?task={Guid.NewGuid()}");
        var hers = Seed(priya, NotificationType.TaskAssigned, $"/projects/{project}?task={taskId}");
        var before = await Unread(ravi);

        Assert.True((await ravi.Get($"/api/v1/tasks/{taskId}")).Ok);

        Assert.True(IsRead(mine));
        Assert.False(IsRead(unrelated));
        Assert.False(IsRead(hers));
        Assert.Equal(before - 1, await Unread(ravi));
    }

    [Fact]
    public async Task Finishing_a_reminder_reads_its_notices_matched_by_dedupe_key()
    {
        var (ravi, _, _) = await TeamAsync();
        var created = await ravi.Post("/api/v1/reminders", new { title = "Call the vendor", when = new { at = "2030-01-01T09:00", timeZone = "UTC" } });
        Assert.True(created.Ok, created.ToString());
        var id = Guid.Parse(S(created.Data!["id"]));
        var fired = Seed(ravi, NotificationType.Reminder, $"/r/{Guid.NewGuid():N}", $"rem:{id:N}:1");   // the link carries a one-time key, not the id
        var other = Seed(ravi, NotificationType.Reminder, $"/r/{Guid.NewGuid():N}", $"rem:{Guid.NewGuid():N}:1");

        Assert.True((await ravi.Post($"/api/v1/reminders/{id}/done")).Ok);

        Assert.True(IsRead(fired));
        Assert.False(IsRead(other));
    }

    [Fact]
    public async Task Joining_a_call_reads_the_invitation()
    {
        var (ravi, priya, kumar) = await TeamAsync();
        var project = await ravi.CreateProjectAsync("Atlas Calls");
        var started = await ravi.Post("/api/v1/calls", new { projectId = project, invite = new[] { priya.UserId } });
        Assert.True(started.Ok, started.ToString());
        var id = S(started.Data!["id"]);
        Assert.NotEmpty(await UnreadAbout(priya, $"/calls/{id}"));
        var before = await Unread(priya);

        Assert.True((await priya.Post($"/api/v1/calls/{id}/join")).Ok);

        Assert.Empty(await UnreadAbout(priya, $"/calls/{id}"));
        Assert.True(await Unread(priya) < before);
    }
}
