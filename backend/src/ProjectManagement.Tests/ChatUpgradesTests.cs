using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using ProjectManagement.Application.Features.Chat;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Infrastructure.Persistence;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Chat upgrades: real threads, pins and saved messages, quick polls that record a decision, seen-by in groups, questions waiting for me,
/// status and do-not-disturb, scheduled send, voice notes, what was made from a message, task keys as live cards, and the AI helpers
/// (catch me up, ask the chat, smart replies, fields from a message, translate).
/// </summary>
[Collection("api")]
public class ChatUpgradesTests(ApiFactory factory)
{
    private record Team(TestClient Ravi, TestClient Priya, TestClient Kumar);
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private async Task<Team> BuildTeam()
    {
        factory.Ai.Reset();
        var ravi = await TestClient.RegisterAsync(factory, "Ravi");
        await ravi.CreateOrgAsync();
        await ravi.UpgradeAsync("BUSINESS");
        var priya = await ravi.AddMemberAsync(factory, TenantRole.Member, "Priya");
        var kumar = await ravi.AddMemberAsync(factory, TenantRole.Member, "Kumar");
        return new Team(ravi, priya, kumar);
    }

    private static async Task<string> Direct(TestClient from, TestClient to) =>
        S((await from.Post("/api/v1/chat/conversations/direct", new { userId = to.UserId })).Data!["id"]);

    private static async Task<string> Group(TestClient from, string name, params TestClient[] others)
    {
        var res = await from.Post("/api/v1/chat/conversations/group", new { name, memberIds = others.Select(o => o.UserId).ToArray() });
        Assert.Equal(HttpStatusCode.Created, res.Status);
        return S(res.Data!["id"]);
    }

    private static async Task<JsonNode> Say(TestClient who, string conversation, string body, string? thread = null)
    {
        var res = await who.Post($"/api/v1/chat/conversations/{conversation}/messages", new { body, threadRootId = thread });
        Assert.Equal(HttpStatusCode.Created, res.Status);
        return res.Data!;
    }

    private static async Task<string[]> Main(TestClient who, string conversation) =>
        (await who.Get($"/api/v1/chat/conversations/{conversation}/messages")).Data!["items"]!.AsArray().Select(m => S(m!["body"])).ToArray();

    [Fact]
    public async Task A_thread_keeps_its_replies_out_of_the_conversation_and_tells_the_people_in_it()
    {
        var (ravi, priya, kumar) = await BuildTeam();
        var g = await Group(ravi, "Release crew", priya, kumar);
        var root = await Say(ravi, g, "Release on Friday?");
        var reply = await Say(priya, g, "Fine by me", S(root["id"]));
        Assert.Equal(S(root["id"]), S(reply["threadRootId"]));
        await Say(kumar, g, "Me too", S(root["id"]));

        var main = await Main(kumar, g);                                                 // replies live in the thread
        Assert.Contains("Release on Friday?", main);
        Assert.DoesNotContain("Fine by me", main);
        Assert.DoesNotContain("Me too", main);
        var thread = (await kumar.Get($"/api/v1/chat/messages/{root["id"]}/thread")).Data!;
        Assert.Equal(2, thread["root"]!["threadReplies"]!.GetValue<int>());
        Assert.Equal(["Fine by me", "Me too"], thread["replies"]!.AsArray().Select(m => S(m!["body"])).ToArray());
        // Ravi started it: he hears about the replies; the conversation's unread count is not raised by thread replies.
        Assert.Contains("replied in a thread", (await ravi.Get("/api/v1/notifications")).Data!.ToJsonString());
        var list = (await ravi.Get("/api/v1/chat/conversations")).Data!.AsArray().First(c => S(c!["id"]) == g)!;
        Assert.Equal(0, list["unread"]!.GetValue<int>());
        Assert.Equal(400, (int)(await priya.Post($"/api/v1/chat/conversations/{g}/messages", new { body = "nested", threadRootId = S(reply["id"]) })).Status / 100 * 100);
    }

