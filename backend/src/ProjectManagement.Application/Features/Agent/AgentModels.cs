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
    /// <summary>Recall.ai's API host pattern ({region} is replaced); tests point it elsewhere.</summary>
    public string RecallBaseUrl { get; set; } = "https://{region}.recall.ai";
}

public record AgentRunDto(Guid Id, string Trigger, string Status, int SignalCount, int FindingCount, int Credits, string? Summary, string? Error,
    DateTime StartedAt, DateTime? FinishedAt);

public record ProjectAgentDto(Guid ProjectId, bool Enabled, bool ReadMailbox, bool ReadChat, bool ReadMeetings, bool LiveBot, bool DailyUpdates,
    string? MailboxAddress, bool LiveBotAvailable, bool AiAvailable, int Pending, DateTime? LastRunAt, string? LastError, int RunsThisMonth,
    int MonthlyRunLimit, bool CanManage, string? ActingUserName, IReadOnlyList<AgentRunDto> Runs, bool TranscriptAccess);

public record SaveProjectAgentRequest(bool Enabled, bool? ReadMailbox, bool? ReadChat, bool? ReadMeetings, bool? LiveBot, bool? DailyUpdates);

public record AgentWorkspaceDto(bool RecallConfigured, string RecallRegion, string BotName, bool InCallReminders, bool CanManage, int EnabledProjects);
public record SaveAgentWorkspaceRequest(string? RecallApiKey, bool? ClearRecallKey, string? RecallRegion, string? BotName, bool? InCallReminders);

public record AgentInboxOptInDto(bool GoogleAvailable, bool MicrosoftAvailable, string? Provider, bool Enabled, DateTime? ScannedUntil, int Found, string? LastError);
public record SaveAgentInboxOptInRequest(string? Provider, bool Enabled);

public record AgentTranscriptRequest(string? Title, string? Text, Guid? MeetingId);

public record AgentPersonRef(Guid Id, string Name);

public record AgentFindingDto(Guid Id, Guid ProjectId, string ProjectKey, string ProjectName, Guid RunId, AgentFindingKind Kind, AgentFindingStatus Status,
    string Title, string? Detail, string? Evidence, string? SourceLabel, AgentSourceKind? Source, Guid? TaskId, string? TaskKey, string? TaskTitle,
    Guid? IssueId, string? IssueKey, AgentPersonRef? Assignee, DateOnly? DueDate, Priority? Priority, string? NewStatus, string? Comment, int Confidence,
    DateTime CreatedAt, AgentPersonRef? DecidedBy, DateTime? DecidedAt, Guid? AppliedEntityId, string? AppliedKey, string? Error);

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
