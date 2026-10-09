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
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

[Collection("api")]
public sealed class LocalAiWorkflowTests(ApiFactory factory)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private async Task Local(Func<TestClient, Task> test)
    {
        var options = factory.Services.GetRequiredService<IOptions<AiOptions>>().Value;
        var previous = options.PrimaryProvider;
        try
        {
            options.PrimaryProvider = "local"; factory.Chat.Reset(); factory.Chat.Configured = true;
            factory.Chat.ModelOverride = "qwen2.5:7b";
            var owner = await TestClient.RegisterAsync(factory); await owner.CreateOrgAsync(); await owner.UpgradeAsync("BUSINESS");
            await test(owner);
        }
        finally { options.PrimaryProvider = previous; factory.Chat.ModelOverride = null; factory.Chat.Reset(); }
    }
    private static async Task<JsonNode> Ask(TestClient owner, string text, Guid? conversation = null)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, conversation is null ? "/api/v1/ai/ask" : $"/api/v1/ai/conversations/{conversation}/ask")
        { Content = JsonContent.Create(new { text, timeZone = "Asia/Kolkata" }) };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", owner.Token);
        using var response = await owner.Http.SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        var done = body.Split("\n\n").Single(block => block.StartsWith("event: done\n"));
        return JsonNode.Parse(done.Split('\n')[1][6..])!["message"]!;
    }
    private (Guid Conversation, Guid Message) Pending(TestClient owner, string actionId = "original") => factory.WithDb(db =>
    {
        var conv = new AiConversation { TenantId = owner.WorkspaceId, UserId = owner.UserId };
        var proposal = new AiProposal(actionId, "reminder", "Remind you: test 3", "Pending", JsonSerializer.Serialize(new { title = "test 3", at = "2027-10-10T23:35", timeZone = "Asia/Kolkata" }, Json));
        var message = new AiMessage { TenantId = owner.WorkspaceId, UserId = owner.UserId, ConversationId = conv.Id, Role = "assistant", Content = "Pending", ActionsJson = JsonSerializer.Serialize(new[] { proposal }, Json) };
        db.AiConversations.Add(conv); db.AiMessages.Add(message); db.SaveChanges(); return (conv.Id, message.Id);
    });

    [Fact]
    public Task Reminder_revision_waits_for_confirmation_and_invalidates_old_cards() => Local(async owner =>
    {
        var pending = Pending(owner);
        factory.Chat.Script.Enqueue(_ => FakeAiChat.UseTool(AiToolbox.ReviseReminder, new { message_id = pending.Message, proposal_id = "original", at = "2027-10-10T23:36" }, text: "I've updated it."));
        var reply = await Ask(owner, "Please change it to 23:36", pending.Conversation);
        Assert.Single(factory.Chat.Requests);
        Assert.Contains("Awaiting confirmation", reply["content"]!.GetValue<string>());
        Assert.DoesNotContain("I've updated", reply["content"]!.GetValue<string>());
        Assert.Empty((await owner.Get("/api/v1/reminders")).Data!["open"]!.AsArray());
        var action = reply["actions"]![0]!["id"]!.GetValue<string>();
        var confirmation = await owner.Post($"/api/v1/ai/messages/{reply["id"]}/actions/{action}/confirm");
        Assert.Equal("done", confirmation.Data!["status"]!.GetValue<string>());
        (await owner.Post($"/api/v1/ai/messages/{pending.Message}/actions/original/confirm")).CheckStatus(HttpStatusCode.Conflict);
        var saved = (await owner.Get("/api/v1/reminders")).Data!["open"]!.AsArray();
        Assert.Single(saved); Assert.Equal("2027-10-10T23:36", saved[0]!["localAt"]!.GetValue<string>());
    });

    [Fact]
    public Task Parallel_replacements_share_one_claim_and_cannot_duplicate_the_reminder() => Local(async owner =>
    {
        var pending = Pending(owner);
        var ids = new List<(string Message, string Action)>();
        foreach (var minute in new[] { "36", "37" })
        {
            factory.Chat.Script.Enqueue(_ => FakeAiChat.UseTool(AiToolbox.ReviseReminder, new { message_id = pending.Message, proposal_id = "original", at = $"2027-10-10T23:{minute}" }));
            var reply = await Ask(owner, "Please change it to 23:36", pending.Conversation);
            ids.Add((reply["id"]!.GetValue<string>(), reply["actions"]![0]!["id"]!.GetValue<string>()));
        }
        var results = await Task.WhenAll(ids.Select(id => owner.Post($"/api/v1/ai/messages/{id.Message}/actions/{id.Action}/confirm")));
        Assert.Single(results.Where(r => r.Data?["status"]?.GetValue<string>() == "done"));
        Assert.Single((await owner.Get("/api/v1/reminders")).Data!["open"]!.AsArray());
    });

    [Fact]
    public Task Saved_reminders_can_be_read_and_rescheduled_only_after_confirmation() => Local(async owner =>
    {
        var created = await owner.Post("/api/v1/reminders", new { title = "Saved test", note = "Keep my note", when = new { at = "2027-10-10T23:35", timeZone = "Asia/Kolkata" } });
        Assert.True(created.Ok, created.ToString());
        var id = created.Data!["id"]!.GetValue<string>();
        factory.Chat.Script.Enqueue(_ => FakeAiChat.UseTool(AiToolbox.ListReminders, new { }));
        factory.Chat.Script.Enqueue(request => {
            Assert.Contains(id, Assert.IsType<AiToolResult>(request.Turns.Last().Blocks.Single()).Content);
            return FakeAiChat.UseTool(AiToolbox.UpdateReminder, new { id, at = "2027-10-10T23:36" });
        });
        var reply = await Ask(owner, "Update my saved reminder to 23:36 on 10 October 2027");
        Assert.Equal("2027-10-10T23:35", (await owner.Get("/api/v1/reminders")).Data!["open"]![0]!["localAt"]!.GetValue<string>());
        var confirmed = await owner.Post($"/api/v1/ai/messages/{reply["id"]}/actions/{reply["actions"]![0]!["id"]}/confirm");
        Assert.Equal("done", confirmed.Data!["status"]!.GetValue<string>());
        var saved = (await owner.Get("/api/v1/reminders")).Data!["open"]![0]!;
        Assert.Equal("2027-10-10T23:36", saved["localAt"]!.GetValue<string>());
        Assert.Equal("Keep my note", saved["note"]!.GetValue<string>());
    });

    [Fact]
    public Task Unsupported_images_are_rejected_and_historical_images_do_not_break_text() => Local(async owner =>
    {
        var rejected = await owner.Upload("/api/v1/ai/files", "chart.png", new byte[] { 137,80,78,71,13,10,26,10 });
        Assert.Equal("AI_ATTACHMENT_UNSUPPORTED", rejected.ErrorCode);
        var conv = factory.WithDb(db => {
            var conv = new AiConversation { TenantId = owner.WorkspaceId, UserId = owner.UserId };
            var user = new AiMessage { TenantId = owner.WorkspaceId, UserId = owner.UserId, ConversationId = conv.Id, Role = "user", Content = "See this chart", AttachmentsJson = "[]" };
            db.AiConversations.Add(conv); db.AiMessages.Add(user);
            db.AiAttachments.Add(new AiAttachment { TenantId = owner.WorkspaceId, UserId = owner.UserId, ConversationId = conv.Id, MessageId = user.Id, FileName = "chart.png", ContentType = "image/png", StorageKey = "missing-image" });
            db.SaveChanges(); return conv.Id;
        });
        await Ask(owner, "Why is my reminder missing?", conv);
        var request = factory.Chat.Requests.Last();
        Assert.DoesNotContain(request.Turns.SelectMany(t => t.Blocks), b => b is AiImage);
        Assert.Contains(request.Turns.SelectMany(t => t.Blocks).OfType<AiText>(), b => b.Text.Contains("not readable by the current model"));
        Assert.Contains("Current local date and time", request.Context);
    });

    [Fact]
    public Task Exact_reminder_commands_and_greetings_require_no_model_calls() => Local(async owner =>
    {
        factory.Chat.Fail = new InvalidOperationException("The model must not be invoked");
        var samples = new List<double>();
        for (var i = 0; i < 20; i++)
        {
            var timer = System.Diagnostics.Stopwatch.StartNew();
            await Ask(owner, "Hi"); samples.Add(timer.Elapsed.TotalMilliseconds);
        }
        samples.Sort();
        Console.WriteLine($"In-process API greeting benchmark (20 warm requests, no inference): mean={samples.Average():F1}ms p95={samples[18]:F1}ms");
        var greeting = await Ask(owner, "Hi");
        Assert.Equal(0, greeting["credits"]!.GetValue<int>());
        var pending = Pending(owner);
        var revision = await Ask(owner, "change it to 23:36", pending.Conversation);
        Assert.Equal("builtin-reminder", revision["model"]!.GetValue<string>());
        Assert.Single(revision["actions"]!.AsArray());
        Assert.Equal(0, revision["credits"]!.GetValue<int>());
        var past = await Ask(owner, "create reminder for 00:00 as test 3");
        Assert.Contains("Which date", past["content"]!.GetValue<string>());
        Assert.Empty(past["actions"]!.AsArray());
        Assert.Empty(factory.Chat.Requests);
        Assert.Empty(factory.Chat.Classified);
    });

    [Fact]
    public Task Reminder_revisions_cannot_access_another_workspace_or_conversation() => Local(async owner =>
    {
        var other = await TestClient.RegisterAsync(factory); await other.CreateOrgAsync(); await other.UpgradeAsync("BUSINESS");
        var foreign = Pending(other);
        factory.Chat.Script.Enqueue(_ => FakeAiChat.UseTool(AiToolbox.ReviseReminder, new { message_id = foreign.Message, proposal_id = "original", at = "2027-10-10T23:36" }));
        var reply = await Ask(owner, "Please change my reminder to 23:36");
        Assert.Empty(reply["actions"]!.AsArray());
        Assert.Empty((await owner.Get("/api/v1/reminders")).Data!["open"]!.AsArray());
    });

    [Fact]
    public Task Compound_requests_keep_other_tools_and_can_continue_after_a_proposal() => Local(async owner =>
    {
        var project = await owner.CreateProjectAsync();
        factory.Chat.Script.Enqueue(request => {
            Assert.Contains(request.Tools, t => t.Name == AiToolbox.CreateTask);
            Assert.Contains(request.Tools, t => t.Name == AiToolbox.CreateReminder);
            return FakeAiChat.UseTool(AiToolbox.CreateReminder, new { text = "Compound test", at = "2027-10-10T23:35" });
        });
        factory.Chat.Script.Enqueue(_ => FakeAiChat.Say("I still need the task details."));
        await Ask(owner, "Create a reminder and then add a task to my project");
        Assert.Equal(2, factory.Chat.Requests.Count);
    });

    [Fact]
    public Task A_false_reminder_completion_without_tools_is_not_shown_as_success() => Local(async owner =>
    {
        factory.Chat.Script.Enqueue(_ => FakeAiChat.Say("I've updated your reminder."));
        var reply = await Ask(owner, "Update reminder to 23:36");
        Assert.StartsWith("No reminder was created or changed", reply["content"]!.GetValue<string>());
        Assert.Empty((await owner.Get("/api/v1/reminders")).Data!["open"]!.AsArray());
    });
}
