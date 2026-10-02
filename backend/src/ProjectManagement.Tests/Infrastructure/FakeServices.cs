using System.Collections.Concurrent;
using System.Net;
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
