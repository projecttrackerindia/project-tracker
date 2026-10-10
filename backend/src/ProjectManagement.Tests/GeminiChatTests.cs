using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Infrastructure;
using ProjectManagement.Infrastructure.Services;
using StackExchange.Redis;

namespace ProjectManagement.Tests;

public class GeminiChatTests
{
    private static IOptions<AiOptions> Settings() => Options.Create(new AiOptions
    { PrimaryProvider = "gemini", Gemini = new() { Enabled = true, ApiKey = "test-only", ProjectId = Guid.NewGuid().ToString("N") } });
    private sealed class Admission(IOptions<AiOptions> options) : GeminiAdmission(options)
    {
        public int Calls;
        public override Task ReserveAsync(int inputEstimate, int maxOutput, CancellationToken ct)
        { ct.ThrowIfCancellationRequested(); Calls++; Assert.True(inputEstimate > 4096); Assert.InRange(maxOutput, 1, 1024); return Task.CompletedTask; }
    }
    private sealed class Stub(string[] events, HttpStatusCode status = HttpStatusCode.OK) : HttpMessageHandler, IHttpClientFactory
    {
        public int Calls;
        public string? Body, Url, Key;
        public HttpClient CreateClient(string name) => new(this, false);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls++; Body = await request.Content!.ReadAsStringAsync(ct); Url = request.RequestUri!.ToString();
            Key = request.Headers.GetValues("x-goog-api-key").Single();
            return new(status) { Content = new StringContent(string.Concat(events.Select(x => "data: " + x + "\n\n")), Encoding.UTF8, "text/event-stream") };
        }
    }
    private static AiChatRequest Ask(IReadOnlyList<AiTurn>? turns = null, IReadOnlyList<AiToolDef>? tools = null) =>
        new("ignored-caller-model", "Follow permission checks.", "Test workspace", turns ?? [AiTurn.User("show tasks")], tools ?? [], 500, null, false);
    private static async Task<List<AiChatEvent>> Collect(GeminiChat chat, AiChatRequest ask, CancellationToken ct = default)
    { var result = new List<AiChatEvent>(); await foreach (var e in chat.StreamAsync(ask, ct)) result.Add(e); return result; }

    private sealed class Hanging : HttpMessageHandler, IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(this, false);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        { await Task.Delay(Timeout.Infinite, ct); throw new InvalidOperationException("Unreachable after cancellation"); }
    }

    [Fact]
    public async Task Deadline_cancels_provider_and_reports_timeout_without_retry()
    {
        var o = Settings(); o.Value.Gemini.TimeoutSeconds = 1;
        var admission = new Admission(o);
        var error = await Assert.ThrowsAsync<AppException>(() => Collect(new(new Hanging(), o, admission), Ask()));
        Assert.Equal("AI_TIMEOUT", error.Code); Assert.Equal(1, admission.Calls);
    }

    [Fact]
    public async Task Prompt_safety_block_is_a_refusal_even_without_candidates()
    {
        var o = Settings(); var stub = new Stub(["""{"promptFeedback":{"blockReason":"SAFETY"},"candidates":[]}"""]);
        Assert.Equal("refusal", Assert.Single((await Collect(new(stub, o, new Admission(o)), Ask())).OfType<AiTurnEnd>()).StopReason);
    }

    [Fact]
    public async Task Streams_text_and_accounts_for_cached_input_and_thinking_without_exposing_thoughts()
    {
        var o = Settings(); var admission = new Admission(o);
        var stub = new Stub([
            """{"candidates":[{"content":{"parts":[{"text":"private thought","thought":true,"thoughtSignature":"opaque-a"}]}}]}""",
            """{"candidates":[{"content":{"parts":[{"text":"Hello","thoughtSignature":"opaque-b"}]}}]}""",
            """{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":100,"cachedContentTokenCount":20,"candidatesTokenCount":5,"thoughtsTokenCount":7}}"""]);
        var events = await Collect(new(stub, o, admission), Ask());
        Assert.Equal("Hello", Assert.Single(events.OfType<AiTextDelta>()).Text);
        Assert.Empty(events.OfType<AiThinkingDelta>());
        var end = Assert.Single(events.OfType<AiTurnEnd>());
        Assert.Equal(80, end.InputTokens); Assert.Equal(20, end.CacheReadTokens); Assert.Equal(12, end.OutputTokens);
        Assert.Equal("end_turn", end.StopReason); Assert.Equal("gemini-3.5-flash-lite", end.Model);
        Assert.Contains(":streamGenerateContent?alt=sse", stub.Url); Assert.DoesNotContain("test-only", stub.Url);
        Assert.Equal("test-only", stub.Key); Assert.Equal(1, admission.Calls); Assert.Equal(1, stub.Calls);
    }

    [Fact]
    public async Task Tool_round_replays_opaque_parts_and_signatures_unchanged_and_matches_response_ids()
    {
        var o = Settings(); var admission = new Admission(o);
        AiToolDef[] tools = [new("list_tasks", "List authorized tasks", """{"type":"object","properties":{}}""")];
        var stub = new Stub(["""{"candidates":[{"content":{"parts":[{"functionCall":{"id":"provider-1","name":"list_tasks","args":{}},"thoughtSignature":"keep-me"},{"text":"","thoughtSignature":"separate-signature"}]},"finishReason":"STOP"}]}"""]);
        var first = Assert.Single((await Collect(new(stub, o, admission), Ask(tools: tools))).OfType<AiTurnEnd>());
        Assert.True(first.WantsTools); Assert.Equal("provider-1", Assert.Single(first.Assistant.OfType<AiToolUse>()).Id);
        var next = new Stub(["""{"candidates":[{"content":{"parts":[{"text":"No tasks"}]},"finishReason":"STOP"}]}"""]);
        await Collect(new(next, o, admission), Ask([AiTurn.User("show tasks"), new("assistant", first.Assistant),
            new("user", [new AiToolResult("provider-1", "[]")])], tools));
        var body = JsonNode.Parse(next.Body!)!;
        var parts = body["contents"]![1]!["parts"]!.AsArray();
        Assert.Equal(2, parts.Count);
        Assert.Equal("keep-me", parts[0]!["thoughtSignature"]!.GetValue<string>());
        Assert.Equal("separate-signature", parts[1]!["thoughtSignature"]!.GetValue<string>());
        Assert.Equal("provider-1", body["contents"]![2]!["parts"]![0]!["functionResponse"]!["id"]!.GetValue<string>());
        Assert.NotNull(body["tools"]![0]!["functionDeclarations"]![0]!["parametersJsonSchema"]);
    }

    [Theory]
    [InlineData("{broken", "AI_MALFORMED_RESPONSE")]
    [InlineData("""{"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}""", "AI_INCOMPLETE_RESPONSE")]
    [InlineData("""{"candidates":[{"content":{"parts":[{"functionCall":{"name":"delete_everything","args":{}}}]},"finishReason":"STOP"}]}""", "AI_INVALID_TOOL_CALL")]
    [InlineData("""{"error":{"message":"private-provider-secret"}}""", "AI_PROVIDER_ERROR")]
    public async Task Invalid_or_partial_responses_fail_without_retry(string chunk, string code)
    {
        var o = Settings(); var stub = new Stub([chunk]);
        var error = await Assert.ThrowsAsync<AppException>(() => Collect(new(stub, o, new Admission(o)), Ask()));
        Assert.Equal(code, error.Code); Assert.DoesNotContain("private-provider-secret", error.Message); Assert.Equal(1, stub.Calls);
    }

    [Fact]
    public async Task Provider_429_has_retry_delay_and_is_not_replayed()
    {
        var o = Settings(); var stub = new Stub(["secret provider error"], HttpStatusCode.TooManyRequests);
        var error = await Assert.ThrowsAsync<AiRequestLimitException>(() => Collect(new(stub, o, new Admission(o)), Ask()));
        Assert.Equal("AI_PROVIDER_LIMIT", error.Code); Assert.Equal(60, error.RetryAfterSeconds); Assert.Equal(1, stub.Calls);
    }

    [Fact]
    public async Task Stored_key_does_not_enable_provider_and_missing_shared_store_refuses_calls()
    {
        var o = Settings(); var stub = new Stub([]);
        var error = await Assert.ThrowsAsync<AppException>(() => Collect(new(stub, o, new GeminiAdmission(o)), Ask()));
        Assert.Equal("AI_LIMIT_STORE_UNAVAILABLE", error.Code); Assert.Equal(0, stub.Calls);
        o.Value.Gemini.Enabled = false;
        Assert.False(new GeminiChat(stub, o, new Admission(o)).Configured);
    }

    [Fact]
    public async Task Cancelled_request_and_unsupported_media_never_dispatch()
    {
        var o = Settings(); var stub = new Stub([]); var chat = new GeminiChat(stub, o, new Admission(o));
        using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Collect(chat, Ask(), cancelled.Token));
        var error = await Assert.ThrowsAsync<AppException>(() => Collect(chat, Ask([new("user", [new AiImage("image/png", [])])])));
        Assert.Equal("AI_ATTACHMENT_UNSUPPORTED", error.Code); Assert.Equal(0, stub.Calls);
    }

    [Fact]
    public void Railway_alias_binds_only_to_backend_key_and_keeps_local_provider_default()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        { ["AI_gemini_apikey"] = "test-only", ["Database:Provider"] = "Sqlite", ["ConnectionStrings:Default"] = "Data Source=:memory:" }).Build();
        var services = new ServiceCollection(); services.AddLogging(); services.AddInfrastructure(config);
        using var provider = services.BuildServiceProvider(); var o = provider.GetRequiredService<IOptions<AiOptions>>().Value;
        Assert.Equal("test-only", o.Gemini.ApiKey); Assert.False(o.UsesGemini); Assert.Equal("local", o.PrimaryProvider);
    }

    [RedisFact]
    public async Task Shared_provider_admission_counts_all_instances_and_retains_pilot_reservations()
    {
        var o = Settings(); o.Value.Gemini.RequestsPerMinute = 5;
        using var redis = await ConnectionMultiplexer.ConnectAsync(Environment.GetEnvironmentVariable("PM_TEST_REDIS")!);
        var one = new GeminiAdmission(o, redis); var two = new GeminiAdmission(o, redis);
        var key = $"pm:gemini:{{{o.Value.Gemini.ProjectId}}}:pilot:v1";
        try
        {
            var admitted = await Task.WhenAll(Enumerable.Range(0, 100).Select(async i =>
            {
                try { await (i % 2 == 0 ? one : two).ReserveAsync(100, 500, default); return true; }
                catch (AiRequestLimitException ex) { Assert.Equal("AI_PROVIDER_LIMIT", ex.Code); return false; }
            }));
            Assert.Equal(5, admitted.Count(x => x));
            Assert.Equal("2500", (await redis.GetDatabase().HashGetAsync(key, "pilotOut")).ToString());
            o.Value.Gemini.RequestsPerMinute = 1000; o.Value.Gemini.PilotOutputTokenAllowance = 2500;
            Assert.Equal("AI_PILOT_BUDGET", (await Assert.ThrowsAsync<AiRequestLimitException>(() => one.ReserveAsync(100, 500, default))).Code);
        }
        finally { await redis.GetDatabase().KeyDeleteAsync(key); }
    }
}
