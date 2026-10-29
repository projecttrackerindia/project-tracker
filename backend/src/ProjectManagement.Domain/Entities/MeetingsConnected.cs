using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>
/// One session of a repeating meeting changed on its own ("this occurrence"): moved to another time, renamed, or cancelled. The series keeps
/// its rule; expanding it applies these on top. Only meetings held by Project Tracker itself (a Google or Outlook series is changed in that
/// calendar, which owns the invitation).
/// </summary>
public class MeetingOccurrenceChange : TenantEntity, ITenantScoped
{
    /// <summary>"p:{id}" or "w:{id}".</summary>
    public string MeetingRef { get; set; } = "";
    public Guid MeetingId { get; set; }
    /// <summary>The session as the rule places it (UTC): which one this changes.</summary>
    public DateTime OccurrenceStartUtc { get; set; }
    public bool IsCancelled { get; set; }
    public DateTime? NewStartUtc { get; set; }
    public DateTime? NewEndUtc { get; set; }
    public string? Title { get; set; }
}

/// <summary>
/// "Log 45m to UPI AutoPay?": time an attendee spent in a session of a project meeting, proposed when the session ends and only logged when
/// they confirm it (Status Proposed → Logged or Dismissed; Later snoozes it). Never logged without that tap.
/// </summary>
public class MeetingTimeProposal : TenantEntity, ITenantScoped
{
    public Guid UserId { get; set; }
    public string MeetingRef { get; set; } = "";
    public Guid MeetingId { get; set; }
    public string MeetingTitle { get; set; } = "";
    /// <summary>The meeting's project: where the time goes (and who may see the proposal).</summary>
    public Guid ProjectId { get; set; }
    public DateTime OccurrenceStartUtc { get; set; }
    public DateTime OccurrenceEndUtc { get; set; }
    /// <summary>The meeting's length: what is proposed (the person can change it before logging).</summary>
    public int Minutes { get; set; }
    /// <summary>Proposed, Logged or Dismissed.</summary>
    public string Status { get; set; } = "Proposed";
    public DateTime? SnoozedUntil { get; set; }
    public Guid? TimeEntryId { get; set; }
    public DateTime? DecidedAt { get; set; }
    /// <summary>Why it was dismissed ("didnt_attend").</summary>
    public string? DismissReason { get; set; }
}

/// <summary>
/// A pass over a meeting series' action items at one session ("Review action items"): who started it, the decisions made (as
/// <see cref="MeetingReviewDecision"/> rows) and the minutes written from them once finished. Two people reviewing at once share it.
/// </summary>
public class MeetingReviewSession : TenantEntity, ITenantScoped
{
    /// <summary>The series reviewed ("p:{id}" / "w:{id}", the series' first meeting).</summary>
    public string SeriesRef { get; set; } = "";
    public string MeetingTitle { get; set; } = "";
    public DateTime OccurrenceStartUtc { get; set; }
    public Guid StartedBy { get; set; }
    public DateTime StartedAt { get; set; }
    public DateTime? FinishedAt { get; set; }
    /// <summary>The minutes as drafted from the decisions and edited before sending.</summary>
    public string? Minutes { get; set; }
    public DateTime? SentAt { get; set; }
    public Guid? MinutesDocumentId { get; set; }
}

/// <summary>
/// One decision on one work item in a review: done, carry (due moved to the next session), replan (owner and/or due, with a reason), convert
/// (made into a project task) or drop (cancelled, with a reason). What it changed is kept so Undo can put it back until the minutes are sent.
/// </summary>
public class MeetingReviewDecision : TenantEntity, ITenantScoped
{
    public Guid SessionId { get; set; }
    public Guid WorkItemId { get; set; }
    public string ItemTitle { get; set; } = "";
    /// <summary>done, carry, replan, convert or drop.</summary>
    public string Decision { get; set; } = "";
    public string? Reason { get; set; }
    public Guid? FromOwnerId { get; set; }
    public Guid? ToOwnerId { get; set; }
    public DateOnly? FromDue { get; set; }
    public DateOnly? ToDue { get; set; }
    /// <summary>The work item's status before (WorkTaskStatus name), for Undo.</summary>
    public string? FromStatus { get; set; }
    /// <summary>Convert: the project task it became.</summary>
    public Guid? ConvertedTaskId { get; set; }
    public Guid DecidedBy { get; set; }
    public DateTime DecidedAt { get; set; }
    public DateTime? UndoneAt { get; set; }
}
