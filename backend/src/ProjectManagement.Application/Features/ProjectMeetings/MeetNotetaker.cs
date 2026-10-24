using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Features.Agent;
using ProjectManagement.Application.Features.Voice;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.ProjectMeetings;

/// <param name="Available">The notetaker can come to this project's meetings.</param>
/// <param name="Reason">Why not, in a sentence that says what to do.</param>
/// <param name="VoiceAvailable">It can also speak (a speech service and AI are on).</param>
/// <param name="CanSwitchOn">The person asking may switch the project agent on (Project › Agent).</param>
public record NotetakerReadinessDto(bool Available, string? Reason, bool VoiceAvailable, string? VoiceReason, bool CanSwitchOn);

/// <summary>
/// The notetaker a meeting asks for on its schedule form. It is the project's agent in the meeting (the same bot for Google Meet and Teams,
/// let in by our own media server for a Project Tracker call), so it needs a project with its agent allowed to read meetings. Speaking up also
/// needs a speech service (to turn its words into a voice) and AI (to notice what is being missed).
/// </summary>
public class MeetNotetaker(IAppDbContext db, MeetingBotClient bot, VoiceSpeechService speech, AgentSettingsService agent)
{
    public static MeetingNotetaker Parse(string? value) => (value ?? "").Trim().ToLowerInvariant() switch
    {
        "" or "project" or "default" => MeetingNotetaker.ProjectDefault,
        "off" or "none" => MeetingNotetaker.Off,
        "transcript" or "transcription" => MeetingNotetaker.Transcript,
        "voice" or "transcript_voice" or "transcriptandvoice" => MeetingNotetaker.TranscriptAndVoice,
        _ => throw new ValidationException("notetaker", "Choose no notetaker, Transcription, or Transcription + voice suggestions."),
    };

    public static string Key(MeetingNotetaker n) => n switch { MeetingNotetaker.Transcript => "transcript", MeetingNotetaker.TranscriptAndVoice => "voice", MeetingNotetaker.Off => "off", _ => "project" };

    /// <summary>A notetaker was asked for explicitly.</summary>
    public static bool Wanted(MeetingNotetaker n) => n is MeetingNotetaker.Transcript or MeetingNotetaker.TranscriptAndVoice;

    /// <summary>The bot's mode for a meeting's notetaker choice (null: no choice was made).</summary>
    public static string? BotMode(MeetingNotetaker n) => n switch { MeetingNotetaker.Transcript => "transcript", MeetingNotetaker.TranscriptAndVoice => "voice", _ => null };

    public async Task<NotetakerReadinessDto> ReadinessAsync(Guid projectId, CancellationToken ct)
    {
        var project = await db.Projects.AsNoTracking().FirstOrDefaultAsync(p => p.Id == projectId, ct) ?? throw new NotFoundException("Project not found.");
        var canSwitch = await agent.CanManageAsync(project, ct);
        string? reason = null;
        if (!bot.Configured) reason = "The notetaker is not set up on this installation yet.";
        else
        {
            var s = await db.ProjectAgentSettings.AsNoTracking().FirstOrDefaultAsync(x => x.ProjectId == projectId, ct);
            if (s is not { Enabled: true }) reason = canSwitch ? "Switch on this project's agent first (Project › Agent): the notetaker is the agent in the meeting." : "Ask the project lead to switch on this project's agent: the notetaker is the agent in the meeting.";
            else if (!s.ReadMeetings) reason = canSwitch ? "Let this project's agent read meetings first (Project › Agent › Sources)." : "Ask the project lead to let the project agent read meetings.";
        }
        string? voiceReason = null;
        if (reason is not null) voiceReason = reason;
        else if (!speech.Configured) voiceReason = "Voice needs the speech service, which is not set up here. Transcription works.";
        else if (!await agent.AiAvailableAsync(ct)) voiceReason = "Voice suggestions need AI, which is off for this workspace. Transcription works.";
        return new(reason is null, reason, voiceReason is null, voiceReason, canSwitch);
    }

    /// <summary>Throws with the reason when the chosen notetaker cannot come.</summary>
    public async Task RequireAsync(Guid projectId, MeetingNotetaker choice, CancellationToken ct)
    {
        if (!Wanted(choice)) return;
        var r = await ReadinessAsync(projectId, ct);
        if (!r.Available) throw new ConflictException(r.Reason!, "NOTETAKER_UNAVAILABLE");
        if (choice == MeetingNotetaker.TranscriptAndVoice && !r.VoiceAvailable) throw new ConflictException(r.VoiceReason!, "NOTETAKER_VOICE_UNAVAILABLE");
    }
}
