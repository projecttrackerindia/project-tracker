using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Voice;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Agent;

public record RecordingStartRequest(Guid MeetingId);
public record RecordingLineDto(string Who, string? Lang, string Text, int Offset);
public record RecordingDto(Guid Id, Guid MeetingId, string Title, string Status, int Lines, bool Speech);
public record RecordingTasksRequest(IReadOnlyList<int>? Items);
public record RecordingTasksDto(IReadOnlyList<string> Created);

/// <summary>
/// "Record this meeting" from the person's own device: no bot joins. The browser (or the desktop app) sends the call's sound in short pieces,
/// each piece is written down by the speech service in whatever language it hears (Telugu, Hindi, Tamil, English, mixed), and the words are
/// kept as the session's transcript. The sound itself is never stored: it is read and dropped. When the person stops, the notetaker's own
/// minutes writer turns the transcript into minutes with action items, which the person then turns into tasks one tap at a time.
/// </summary>
public class DeviceRecordingService(IAppDbContext db, ICurrentContext ctx, ProjectAccess access, VoiceSpeechService speech, ISecretProtector secrets, AppClock clock, NotetakerService notetaker)
{
    /// <summary>One piece of sound: about half a minute of speech. Larger is refused, so a client cannot feed the speech service whole files.</summary>
    public const int MaxPieceBytes = 2_000_000;
    private const int MaxTranscriptChars = 400_000;
    public const string Kind = "device";

    private IQueryable<AgentMeetingBot> Mine(Guid uid) => db.AgentMeetingBots.Where(b => b.Kind == Kind && b.CreatedBy == uid);

    private async Task<AgentMeetingBot> LoadAsync(Guid id, CancellationToken ct)
    {
        var bot = await Mine(ctx.RequireUserId()).FirstOrDefaultAsync(b => b.Id == id, ct) ?? throw new NotFoundException("Recording not found.");
        await access.GetProjectAsync(bot.ProjectId, ct);
        return bot;
    }

    private static RecordingDto ToDto(AgentMeetingBot b, bool speechOn) => new(b.Id, b.MeetingId, b.Title ?? "Meeting", b.Status, b.TranscriptLength == 0 ? 0 : b.NudgeCount, speechOn);

    /// <summary>Whether the speech service is set up, so the page can say so before anyone presses Record.</summary>
    public bool SpeechReady => speech.Configured;

    public async Task<RecordingDto> StartAsync(RecordingStartRequest req, CancellationToken ct)
    {
        var uid = ctx.RequireUserId();
        if (!speech.Configured) throw new ConflictException("Recording needs the speech service, which is not set up here.", "RECORDING_NO_SPEECH");
        var meeting = await db.ProjectMeetings.AsNoTracking().FirstOrDefaultAsync(m => m.Id == req.MeetingId, ct) ?? throw new NotFoundException("Meeting not found.");
        await access.GetProjectAsync(meeting.ProjectId, ct);
        var now = clock.Now;
        // One recording at a time per person and meeting: the one still going is continued, not duplicated.
        var open = await Mine(uid).FirstOrDefaultAsync(b => b.MeetingId == meeting.Id && b.Status == "in_call", ct);
        if (open is not null) return ToDto(open, true);
        var bot = new AgentMeetingBot
        {
            TenantId = meeting.TenantId, ProjectId = meeting.ProjectId, MeetingId = meeting.Id, SessionStartUtc = now, SessionEndUtc = now, Kind = Kind, Status = "in_call",
            WebhookToken = AgentSettingsService.NewToken(16), Title = meeting.Title.Length > 300 ? meeting.Title[..300] : meeting.Title, CreatedAt = now, CreatedBy = uid,
        };
        db.AgentMeetingBots.Add(bot);
        await db.SaveChangesAsync(ct);
        return ToDto(bot, true);
    }

    /// <summary>
    /// One piece of sound in, the words out. <paramref name="who"/> is "me" (the microphone) or "others" (the call's own sound), so a line is
    /// attributed to the person recording or to the rest of the call. Silence or music gives no line.
    /// </summary>
    public async Task<RecordingLineDto?> SegmentAsync(Guid id, string who, int offsetSeconds, byte[] audio, string contentType, CancellationToken ct)
    {
        if (audio.Length == 0) return null;
        if (audio.Length > MaxPieceBytes) throw new ValidationException("file", "That piece of sound is too large.");
        var bot = await LoadAsync(id, ct);
        if (bot.Status != "in_call") throw new ConflictException("This recording has ended.", "RECORDING_ENDED");
        var heard = await speech.TranscribeAsync(audio, contentType, ct);
        if (heard is null) return null;
        var name = who == "me" ? await db.Users.AsNoTracking().Where(u => u.Id == bot.CreatedBy).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) ?? "Me" : "Others";
        var text = heard.Value.Text.Replace('\n', ' ').Trim();
        if (text.Length == 0) return null;
        var existing = bot.TranscriptProtected is null ? "" : secrets.Unprotect(bot.TranscriptProtected);
        if (existing.Length + text.Length > MaxTranscriptChars) throw new ConflictException("This recording is longer than the transcript can hold.", "RECORDING_TOO_LONG");
        var line = $"{name}: {text}";
        var all = existing.Length == 0 ? line : existing + "\n" + line;
        bot.TranscriptProtected = secrets.Protect(all);
        bot.TranscriptLength = all.Length;
        bot.NudgeCount++; // the number of lines so far (not used for nudging on a device recording)
        await db.SaveChangesAsync(ct);
        return new RecordingLineDto(name, heard.Value.Language, text, Math.Max(0, offsetSeconds));
    }

    public async Task<RecordingDto> GetAsync(Guid id, CancellationToken ct) => ToDto(await LoadAsync(id, ct), speech.Configured);

    /// <summary>The words so far, one line each, for the page to show again after a refresh.</summary>
    public async Task<IReadOnlyList<RecordingLineDto>> LinesAsync(Guid id, CancellationToken ct)
    {
        var bot = await LoadAsync(id, ct);
        if (bot.TranscriptProtected is null) return [];
        var i = 0;
        return secrets.Unprotect(bot.TranscriptProtected).Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(l =>
        {
            var at = l.IndexOf(": ", StringComparison.Ordinal);
            return new RecordingLineDto(at > 0 ? l[..at] : "", null, at > 0 ? l[(at + 2)..] : l, i++);
        }).ToList();
    }

    /// <summary>Stops the recording and writes the minutes from what was heard. With nothing heard there are no minutes and the recording is marked as failed.</summary>
    public async Task<MinutesDto?> FinishAsync(Guid id, CancellationToken ct)
    {
        var bot = await LoadAsync(id, ct);
        if (bot.Status == "in_call")
        {
            var now = clock.Now;
            bot.EndedAt = now; bot.SessionEndUtc = now;
            bot.Status = bot.TranscriptLength > 0 ? "done" : "failed";
            if (bot.TranscriptLength == 0) bot.Error ??= "Nothing was heard.";
            await db.SaveChangesAsync(ct);
        }
        if (bot.TranscriptLength == 0) return null;
        return await notetaker.WriteMinutesForRecordingAsync(bot, ct);
    }

    /// <summary>Creates tasks for the chosen action items (all of them when none are named), in the meeting's project, as the person recording.</summary>
    public async Task<RecordingTasksDto> CreateTasksAsync(Guid id, RecordingTasksRequest req, CancellationToken ct)
    {
        var bot = await LoadAsync(id, ct);
        return new RecordingTasksDto(await notetaker.CreateRecordingTasksAsync(bot, req.Items, ct));
    }
}
