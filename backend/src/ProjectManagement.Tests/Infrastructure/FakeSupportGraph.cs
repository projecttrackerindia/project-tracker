using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ProjectManagement.Tests.Infrastructure;

/// <summary>
/// Stands in for Meta's Graph API as used by teams' own WhatsApp support numbers: records the messages sent (text and templates) and serves
/// media (the lookup that gives a file address, then the file itself, both only with the bearer token).
/// </summary>
public sealed class FakeSupportGraph : HttpMessageHandler
{
    public record Sent(string PhoneNumberId, string To, string Type, string Text);
    public ConcurrentQueue<Sent> Sends { get; } = new();
    public ConcurrentDictionary<string, (byte[] Bytes, string Mime)> Media { get; } = new();

    private static HttpResponseMessage Json(object value, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(JsonSerializer.Serialize(value), Encoding.UTF8, "application/json") };

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var uri = request.RequestUri!;
        if (request.Headers.Authorization?.Scheme != "Bearer" || string.IsNullOrEmpty(request.Headers.Authorization.Parameter))
            return Json(new { error = new { message = "Missing token" } }, HttpStatusCode.Unauthorized);
        if (uri.Host == "lookaside.fbsbx.com")
        {
            var id = System.Web.HttpUtility.ParseQueryString(uri.Query)["mid"] ?? "";
            return Media.TryGetValue(id, out var f) ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(f.Bytes) } : new HttpResponseMessage(HttpStatusCode.NotFound);
        }
        if (uri.Host != "graph.facebook.com") throw new InvalidOperationException("Unexpected provider target: " + uri.Host);
        var parts = uri.AbsolutePath.Trim('/').Split('/');
        if (request.Method == HttpMethod.Post && parts.Length == 3 && parts[2] == "messages")
        {
            var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(ct))!;
            var type = body["type"]!.ToString();
            var text = type == "text" ? body["text"]!["body"]!.ToString()
                : $"{body["template"]!["name"]}:{string.Join(",", (body["template"]!["components"]![0]!["parameters"] as JsonArray ?? []).Select(p => p!["text"]!.ToString()))}";
            Sends.Enqueue(new(parts[1], body["to"]!.ToString(), type, text));
            return Json(new { messages = new[] { new { id = "wamid.out" + Guid.NewGuid().ToString("N")[..8] } } });
        }
        if (request.Method == HttpMethod.Get && parts.Length == 2 && Media.TryGetValue(parts[1], out var m))
            return Json(new { url = $"https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid={parts[1]}", mime_type = m.Mime, file_size = m.Bytes.Length, id = parts[1] });
        return Json(new { error = new { message = "Not found" } }, HttpStatusCode.NotFound);
    }
}
