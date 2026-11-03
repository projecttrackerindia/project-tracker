using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Voice;
using ProjectManagement.Application.Features.Work;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Desk;

// ---------------------------------------------------------------------- provider interfaces

/// <summary>What a caller said and the language it was heard in (two-letter code, when known).</summary>
public record SpeechText(string Text, string? Language);

/// <summary>Speech-to-text, text-to-speech and translation for the voice agent. One adapter per provider (Sarvam AI today).</summary>
public interface ISpeechProvider
{
    string Name { get; }
    Task<bool> ConfiguredAsync(CancellationToken ct);
    Task<SpeechText?> TranscribeAsync(byte[] audio, string contentType, CancellationToken ct);
    /// <summary>Base64 WAV, or null when speech is not available (the text is still shown).</summary>
    Task<string?> SynthesizeAsync(string text, string language, CancellationToken ct);
    /// <summary>The text in the target language, or null when it could not be translated.</summary>
    Task<string?> TranslateAsync(string text, string from, string to, CancellationToken ct);
}

public record TelephonyCall(string ProviderCallId, string Status);

/// <summary>Places and receives phone calls (Exotel, Plivo, Twilio …). Real calls need a provider account, a number and media streaming.</summary>
public interface ITelephonyProvider
{
    string Name { get; }
    bool Configured { get; }
    Task<TelephonyCall> PlaceCallAsync(string toNumber, Guid sessionId, CancellationToken ct);
}

/// <summary>No telephony provider is connected: calls are never pretended, the person is told what is needed.</summary>
public sealed class NotConfiguredTelephony : ITelephonyProvider
{
    public string Name => "none";
    public bool Configured => false;
    public Task<TelephonyCall> PlaceCallAsync(string toNumber, Guid sessionId, CancellationToken ct) =>
        throw new ConflictException("Phone calls are not set up yet: connect a telephony provider (Exotel, Plivo or Twilio) with a number and media streaming in Desk › Integrations. " +
            "Until then use voice intake in the browser, or call the customer yourself.", "TELEPHONY_NOT_CONFIGURED");
}

/// <summary>
/// Sarvam AI (Indian languages): speech-to-text, text-to-speech and translation. The key is the workspace's own (Desk › Integrations, stored
/// encrypted) or, without one, the server's (Voice__SarvamApiKey). It is sent only to Sarvam, never to the browser.
/// </summary>
public class SarvamSpeechProvider(IAppDbContext db, ISecretProtector secrets, IOptions<VoiceOptions> options, IHttpClientFactory http, ILogger<SarvamSpeechProvider> log) : ISpeechProvider
{
    public string Name => "sarvam";
    private string? key;
    private bool loaded;

    private async Task<string?> KeyAsync(CancellationToken ct)
    {
        if (loaded) return key;
        loaded = true;
        var own = await db.DeskSettings.AsNoTracking().Select(s => s.SarvamApiKeyProtected).FirstOrDefaultAsync(ct);
        key = own is { Length: > 0 } ? secrets.Unprotect(own) : string.IsNullOrWhiteSpace(options.Value.SarvamApiKey) ? null : options.Value.SarvamApiKey;
        return key;
    }

    public async Task<bool> ConfiguredAsync(CancellationToken ct) => await KeyAsync(ct) is not null;

