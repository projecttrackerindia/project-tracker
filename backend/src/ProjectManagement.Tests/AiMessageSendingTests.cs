using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>Real application chat services and SQLite persistence; LLM transport is disabled/scripted, not a delivery integration mock.</summary>
[Collection("api")]
public sealed class AiMessageSendingTests(ApiFactory factory)
{
    private async Task Run(Func<TestClient, TestClient, Task> test)
    {
        var options = factory.Services.GetRequiredService<IOptions<AiOptions>>().Value;
        var previous = options.PrimaryProvider;
        try
        {
            options.PrimaryProvider = "local"; factory.Chat.Reset(); factory.Chat.Configured = true;
            factory.Chat.ModelOverride = "qwen2.5:7b";
            var sender = await TestClient.RegisterAsync(factory, "Prasanna"); await sender.CreateOrgAsync(); await sender.UpgradeAsync("BUSINESS");
            var recipient = await sender.AddMemberAsync(factory, TenantRole.Member, "Sivareddy");
            await test(sender, recipient);
        }
        finally { options.PrimaryProvider = previous; factory.Chat.ModelOverride = null; factory.Chat.Reset(); }
    }
    private static async Task<JsonNode> Ask(TestClient sender, string text, Guid? conversation = null, Guid? attachment = null, AiConfirmationBinding? confirmation = null)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, conversation is null ? "/api/v1/ai/ask" : $"/api/v1/ai/conversations/{conversation}/ask")
        { Content = JsonContent.Create(new { text, timeZone = "Asia/Kolkata", attachmentIds = attachment is null ? null : new[] { attachment.Value }, confirmation }) };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", sender.Token);
        using var response = await sender.Http.SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        var done = body.Split("\n\n").Single(block => block.StartsWith("event: done\n"));
        return JsonNode.Parse(done.Split('\n')[1][6..])!["message"]!;
    }
    private Guid Conversation(JsonNode reply) => factory.WithDb(db => db.AiMessages.IgnoreQueryFilters().Single(m => m.Id == Guid.Parse(reply["id"]!.GetValue<string>())).ConversationId);
    private static string ConfirmUrl(JsonNode reply) => $"/api/v1/ai/messages/{reply["id"]}/actions/{reply["actions"]![0]!["id"]}/confirm";
    private int Sent(TestClient sender) => factory.WithDb(db => db.ChatMessages.IgnoreQueryFilters().Count(m => m.TenantId == sender.WorkspaceId && m.SenderId == sender.UserId));

    [Fact]
    public Task Typed_confirmation_sends_exact_content_once_and_returns_verified_receipt() => Run(async (sender, recipient) =>
    {
        factory.Chat.Fail = new InvalidOperationException("Exact commands/confirmations must not use the model");
        var proposal = await Ask(sender, "Can you send Hi message to Sivareddy?");
        Assert.Equal("send_message", proposal["actions"]![0]!["kind"]!.GetValue<string>());
        Assert.Equal("Hi", proposal["actions"]![0]!["preview"]!.GetValue<string>());
        Assert.Contains("Sivareddy", proposal["actions"]![0]!["summary"]!.GetValue<string>());
        Assert.Equal(0, Sent(sender));
        var conversation = Conversation(proposal);
        var answer = await Ask(sender, "yes, send it", conversation);
        Assert.Equal("builtin-confirmation", answer["model"]!.GetValue<string>());
        Assert.Contains("Verified saved message ID", answer["content"]!.GetValue<string>());
        Assert.Equal(1, Sent(sender));
        var history = (await sender.Get($"/api/v1/ai/conversations/{conversation}")).Data!["messages"]!.AsArray();
        var card = history.Single(m => m!["id"]!.GetValue<string>() == proposal["id"]!.GetValue<string>())!["actions"]![0]!;
        Assert.Equal("done", card["status"]!.GetValue<string>());
        var id = card["resultId"]!.GetValue<string>();
        var chatId = factory.WithDb(db => db.ChatMessages.IgnoreQueryFilters().Single(m => m.Id == Guid.Parse(id)).ConversationId);
        var received = (await recipient.Get($"/api/v1/chat/conversations/{chatId}/messages")).Data!["items"]!.AsArray();
        Assert.Single(received); Assert.Equal("Hi", received[0]!["body"]!.GetValue<string>());
        Assert.Equal(id, received[0]!["id"]!.GetValue<string>());
        var repeated = await Ask(sender, "yes, send it", conversation);
        Assert.Empty(repeated["actions"]!.AsArray()); Assert.Equal(1, Sent(sender));
        Assert.Contains("No single matching", repeated["content"]!.GetValue<string>());
        Assert.Empty(factory.Chat.Requests);
    });

    [Fact]
    public Task Concurrent_buttons_and_retries_do_not_send_twice() => Run(async (sender, recipient) =>
    {
        var proposal = await Ask(sender, "Send Hi message to Sivareddy");
        var results = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => sender.Post(ConfirmUrl(proposal))));
        var success = Assert.Single(results, r => r.Ok);
        Assert.Equal("done", success.Data!["status"]!.GetValue<string>());
        Assert.NotNull(success.Data["resultId"]);
        Assert.All(results.Where(r => !r.Ok), r => r.CheckStatus(HttpStatusCode.Conflict));
        (await sender.Post(ConfirmUrl(proposal))).CheckStatus(HttpStatusCode.Conflict);
        Assert.Equal(1, Sent(sender));
    });

    [Fact]
    public Task Foreign_mismatched_and_expired_confirmations_send_nothing() => Run(async (sender, recipient) =>
    {
        var proposal = await Ask(sender, "Send Hi message to Sivareddy");
        (await recipient.Post(ConfirmUrl(proposal))).CheckStatus(HttpStatusCode.NotFound);
        var other = await TestClient.RegisterAsync(factory); await other.CreateOrgAsync();
        (await other.Post(ConfirmUrl(proposal))).CheckStatus(HttpStatusCode.NotFound);
        (await sender.Post($"/api/v1/ai/messages/{proposal["id"]}/actions/not-the-approved-id/confirm")).CheckStatus(HttpStatusCode.NotFound);
        factory.WithDb(db => { db.AiMessages.IgnoreQueryFilters().Single(m => m.Id == Guid.Parse(proposal["id"]!.GetValue<string>())).CreatedAt = DateTime.UtcNow.AddDays(-2); db.SaveChanges(); return 0; });
        var expired = await sender.Post(ConfirmUrl(proposal));
        Assert.Equal("AI_ACTION_EXPIRED", expired.ErrorCode); Assert.Equal(0, Sent(sender));
    });

    [Fact]
    public Task Unavailable_recipient_fails_truthfully_without_delivery() => Run(async (sender, recipient) =>
    {
        var proposal = await Ask(sender, "Send Hi message to Sivareddy");
        factory.WithDb(db => { db.Users.Single(u => u.Id == recipient.UserId).IsActive = false; db.SaveChanges(); return 0; });
        var result = await sender.Post(ConfirmUrl(proposal));
        Assert.Equal("failed", result.Data!["status"]!.GetValue<string>());
        Assert.NotNull(result.Data["error"]); Assert.Null(result.Data["resultId"]); Assert.Equal(0, Sent(sender));
        (await sender.Post(ConfirmUrl(proposal))).CheckStatus(HttpStatusCode.Conflict);
    });

    [Fact]
    public Task Model_cannot_embellish_an_explicit_requested_message() => Run(async (sender, recipient) =>
    {
        // Exercise the tool directly: its canonical body comes from the user command, never the model's expanded draft.
        factory.Chat.Script.Enqueue(_ => FakeAiChat.UseTool(AiToolbox.SendMessage, new { recipient = "Sivareddy", body = "Hello Sivareddy, Hi! From Prasanna" }));
        var uploaded = await sender.Upload("/api/v1/ai/files", "context.txt", "An unrelated note."u8.ToArray());
        var proposal = await Ask(sender, "Please send \"Hi\" message to Sivareddy?", attachment: Guid.Parse(uploaded.Data!["id"]!.GetValue<string>()));
        Assert.Equal("Hi", proposal["actions"]![0]!["preview"]!.GetValue<string>());
        await sender.Post(ConfirmUrl(proposal)); Assert.Equal(1, Sent(sender));
        Assert.Equal("Hi", factory.WithDb(db => db.ChatMessages.IgnoreQueryFilters().Single(m => m.TenantId == sender.WorkspaceId && m.SenderId == sender.UserId).Body));
    });

    [Fact]
    public Task A_recovered_action_uses_the_same_persisted_message_identity() => Run(async (sender, recipient) =>
    {
        var proposal = await Ask(sender, "Send Hi message to Sivareddy");
        var first = await sender.Post(ConfirmUrl(proposal));
        Assert.Equal("done", first.Data!["status"]!.GetValue<string>());
        var receipt = first.Data["resultId"]!.GetValue<string>();
        // Model the uncertain window: business write persisted, action state recovery restored a pending claim.
        // This is a controlled test of service idempotency, not an assertion of automatic crash recovery.
        factory.WithDb(db => {
            var message = db.AiMessages.IgnoreQueryFilters().Single(m => m.Id == Guid.Parse(proposal["id"]!.GetValue<string>()));
            var actions = JsonNode.Parse(message.ActionsJson!)!.AsArray(); actions[0]!["status"] = "proposed";
            message.ActionsJson = actions.ToJsonString(); db.SaveChanges(); return 0;
        });
        var recovered = await sender.Post(ConfirmUrl(proposal));
        Assert.Equal("done", recovered.Data!["status"]!.GetValue<string>());
        Assert.Equal(receipt, recovered.Data["resultId"]!.GetValue<string>()); Assert.Equal(1, Sent(sender));
    });

    [Fact]
    public Task Ambiguous_approval_does_not_select_one_of_multiple_actions() => Run(async (sender, recipient) =>
    {
        factory.Chat.Script.Enqueue(_ => new AiChatEvent[] {
            new AiTurnEnd(new AiBlock[] { new AiToolUse("one", AiToolbox.SendMessage, "{\"recipient\":\"Sivareddy\",\"body\":\"Hi\"}"),
                new AiToolUse("two", AiToolbox.SendMessage, "{\"recipient\":\"Sivareddy\",\"body\":\"Hello\"}") }, "tool_use", 10, 20)
        });
        var proposal = await Ask(sender, "Send two messages to Sivareddy");
        Assert.Equal(2, proposal["actions"]!.AsArray().Count);
        var approval = await Ask(sender, "yes", Conversation(proposal));
        Assert.Contains("No single matching", approval["content"]!.GetValue<string>());
        Assert.Equal(0, Sent(sender));
    });

    [Fact]
    public Task Explicit_confirmation_binding_rejects_a_different_kind_or_action() => Run(async (sender, recipient) =>
    {
        var proposal = await Ask(sender, "Send Hi message to Sivareddy");
        var message = Guid.Parse(proposal["id"]!.GetValue<string>());
        var action = proposal["actions"]![0]!["id"]!.GetValue<string>();
        var conversation = Conversation(proposal);
        var mismatch = await Ask(sender, "confirm", conversation, confirmation: new(message, action, "send_report"));
        Assert.Contains("No single matching", mismatch["content"]!.GetValue<string>()); Assert.Equal(0, Sent(sender));
        var correct = await Ask(sender, "confirm", conversation, confirmation: new(message, action, "send_message"));
        Assert.Contains("Verified saved message ID", correct["content"]!.GetValue<string>()); Assert.Equal(1, Sent(sender));
    });

    [Fact]
    public Task Unsupported_external_channel_is_reported_without_a_send_proposal() => Run(async (sender, recipient) =>
    {
        factory.Chat.Script.Enqueue(_ => FakeAiChat.UseTool(AiToolbox.SendMessage, new { recipient = "Sivareddy", body = "Hi" }));
        factory.Chat.Script.Enqueue(request => {
            Assert.Contains("not supported", Assert.IsType<AiToolResult>(request.Turns.Last().Blocks.Single()).Content);
            return FakeAiChat.Say("WhatsApp sending is not supported.");
        });
        var response = await Ask(sender, "Send Hi through WhatsApp message to Sivareddy");
        Assert.Empty(response["actions"]!.AsArray()); Assert.Equal(0, Sent(sender));
    });
}