    [Fact]
    public async Task Pinned_and_saved_messages_are_kept_and_listed()
    {
        var (ravi, priya, _) = await BuildTeam();
        var d = await Direct(ravi, priya);
        var m = await Say(priya, d, "The VPN code is in the vault");
        var pinned = await ravi.Send(HttpMethod.Put, $"/api/v1/chat/messages/{m["id"]}/pin", new { });
        Assert.True(pinned.Ok, pinned.ToString());
        Assert.Equal("Ravi", S(pinned.Data!["pinnedBy"]));
        Assert.Single((await priya.Get($"/api/v1/chat/conversations/{d}/pins")).Data!.AsArray());
        Assert.True((await ravi.Send(HttpMethod.Put, $"/api/v1/chat/messages/{m["id"]}/save", new { })).Data!["saved"]!.GetValue<bool>());
        var saved = (await ravi.Get("/api/v1/chat/saved")).Data!.AsArray();
        Assert.Equal("Priya", S(saved.Single()!["conversationName"]));
        Assert.Empty((await priya.Get("/api/v1/chat/saved")).Data!.AsArray());           // saving is personal
        await ravi.Send(HttpMethod.Delete, $"/api/v1/chat/messages/{m["id"]}/pin");
        Assert.Empty((await priya.Get($"/api/v1/chat/conversations/{d}/pins")).Data!.AsArray());
    }

    [Fact]
    public async Task A_poll_collects_votes_and_closing_it_posts_and_pins_the_decision()
    {
        var (ravi, priya, kumar) = await BuildTeam();
        var g = await Group(ravi, "Offsite", priya, kumar);
        Assert.Equal(422, (int)(await ravi.Post($"/api/v1/chat/conversations/{g}/polls", new { question = "Where?", options = new[] { "Goa" } })).Status);
        var poll = await ravi.Post($"/api/v1/chat/conversations/{g}/polls", new { question = "Where should we go?", options = new[] { "Goa", "Coorg", "Vizag" } });
        Assert.Equal(HttpStatusCode.Created, poll.Status);
        var pollId = S(poll.Data!["poll"]!["id"]);
        Assert.True((await priya.Post($"/api/v1/chat/polls/{pollId}/vote", new { options = new[] { 1 } })).Ok);
        var voted = await kumar.Post($"/api/v1/chat/polls/{pollId}/vote", new { options = new[] { 1 } });
        Assert.Equal(2, voted.Data!["poll"]!["options"]![1]!["votes"]!.GetValue<int>());
        Assert.Equal(422, (int)(await kumar.Post($"/api/v1/chat/polls/{pollId}/vote", new { options = new[] { 0, 2 } })).Status);   // one choice only
        Assert.Equal(HttpStatusCode.Forbidden, (await priya.Post($"/api/v1/chat/polls/{pollId}/close", new { })).Status);

        var closed = await ravi.Post($"/api/v1/chat/polls/{pollId}/close", new { });
        Assert.True(closed.Ok, closed.ToString());
        Assert.Equal("Coorg", S(closed.Data!["poll"]!["decision"]));
        Assert.Contains(await Main(kumar, g), b => b.StartsWith("Decision: Coorg"));
        Assert.Contains((await kumar.Get($"/api/v1/chat/conversations/{g}/pins")).Data!.AsArray(), p => S(p!["body"]).StartsWith("Decision: Coorg"));
        Assert.Equal(HttpStatusCode.Conflict, (await priya.Post($"/api/v1/chat/polls/{pollId}/vote", new { options = new[] { 0 } })).Status);
    }

