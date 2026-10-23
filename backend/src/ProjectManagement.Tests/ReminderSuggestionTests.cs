using System.Net;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Features.Reminders;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Reminders offered from what people said (chat promises, meeting action items) and the follow-up when a question goes unanswered.</summary>
[Collection("api")]
public class ReminderSuggestionTests(ApiFactory factory)
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private async Task<(TestClient Ravi, TestClient Priya, string Chat)> Team()
    {
        var ravi = await TestClient.RegisterAsync(factory, "Ravi Promise");
        await ravi.CreateOrgAsync();
        await ravi.UpgradeAsync("BUSINESS");
        var priya = await ravi.AddMemberAsync(factory, TenantRole.Member, "Priya Reader");
        var chat = await ravi.Post("/api/v1/chat/conversations/direct", new { userId = priya.UserId });
        Assert.True(chat.Ok, chat.ToString());
        return (ravi, priya, S(chat.Data!["id"]));
    }

    [Fact]
    public async Task A_promise_in_chat_is_offered_as_a_reminder_and_one_tap_sets_it()
    {
        var (ravi, priya, chat) = await Team();
        Assert.True((await ravi.Post($"/api/v1/chat/conversations/{chat}/messages", new { body = "Sure, I'll send the estimate tomorrow." })).Ok);
        Assert.True((await ravi.Post($"/api/v1/chat/conversations/{chat}/messages", new { body = "Can you check the numbers by Friday?" })).Ok);   // a question, not a promise
        Assert.True((await ravi.Post($"/api/v1/chat/conversations/{chat}/messages", new { body = "I'll look into it" })).Ok);                      // no time

        var offered = (await ravi.Get("/api/v1/reminders/suggestions")).Data!.AsArray();
        var s = Assert.Single(offered)!;
        Assert.Equal("Send the estimate", S(s["title"]));
        Assert.Equal("chat", S(s["sourceKind"]));
        Assert.Equal($"/chat/{chat}", S(s["link"]));
        Assert.Contains("I'll send the estimate tomorrow", S(s["quote"]));
        Assert.Empty((await priya.Get("/api/v1/reminders/suggestions")).Data!.AsArray());   // only the person who promised

        var set = await ravi.Post($"/api/v1/reminders/suggestions/{S(s["id"])}/accept", new { });
        Assert.True(set.Ok, set.ToString());
        Assert.Equal("Send the estimate", S(set.Data!["title"]));
        Assert.Contains("You said", S(set.Data!["note"]));
        var reminderId = Guid.Parse(S(set.Data!["id"]));
        Assert.Equal($"/chat/{chat}", factory.WithDb(db => db.Reminders.IgnoreQueryFilters().Single(r => r.Id == reminderId).Link));
        Assert.Empty((await ravi.Get("/api/v1/reminders/suggestions")).Data!.AsArray());
        Assert.Equal(HttpStatusCode.Conflict, (await ravi.Post($"/api/v1/reminders/suggestions/{S(s["id"])}/accept", new { })).Status);   // once

        // Another promise, let go with the cross; and the same message never offers twice.
        Assert.True((await ravi.Post($"/api/v1/chat/conversations/{chat}/messages", new { body = "I will call the bank next Monday" })).Ok);
        var next = Assert.Single((await ravi.Get("/api/v1/reminders/suggestions")).Data!.AsArray())!;
        Assert.Equal("Call the bank", S(next["title"]));
        Assert.Equal(HttpStatusCode.NotFound, (await priya.Post($"/api/v1/reminders/suggestions/{S(next["id"])}/dismiss", new { })).Status);
        Assert.Equal(HttpStatusCode.NoContent, (await ravi.Post($"/api/v1/reminders/suggestions/{S(next["id"])}/dismiss", new { })).Status);
        Assert.Empty((await ravi.Get("/api/v1/reminders/suggestions")).Data!.AsArray());
    }

    [Fact]
    public async Task A_meeting_action_item_is_offered_to_its_owner()
    {
        var (ravi, priya, _) = await Team();
        var tenant = ravi.WorkspaceId;
        using (var scope = factory.Services.CreateScope())
        {
            var svc = scope.ServiceProvider.GetRequiredService<ReminderSuggestionService>();
            var at = DateTime.UtcNow.Date.AddDays(3).AddHours(9);
            Assert.Equal(1, await svc.OfferAtAsync(tenant, priya.UserId, "share the revised plan.", at, "meeting", "minutes:test:1", "/notetaker?session=x", "Share the revised plan — Priya, by Monday", CancellationToken.None));
            Assert.Equal(0, await svc.OfferAtAsync(tenant, priya.UserId, "share the revised plan.", at, "meeting", "minutes:test:1", "/notetaker?session=x", null, CancellationToken.None));   // once
            Assert.Equal(0, await svc.OfferAtAsync(tenant, priya.UserId, "old", DateTime.UtcNow.AddDays(-1), "meeting", "minutes:test:2", null, null, CancellationToken.None));   // passed
        }
        var s = Assert.Single((await priya.Get("/api/v1/reminders/suggestions")).Data!.AsArray())!;
        Assert.Equal("Share the revised plan", S(s["title"]));
        Assert.Equal("meeting", S(s["sourceKind"]));
        Assert.Empty((await ravi.Get("/api/v1/reminders/suggestions")).Data!.AsArray());
    }

    [Fact]
    public async Task An_unanswered_question_becomes_one_follow_up_with_a_nudge_to_send()
    {
        var (ravi, priya, chat) = await Team();
        var asked = await ravi.Post($"/api/v1/chat/conversations/{chat}/messages", new { body = "Can you share the signed agreement?" });
        Assert.True(asked.Ok, asked.ToString());
        // Asked on Friday 4 January 2030; it is now Wednesday the 9th, 11:00 (UTC): three working days with no reply.
        var askedAt = new DateTime(2030, 1, 4, 10, 0, 0, DateTimeKind.Utc);
        var now = new DateTime(2030, 1, 9, 11, 0, 0, DateTimeKind.Utc);
        var conv = Guid.Parse(chat); var msg = Guid.Parse(S(asked.Data!["id"]));
        factory.WithDb(db =>
        {
            db.ChatMessages.IgnoreQueryFilters().Where(m => m.Id == msg).ExecuteUpdate(u => u.SetProperty(m => m.CreatedAt, askedAt));
            return db.Conversations.IgnoreQueryFilters().Where(c => c.Id == conv).ExecuteUpdate(u => u.SetProperty(c => c.LastMessageAt, askedAt));
        });
        async Task<int> Check(DateTime at)
        {
            using var scope = factory.Services.CreateScope();
            return await scope.ServiceProvider.GetRequiredService<ReminderEngine>().FollowUpsAsync(at);
        }
        Assert.Equal(0, await Check(new DateTime(2030, 1, 7, 11, 0, 0, DateTimeKind.Utc)));   // Monday: one working day so far
        Assert.True(await Check(now) >= 1);
        Assert.Equal(0, await Check(now.AddHours(1)));                                             // once

        var mine = factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => n.UserId == ravi.UserId && n.DedupeKey == $"owed:{msg:N}").ToList());
        var n = Assert.Single(mine);
        Assert.Equal(NotificationType.Reminder, n.Type);
        Assert.Equal($"/chat/{chat}", n.Link);
        Assert.Contains("Priya Reader hasn't replied", n.Title);
        Assert.Contains("Suggested nudge: Hi Priya", n.Body);
        Assert.Empty(factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(x => x.UserId == priya.UserId && x.DedupeKey == $"owed:{msg:N}").ToList()));

        // Reply right from the reminder sends the nudge into the chat.
        var item = (await ravi.Get("/api/v1/notifications?lane=needs")).Data!["items"]!.AsArray().FirstOrDefault(x => S(x!["id"]) == n.Id.ToString())
            ?? (await ravi.Get("/api/v1/notifications")).Data!["items"]!.AsArray().First(x => S(x!["id"]) == n.Id.ToString());
        Assert.Contains("reply", item!["actions"]!.AsArray().Select(a => a!.GetValue<string>()));
        Assert.True((await ravi.Post($"/api/v1/notifications/{n.Id}/act", new { action = "reply", text = "Hi Priya, just following up on my question above." })).Ok);
        var messages = (await priya.Get($"/api/v1/chat/conversations/{chat}/messages")).Data!;
        Assert.Contains("just following up", messages.ToJsonString());
    }

    [Fact]
    public async Task No_follow_up_when_the_last_word_was_not_a_question()
    {
        var (ravi, priya, chat) = await Team();
        var thanks = await ravi.Post($"/api/v1/chat/conversations/{chat}/messages", new { body = "Thanks, see you at the review" });
        var askedAt = new DateTime(2031, 3, 3, 10, 0, 0, DateTimeKind.Utc);   // Monday
        var conv = Guid.Parse(chat); var msg = Guid.Parse(S(thanks.Data!["id"]));
        factory.WithDb(db =>
        {
            db.ChatMessages.IgnoreQueryFilters().Where(m => m.Id == msg).ExecuteUpdate(u => u.SetProperty(m => m.CreatedAt, askedAt));
            return db.Conversations.IgnoreQueryFilters().Where(c => c.Id == conv).ExecuteUpdate(u => u.SetProperty(c => c.LastMessageAt, askedAt));
        });
        using var scope = factory.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<ReminderEngine>().FollowUpsAsync(new DateTime(2031, 3, 6, 11, 0, 0, DateTimeKind.Utc));
        Assert.Empty(factory.WithDb(db => db.Notifications.IgnoreQueryFilters().Where(n => n.UserId == ravi.UserId && n.DedupeKey == $"owed:{msg:N}").ToList()));
    }
}
