using System.Collections.Concurrent;
using System.Net;
using System.Runtime.CompilerServices;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Ai;

namespace ProjectManagement.Tests.Infrastructure;

/// <summary>
/// Stands in for Claude. Off by default (like an installation without a key); a test switches it on, says what it answers, and can read the
/// prompts it was given. Tests in the collection run one at a time, so the switch is safe; <see cref="Reset"/> puts it back.
/// </summary>
public sealed class FakeAiClient : IAiClient
{
    public bool Configured { get; set; }
    public string Model => "claude-test";
    public string? Provider => Configured ? "Claude (Anthropic)" : null;
    public string? Backup => null;
    public Func<string, string, string> Answer { get; set; } = (_, _) => "{}";
    public ConcurrentQueue<(string System, string User)> Prompts { get; } = new();

    public Task<AiAnswer> CompleteAsync(string system, string user, int maxTokens, CancellationToken ct)
    {
        Prompts.Enqueue((system, user));
        return Task.FromResult(new AiAnswer(Answer(system, user), Model));
    }

    public void Reset() { Configured = false; Answer = (_, _) => "{}"; Prompts.Clear(); }
}

/// <summary>
/// Stands in for Claude in the AI workspace. A test scripts the model's turns (what it says, which tool it calls), can read every request it
/// was sent (model, effort, system text, history, files) and can make it fail. Off until a test switches it on; <see cref="Reset"/> puts it back.
/// </summary>
public sealed class FakeAiChat : IAiChat
{
    public bool Configured { get; set; }
    public ConcurrentQueue<Func<AiChatRequest, IEnumerable<AiChatEvent>>> Script { get; } = new();
    public ConcurrentQueue<AiChatRequest> Requests { get; } = new();
    public ConcurrentQueue<string> Classified { get; } = new();
    /// <summary>What the small classifier model answers for a question.</summary>
    public Func<string, string> Classifier { get; set; } = _ => "standard";
    public Exception? Fail { get; set; }

    public async IAsyncEnumerable<AiChatEvent> StreamAsync(AiChatRequest request, [EnumeratorCancellation] CancellationToken ct)
    {
        Requests.Enqueue(request);
        if (Fail is { } f) throw f;
        var events = Script.TryDequeue(out var next) ? next(request) : Say("Fine.");
        foreach (var e in events) { await Task.Yield(); yield return e; }
    }

    /// <summary>What the small model writes when it is asked to summarize a conversation.</summary>
    public string Summary { get; set; } = "SUMMARY: they were looking at the Atlas project.";
    public ConcurrentQueue<string> Summarized { get; } = new();

    public Task<string> CompleteAsync(string model, string system, string user, int maxTokens, CancellationToken ct)
    {
        if (system.Contains("running memory")) { Summarized.Enqueue(user); return Task.FromResult(Summary); }
        Classified.Enqueue(user);
        return Task.FromResult(Classifier(user));
    }

    /// <summary>A finished turn of plain text, optionally with reasoning before it.</summary>
    public static IEnumerable<AiChatEvent> Say(string text, string? thinking = null, int cacheRead = 0, int cacheWrite = 0)
    {
        var blocks = new List<AiBlock>();
        if (thinking is not null) { yield return new AiThinkingDelta(thinking); blocks.Add(new AiThinking(thinking, "sig")); }
        yield return new AiTextDelta(text); blocks.Add(new AiText(text));
        yield return new AiTurnEnd(blocks, "end_turn", 200, 40, cacheRead, cacheWrite);
    }

    /// <summary>A turn the model declined to answer.</summary>
    public static IEnumerable<AiChatEvent> Refuse(string? writtenFirst = null)
    {
        var blocks = new List<AiBlock>();
        if (writtenFirst is not null) { yield return new AiTextDelta(writtenFirst); blocks.Add(new AiText(writtenFirst)); }
        yield return new AiTurnEnd(blocks, "refusal", 120, 5);
    }

    /// <summary>A turn that ends by calling a tool.</summary>
    public static IEnumerable<AiChatEvent> UseTool(string name, object input, string? text = null, string id = "toolu_1", string? thinking = null)
    {
        var blocks = new List<AiBlock>();
        if (thinking is not null) { yield return new AiThinkingDelta(thinking); blocks.Add(new AiThinking(thinking, "sig-tool")); }
        if (text is not null) { yield return new AiTextDelta(text); blocks.Add(new AiText(text)); }
        blocks.Add(new AiToolUse(id, name, System.Text.Json.JsonSerializer.Serialize(input)));
        yield return new AiTurnEnd(blocks, "tool_use", 150, 30);
    }

