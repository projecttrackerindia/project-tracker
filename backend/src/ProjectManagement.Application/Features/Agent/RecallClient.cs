using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace ProjectManagement.Application.Features.Agent;

public class RecallApiException(string message) : Exception(message);

/// <summary>
/// Recall.ai's meeting-bot API ("recall" HTTP client): send a bot into a Google Meet at a given time with real-time transcription delivered to
/// our webhook, post in the meeting chat, and ask how the bot is doing. The workspace's own API key is used for every call.
/// </summary>
public class RecallClient(IHttpClientFactory http, IOptions<AgentOptions> options, ILogger<RecallClient> log)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private string Base(string region) => options.Value.RecallBaseUrl.Replace("{region}", region).TrimEnd('/');

    public async Task<string> CreateBotAsync(string apiKey, string region, string meetingUrl, string botName, DateTime joinAtUtc, string webhookUrl, string introMessage, CancellationToken ct)
    {
        var body = new Dictionary<string, object?>
        {
            ["meeting_url"] = meetingUrl,
            ["bot_name"] = botName,
            ["join_at"] = joinAtUtc > DateTime.UtcNow.AddMinutes(1) ? joinAtUtc.ToString("yyyy-MM-ddTHH:mm:ssZ") : null,
            ["recording_config"] = new Dictionary<string, object?>
            {
                ["transcript"] = new { provider = new { recallai_streaming = new { mode = "prioritize_low_latency", language_code = "en" } } },
                ["realtime_endpoints"] = new[] { new { type = "webhook", url = webhookUrl, events = new[] { "transcript.data" } } },
            },
            ["chat"] = new { on_bot_join = new { send_to = "everyone", message = introMessage } },
        };
        var doc = await SendAsync(HttpMethod.Post, $"{Base(region)}/api/v1/bot/", apiKey, body, "create the bot", ct);
        return doc.ValueKind == JsonValueKind.Object && doc.TryGetProperty("id", out var id) && id.GetString() is { Length: > 0 } s ? s : throw new RecallApiException("The meeting bot service did not return a bot.");
    }

    public async Task SendChatAsync(string apiKey, string region, string botId, string message, CancellationToken ct) =>
        await SendAsync(HttpMethod.Post, $"{Base(region)}/api/v1/bot/{Uri.EscapeDataString(botId)}/send_chat_message/", apiKey, new { to = "everyone", message }, "post in the meeting chat", ct);

    /// <summary>The bot's latest status code ("joining_call", "in_call_recording", "call_ended", "done", "fatal" ...), or null when unknown.</summary>
    public async Task<string?> StatusAsync(string apiKey, string region, string botId, CancellationToken ct)
    {
        var doc = await SendAsync(HttpMethod.Get, $"{Base(region)}/api/v1/bot/{Uri.EscapeDataString(botId)}/", apiKey, null, "read the bot", ct);
        if (doc.ValueKind != JsonValueKind.Object) return null;
        if (doc.TryGetProperty("status", out var st) && st.ValueKind == JsonValueKind.Object && st.TryGetProperty("code", out var c)) return c.GetString();
        if (doc.TryGetProperty("status_changes", out var changes) && changes.ValueKind == JsonValueKind.Array && changes.GetArrayLength() > 0
            && changes[changes.GetArrayLength() - 1].TryGetProperty("code", out var last)) return last.GetString();
        return null;
    }

    private async Task<JsonElement> SendAsync(HttpMethod method, string url, string apiKey, object? payload, string action, CancellationToken ct)
    {
        // Recall's documentation shows the bare key in the Authorization header; older keys expect "Token <key>", tried once on a 401.
        var key = apiKey.StartsWith("Token ", StringComparison.Ordinal) ? apiKey[6..] : apiKey;
        foreach (var header in new[] { key, $"Token {key}" })
        {
            using var req = new HttpRequestMessage(method, url);
            req.Headers.TryAddWithoutValidation("Authorization", header);
            req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            if (payload is not null) req.Content = new StringContent(JsonSerializer.Serialize(payload, Json), Encoding.UTF8, "application/json");
            using var res = await http.CreateClient("recall").SendAsync(req, ct);
            if (res.StatusCode == System.Net.HttpStatusCode.Unauthorized && header == key) continue;
            var text = await res.Content.ReadAsStringAsync(ct);
            if (!res.IsSuccessStatusCode)
            {
                log.LogWarning("Recall.ai could not {Action}: {Status}", action, (int)res.StatusCode);
                throw new RecallApiException($"The meeting bot service could not {action} ({(int)res.StatusCode}). Check the bot's API key and region.");
            }
            if (string.IsNullOrWhiteSpace(text)) return default;
            try { return JsonDocument.Parse(text).RootElement.Clone(); }
            catch (JsonException) { return default; }
        }
        throw new RecallApiException($"The meeting bot service refused the API key while trying to {action}. Check the key in Settings.");
    }
}
