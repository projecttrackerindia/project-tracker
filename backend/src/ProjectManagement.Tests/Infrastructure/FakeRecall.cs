using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;

namespace ProjectManagement.Tests.Infrastructure;

/// <summary>Stands in for Recall.ai's meeting-bot API (the "recall" HTTP client): bots are created, chat messages recorded, and a bot's status is whatever the test says.</summary>
public sealed class FakeRecall : HttpMessageHandler
{
    public ConcurrentQueue<(string Path, string Body, string? Authorization)> Requests { get; } = new();
    public ConcurrentQueue<string> Chat { get; } = new();
    /// <summary>The status code GET /bot/{id}/ reports.</summary>
    public string Status { get; set; } = "in_call_recording";

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var path = request.RequestUri!.AbsolutePath;
        var body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(ct);
        Requests.Enqueue((path, body, request.Headers.TryGetValues("Authorization", out var a) ? a.FirstOrDefault() : null));
        if (request.Method == HttpMethod.Post && path == "/api/v1/bot/") return Json(new { id = "bot-" + Guid.NewGuid().ToString("N")[..8] }, HttpStatusCode.Created);
        if (request.Method == HttpMethod.Post && path.EndsWith("/send_chat_message/", StringComparison.Ordinal))
        {
            using var doc = JsonDocument.Parse(body);
            Chat.Enqueue(doc.RootElement.GetProperty("message").GetString() ?? "");
            return Json(new { ok = true });
        }
        if (request.Method == HttpMethod.Get && path.StartsWith("/api/v1/bot/", StringComparison.Ordinal))
            return Json(new { id = path.Split('/', StringSplitOptions.RemoveEmptyEntries).Last(), status_changes = new[] { new { code = "joining_call" }, new { code = Status } } });
        return Json(new { error = "not found" }, HttpStatusCode.NotFound);
    }

    private static HttpResponseMessage Json(object value, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(JsonSerializer.Serialize(value), Encoding.UTF8, "application/json") };

    public void Reset() { Requests.Clear(); Chat.Clear(); Status = "in_call_recording"; }
}
