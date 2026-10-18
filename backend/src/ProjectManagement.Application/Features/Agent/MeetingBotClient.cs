using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace ProjectManagement.Application.Features.Agent;

public class MeetingBotException(string message) : Exception(message);

/// <summary>
/// Our own meeting-bot service (apps/meetbot, "meetbot" HTTP client): send a bot into a Google Meet at a given time, have it stream the
/// meeting's captions to our webhook, post in the meeting chat, and ask how it is doing. Configured once per installation
/// (Agent:MeetingBotUrl + Agent:MeetingBotSecret); every workspace can use it.
/// </summary>
public class MeetingBotClient(IHttpClientFactory http, IOptions<AgentOptions> options, ILogger<MeetingBotClient> log)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public bool Configured => Uri.TryCreate(options.Value.MeetingBotUrl, UriKind.Absolute, out _) && (options.Value.MeetingBotSecret?.Length ?? 0) >= 16;
    private string Base => options.Value.MeetingBotUrl!.TrimEnd('/');

    /// <summary>Sends a bot. The agenda is posted after the hello; the caption language (Meet's own name for it, e.g. "Hindi") is set when Meet offers it.</summary>
    public async Task<string> CreateBotAsync(string meetingUrl, string botName, DateTime joinAtUtc, DateTime leaveAtUtc, string webhookUrl, string introMessage, CancellationToken ct,
        string? agendaMessage = null, string? captionLanguage = null)
    {
        var doc = await SendAsync(HttpMethod.Post, $"{Base}/bots", new
        {
            meetingUrl, botName, webhookUrl, introMessage, agendaMessage, captionLanguage,
            joinAt = joinAtUtc.ToString("yyyy-MM-ddTHH:mm:ssZ"), leaveAt = leaveAtUtc.ToString("yyyy-MM-ddTHH:mm:ssZ"),
        }, "send the bot", ct);
        return doc.ValueKind == JsonValueKind.Object && doc.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String && id.GetString() is { Length: > 0 } s
            ? s : throw new MeetingBotException("The meeting bot service did not return a bot.");
    }

    public async Task SendChatAsync(string botId, string message, CancellationToken ct) =>
        await SendAsync(HttpMethod.Post, $"{Base}/bots/{Uri.EscapeDataString(botId)}/chat", new { message }, "post in the meeting chat", ct);

    /// <summary>The bot's status: scheduled, joining, waiting_admission, in_call_recording, call_ended, done or fatal - "gone" when the service no
    /// longer knows it (it restarted, or forgot a finished bot).</summary>
    public async Task<string?> StatusAsync(string botId, CancellationToken ct)
    {
        try
        {
            var doc = await SendAsync(HttpMethod.Get, $"{Base}/bots/{Uri.EscapeDataString(botId)}", null, "read the bot", ct);
            return doc.ValueKind == JsonValueKind.Object && doc.TryGetProperty("status", out var st) && st.ValueKind == JsonValueKind.String ? st.GetString() : null;
        }
        catch (MeetingBotNotFoundException) { return "gone"; }
    }

    private sealed class MeetingBotNotFoundException(string message) : MeetingBotException(message);

    private async Task<JsonElement> SendAsync(HttpMethod method, string url, object? payload, string action, CancellationToken ct)
    {
        if (!Configured) throw new MeetingBotException("The meeting bot is not set up on this installation.");
        using var req = new HttpRequestMessage(method, url);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", options.Value.MeetingBotSecret);
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (payload is not null) req.Content = new StringContent(JsonSerializer.Serialize(payload, Json), Encoding.UTF8, "application/json");
        HttpResponseMessage response;
        try { response = await http.CreateClient("meetbot").SendAsync(req, ct); }
        catch (Exception ex) when (ex is HttpRequestException || ex is TaskCanceledException && !ct.IsCancellationRequested)
        {
            throw new MeetingBotException($"The meeting bot service could not be reached to {action}. It will be tried again.");
        }
        using var res = response;
        var text = await res.Content.ReadAsStringAsync(ct);
        if (res.StatusCode == HttpStatusCode.NotFound) throw new MeetingBotNotFoundException("The meeting bot service does not know this bot.");
        if (!res.IsSuccessStatusCode)
        {
            log.LogWarning("The meeting bot service could not {Action}: {Status}", action, (int)res.StatusCode);
            var reason = "";
            try { if (JsonDocument.Parse(text).RootElement.TryGetProperty("error", out var e) && e.ValueKind == JsonValueKind.String) reason = $": {e.GetString()}"; } catch (JsonException) { }
            throw new MeetingBotException($"The meeting bot service could not {action} ({(int)res.StatusCode}{reason}).");
        }
        if (string.IsNullOrWhiteSpace(text)) return default;
        try { return JsonDocument.Parse(text).RootElement.Clone(); }
        catch (JsonException) { return default; }
    }
}