    private async Task<HttpResponseMessage?> SendAsync(string path, HttpContent body, CancellationToken ct)
    {
        if (await KeyAsync(ct) is not { } k) return null;
        var req = new HttpRequestMessage(HttpMethod.Post, new Uri(new Uri(options.Value.SarvamBaseUrl.TrimEnd('/') + "/"), path)) { Content = body };
        req.Headers.TryAddWithoutValidation("api-subscription-key", k);
        try { return await http.CreateClient("voice-speech").SendAsync(req, ct); }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException) { log.LogWarning("Sarvam {Path} could not be reached ({Kind})", path, e.GetType().Name); return null; }
        finally { req.Dispose(); }
    }

    private async Task<JsonNode?> JsonAsync(HttpResponseMessage? res, string what, CancellationToken ct)
    {
        if (res is null) return null;
        using (res)
        {
            var raw = await res.Content.ReadAsStringAsync(ct);
            if (!res.IsSuccessStatusCode) { log.LogWarning("Sarvam {What} answered {Status}", what, (int)res.StatusCode); return null; }
            try { return JsonNode.Parse(raw); } catch (JsonException) { return null; }
        }
    }

    public async Task<SpeechText?> TranscribeAsync(byte[] audio, string contentType, CancellationToken ct)
    {
        using var form = new MultipartFormDataContent();
        var file = new ByteArrayContent(audio);
        var media = contentType.Split(';')[0].Trim().ToLowerInvariant();
        file.Headers.ContentType = new MediaTypeHeaderValue(media.StartsWith("audio/") ? media : "audio/wav");
        var ext = media.Contains("wav") ? "wav" : media.Contains("ogg") ? "ogg" : media.Contains("mp4") || media.Contains("m4a") ? "m4a" : media.Contains("mpeg") ? "mp3" : "webm";
        form.Add(file, "file", "speech." + ext);
        form.Add(new StringContent("unknown"), "language_code");
        var j = await JsonAsync(await SendAsync("speech-to-text", form, ct), "speech-to-text", ct);
        var text = j?["transcript"]?.ToString()?.Trim();
        if (string.IsNullOrEmpty(text)) return null;
        var lang = j?["language_code"]?.ToString() is { Length: >= 2 } code ? code[..2].ToLowerInvariant() : null;
        return new(text, lang is not null && VoiceLanguages.Names.ContainsKey(lang) ? lang : null);
    }

    public async Task<string?> SynthesizeAsync(string text, string language, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var o = options.Value;
        var fields = new Dictionary<string, object>
        {
            ["text"] = text.Length > 1500 ? text[..1500] : text, ["language_code"] = VoiceSpeechService.Code(language), ["model"] = o.SarvamTtsModel,
            ["speaker"] = o.SarvamSpeaker, ["speech_sample_rate"] = 22050, ["pace"] = Math.Clamp(o.SarvamPace, 0.5, 2.0),
        };
        var j = await JsonAsync(await SendAsync("text-to-speech", new StringContent(JsonSerializer.Serialize(fields), Encoding.UTF8, "application/json"), ct), "text-to-speech", ct);
        var audios = j?["audios"] ?? j?["audio"];
        return audios is JsonArray a && a.Count > 0 ? a[0]?.ToString() : audios?.ToString();
    }

    public async Task<string?> TranslateAsync(string text, string from, string to, CancellationToken ct)
    {
        if (from == to || string.IsNullOrWhiteSpace(text)) return text;
        var body = JsonSerializer.Serialize(new { input = text.Length > 1000 ? text[..1000] : text, source_language_code = VoiceSpeechService.Code(from), target_language_code = VoiceSpeechService.Code(to) });
        var j = await JsonAsync(await SendAsync("translate", new StringContent(body, Encoding.UTF8, "application/json"), ct), "translate", ct);
        return j?["translated_text"]?.ToString() is { Length: > 0 } t ? t : null;
    }
}

// ---------------------------------------------------------------------- sessions

public record DeskVoiceTurnDto(int Index, string Role, string Text, DateTime At, bool HasAudio);
public record DeskVoiceSessionDto(Guid Id, Guid? WorkTaskId, string? TicketKey, string Channel, string Language, string Status, bool? ConsentGiven, DateTime? ConsentAt,
    IReadOnlyList<DeskVoiceTurnDto> Transcript, string? Summary, bool Recorded, long RecordingBytes, DateTime? RetainUntil, DateTime StartedAt, DateTime? EndedAt, string Provider);
/// <summary>What the assistant says next, as text and (when speech is set up) audio.</summary>
public record DeskVoiceStepDto(DeskVoiceSessionDto Session, string Say, string? Audio, bool SpeechReady);
public record StartDeskVoiceRequest(Guid? WorkTaskId, string? Language);
public record DeskConsentRequest(bool Agree);
public record DeskVoiceSayRequest(string Text);
public record DeskCallbackRequest(string? Number);
public record DeskVoiceStatusDto(bool Enabled, bool SpeechReady, bool TelephonyReady, string TelephonyProvider, IReadOnlyList<string> Languages);

