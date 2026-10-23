using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Voice;
using ProjectManagement.Application.Services;

namespace ProjectManagement.Application.Features.Ai;

public record AiSpeechStatusDto(bool Available, int MaxSeconds);
public record AiTranscriptDto(string Text, string? Language);

/// <summary>
/// Speaking to the assistant: a short recording (16 kHz WAV from the browser) becomes text in the ask box - English, Hindi, Telugu and the
/// other Indian languages the speech service knows, detected by itself. Nothing is kept: the audio is sent once and dropped. The person
/// reads the text before sending it, so a mishearing is never acted on.
/// </summary>
public class AiVoiceInput(IAppDbContext db, ICurrentContext ctx, VoiceSpeechService speech, AppClock clock)
{
    public const int MaxSeconds = 60, MaxBytes = 16000 * 2 * MaxSeconds + 1024, PerHour = 120;
    private static readonly ConcurrentDictionary<Guid, (DateTime Hour, int Count)> Use = new();

    public AiSpeechStatusDto Status() => new(speech.Configured, MaxSeconds);

    public async Task<AiTranscriptDto> TranscribeAsync(byte[] audio, string contentType, CancellationToken ct)
    {
        var tid = ctx.RequireTenantId(); var me = ctx.RequireUserId();
        if (await db.Tenants.Where(t => t.Id == tid).Select(t => t.AiDisabled).FirstOrDefaultAsync(ct))
            throw new ForbiddenException("The AI assistant is switched off for this workspace.", "AI_DISABLED");
        if (!speech.Configured) throw new ConflictException("Speaking to the assistant is not set up on this installation.", "AI_VOICE_UNAVAILABLE");
        if (audio.Length < 1000) throw new ValidationException("audio", "Nothing was recorded. Hold the microphone button and speak.");
        if (audio.Length > MaxBytes) throw new ValidationException("audio", $"Speak for at most {MaxSeconds} seconds at a time.");
        var hour = new DateTime(clock.Now.Year, clock.Now.Month, clock.Now.Day, clock.Now.Hour, 0, 0, DateTimeKind.Utc);
        var used = Use.AddOrUpdate(me, (hour, 1), (_, v) => v.Hour == hour ? (hour, v.Count + 1) : (hour, 1));
        if (used.Count > PerHour) throw new AppException(429, "AI_VOICE_LIMIT", "That is a lot of speaking for one hour. Type for now, or try again later.");
        var heard = await speech.TranscribeAsync(audio, contentType, ct)
            ?? throw new AppException(422, "AI_VOICE_NOT_UNDERSTOOD", "I could not make out what was said. Try again a little closer to the microphone.");
        return new(heard.Text.Length > 4000 ? heard.Text[..4000] : heard.Text, heard.Language);
    }
}
