using Microsoft.EntityFrameworkCore.Infrastructure;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Agent;

public class AgentOptions
{
    public const string Section = "Agent";
    public bool WorkerEnabled { get; set; } = true;
    /// <summary>How often the worker looks for new mail, chat, finished meetings and live bots.</summary>
    public int IntervalSeconds { get; set; } = 60;
    /// <summary>New chat is read once the conversation has been quiet this long (so a discussion is read as a whole).</summary>
    public int ChatQuietMinutes { get; set; } = 10;
    /// <summary>Mail to a project is read once it has settled this long, so a burst of mail is one reading.</summary>
    public int MailBatchMinutes { get; set; } = 5;
    /// <summary>Opted-in personal inboxes are looked at this often.</summary>
    public int InboxScanMinutes { get; set; } = 30;
    /// <summary>The local hour each person's daily update goes out (workspace time zone).</summary>
    public int DailyUpdateHour { get; set; } = 9;
    /// <summary>Not used any more: bot workers (apps/meetbot with MEETBOT_API_URL) ask the API for meetings themselves. Kept so old settings still load.</summary>
    public string? MeetingBotUrl { get; set; }
    /// <summary>The secret shared with the meeting-bot workers (their MEETBOT_SECRET), 16 characters or more. Empty: no live bot on this installation.</summary>
    public string? MeetingBotSecret { get; set; }
    /// <summary>After each reading, a second, quick look checks every proposal against its source and drops what the source does not support.</summary>
    public bool VerifyFindings { get; set; } = true;
    /// <summary>What the agent read (mail, chat, transcripts) is erased this many days after it was read; the proposals and their short quotes stay.</summary>
    public int SignalRetentionDays { get; set; } = 30;
    /// <summary>How often a project's Slack channel is looked at (Slack limits how often history may be read).</summary>
    public int SlackPollMinutes { get; set; } = 2;
}

/// <summary>Meeting: it read a meeting (minutes can be sent). MinutesSentAt: when its minutes were last e-mailed.</summary>
public record AgentRunDto(Guid Id, string Trigger, string Status, int SignalCount, int FindingCount, int Credits, string? Summary, string? Error,
    DateTime StartedAt, DateTime? FinishedAt, bool Meeting = false, DateTime? MinutesSentAt = null);

public record ProjectAgentDto(Guid ProjectId, bool Enabled, bool ReadMailbox, bool ReadChat, bool ReadMeetings, bool LiveBot, bool DailyUpdates,
    string? MailboxAddress, bool LiveBotAvailable, bool AiAvailable, int Pending, DateTime? LastRunAt, string? LastError, int RunsThisMonth,
    int MonthlyRunLimit, bool CanManage, string? ActingUserName, IReadOnlyList<AgentRunDto> Runs, bool TranscriptAccess,
    string? Instructions = null, string? SpeakerAliases = null, string? CaptionLanguage = null, bool AutoJoinCalendar = false, bool SendMinutes = true,
    string? SlackChannelId = null, bool SlackAvailable = false, bool ReadWhatsApp = true, bool WhatsAppAvailable = false, bool AutoTranscriptAccess = false);

/// <summary>Anything left out (null) keeps its current value; an empty string clears a text setting.</summary>
public record SaveProjectAgentRequest(bool Enabled, bool? ReadMailbox, bool? ReadChat, bool? ReadMeetings, bool? LiveBot, bool? DailyUpdates,
    string? Instructions = null, string? SpeakerAliases = null, string? CaptionLanguage = null, bool? AutoJoinCalendar = null, bool? SendMinutes = null,
    string? SlackChannelId = null, bool? ReadWhatsApp = null);

/// <summary>BotAvailable: the installation runs the built-in meeting bot.</summary>
public record AgentWorkspaceDto(bool BotAvailable, string BotName, bool InCallReminders, bool CanManage, int EnabledProjects);
public record SaveAgentWorkspaceRequest(string? BotName, bool? InCallReminders);

public record AgentInboxOptInDto(bool GoogleAvailable, bool MicrosoftAvailable, string? Provider, bool Enabled, DateTime? ScannedUntil, int Found, string? LastError);
public record SaveAgentInboxOptInRequest(string? Provider, bool Enabled);

public record AgentTranscriptRequest(string? Title, string? Text, Guid? MeetingId);

public record AgentPersonRef(Guid Id, string Name);

public record AgentFindingDto(Guid Id, Guid ProjectId, string ProjectKey, string ProjectName, Guid RunId, AgentFindingKind Kind, AgentFindingStatus Status,
    string Title, string? Detail, string? Evidence, string? SourceLabel, AgentSourceKind? Source, Guid? TaskId, string? TaskKey, string? TaskTitle,
    Guid? IssueId, string? IssueKey, AgentPersonRef? Assignee, DateOnly? DueDate, Priority? Priority, string? NewStatus, string? Comment, int Confidence,
    DateTime CreatedAt, AgentPersonRef? DecidedBy, DateTime? DecidedAt, Guid? AppliedEntityId, string? AppliedKey, string? Error,
    bool Grounded = true, string? Edits = null, string? OwnerResponse = null, string? OwnerNote = null, DateTime? OwnerRespondedAt = null);

/// <summary>The assignee's answer to work the agent gave them: "accepted" or "declined" (with a note: why, or who it belongs to).</summary>
public record AgentOwnerResponseRequest(string? Response, string? Note);

public record AgentFindingPageDto(IReadOnlyList<AgentFindingDto> Items, int Pending, bool CanDecide);

/// <summary>What the person changed before approving (anything left out keeps what the agent proposed).</summary>
public record ApproveFindingRequest(string? Title, string? Detail, Guid? AssigneeId, bool? ClearAssignee, DateOnly? DueDate, bool? ClearDueDate,
    Priority? Priority, string? NewStatus, string? Comment);

/// <summary>Skipped: changes to existing work, which are approved one by one.</summary>
public record ApproveAllResult(int Applied, int Failed, IReadOnlyList<AgentFindingDto> Items, int Skipped = 0);

internal static class AgentDb
{
    /// <summary>Forgets everything tracked in this unit of work (after a failed change), so a following save only writes what comes next.</summary>
    public static void ClearTracking(IAppDbContext db) => db.Database.GetService<ICurrentDbContext>().Context.ChangeTracker.Clear();
}