/// <summary>
/// Voice intake: the assistant says it is automated and asks before recording; then it asks a few questions (what is wrong, which application,
/// the error, since when, how urgent), writes down what is said (Sarvam), summarises it and puts the transcript, summary and (only after a yes)
/// the recording on the ticket, which is then routed. Works in the browser today; phone calls need a telephony provider (see <see cref="ITelephonyProvider"/>).
/// </summary>
public class DeskVoiceService(IAppDbContext db, ICurrentContext ctx, AppClock clock, PermissionService permissions, ISecretProtector secrets, IFileStorage files, Recorder recorder,
    ISpeechProvider speech, ITelephonyProvider telephony, DeskSettingsService settings, DeskClassifier classifier, DeskRoutingService routing, WorkTaskService workTasks,
    WorkTypeService workTypes)
{
    private record Entry(string Role, string Text, DateTime At, string? AudioKey = null);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private const long MaxTurnBytes = 8 * 1024 * 1024;

    /// <summary>The questions the assistant works through, skipping any the caller already answered.</summary>
    private static readonly (string Key, string Ask, string[] Answered)[] Questions =
    [
        ("issue", "Please tell me what is going wrong.", Array.Empty<string>()),
        ("app", "Which application or service is affected?", new[] { "app", "application", "portal", "website", "system", "service", "email", "vpn", "laptop" }),
        ("error", "Do you see an error message? If so, please read it out.", new[] { "error", "message", "says", "code", "shows" }),
        ("since", "Since when has this been happening, and does it affect only you or others too?", new[] { "since", "today", "yesterday", "morning", "everyone", "only me", "others" }),
    ];

    private List<Entry> Entries(DeskVoiceSession s) =>
        string.IsNullOrEmpty(s.TranscriptProtected) ? [] : JsonSerializer.Deserialize<List<Entry>>(secrets.Unprotect(s.TranscriptProtected), Json) ?? [];
    private void Save(DeskVoiceSession s, List<Entry> entries) => s.TranscriptProtected = secrets.Protect(JsonSerializer.Serialize(entries.TakeLast(200).ToList(), Json));

    public async Task<DeskVoiceStatusDto> StatusAsync(CancellationToken ct)
    {
        await permissions.RequireAsync(Permissions.WorkEdit, ct);
        var s = await settings.CurrentAsync(ct);
        return new(s.VoiceEnabled, await speech.ConfiguredAsync(ct), telephony.Configured, s.TelephonyProvider, DeskSettingsService.Languages(s.VoiceLanguages));
    }

    public async Task<DeskVoiceStepDto> StartAsync(StartDeskVoiceRequest req, CancellationToken ct)
    {
        await permissions.RequireAsync(Permissions.WorkEdit, ct);
        var s = await settings.CurrentAsync(ct);
        if (!s.VoiceEnabled) throw new ConflictException("Voice intake is off. Turn it on in Desk › Integrations.", "DESK_VOICE_OFF");
        var langs = DeskSettingsService.Languages(s.VoiceLanguages);
        var lang = req.Language is { Length: > 0 } l ? l.Trim() : langs.FirstOrDefault() ?? "en";
        if (!langs.Contains(lang)) throw new ValidationException("language", "Choose one of the languages set in Desk › Integrations.");
        if (req.WorkTaskId is { } wt && !await db.WorkTasks.AnyAsync(t => t.Id == wt && t.Kind == WorkTaskKind.Operational, ct)) throw new ValidationException("workTaskId", "Ticket not found.");
        var row = new DeskVoiceSession
        {
            TenantId = ctx.RequireTenantId(), WorkTaskId = req.WorkTaskId, Channel = "web", Direction = "inbound", Language = lang, Status = "consent", Provider = speech.Name,
            StartedAt = clock.Now, StartedBy = ctx.UserId, CreatedAt = clock.Now, CreatedBy = ctx.UserId,
        };
        var prompt = s.ConsentPrompt.Length > 0 ? s.ConsentPrompt : DeskSettingsService.DefaultConsent;
        var say = await LocalAsync(prompt, lang, ct);
        Save(row, [new("assistant", say, clock.Now)]);
        db.DeskVoiceSessions.Add(row);
        recorder.Audit("desk.voice_started", "DeskVoiceSession", row.Id, null, new { row.WorkTaskId, row.Language });
        await db.SaveChangesAsync(ct);
        return await StepAsync(row, say, ct);
    }

    /// <summary>The caller's answer to the consent question. No: nothing is recorded, the conversation goes on with the transcript only.</summary>
    public async Task<DeskVoiceStepDto> ConsentAsync(Guid id, DeskConsentRequest req, CancellationToken ct)
    {
        var row = await RowAsync(id, ct);
        if (row.Status != "consent") throw new ConflictException("Consent was already answered for this conversation.");
        row.ConsentGiven = req.Agree; row.ConsentAt = clock.Now; row.Status = "active"; row.UpdatedAt = clock.Now;
        var entries = Entries(row);
        entries.Add(new("caller", req.Agree ? "Yes, I agree." : "No, I do not agree to recording.", clock.Now));
        var say = await LocalAsync(req.Agree ? "Thank you. " + Questions[0].Ask : "Understood, this conversation will not be recorded. " + Questions[0].Ask, row.Language, ct);
        entries.Add(new("assistant", say, clock.Now));
        Save(row, entries);
        recorder.Audit("desk.voice_consent", "DeskVoiceSession", row.Id, null, new { agreed = req.Agree });
        await db.SaveChangesAsync(ct);
        return await StepAsync(row, say, ct);
    }

    /// <summary>A spoken turn: written down by Sarvam; the audio is kept only when the caller agreed and the policy records calls.</summary>
    public async Task<DeskVoiceStepDto> ListenAsync(Guid id, byte[] audio, string contentType, CancellationToken ct)
    {
        var row = await ActiveAsync(id, ct);
        if (audio.Length is 0 or > (int)MaxTurnBytes) throw new ValidationException("audio", "Send 1 byte to 8 MB of audio per turn.");
        if (!await speech.ConfiguredAsync(ct)) throw new ConflictException("Speech is not set up: add a Sarvam AI key in Desk › Integrations, or type the answer.", "DESK_SPEECH_OFF");
        var heard = await speech.TranscribeAsync(audio, contentType, ct);
        if (heard is null) return await StepAsync(row, await LocalAsync("Sorry, I did not catch that. Could you say it again?", row.Language, ct), ct);
        string? key = null;
        var s = await settings.CurrentAsync(ct);
        if (row.ConsentGiven == true && s.RecordCalls)
        {
            var n = Entries(row).Count;
            key = $"desk/voice/{row.TenantId:N}/{row.Id:N}/{n:D3}";
            await files.SaveAsync(key, new MemoryStream(audio), ct);
            row.RecordingKey = $"desk/voice/{row.TenantId:N}/{row.Id:N}/";
            row.RecordingContentType = contentType.Split(';')[0].Trim() is { Length: > 0 and <= 100 } mt ? mt : "audio/webm";
            row.RecordingBytes += audio.Length;
        }
        if (heard.Language is { } lang && lang != row.Language) row.Language = lang;
        return await TurnAsync(row, heard.Text, key, ct);
    }

    /// <summary>A typed turn (no microphone, or speech not set up).</summary>
    public async Task<DeskVoiceStepDto> SayAsync(Guid id, DeskVoiceSayRequest req, CancellationToken ct)
    {
        var row = await ActiveAsync(id, ct);
        var text = (req.Text ?? "").Trim();
        if (text.Length is 0 or > 2000) throw new ValidationException("text", "Write what the caller said (up to 2000 characters).");
        return await TurnAsync(row, text, null, ct);
    }

    private async Task<DeskVoiceStepDto> TurnAsync(DeskVoiceSession row, string text, string? audioKey, CancellationToken ct)
    {
        var entries = Entries(row);
        entries.Add(new("caller", text, clock.Now, audioKey));
        var said = string.Join(" ", entries.Where(e => e.Role == "caller").Skip(1).Select(e => e.Text)).ToLowerInvariant();
        var asked = entries.Count(e => e.Role == "assistant");
        var next = Questions.Skip(1).FirstOrDefault(q => asked <= Array.IndexOf(Questions, q) + 1 && !q.Answered.Any(w => said.Contains(w, StringComparison.Ordinal)));
        var say = await LocalAsync(next.Key is null ? "Thank you, I have everything I need. I am creating your ticket now and an engineer will contact you." : next.Ask, row.Language, ct);
        entries.Add(new("assistant", say, clock.Now));
        Save(row, entries);
        row.UpdatedAt = clock.Now;
        await db.SaveChangesAsync(ct);
        return await StepAsync(row, say, ct);
    }

    /// <summary>Ends the conversation: summary, ticket (raised or updated), routing, and the retention date for the recording.</summary>
    public async Task<DeskVoiceSessionDto> CompleteAsync(Guid id, CancellationToken ct)
    {
        var row = await RowAsync(id, ct);
        if (row.Status is "completed") return await DtoAsync(row, ct);
        var entries = Entries(row);
        var said = string.Join("\n", entries.Where(e => e.Role == "caller").Skip(row.ConsentAt is null ? 0 : 1).Select(e => e.Text));
        row.EndedAt = clock.Now; row.UpdatedAt = clock.Now;
        if (said.Trim().Length == 0) { row.Status = "declined"; await db.SaveChangesAsync(ct); return await DtoAsync(row, ct); }
        var c = await classifier.ClassifyAsync(said, ct);
        row.Summary = c.Summary.Length > 2000 ? c.Summary[..2000] : c.Summary;
        var transcript = string.Join("\n", entries.Select(e => $"{(e.Role == "caller" ? "Caller" : "Assistant")}: {e.Text}"));
        var s = await settings.CurrentAsync(ct);
        if (row.WorkTaskId is null)
        {
            await workTypes.EnsureDefaultsAsync(ct);
            var typeId = await db.WorkTypes.Where(t => t.IsActive).OrderBy(t => t.Order).Select(t => (Guid?)t.Id).FirstOrDefaultAsync(ct)
                ?? throw new ConflictException("Add a work type in Operations › Settings first.");
            var title = c.Summary.Length > 0 ? c.Summary : "Voice request";
            var details = $"{c.Summary}\n\nFrom voice intake ({row.Language}).\n\nTranscript:\n{transcript}";
            var confident = !DeskRules.NeedsReview(c.Confidence, s.ConfidenceThreshold);
            var ticket = await workTasks.CreateAsync(new CreateWorkTaskRequest(title.Length > 120 ? title[..117] + "…" : title, details.Length > 9000 ? details[..9000] : details, typeId,
                null, null, confident ? c.Priority : Priority.Medium, null, null, null), ct);
            row.WorkTaskId = ticket.Id;
        }
        else await workTasks.AddCommentAsync(row.WorkTaskId.Value, new WorkCommentRequest(Clip($"Voice intake summary: {c.Summary}\n\nTranscript:\n{transcript}", 8000)), ct);
        if (row.RecordingKey is not null) row.RetainUntil = clock.Now.AddDays(Math.Max(1, s.RetentionDays));
        row.Status = "completed";
        await db.SaveChangesAsync(ct);
        var task = await db.WorkTasks.FirstAsync(t => t.Id == row.WorkTaskId, ct);
        await routing.RecordInsightAsync(task, c, "voice", null, null, ct);
        if (!await db.DeskAssignments.AnyAsync(a => a.WorkTaskId == task.Id && a.Active, ct)) await routing.RouteAsync(task.Id, ct);
        recorder.Audit("desk.voice_completed", "DeskVoiceSession", row.Id, null, new { row.WorkTaskId, recorded = row.RecordingKey is not null });
        await db.SaveChangesAsync(ct);
        return await DtoAsync(row, ct);
    }

    public async Task<DeskVoiceSessionDto> GetAsync(Guid id, CancellationToken ct) => await DtoAsync(await RowAsync(id, ct), ct);

    public async Task<IReadOnlyList<DeskVoiceSessionDto>> ForTicketAsync(Guid taskId, CancellationToken ct)
    {
        await permissions.RequireAsync(Permissions.WorkEdit, ct);
        var rows = await db.DeskVoiceSessions.AsNoTracking().Where(v => v.WorkTaskId == taskId).OrderByDescending(v => v.StartedAt).Take(20).ToListAsync(ct);
        var list = new List<DeskVoiceSessionDto>();
        foreach (var r in rows) list.Add(await DtoAsync(r, ct));
        return list;
    }

    /// <summary>One recorded turn's audio, for the ticket's player (until the retention date).</summary>
    public async Task<(Stream Content, string ContentType)> AudioAsync(Guid id, int index, CancellationToken ct)
    {
        var row = await RowAsync(id, ct);
        var entry = Entries(row).ElementAtOrDefault(index);
        if (entry?.AudioKey is not { } key) throw new NotFoundException("No recording for this part of the conversation.");
        var stream = await files.OpenReadAsync(key, ct) ?? throw new NotFoundException("The recording is no longer kept.");
        return (stream, row.RecordingContentType ?? "audio/webm");
    }

    /// <summary>An engineer asks for a call back to the customer: placed by the telephony provider, or refused with what is missing.</summary>
    public async Task<DeskVoiceSessionDto> CallbackAsync(Guid taskId, DeskCallbackRequest req, CancellationToken ct)
    {
        await permissions.RequireAsync(Permissions.WorkEdit, ct);
        if (!await db.WorkTasks.AnyAsync(t => t.Id == taskId, ct)) throw new NotFoundException("Ticket not found.");
        var number = new string((req.Number ?? "").Where(char.IsDigit).ToArray());
        if (number.Length is < 10 or > 15) throw new ValidationException("number", "Give the customer's phone number with the country code.");
        var row = new DeskVoiceSession
        {
            TenantId = ctx.RequireTenantId(), WorkTaskId = taskId, Channel = "phone", Direction = "outbound", Status = "consent", Provider = telephony.Name, StartedAt = clock.Now,
            StartedBy = ctx.UserId, CreatedAt = clock.Now, CreatedBy = ctx.UserId, Language = "en",
        };
        var call = await telephony.PlaceCallAsync(number, row.Id, ct);   // throws (409) while no provider is connected: nothing is stored
        row.ProviderCallId = call.ProviderCallId.Length > 200 ? call.ProviderCallId[..200] : call.ProviderCallId;
        Save(row, []);
        db.DeskVoiceSessions.Add(row);
        await db.SaveChangesAsync(ct);
        return await DtoAsync(row, ct);
    }

    /// <summary>The retention date passed: the audio goes, the transcript and summary stay.</summary>
    public async Task ExpireRecordingAsync(Guid id, CancellationToken ct)
    {
        var row = await db.DeskVoiceSessions.FirstOrDefaultAsync(v => v.Id == id, ct);
        if (row is null || row.RecordingKey is null) return;
        var entries = Entries(row);
        for (var i = 0; i < entries.Count; i++)
            if (entries[i].AudioKey is { } k) { await files.DeleteAsync(k, ct); entries[i] = entries[i] with { AudioKey = null }; }
        Save(row, entries);
        row.RecordingKey = null; row.RecordingBytes = 0; row.UpdatedAt = clock.Now;
        db.Activities.Add(new Activity { TenantId = row.TenantId, Action = "desk.voice_recording_expired", EntityType = "DeskVoiceSession", EntityId = row.Id,
            Summary = "A voice recording reached its retention date and was deleted", CreatedAt = clock.Now });
        await db.SaveChangesAsync(ct);
    }

    // ------------------------------------------------------------------ helpers

    private async Task<DeskVoiceSession> RowAsync(Guid id, CancellationToken ct)
    {
        await permissions.RequireAsync(Permissions.WorkEdit, ct);
        return await db.DeskVoiceSessions.FirstOrDefaultAsync(v => v.Id == id, ct) ?? throw new NotFoundException("Voice conversation not found.");
    }

    private async Task<DeskVoiceSession> ActiveAsync(Guid id, CancellationToken ct)
    {
        var row = await RowAsync(id, ct);
        if (row.Status == "consent") throw new ConflictException("Ask for consent first: the caller has not answered yet.", "DESK_CONSENT_PENDING");
        if (row.Status != "active") throw new ConflictException("This conversation has ended.");
        return row;
    }

    /// <summary>The assistant's line in the conversation's language (Sarvam translation; English when it is not set up).</summary>
    private async Task<string> LocalAsync(string english, string lang, CancellationToken ct)
    {
        if (lang == "en" || !await speech.ConfiguredAsync(ct)) return english;
        return await speech.TranslateAsync(english, "en", lang, ct) ?? english;
    }

    private async Task<DeskVoiceStepDto> StepAsync(DeskVoiceSession row, string say, CancellationToken ct)
    {
        var ready = await speech.ConfiguredAsync(ct);
        return new(await DtoAsync(row, ct), say, ready ? await speech.SynthesizeAsync(say, row.Language, ct) : null, ready);
    }

    private async Task<DeskVoiceSessionDto> DtoAsync(DeskVoiceSession r, CancellationToken ct)
    {
        var key = r.WorkTaskId is { } t ? await db.WorkTasks.AsNoTracking().Where(x => x.Id == t).Select(x => (int?)x.Number).FirstOrDefaultAsync(ct) : null;
        var turns = Entries(r).Select((e, i) => new DeskVoiceTurnDto(i, e.Role, e.Text, e.At, e.AudioKey is not null)).ToList();
        return new(r.Id, r.WorkTaskId, key is { } n ? WorkTaskService.KeyOf(n) : null, r.Channel, r.Language, r.Status, r.ConsentGiven, r.ConsentAt, turns, r.Summary,
            r.RecordingKey is not null, r.RecordingBytes, r.RetainUntil, r.StartedAt, r.EndedAt, r.Provider);
    }

    private static string Clip(string s, int max) => s.Length > max ? s[..max] : s;
}