    [Fact]
    public async Task Seen_by_and_questions_waiting_for_me()
    {
        var (ravi, priya, kumar) = await BuildTeam();
        var g = await Group(ravi, "Audit", priya, kumar);
        var m = await Say(ravi, g, "Audit files are uploaded");
        await priya.Post($"/api/v1/chat/conversations/{g}/read", new { });
        var seen = (await ravi.Get($"/api/v1/chat/messages/{m["id"]}/seen")).Data!;
        Assert.Equal("Priya", S(seen["seen"]![0]!["name"]));
        Assert.Equal("Kumar", S(seen["notYet"]![0]));

        var d = await Direct(priya, ravi);
        var q = await Say(priya, d, "Can you send the bank statement today?");
        var page = (await ravi.Get($"/api/v1/chat/conversations/{d}/messages")).Data!["items"]!.AsArray();
        Assert.True(page.Single(x => S(x!["id"]) == S(q["id"]))!["asksMe"]!.GetValue<bool>());
        Assert.Contains((await ravi.Get("/api/v1/chat/questions")).Data!.AsArray(), x => S(x!["messageId"]) == S(q["id"]));
        // A mention in a group asks the person named; others are not asked.
        var mention = await Say(kumar, g, $"@[Ravi]({ravi.UserId}) who approves the audit?");
        var inGroup = (await ravi.Get($"/api/v1/chat/conversations/{g}/messages")).Data!["items"]!.AsArray().Single(x => S(x!["id"]) == S(mention["id"]))!;
        Assert.True(inGroup["asksMe"]!.GetValue<bool>(), inGroup.ToJsonString());
        var waiting = (await ravi.Get("/api/v1/chat/questions")).Data!.AsArray();
        Assert.True(waiting.Any(x => S(x!["messageId"]) == S(mention["id"])), waiting.ToJsonString());
        Assert.DoesNotContain((await priya.Get("/api/v1/chat/questions")).Data!.AsArray(), x => S(x!["messageId"]) == S(mention["id"]));
        await Say(ravi, d, "Sending it now");
        Assert.DoesNotContain((await ravi.Get("/api/v1/chat/questions")).Data!.AsArray(), x => S(x!["messageId"]) == S(q["id"]));
    }

    [Fact]
    public async Task Status_and_do_not_disturb_show_to_others_and_hold_pop_ups()
    {
        var (ravi, priya, _) = await BuildTeam();
        var d = await Direct(ravi, priya);
        var set = await priya.Send(HttpMethod.Put, "/api/v1/chat/status", new { emoji = "🌴", text = "On leave till Monday", dndUntil = DateTime.UtcNow.AddHours(3) });
        Assert.True(set.Ok, set.ToString());
        Assert.True(set.Data!["dnd"]!.GetValue<bool>());
        var member = (await ravi.Get($"/api/v1/chat/conversations/{d}")).Data!["members"]!.AsArray().First(x => S(x!["name"]) == "Priya")!;
        Assert.Equal("On leave till Monday", S(member["statusText"]));
        Assert.True(member["dnd"]!.GetValue<bool>());
        await Say(ravi, d, "Ping");
        var notice = (await priya.Get("/api/v1/notifications")).Data!["items"]!.AsArray().First()!;
        Assert.False(notice["browser"]!.GetValue<bool>());                                // no pop-up while do-not-disturb is on
        Assert.Equal(422, (int)(await priya.Send(HttpMethod.Put, "/api/v1/chat/status", new { dndUntil = DateTime.UtcNow.AddDays(40) })).Status);
    }

