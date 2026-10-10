using System.Net;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

[Collection("api")]
public sealed class AgentTrackerTests(ApiFactory factory)
{
    private static AiExecutionTrace Trace(string correlation = "correlation") => new("project-assistant", "2", correlation, "Ollama", "qwen2.5:7b", DateTime.UtcNow, 1234, 34, 300, 2000, 4, "succeeded", null,
        [new(0, 1200, 40, 10, "end_turn")], [new("find_work", 10, true, "read")]);
    private Guid Insert(TestClient user, string? trace = null) => factory.WithDb(db =>
    {
        var conv = new AiConversation { TenantId = user.WorkspaceId, UserId = user.UserId, Title = "private" };
        var message = new AiMessage { TenantId = user.WorkspaceId, UserId = conv.UserId, ConversationId = conv.Id, Role = "assistant", Content = "private password or confidential notes", Model = "qwen2.5:7b", InputTokens = 40, OutputTokens = 10,
            ExecutionJson = trace ?? JsonSerializer.Serialize(Trace(), new JsonSerializerOptions(JsonSerializerDefaults.Web)) };
        db.AiConversations.Add(conv); db.AiMessages.Add(message); db.SaveChanges(); return message.Id;
    });

    [Fact]
    public async Task Tracker_enforces_tenant_and_admin_boundaries_and_never_returns_private_content()
    {
        var owner = await TestClient.RegisterAsync(factory); await owner.CreateOrgAsync(); await owner.UpgradeAsync("BUSINESS");
        var member = await owner.AddMemberAsync(factory, TenantRole.Member);
        var other = await TestClient.RegisterAsync(factory); await other.CreateOrgAsync();
        var mine = Insert(owner); var foreign = Insert(other);
        var response = await owner.Get("/api/v1/ai/tracker"); response.CheckStatus(HttpStatusCode.OK);
        Assert.Equal(1, response.Data!["total"]!.GetValue<int>());
        var json = response.Data.ToJsonString();
        Assert.Contains(mine.ToString(), json); Assert.DoesNotContain(foreign.ToString(), json);
        Assert.DoesNotContain("private password", json); Assert.DoesNotContain("confidential", json);
        Assert.Equal(1234, response.Data["p95Ms"]!.GetValue<long>());
        (await member.Get("/api/v1/ai/tracker")).CheckStatus(HttpStatusCode.Forbidden);
        (await member.Get("/api/v1/ai/tracker/health")).CheckStatus(HttpStatusCode.Forbidden);
        (await member.Put("/api/v1/ai/tracker/agent", new { enabled = false })).CheckStatus(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Operational_summaries_rank_paths_and_count_errors_before_pagination()
    {
        var owner = await TestClient.RegisterAsync(factory); await owner.CreateOrgAsync();
        Insert(owner, JsonSerializer.Serialize(Trace() with { Intent = "greeting", DurationMs = 10, Models = [] }, new JsonSerializerOptions(JsonSerializerDefaults.Web)));
        for (var i = 0; i < 2; i++)
            Insert(owner, JsonSerializer.Serialize(Trace() with { Intent = "reasoning", DurationMs = 5000, Outcome = "timeout", ErrorCode = "AI_TIMEOUT",
                Models = [new(0, 4900, 40, 10, "error", new(null, null, null, null, null, 100))] }, new JsonSerializerOptions(JsonSerializerDefaults.Web)));
        var data = (await owner.Get("/api/v1/ai/tracker?pageSize=1")).Data!;
        Assert.Single(data["runs"]!.AsArray());
        Assert.Equal("reasoning", data["slowestPaths"]![0]!["intent"]!.GetValue<string>());
        Assert.Equal(2, data["slowestPaths"]![0]!["requests"]!.GetValue<int>());
        Assert.Equal(100, data["slowestPaths"]![0]!["averageQueueMs"]!.GetValue<double>());
        Assert.Null(data["slowestPaths"]![1]!["averageQueueMs"]);
        Assert.Equal("AI_TIMEOUT", data["frequentErrors"]![0]!["code"]!.GetValue<string>());
        Assert.Equal(2, data["frequentErrors"]![0]!["count"]!.GetValue<int>());
        var filtered = (await owner.Get("/api/v1/ai/tracker?intent=greeting")).Data!;
        Assert.Single(filtered["slowestPaths"]!.AsArray());
        Assert.Empty(filtered["frequentErrors"]!.AsArray());
    }

    [Fact]
    public async Task Tracker_filters_paginates_and_tolerates_corrupt_optional_traces()
    {
        var owner = await TestClient.RegisterAsync(factory); await owner.CreateOrgAsync();
        Insert(owner); Insert(owner); Insert(owner, "invalid JSON");
        var page = await owner.Get("/api/v1/ai/tracker?page=2&pageSize=1&status=succeeded&model=qwen2.5%3A7b"); page.CheckStatus(HttpStatusCode.OK);
        Assert.Equal(2, page.Data!["total"]!.GetValue<int>()); Assert.Single(page.Data["runs"]!.AsArray());
        Assert.Empty((await owner.Get("/api/v1/ai/tracker?status=failed")).Data!["runs"]!.AsArray());
        (await owner.Get("/api/v1/ai/tracker?pageSize=101")).CheckStatus(HttpStatusCode.UnprocessableEntity);
        (await owner.Get("/api/v1/ai/tracker?status=anything")).CheckStatus(HttpStatusCode.UnprocessableEntity);
    }

    [Fact]
    public async Task Real_chat_records_model_and_tools_without_logging_the_user_request()
    {
        factory.Chat.Reset(); factory.Chat.Configured = true;
        var owner = await TestClient.RegisterAsync(factory); await owner.CreateOrgAsync(); await owner.UpgradeAsync("BUSINESS");
        var response = await owner.Post("/api/v1/ai/ask", new { text = "Hello private-secret-marker" }); response.CheckStatus(HttpStatusCode.OK);
        var report = await owner.Get("/api/v1/ai/tracker"); report.CheckStatus(HttpStatusCode.OK);
        Assert.Equal(1, report.Data!["total"]!.GetValue<int>());
        Assert.DoesNotContain("private-secret-marker", report.Data.ToJsonString());
        Assert.Single(report.Data["runs"]![0]!["trace"]!["models"]!.AsArray());
    }
    [Fact]
    public async Task Local_greetings_and_queries_reduce_context_without_classifier_calls()
    {
        var owner = await TestClient.RegisterAsync(factory); await owner.CreateOrgAsync(); await owner.UpgradeAsync("BUSINESS");
        var options = factory.Services.GetRequiredService<IOptions<AiOptions>>().Value;
        var previous = options.PrimaryProvider;
        try
        {
            factory.Chat.Reset(); factory.Chat.Configured = true;
            await owner.Post("/api/v1/ai/ask", new { text = "Hello" });
            var baseline = factory.Chat.Requests.Last();
            options.PrimaryProvider = "local"; factory.Chat.ModelOverride = "qwen2.5:7b";
            factory.Chat.Requests.Clear(); factory.Chat.Classified.Clear();
            await owner.Post("/api/v1/ai/ask", new { text = "Hello" });
            Assert.Empty(factory.Chat.Requests); // simple greetings never wake the 7B runner
            var greetingReport = (await owner.Get("/api/v1/ai/tracker?model=builtin-greeting")).Data!;
            Assert.Equal(1, greetingReport["total"]!.GetValue<int>());
            await owner.Post("/api/v1/ai/ask", new { text = "What tasks are overdue?" });
            var lookup = factory.Chat.Requests.Last();
            Assert.Contains(lookup.Tools, t => t.Name == "find_work");
            Assert.True(lookup.Tools.Count < baseline.Tools.Count);
            Assert.Empty(factory.Chat.Classified);
            Console.WriteLine($"Payload baseline: system={baseline.System.Length} chars, tools={baseline.Tools.Count}; local greeting: zero inference; local lookup: tools={lookup.Tools.Count}");
        }
        finally { options.PrimaryProvider = previous; factory.Chat.ModelOverride = null; }
    }

    [Fact]
    public async Task Document_retrieval_checks_permissions_before_returning_content_and_bounds_chunks()
    {
        var owner = await TestClient.RegisterAsync(factory); await owner.CreateOrgAsync(); await owner.UpgradeAsync("BUSINESS");
        var other = await TestClient.RegisterAsync(factory); await other.CreateOrgAsync(); await other.UpgradeAsync("BUSINESS");
        var type = (await owner.Get("/api/v1/document-types")).Data!.AsArray()[0]!["id"]!.GetValue<string>();
        var created = await owner.Post("/api/v1/documents", new { title = "Private evidence", typeId = type });
        Assert.True(created.Ok, created.ToString());
        var id = created.Data!["item"]!["id"]!.GetValue<string>();
        var revision = created.Data["revision"]!.GetValue<int>();
        var section = created.Data["sections"]!.AsArray()[0]!["key"]!.GetValue<string>();
        var saved = await owner.Put($"/api/v1/documents/{id}/sections", new { revision, sections = new[] { new { key = section, content = JsonSerializer.Serialize(new { type = "doc", content = new[] { new { type = "paragraph", content = new[] { new { type = "text", text = "private-doc-marker " + new string('x', 5000) } } } } }) } } });
        Assert.True(saved.Ok, saved.ToString());
        factory.Chat.Reset(); factory.Chat.Configured = true;
        factory.Chat.Script.Enqueue(_ => FakeAiChat.UseTool("read_document", new { id }));
        factory.Chat.Script.Enqueue(_ => FakeAiChat.Say("Retrieved document"));
        await owner.Post("/api/v1/ai/ask", new { text = "Read the document" });
        var content = Assert.IsType<AiToolResult>(factory.Chat.Requests.Last().Turns.Last().Blocks.Single());
        Assert.Contains("private-doc-marker", content.Content);
        var data = System.Text.Json.Nodes.JsonNode.Parse(content.Content)!;
        Assert.True(data["text"]!.GetValue<string>().Length <= 4000); Assert.NotNull(data["next_offset"]);
        factory.Chat.Script.Enqueue(_ => FakeAiChat.UseTool("read_document", new { id }));
        factory.Chat.Script.Enqueue(_ => FakeAiChat.Say("Not available"));
        await other.Post("/api/v1/ai/ask", new { text = "Read the document" });
        var denied = Assert.IsType<AiToolResult>(factory.Chat.Requests.Last().Turns.Last().Blocks.Single());
        Assert.True(denied.IsError); Assert.DoesNotContain("private-doc-marker", denied.Content);
    }

    [Fact]
    public async Task Repeated_tool_calls_stop_and_are_recorded_as_failed_without_a_second_execution()
    {
        var owner = await TestClient.RegisterAsync(factory); await owner.CreateOrgAsync(); await owner.UpgradeAsync("BUSINESS");
        factory.Chat.Reset(); factory.Chat.Configured = true;
        factory.Chat.Script.Enqueue(_ => FakeAiChat.UseTool("my_work_summary", new { }));
        factory.Chat.Script.Enqueue(_ => FakeAiChat.UseTool("my_work_summary", new { }, id: "second"));
        await owner.Post("/api/v1/ai/ask", new { text = "Summarize my work" });
        var report = (await owner.Get("/api/v1/ai/tracker")).Data!;
        var trace = report["runs"]![0]!["trace"]!;
        Assert.Equal("AI_TOOL_LOOP", trace["errorCode"]!.GetValue<string>());
        Assert.Equal("failed", trace["outcome"]!.GetValue<string>());
        Assert.Single(trace["tools"]!.AsArray());
    }

    [Fact]
    public async Task Concurrent_confirmations_execute_once_even_when_optional_telemetry_is_corrupt()
    {
        var owner = await TestClient.RegisterAsync(factory); await owner.CreateOrgAsync(); await owner.UpgradeAsync("BUSINESS");
        factory.Chat.Reset(); factory.Chat.Configured = true;
        var project = await owner.CreateProjectAsync();
        var messageId = factory.WithDb(db =>
        {
            var conversation = new AiConversation { TenantId = owner.WorkspaceId, UserId = owner.UserId };
            var proposal = new AiProposal("action", "create_task", "Atomic task", "One task only", JsonSerializer.Serialize(new { projectId = project, title = "Atomic task", priority = "Medium" }));
            var message = new AiMessage { TenantId = owner.WorkspaceId, UserId = owner.UserId, ConversationId = conversation.Id, Role = "assistant", Content = "Proposal", ExecutionJson = "broken optional telemetry", ActionsJson = JsonSerializer.Serialize(new[] { proposal }, new JsonSerializerOptions(JsonSerializerDefaults.Web)) };
            db.AiConversations.Add(conversation); db.AiMessages.Add(message); db.SaveChanges(); return message.Id;
        });
        var responses = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => owner.Post($"/api/v1/ai/messages/{messageId}/actions/action/confirm")));
        Assert.Single(responses.Where(r => r.Ok));
        Assert.Equal("done", responses.Single(r => r.Ok).Data!["status"]!.GetValue<string>());
        Assert.All(responses.Where(r => !r.Ok), r => Assert.Equal(HttpStatusCode.Conflict, r.Status));
        Assert.Equal(1, factory.WithDb(db => db.Tasks.IgnoreQueryFilters().Count(t => t.ProjectId == project && t.Title == "Atomic task")));
    }

}

internal static class AgentTrackerResultAssertions
{
    public static void CheckStatus(this ApiResult result, HttpStatusCode status) => Assert.Equal(status, result.Status);
}
