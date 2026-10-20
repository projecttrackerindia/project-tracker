using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace ProjectManagement.Application.Features.Voice;

/// <summary>
/// Speech for the voice agent through Sarvam AI (Indian languages): speech-to-text for what the caller says, text-to-speech for the agent's answer.
/// The key lives only in the server's configuration (Voice__SarvamApiKey) and is never sent to the browser.
/// </summary>
public class VoiceSpeechService(IOptions<VoiceOptions> options, IHttpClientFactory http, ILogger<VoiceSpeechService> log)
{
    public bool Configured => !string.IsNullOrWhiteSpace(options.Value.SarvamApiKey);

    /// <summary>"te" -> "te-IN", the BCP-47 code Sarvam expects.</summary>
    public static string Code(string lang) => lang is { Length: 2 } ? lang + "-IN" : "en-IN";

    private HttpClient Client() => http.CreateClient("voice-speech");

    private HttpRequestMessage Request(HttpMethod m, string path, HttpContent body)
    {
        var o = options.Value;
        var req = new HttpRequestMessage(m, new Uri(new Uri(o.SarvamBaseUrl.TrimEnd('/') + "/"), path)) { Content = body };
        req.Headers.TryAddWithoutValidation("api-subscription-key", o.SarvamApiKey);
        return req;
    }

    /// <summary>What the caller said, and the language Sarvam heard it in (two-letter code). Null when nothing was understood.</summary>
    public async Task<(string Text, string? Language)?> TranscribeAsync(byte[] audio, string contentType, CancellationToken ct)
    {
        if (!Configured) return null;
        using var form = new MultipartFormDataContent();
        var file = new ByteArrayContent(audio);
        file.Headers.ContentType = MediaTypeHeaderValue.TryParse(contentType, out var ctype) ? ctype : new MediaTypeHeaderValue("audio/webm");
        var ext = contentType.Contains("wav") ? "wav" : contentType.Contains("ogg") ? "ogg" : contentType.Contains("mp4") || contentType.Contains("m4a") ? "m4a" : "webm";
        form.Add(file, "file", "speech." + ext);
        form.Add(new StringContent("unknown"), "language_code");
        try
        {
            using var req = Request(HttpMethod.Post, "speech-to-text", form);
            using var res = await Client().SendAsync(req, ct);
            var raw = await res.Content.ReadAsStringAsync(ct);
            if (!res.IsSuccessStatusCode) { log.LogWarning("Sarvam speech-to-text answered {Status}", (int)res.StatusCode); return null; }
            var j = JsonNode.Parse(raw);
            var text = j?["transcript"]?.ToString()?.Trim();
            if (string.IsNullOrEmpty(text)) return null;
            var lang = j?["language_code"]?.ToString() is { Length: >= 2 } code ? code[..2].ToLowerInvariant() : null;
            return (text, lang is not null && VoiceLanguages.Names.ContainsKey(lang) ? lang : null);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException) { log.LogWarning("Sarvam speech-to-text failed: {Reason}", e.Message); return null; }
    }

    /// <summary>The agent's line as a base64 WAV, or null when speech is not set up or the call fails (the text is still shown).</summary>
    public async Task<string?> SpeakAsync(string text, string lang, CancellationToken ct)
    {
        if (!Configured || string.IsNullOrWhiteSpace(text)) return null;
        var o = options.Value;
        var body = JsonSerializer.Serialize(new Dictionary<string, object>
        {
            ["text"] = text.Length > 1500 ? text[..1500] : text,
            ["target_language_code"] = Code(lang),
            ["model"] = o.SarvamTtsModel,
            ["speaker"] = o.SarvamSpeaker,
            ["speech_sample_rate"] = 22050,
            ["enable_preprocessing"] = true,
        });
        try
        {
            using var req = Request(HttpMethod.Post, "text-to-speech", new StringContent(body, System.Text.Encoding.UTF8, "application/json"));
            using var res = await Client().SendAsync(req, ct);
            var raw = await res.Content.ReadAsStringAsync(ct);
            if (!res.IsSuccessStatusCode) { log.LogWarning("Sarvam text-to-speech answered {Status}", (int)res.StatusCode); return null; }
            var j = JsonNode.Parse(raw);
            var audios = j?["audios"] ?? j?["audio"];
            return audios is JsonArray a && a.Count > 0 ? a[0]?.ToString() : audios?.ToString();
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException) { log.LogWarning("Sarvam text-to-speech failed: {Reason}", e.Message); return null; }
    }
}