    [Fact]
    public async Task A_scheduled_message_is_sent_as_its_writer_when_it_is_due_and_can_be_cancelled()
    {
        var (ravi, priya, _) = await BuildTeam();
        var d = await Direct(ravi, priya);
        Assert.Equal(422, (int)(await ravi.Post($"/api/v1/chat/conversations/{d}/scheduled", new { body = "too soon", sendAt = DateTime.UtcNow })).Status);
        var later = await ravi.Post($"/api/v1/chat/conversations/{d}/scheduled", new { body = "Good morning, standup in 10", sendAt = DateTime.UtcNow.AddHours(2) });
        Assert.Equal(HttpStatusCode.Created, later.Status);
        var cancel = await ravi.Post($"/api/v1/chat/conversations/{d}/scheduled", new { body = "never mind", sendAt = DateTime.UtcNow.AddHours(3) });
        Assert.Equal(2, (await ravi.Get($"/api/v1/chat/scheduled?conversationId={d}")).Data!.AsArray().Count);
        Assert.Empty((await priya.Get("/api/v1/chat/scheduled")).Data!.AsArray());
        Assert.Equal(HttpStatusCode.NoContent, (await ravi.Send(HttpMethod.Delete, $"/api/v1/chat/scheduled/{cancel.Data!["id"]}")).Status);

        // Time passes: the first one is due.
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var row = await db.ChatScheduledMessages.IgnoreQueryFilters().FirstAsync(s => s.Id == Guid.Parse(S(later.Data!["id"])));
            row.SendAt = DateTime.UtcNow.AddMinutes(-1);
            await db.SaveChangesAsync();
            Assert.Equal(1, await ChatService.SendDueAsync(scope.ServiceProvider, scope.ServiceProvider.GetRequiredService<AppClock>(), NullLogger.Instance, CancellationToken.None));
        }
        var items = (await priya.Get($"/api/v1/chat/conversations/{d}/messages")).Data!["items"]!.AsArray();
        var sent = items.Single(m => S(m!["body"]) == "Good morning, standup in 10")!;
        Assert.Equal(ravi.UserId.ToString(), S(sent["senderId"]));
        Assert.DoesNotContain(items, m => S(m!["body"]) == "never mind");
        Assert.Empty((await ravi.Get($"/api/v1/chat/scheduled?conversationId={d}")).Data!.AsArray());
    }

    private static byte[] Wav()
    {
        var data = new byte[1600];
        var ms = new MemoryStream();
        var w = new BinaryWriter(ms);
        w.Write(Encoding.ASCII.GetBytes("RIFF")); w.Write(36 + data.Length); w.Write(Encoding.ASCII.GetBytes("WAVE"));
        w.Write(Encoding.ASCII.GetBytes("fmt ")); w.Write(16); w.Write((short)1); w.Write((short)1); w.Write(16000); w.Write(32000); w.Write((short)2); w.Write((short)16);
        w.Write(Encoding.ASCII.GetBytes("data")); w.Write(data.Length); w.Write(data);
        return ms.ToArray();
    }

    [Fact]
    public async Task A_voice_note_is_sent_as_a_voice_message_and_task_keys_become_live_cards()
    {
        var (ravi, priya, _) = await BuildTeam();
        var d = await Direct(ravi, priya);
        var up = await ravi.Upload($"/api/v1/chat/conversations/{d}/voice", "note.wav", Wav(), new Dictionary<string, string> { ["seconds"] = "4" });
        Assert.Equal(HttpStatusCode.Created, up.Status);
        Assert.True(up.Data!["isVoice"]!.GetValue<bool>());
        var sent = await ravi.Post($"/api/v1/chat/conversations/{d}/messages", new { body = "", attachmentIds = new[] { S(up.Data["id"]) } });
        Assert.Equal(HttpStatusCode.Created, sent.Status);
        var file = sent.Data!["attachments"]![0]!;
        Assert.True(file["isVoice"]!.GetValue<bool>());
        Assert.Equal(4, file["durationSeconds"]!.GetValue<int>());
        Assert.Equal("Sent a voice note", S((await priya.Get("/api/v1/chat/conversations")).Data!.AsArray().First(c => S(c!["id"]) == d)!["lastMessage"]!["snippet"]));
        Assert.Equal(422, (int)(await ravi.Upload($"/api/v1/chat/conversations/{d}/voice", "note.wav", Encoding.UTF8.GetBytes("not a wav file at all")))
            .Status);

        var project = await ravi.CreateProjectAsync("Payments Core");
        var task = await ravi.CreateTaskAsync(project, "Refund export");
        var key = S(task["key"]);
        var cards = (await ravi.Get($"/api/v1/chat/unfurl?keys={key},DOC-9999,nonsense")).Data!.AsArray();
        var card = cards.Single()!;
        Assert.Equal("Refund export", S(card["title"]));
        Assert.Equal("task", S(card["kind"]));

        // A task made from a message is linked from it.
        var msg = await Say(ravi, d, "Please export the refunds by Friday");
        var linked = await ravi.Post($"/api/v1/chat/messages/{msg["id"]}/links", new { kind = "task", id = S(task["id"]) });
        Assert.True(linked.Ok, linked.ToString());
        Assert.Equal(key, S(linked.Data!["linked"]![0]!["key"]));
        Assert.Equal(HttpStatusCode.NotFound, (await ravi.Post($"/api/v1/chat/messages/{msg["id"]}/links", new { kind = "task", id = Guid.NewGuid() })).Status);
    }

    [Fact]
    public async Task Ai_catches_me_up_answers_from_the_chat_suggests_replies_and_fills_a_task_from_a_message()
    {
        var (ravi, priya, kumar) = await BuildTeam();
        var g = await Group(priya, "Collections", ravi, kumar);
        await Say(priya, g, "We agreed to move the EMI reminder to 9 am");
        var question = await Say(kumar, g, $"@[Ravi]({ravi.UserId}) can you approve the new template by Friday?");

        // Without AI: catching up and asking need it; filling a task still works from the first line.
        Assert.Equal(HttpStatusCode.Conflict, (await ravi.Post("/api/v1/chat/ai/catch-up", new { })).Status);
        var plain = await ravi.Post($"/api/v1/chat/messages/{question["id"]}/extract", new { kind = "task" });
        Assert.True(plain.Ok, plain.ToString());
        Assert.False(plain.Data!["byAi"]!.GetValue<bool>());
        Assert.StartsWith("@Ravi can you approve", S(plain.Data["title"]));

        factory.Ai.Configured = true;
        factory.Ai.Answer = (system, user) =>
            system.Contains("catch a busy person up") ? "{\"summary\":\"The EMI reminder moves to 9 am; Kumar needs your approval.\",\"decisions\":[{\"text\":\"EMI reminder at 9 am\",\"ref\":1}],\"questions\":[{\"text\":\"Approve the new template by Friday\",\"ref\":2}],\"actions\":[]}"
            : system.Contains("answer a question from a company's chat") ? "The reminder moves to 9 am [1]."
            : system.Contains("Suggest three different short replies") ? "[\"Yes, approving today\",\"Can I see it first?\",\"Will do by Friday\"]"
            : system.Contains("fill the fields") ? "{\"title\":\"Approve the new template\",\"due\":\"2099-01-02\",\"priority\":\"High\",\"assignee\":\"Ravi\"}"
            : system.Contains("You edit text") ? "నేను ఈరోజు ఆమోదిస్తాను" : "{}";
        var catchUp = await ravi.Post("/api/v1/chat/ai/catch-up", new { });
        Assert.True(catchUp.Ok, catchUp.ToString());
        Assert.Contains("9 am", S(catchUp.Data!["summary"]));
        Assert.Equal(S(question["id"]), S(catchUp.Data["questions"]![0]!["messageId"]));
        Assert.Equal("Collections", S(catchUp.Data["questions"]![0]!["conversationName"]));
        Assert.Contains("Ravi", factory.Ai.Prompts.Last().System);

        var ask = await ravi.Post("/api/v1/chat/ai/ask", new { question = "When is the EMI reminder sent?" });
        Assert.True(ask.Ok, ask.ToString());
        Assert.True(ask.Data!["found"]!.GetValue<bool>());
        Assert.Contains("EMI reminder", factory.Ai.Prompts.Last().User);

        var replies = await ravi.Post($"/api/v1/chat/messages/{question["id"]}/replies", new { });
        Assert.Equal(3, replies.Data!["replies"]!.AsArray().Count);

        var filled = await ravi.Post($"/api/v1/chat/messages/{question["id"]}/extract", new { kind = "task" });
        Assert.True(filled.Data!["byAi"]!.GetValue<bool>());
        Assert.Equal("Approve the new template", S(filled.Data["title"]));
        Assert.Equal("High", S(filled.Data["priority"]));
        Assert.Equal(ravi.UserId.ToString(), S(filled.Data["assigneeId"]));
        Assert.Contains("approve the new template", S(filled.Data["description"]));   // the message itself, not the model's words

        var translated = await ravi.Post("/api/v1/chat/ai/transform", new { text = "I will approve it today", action = "translate", language = "te" });
        Assert.True(translated.Ok, translated.ToString());
        Assert.Contains("Telugu", factory.Ai.Prompts.Last().System);

        // Someone outside the group cannot catch up on it or ask about it.
        var outsider = await ravi.AddMemberAsync(factory, TenantRole.Member, "Outsider");
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Post("/api/v1/chat/ai/catch-up", new { conversationId = g })).Status);
        Assert.False((await outsider.Post("/api/v1/chat/ai/ask", new { question = "When is the EMI reminder sent?" })).Data!["found"]!.GetValue<bool>());
        factory.Ai.Reset();
    }
}