    public void Reset() { Configured = false; Summarized.Clear(); Script.Clear(); Requests.Clear(); Classified.Clear(); Classifier = _ => "standard"; Fail = null; }
}

/// <summary>Stands in for the push services (FCM, Mozilla, Apple): records each request and answers with the status a test chose.</summary>
public sealed class RecordingPushHandler : HttpMessageHandler
{
    public ConcurrentQueue<(Uri Url, Dictionary<string, string> Headers, byte[] Body)> Sent { get; } = new();
    public HttpStatusCode Status { get; set; } = HttpStatusCode.Created;

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var headers = request.Headers.Concat(request.Content?.Headers ?? Enumerable.Empty<KeyValuePair<string, IEnumerable<string>>>())
            .ToDictionary(h => h.Key, h => string.Join(",", h.Value), StringComparer.OrdinalIgnoreCase);
        Sent.Enqueue((request.RequestUri!, headers, request.Content is null ? [] : await request.Content.ReadAsByteArrayAsync(ct)));
        return new HttpResponseMessage(Status);
    }
}

/// <summary>Records what the app would broadcast to open screens.</summary>
public sealed class RecordingChangeFeed : IChangeFeed
{
    public ConcurrentQueue<ChangeEvent> Published { get; } = new();
    public void Publish(IReadOnlyList<ChangeEvent> changes) { foreach (var c in changes) Published.Enqueue(c); }
}

/// <summary>
/// A payment provider for tests that can behave like the simulated one (the default: everything succeeds at once) or like a hosted one such as Razorpay
/// (<see cref="Hosted"/> = true): the owner "pays in a window", and signatures are the real Razorpay HMACs under known secrets.
/// </summary>
public sealed class FakePayments : ProjectManagement.Application.Abstractions.IPaymentProvider
{
    public const string KeySecret = "test-key-secret", WebhookSecret = "test-webhook-secret";
    public bool Hosted { get; set; }
    public List<(string Id, bool AtCycleEnd)> Cancelled { get; } = [];
    public bool FailToStart { get; set; }
    public string Name => Hosted ? "razorpay" : "mock";
    public bool RequiresCheckout => Hosted;

    public Task<ProjectManagement.Application.Abstractions.PaymentResult> ChargeAsync(Guid tenantId, string planCode, decimal amount, string currency, CancellationToken ct = default) =>
        Task.FromResult(new ProjectManagement.Application.Abstractions.PaymentResult(true, $"mock_{Guid.NewGuid():N}"[..20], null));
    public Task<string> EnsurePlanAsync(string planCode, string name, decimal price, string currency, string? existingId, decimal? existingAmount, CancellationToken ct = default) =>
        Task.FromResult(existingId is not null && existingAmount == price ? existingId : $"plan_{planCode}_{price}");
    public Task<ProjectManagement.Application.Abstractions.HostedCheckout> StartSubscriptionAsync(Guid tenantId, string planCode, string planName, string providerPlanId, decimal price, string currency, CancellationToken ct = default)
    {
        if (FailToStart) throw new InvalidOperationException("Razorpay: the plan is not valid");
        return Task.FromResult(new ProjectManagement.Application.Abstractions.HostedCheckout("razorpay", "rzp_test_key", $"sub_{Guid.NewGuid():N}"[..20], "Project Tracker", $"{planName} plan, monthly", (long)(price * 100), currency));
    }
    public Task CancelSubscriptionAsync(string providerSubscriptionId, bool atCycleEnd, CancellationToken ct = default) { Cancelled.Add((providerSubscriptionId, atCycleEnd)); return Task.CompletedTask; }
    public bool VerifyCheckout(string paymentId, string subscriptionId, string signature) =>
        ProjectManagement.Infrastructure.Services.RazorpaySignature.Matches(ProjectManagement.Infrastructure.Services.RazorpaySignature.Hex(KeySecret, $"{paymentId}|{subscriptionId}"), signature);
    public bool VerifyWebhook(string body, string? signature) =>
        ProjectManagement.Infrastructure.Services.RazorpaySignature.Matches(ProjectManagement.Infrastructure.Services.RazorpaySignature.Hex(WebhookSecret, body), signature);

    public static string CheckoutSignature(string paymentId, string subscriptionId) => ProjectManagement.Infrastructure.Services.RazorpaySignature.Hex(KeySecret, $"{paymentId}|{subscriptionId}");
    public static string WebhookSignature(string body) => ProjectManagement.Infrastructure.Services.RazorpaySignature.Hex(WebhookSecret, body);
}
