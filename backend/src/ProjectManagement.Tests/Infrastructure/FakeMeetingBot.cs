using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;

namespace ProjectManagement.Tests.Infrastructure;

/// <summary>Stands in for our own meeting-bot service (apps/meetbot, the "meetbot" HTTP client): bots are created, chat messages recorded, and a bot's status is whatever the test says.</summary>
public sealed class FakeMeetingBot : HttpMessageHandler
{
    public ConcurrentQueue<(string Path, string Body, string? Authorization)> Requests { get; } = new();
    public ConcurrentQueue<string> Chat { get; } = new();
    /// <summary>The status GET /bots/{id} reports.</summary>
    public string Status { get; set; } = "in_call_recording";

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var path = request.RequestUri!.AbsolutePath;
        var body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(ct);
        var auth = request.Headers.Authorization?.ToString();
        Requests.Enqueue((path, body, auth));
        if (auth != "Bearer test-meetbot-secret-0123") return Json(new { error = "unauthorized" }, HttpStatusCode.Unauthorized);
        if (request.Method == HttpMethod.Post && path == "/bots") return Json(new { id = Guid.NewGuid().ToString(), status = "scheduled" }, HttpStatusCode.Created);
        if (request.Method == HttpMethod.Post && path.EndsWith("/chat", StringComparison.Ordinal))
        {
            using var doc = JsonDocument.Parse(body);
            Chat.Enqueue(doc.RootElement.GetProperty("message").GetString() ?? "");
            return Json(new { queued = true }, HttpStatusCode.Accepted);
        }
        if (request.Method == HttpMethod.Get && path.StartsWith("/bots/", StringComparison.Ordinal))
            return Json(new { id = path.Split('/', StringSplitOptions.RemoveEmptyEntries).Last(), status = Status });
        return Json(new { error = "not found" }, HttpStatusCode.NotFound);
    }

    private static HttpResponseMessage Json(object value, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(JsonSerializer.Serialize(value), Encoding.UTF8, "application/json") };

    public void Reset() { Requests.Clear(); Chat.Clear(); Status = "in_call_recording"; }
}
