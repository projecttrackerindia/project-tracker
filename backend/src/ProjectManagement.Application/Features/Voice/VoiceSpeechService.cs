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

    /// <summary>Sarvam's error message, for the log (it never contains the key).</summary>
    private static string Short(string raw) => raw.Length > 300 ? raw[..300] : raw;

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
        var media = contentType.Split(';')[0].Trim().ToLowerInvariant();
        file.Headers.ContentType = new MediaTypeHeaderValue(media.StartsWith("audio/") ? media : "audio/wav");
        var ext = contentType.Contains("wav") ? "wav" : contentType.Contains("ogg") ? "ogg" : contentType.Contains("mp4") || contentType.Contains("m4a") ? "m4a" : "webm";
        form.Add(file, "file", "speech." + ext);
        form.Add(new StringContent("unknown"), "language_code");
        try
        {
            using var req = Request(HttpMethod.Post, "speech-to-text", form);
            using var res = await Client().SendAsync(req, ct);
            var raw = await res.Content.ReadAsStringAsync(ct);
            if (!res.IsSuccessStatusCode) { log.LogWarning("Sarvam speech-to-text answered {Status}: {Reason}", (int)res.StatusCode, Short(raw)); return null; }
            var j = JsonNode.Parse(raw);
            var text = j?["transcript"]?.ToString()?.Trim();
            if (string.IsNullOrEmpty(text)) return null;
            var lang = j?["language_code"]?.ToString() is { Length: >= 2 } code ? code[..2].ToLowerInvariant() : null;
            return (text, lang is not null && VoiceLanguages.Names.ContainsKey(lang) ? lang : null);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException) { log.LogWarning("Sarvam speech-to-text failed: {Reason}", e.Message); return null; }
    }

    /// <summary>
    /// The agent's line as one WAV per sentence, voiced in parallel: the reply is ready when its longest sentence is, not after all of them,
    /// and the browser plays them back to back.
    /// </summary>
    public async Task<IReadOnlyList<string>> SpeakPartsAsync(string text, string lang, CancellationToken ct)
    {
        if (!Configured || string.IsNullOrWhiteSpace(text)) return [];
        var parts = Sentences(text);
        var audios = await Task.WhenAll(parts.Select(p => SpeakAsync(p, lang, ct)));
        return audios.Where(a => !string.IsNullOrEmpty(a)).Select(a => a!).ToList();
    }

    /// <summary>Splits a reply at sentence ends (. ? ! । and line breaks) into at most four pieces; short sentences stay with their neighbour.</summary>
    public static List<string> Sentences(string text)
    {
        var raw = System.Text.RegularExpressions.Regex.Split(text.Trim(), @"(?<=[.?!।])\s+|\n+").Select(x => x.Trim()).Where(x => x.Length > 0).ToList();
        var merged = new List<string>();
        foreach (var piece in raw)
        {
            if (merged.Count > 0 && (merged[^1].Length < 25 || merged.Count >= 4)) merged[^1] += " " + piece;
            else merged.Add(piece);
        }
        return merged.Count == 0 ? [text.Trim()] : merged;
    }

    /// <summary>The agent's line as a base64 WAV, or null when speech is not set up or the call fails (the text is still shown).</summary>
    public async Task<string?> SpeakAsync(string text, string lang, CancellationToken ct)
    {
        if (!Configured || string.IsNullOrWhiteSpace(text)) return null;
        var o = options.Value;
        var v2 = o.SarvamTtsModel == "bulbul:v2";
        var max = v2 ? 1500 : 2500;
        var fields = new Dictionary<string, object>
        {
            ["text"] = text.Length > max ? text[..max] : text,
            ["language_code"] = Code(lang),
            ["model"] = o.SarvamTtsModel,
            ["speaker"] = o.SarvamSpeaker,
            ["speech_sample_rate"] = 22050,
            ["pace"] = Math.Clamp(o.SarvamPace, 0.5, 2.0),
        };
        if (v2) fields["enable_preprocessing"] = true;   // v3 and later normalise numbers and English words themselves and reject the flag
        var body = JsonSerializer.Serialize(fields);
        try
        {
            using var req = Request(HttpMethod.Post, "text-to-speech", new StringContent(body, System.Text.Encoding.UTF8, "application/json"));
            using var res = await Client().SendAsync(req, ct);
            var raw = await res.Content.ReadAsStringAsync(ct);
            if (!res.IsSuccessStatusCode) { log.LogWarning("Sarvam text-to-speech answered {Status}: {Reason}", (int)res.StatusCode, Short(raw)); return null; }
            var j = JsonNode.Parse(raw);
            var audios = j?["audios"] ?? j?["audio"];
            return audios is JsonArray a && a.Count > 0 ? a[0]?.ToString() : audios?.ToString();
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException) { log.LogWarning("Sarvam text-to-speech failed: {Reason}", e.Message); return null; }
    }
}
