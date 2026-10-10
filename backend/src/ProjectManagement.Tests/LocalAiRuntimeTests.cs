using System.Net;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Infrastructure.Services;

namespace ProjectManagement.Tests;

public sealed class LocalAiRuntimeTests
{
    private sealed class Handler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> respond) : HttpMessageHandler
    {
        public int Calls;
        public string? Body;
        public Uri? Url;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        { Calls++; Url = request.RequestUri; Body = await request.Content!.ReadAsStringAsync(ct); return await respond(request, ct); }
    }
    private sealed class Factory(HttpMessageHandler handler) : IHttpClientFactory
    { public HttpClient CreateClient(string name) => new(handler, false); }
    private static AiOptions Settings() => new() { AnthropicApiKey = "unused-test-key", Fallback = new() { BaseUrl = "http://ollama:11434/v1", Model = "qwen2.5:7b", Wire = "ollama" } };
    private static OpenAiCompatibleClient Client(Handler h, AiOptions o) => new(new Factory(h), Options.Create(o), NullLogger<OpenAiCompatibleClient>.Instance);
    private static OpenAiCompatibleChat Chat(Handler h, AiOptions o) => new(new Factory(h), Options.Create(o), Client(h, o), NullLogger<OpenAiCompatibleChat>.Instance);
    private static AiChatRequest Ask() => new("claude-opus-5-5", "Be concise.", "", [AiTurn.User("Hello")], [], 16000, "high", true);
    private static async Task<List<AiChatEvent>> Read(IAiChat chat, AiChatRequest? request = null, CancellationToken ct = default)
    { var events = new List<AiChatEvent>(); await foreach (var e in chat.StreamAsync(request ?? Ask(), ct)) events.Add(e); return events; }
    private static HttpResponseMessage Answer(string body) => new(HttpStatusCode.OK) { Content = new StringContent(body) };

    [Fact]
    public async Task A_key_alone_cannot_select_or_charge_Anthropic_in_either_router()
    {
        var o = Settings();
        var local = new Handler((_, _) => Task.FromResult(Answer("""{"message":{"content":"Hello"},"done":true}""")));
        var paid = new Handler((_, _) => throw new InvalidOperationException("Paid provider must not be invoked"));
        var router = new AiRouter(new AnthropicClient(new Factory(paid), Options.Create(o), NullLogger<AnthropicClient>.Instance), Client(local, o), NullLogger<AiRouter>.Instance);
        Assert.Equal("qwen2.5:7b", router.Model);
        Assert.Equal("qwen2.5:7b", (await router.CompleteAsync("Be brief", "Hello", 50, default)).Model);
        var streamed = new AiChatRouter(new AnthropicChat(Options.Create(o), NullLogger<AnthropicChat>.Instance), Chat(local, o), NullLogger<AiChatRouter>.Instance);
        await Read(streamed);
        Assert.Equal("qwen2.5:7b", streamed.ModelFor("claude-haiku-4-5"));
        Assert.Equal(0, paid.Calls);
        Assert.Equal(2, local.Calls);
    }

    [Fact]
    public void Without_a_local_model_an_Anthropic_key_does_not_enable_the_assistant()
    {
        var o = new AiOptions { AnthropicApiKey = "unused" };
        var h = new Handler((_, _) => throw new Exception());
        Assert.False(new AiRouter(new AnthropicClient(new Factory(h), Options.Create(o), NullLogger<AnthropicClient>.Instance), Client(h, o), NullLogger<AiRouter>.Instance).Configured);
        Assert.False(new AiChatRouter(new AnthropicChat(Options.Create(o), NullLogger<AnthropicChat>.Instance), Chat(h, o), NullLogger<AiChatRouter>.Instance).Configured);
    }

    [Fact]
    public async Task Native_one_shot_and_streamed_requests_use_the_same_model_limits_and_cpu_settings()
    {
        var o = Settings(); o.AnthropicApiKey = null; o.Fallback.NumCtx = 8192; o.Fallback.NumThread = 2; o.Fallback.MaxOutputTokens = 256;
        var h = new Handler((_, _) => Task.FromResult(Answer("""{"message":{"content":"Hello"},"done":true,"eval_count":2,"prompt_eval_count":12}""")));
        await Client(h, o).CompleteAsync("Brief", "Hello", 9999, default);
        Assert.EndsWith("/api/chat", h.Url!.ToString());
        var body = JsonNode.Parse(h.Body!)!;
        Assert.False(body["stream"]!.GetValue<bool>());
        Assert.Equal(256, body["options"]!["num_predict"]!.GetValue<int>());
        var events = await Read(Chat(h, o));
        body = JsonNode.Parse(h.Body!)!;
        Assert.Equal(256, body["options"]!["num_predict"]!.GetValue<int>());
        Assert.Equal(2, body["options"]!["num_thread"]!.GetValue<int>());
        Assert.Equal(8192, body["options"]!["num_ctx"]!.GetValue<int>());
        Assert.Equal("10m", body["keep_alive"]!.GetValue<string>());
        Assert.Equal(12, Assert.Single(events.OfType<AiTurnEnd>()).InputTokens);
    }

    [Theory]
    [InlineData("{\"message\":{\"content\":\"Partial\"},\"done\":false}\n", "AI_INCOMPLETE_RESPONSE")]
    [InlineData("broken-json\n", "AI_MALFORMED_RESPONSE")]
    [InlineData("{\"error\":\"sensitive details\"}\n", "AI_MODEL_ERROR")]
    public async Task Broken_streams_are_failures_not_successful_answers(string body, string code)
    {
        var h = new Handler((_, _) => Task.FromResult(Answer(body)));
        var error = await Assert.ThrowsAsync<AppException>(() => Read(Chat(h, Settings())));
        Assert.Equal(code, error.Code);
        Assert.DoesNotContain("sensitive", error.Message);
    }

    [Fact]
    public async Task Context_overflow_fails_before_sending_and_releases_capacity()
    {
        var o = Settings(); o.Fallback.MaxPromptChars = 300;
        var h = new Handler((_, _) => Task.FromResult(Answer("""{"message":{"content":"Hi"},"done":true}""")));
        var chat = Chat(h, o);
        var error = await Assert.ThrowsAsync<AppException>(() => Read(chat, Ask() with { Context = new string('x', 500) }));
        Assert.Equal("AI_CONTEXT_OVERFLOW", error.Code); Assert.Equal(0, h.Calls);
        o.Fallback.MaxPromptChars = 1000;
        await Read(chat); Assert.Equal(1, h.Calls);
    }

    [Fact]
    public async Task Inference_deadlines_and_user_cancellation_have_distinct_outcomes()
    {
        var o = Settings(); o.Fallback.TimeoutSeconds = 1;
        var h = new Handler(async (_, ct) => { await Task.Delay(10000, ct); return Answer(""); });
        Assert.Equal("AI_TIMEOUT", (await Assert.ThrowsAsync<AppException>(() => Read(Chat(h, o)))).Code);
        using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Read(Chat(h, o), ct: cancelled.Token));
    }

    [Fact]
    public async Task Capacity_is_bounded_and_cancelled_waiters_release_the_queue()
    {
        var o = Settings(); o.Fallback.MaxQueuedRequests = 1;
        using var gate = new AiInferenceGate(Options.Create(o));
        using var active = await gate.EnterAsync(default);
        using var cancelled = new CancellationTokenSource();
        var waiting = gate.EnterAsync(cancelled.Token);
        Assert.Equal(1, gate.QueueDepth);
        Assert.Equal("AI_BUSY", (await Assert.ThrowsAsync<AppException>(() => gate.EnterAsync(default))).Code);
        cancelled.Cancel(); await Assert.ThrowsAnyAsync<OperationCanceledException>(() => waiting);
        Assert.Equal(0, gate.QueueDepth);
        active.Dispose(); using var next = await gate.EnterAsync(default);
    }
    [Fact]
    public async Task Native_runtime_metrics_preserve_load_prompt_generation_and_cache_evidence()
    {
        var h = new Handler((_, _) => Task.FromResult(Answer("""{"message":{"content":"Hi"},"done":true,"load_duration":60000000000,"prompt_eval_duration":250000000,"eval_duration":750000000,"total_duration":61000000000,"prompt_eval_cached_count":37}""")));
        var end = Assert.Single((await Read(Chat(h, Settings()))).OfType<AiTurnEnd>());
        Assert.Equal(60000, end.Runtime!.LoadMs); Assert.Equal(250, end.Runtime.PromptEvalMs);
        Assert.Equal(750, end.Runtime.GenerationMs); Assert.Equal(61000, end.Runtime.TotalMs); Assert.Equal(37, end.Runtime.CachedPromptTokens);
    }

}
