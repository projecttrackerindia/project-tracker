using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Infrastructure.Services;

namespace ProjectManagement.Tests;

/// <summary>
/// The AI workspace's streamed, tool-using conversation on an OpenAI-compatible backend (Ollama, llama.cpp, Groq...) - the provider a
/// CPU-only deployment runs on - and its fallback behind <see cref="AiChatRouter"/>, which otherwise only ever asks Claude for this
/// conversation.
/// </summary>
public class AiBackupChatTests
{
    private static string S(JsonNode? n) => n!.GetValue<string>();

    private sealed class OneClient(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    /// <summary>Answers with a server-sent-events body built from whole "data: ..." lines, [DONE] added for you.</summary>
    private sealed class SseStub(params string[] dataLines) : HttpMessageHandler
    {
        public HttpRequestMessage? Request; public string? Body;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Request = request; Body = request.Content is null ? null : await request.Content.ReadAsStringAsync(ct);
            var sse = string.Concat(dataLines.Select(d => $"data: {d}\n\n")) + "data: [DONE]\n\n";
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(sse, Encoding.UTF8, "text/event-stream") };
        }
    }

    private sealed class FixedStub(HttpStatusCode status, string body) : HttpMessageHandler
    {
        public int Calls;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        { Calls++; return Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(body) }); }
    }

    private static AiOptions Options(string baseUrl) => new() { Fallback = new AiFallbackOptions { BaseUrl = baseUrl, Model = "qwen3:8b" } };

    private static OpenAiCompatibleChat Chat(HttpMessageHandler handler, AiOptions o)
    {
        var client = new OneClient(handler);
        var oneShot = new OpenAiCompatibleClient(client, Microsoft.Extensions.Options.Options.Create(o), NullLogger<OpenAiCompatibleClient>.Instance);
        return new OpenAiCompatibleChat(client, Microsoft.Extensions.Options.Options.Create(o), oneShot, NullLogger<OpenAiCompatibleChat>.Instance);
    }

    // The caller's chosen model deliberately differs from the Fallback's configured model (as it does for real: AiAgent picks a Claude
    // tier model like "claude-haiku-4-5" regardless of which provider ends up serving the request) - the request actually sent must use
    // this provider's own configured model, never the caller's.
    private static AiChatRequest Ask(string text, IReadOnlyList<AiToolDef>? tools = null) =>
        new("claude-haiku-4-5", "Be brief.", "Workspace: Atlas Inc.", [AiTurn.User(text)], tools ?? [], 500, null, false);

    [Fact]
    public async Task Streamed_text_arrives_as_deltas_and_the_turn_ends_with_what_was_said()
    {
        var stub = new SseStub(
            """{"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}""",
            """{"choices":[{"delta":{"content":" there"},"finish_reason":null}]}""",
            """{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":2}}""");
        var chat = Chat(stub, Options("http://localhost:11434/v1"));

        var events = new List<AiChatEvent>();
        await foreach (var e in chat.StreamAsync(Ask("Hi"), default)) events.Add(e);

        Assert.Equal(["Hello", " there"], events.OfType<AiTextDelta>().Select(d => d.Text));
        var end = Assert.Single(events.OfType<AiTurnEnd>());
        Assert.Equal("end_turn", end.StopReason);
        Assert.False(end.WantsTools);
        Assert.Equal(11, end.InputTokens);
        Assert.Equal(2, end.OutputTokens);
        var text = Assert.IsType<AiText>(Assert.Single(end.Assistant));
        Assert.Equal("Hello there", text.Text);

        // The request itself: streamed, the model from config, system+context combined into one system message, the plain question after it.
        var body = JsonNode.Parse(stub.Body!)!;
        Assert.True(body["stream"]!.GetValue<bool>());
        Assert.Equal("qwen3:8b", S(body["model"]));
        Assert.Contains("Be brief.", S(body["messages"]![0]!["content"]));
        Assert.Contains("Atlas Inc.", S(body["messages"]![0]!["content"]));
        Assert.Equal("Hi", S(body["messages"]![1]!["content"]));
    }

    [Fact]
    public async Task A_tool_call_streamed_across_several_chunks_is_reassembled_and_counts_as_wanting_tools()
    {
        var stub = new SseStub(
            """{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"list_projects","arguments":""}}]},"finish_reason":null}]}""",
            """{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"all_"}}]},"finish_reason":null}]}""",
            """{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"teams\":true}"}}]},"finish_reason":"tool_calls"}]}""");
        var chat = Chat(stub, Options("http://localhost:8080/v1"));

        var events = new List<AiChatEvent>();
        await foreach (var e in chat.StreamAsync(Ask("Which projects exist, everywhere?", [new AiToolDef("list_projects", "List projects.", """{"type":"object","properties":{}}""")]), default)) events.Add(e);

        var end = Assert.Single(events.OfType<AiTurnEnd>());
        Assert.Equal("tool_use", end.StopReason);
        Assert.True(end.WantsTools);
        var use = Assert.IsType<AiToolUse>(Assert.Single(end.Assistant));
        Assert.Equal("call_1", use.Id);
        Assert.Equal("list_projects", use.Name);
        Assert.Equal("""{"all_teams":true}""", use.InputJson);

        var body = JsonNode.Parse(stub.Body!)!;
        Assert.Equal("list_projects", S(body["tools"]![0]!["function"]!["name"]));
    }

    [Fact]
    public async Task A_past_tool_result_turn_becomes_a_tool_message_and_a_past_assistant_tool_call_is_sent_back()
    {
        var stub = new SseStub("""{"choices":[{"delta":{"content":"Three."},"finish_reason":"stop"}]}""");
        var chat = Chat(stub, Options("http://localhost:11434/v1"));
        var turns = new List<AiTurn>
        {
            AiTurn.User("How many overdue tasks?"),
            new("assistant", [new AiToolUse("call_9", "find_work", """{"overdue":true}""")]),
            new("user", [new AiToolResult("call_9", "3 overdue tasks.")]),
        };
        var req = new AiChatRequest("qwen3:8b", "Be brief.", "", turns, [], 500, null, false);

        await foreach (var _ in chat.StreamAsync(req, default)) { }

        var body = JsonNode.Parse(stub.Body!)!;
        var messages = body["messages"]!.AsArray();
        Assert.Equal("call_9", S(messages.First(m => S(m!["role"]) == "assistant")["tool_calls"]![0]!["id"]));
        var toolMsg = messages.First(m => S(m!["role"]) == "tool");
        Assert.Equal("call_9", S(toolMsg["tool_call_id"]));
        Assert.Equal("3 overdue tasks.", S(toolMsg["content"]));
    }

    [Fact]
    public async Task A_bad_or_unreachable_backend_is_reported_the_same_way_as_the_one_shot_client()
    {
        var bad = Chat(new FixedStub(HttpStatusCode.ServiceUnavailable, """{"error":{"message":"model is loading"}}"""), Options("http://localhost:11434/v1"));
        var ex = await Assert.ThrowsAsync<AiProviderException>(async () => { await foreach (var _ in bad.StreamAsync(Ask("Hi"), default)) { } });
        Assert.Contains("model is loading", ex.Detail);

        var off = Chat(new FixedStub(HttpStatusCode.OK, ""), new AiOptions());   // no Fallback:BaseUrl/Model set at all
        await Assert.ThrowsAsync<ConflictException>(async () => { await foreach (var _ in off.StreamAsync(Ask("Hi"), default)) { } });
    }

    [Fact]
    public void A_Google_address_is_not_configured_for_the_streamed_workspace_even_though_the_one_shot_client_speaks_it()
    {
        var o = new AiOptions { Fallback = new AiFallbackOptions { BaseUrl = "https://generativelanguage.googleapis.com/v1beta/openai/", Model = "gemini-flash-test" } };
        var client = new OneClient(new FixedStub(HttpStatusCode.OK, ""));
        var oneShot = new OpenAiCompatibleClient(client, Microsoft.Extensions.Options.Options.Create(o), NullLogger<OpenAiCompatibleClient>.Instance);
        Assert.True(oneShot.Configured);   // the one-shot sizing call still works against Gemini...
        var chat = new OpenAiCompatibleChat(client, Microsoft.Extensions.Options.Options.Create(o), oneShot, NullLogger<OpenAiCompatibleChat>.Instance);
        Assert.False(chat.Configured);     // ...but the streamed, tool-using workspace does not claim to speak Gemini's own API shape
    }

    [Fact]
    public async Task The_router_falls_back_to_the_other_provider_before_anything_has_reached_the_person()
    {
        var backupHandler = new SseStub("""{"choices":[{"delta":{"content":"Hello from the backup"},"finish_reason":"stop"}]}""");
        // AnthropicChat talks through the SDK's own HttpClient, which this test does not intercept, so a live Claude failure mid-stream
        // is not exercised here (that path is identical to the one-shot AiRouter's, which has its own coverage); this test is the
        // simpler, equally real case of no Anthropic key at all, where the router should go straight to the backup.
        var notConfigured = new AnthropicChat(Microsoft.Extensions.Options.Options.Create(new AiOptions()), NullLogger<AnthropicChat>.Instance);
        var backup = Chat(backupHandler, Options("http://localhost:11434/v1"));
        var router = new AiChatRouter(notConfigured, backup, NullLogger<AiChatRouter>.Instance);

        Assert.True(router.Configured);   // the backup alone is enough
        var events = new List<AiChatEvent>();
        await foreach (var e in router.StreamAsync(Ask("Hi"), default)) events.Add(e);
        Assert.Contains(events.OfType<AiTextDelta>(), d => d.Text == "Hello from the backup");
    }
}
