using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Agent;

// ---------------------------------------------------------------- impact and what-if

/// <summary>One piece of work a change would move (or a milestone it would miss).</summary>
public record ImpactTaskDto(Guid Id, string Key, string Title, string? Owner, DateOnly? OldDue, DateOnly? NewDue, int ShiftDays, int Depth);

/// <summary>
/// What moving one task's date does to the rest of the plan, worked out from the task dependencies (no model involved). Level: none, low,
/// medium (other work moves), high (a milestone or the project's due date is missed).
/// </summary>
public record ImpactDto(Guid TaskId, Guid ProjectId, string Key, string Title, DateOnly? OldDue, DateOnly NewDue, int SlipDays, IReadOnlyList<ImpactTaskDto> Moves,
    IReadOnlyList<string> Milestones, DateOnly? ProjectDue, DateOnly? NewFinish, int? ProjectSlipDays, IReadOnlyList<string> People, string Summary, string Level);

/// <summary>Either a new date or a number of days to slip.</summary>
public record WhatIfRequest(Guid TaskId, DateOnly? NewDue, int? SlipDays);

public record WhatIfTaskDto(Guid Id, string Key, string Title, DateOnly? Due, string? Owner, int Dependents);

// ---------------------------------------------------------------- commitments and check-ins

public record AgentCommitmentDto(Guid Id, Guid ProjectId, string ProjectKey, string ProjectName, string? EntityKey, Guid? TaskId, string Title, DateOnly DueDate,
    AgentPersonRef Owner, string Status, string? Quote, string? SourceLabel, DateTime? CheckInSentAt, string? CheckInAnswer, string? CheckInNote,
    DateOnly? ProposedDate, DateTime? AnsweredAt, bool AwaitingAnswer);

/// <summary>The owner's answer: on_track, done, more_time (with NewDate and a Note saying why) or blocked (with a Note).</summary>
public record AgentCheckInRequest(string? Answer, string? Note, DateOnly? NewDate);

// ---------------------------------------------------------------- meetings: brief, delegation

public record BriefItemDto(string Key, string? Owner, DateOnly? Due, string State);

/// <summary>What a person should know before a project meeting: what came of the last one, what is late or stuck, what waits for a decision.</summary>
public record MeetingBriefDto(Guid MeetingId, Guid ProjectId, string ProjectKey, string ProjectName, string Title, DateTime StartUtc, DateTime EndUtc, string? MeetUrl,
    string Headline, int ActionsSinceLast, int Done, int Overdue, int Blocked, int Open, IReadOnlyList<BriefItemDto> Items, IReadOnlyList<string> Blockers,
    IReadOnlyList<string> Commitments, IReadOnlyList<string> Agenda, int PendingDecisions, bool MaybeUnnecessary, DateTime? LastMeetingAt, bool AgentAttending);

/// <summary>A session of one of my meetings: project meetings I organize or am invited to, and (when Google Calendar is connected) my other calls.</summary>
public record MyMeetingDto(string Id, Guid? MeetingId, Guid? ProjectId, string? ProjectKey, string? ProjectName, string Title, DateTime StartUtc, DateTime EndUtc,
    string? MeetUrl, bool Organizer, bool Project, bool AgentEnabled, bool AgentAttending, Guid? DelegationId, string? DelegationStatus, IReadOnlyList<string> OverlapsWith);

public record AgentDelegationDto(Guid Id, Guid ProjectId, string ProjectKey, string ProjectName, Guid MeetingId, string Title, DateTime StartUtc, DateTime EndUtc,
    string Status, string? Instructions, bool Automatic, string? BotStatus, string? BotError, DateTime? ReportSentAt, string? Summary,
    IReadOnlyList<string> Outcomes, int ToDecide, bool CanDecide, string? Note);

public record DelegateRequest(Guid MeetingId, DateTime SessionStartUtc, string? Instructions);

public record AgentPersonalSettingsDto(bool AutoDelegate, bool MeetingBriefs, int BriefMinutes, bool CheckIns, bool GoogleConnected);
public record SaveAgentPersonalSettingsRequest(bool? AutoDelegate, bool? MeetingBriefs, int? BriefMinutes, bool? CheckIns);

// ---------------------------------------------------------------- command center

/// <summary>
/// One thing that needs the person, with the evidence for it (Why) - never an unexplained score. Kind: decide, change_request, check_in,
/// overdue, blocking, double_booked, at_risk, missed_commitments, conflict, unresolved. Severity: high, medium, low. Action: what the button does.
/// </summary>
public record CcAttentionDto(string Id, string Kind, string Severity, string Title, string? Detail, IReadOnlyList<string> Why, string? Link, Guid? ProjectId,
    string? ProjectKey, string? EntityId, string? Action, string? ActionAt = null);

public record CcCountsDto(int Attention, int ToDecide, int DueToday, int Overdue, int Blocking, int CheckIns, int MeetingsToday, int AtRisk);

public record CcChangeDto(string Kind, string Text, string? Link, DateTime At, string? ProjectKey);

public record CcHealthDto(Guid ProjectId, string Key, string Name, string Level, int Score, IReadOnlyList<string> Reasons, int Progress, int OverdueTasks,
    DateOnly? DueDate, DateOnly? ProjectedFinish, int? SlipDays, int Kept, int Missed);

public record CcReliabilityDto(int Kept, int Missed, int Open, int Moved);

public record CcWorkDto(Guid Id, Guid ProjectId, string Key, string Title, DateOnly? Due, string State, int? DaysLate, IReadOnlyList<string> Waiting);

public record CommandCenterDto(string Greeting, string Headline, DateTime Since, CcCountsDto Counts, IReadOnlyList<CcAttentionDto> Attention,
    IReadOnlyList<MyMeetingDto> Today, IReadOnlyList<CcChangeDto> Changes, IReadOnlyList<CcHealthDto> Health, CcReliabilityDto Reliability,
    IReadOnlyList<AgentCommitmentDto> CheckIns, IReadOnlyList<CcWorkDto> Owe, IReadOnlyList<AgentDelegationDto> Delegations);

// ---------------------------------------------------------------- registry and audit

public record AgentDecisionDto(Guid Id, Guid ProjectId, string ProjectKey, string ProjectName, string Title, string? Detail, string? Evidence, string? SourceLabel,
    string Status, DateTime At, AgentPersonRef? DecidedBy, DateTime? DecidedAt, string? TaskKey);

public record AgentAuditDto(Guid Id, Guid ProjectId, string ProjectKey, AgentFindingKind Kind, string Action, string Title, string? Key, string Status, bool Auto,
    AgentPersonRef? By, DateTime? At, int Confidence, string? Before, string? After, string? Evidence, string? SourceLabel, string? Error);
