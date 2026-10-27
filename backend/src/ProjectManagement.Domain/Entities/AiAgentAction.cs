using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>
/// The AI action log: one change an AI agent made, or - at "Ask first" - wants to make and is waiting for a person in the Home inbox.
/// <c>{agent, action, target, approvedBy, at}</c> as in the v2 spec: <see cref="Agent"/> is project, notetaker, mail, triage or timesheet;
/// <see cref="ApprovedBy"/> is null when the agent acted on its own (Auto). A proposal carries in <see cref="Payload"/> exactly what approving
/// it applies, so nothing is worked out again at that moment. Shown in the item's Activity (by <see cref="TargetId"/>) and, through an
/// activity entry written when it is applied, in the project's activity.
/// </summary>
public class AiAgentAction : TenantEntity, ITenantScoped
{
    /// <summary>project, notetaker, mail, triage or timesheet.</summary>
    public string Agent { get; set; } = "";
    /// <summary>What it does, e.g. create_task, set_priority, assign, log_time, apply_finding.</summary>
    public string Action { get; set; } = "";
    /// <summary>task, issue, action, ticket, project or timesheet.</summary>
    public string TargetType { get; set; } = "";
    /// <summary>The work item (or project, or person's week) it changes or created; null for a proposal that creates something new.</summary>
    public Guid? TargetId { get; set; }
    /// <summary>The target's key when it has one (PAY-12, WT-5).</summary>
    public string? TargetKey { get; set; }
    public Guid? ProjectId { get; set; }
    /// <summary>One line a person reads: "Set priority to High and assign Ravi on WT-5".</summary>
    public string Title { get; set; } = "";
    /// <summary>proposed (waits in the inbox), applied, dismissed or failed.</summary>
    public string Status { get; set; } = "proposed";
    /// <summary>Who decides a proposal (their inbox shows it).</summary>
    public Guid? ForUserId { get; set; }
    /// <summary>Who approved it; null when the agent applied it by itself (Auto).</summary>
    public Guid? ApprovedBy { get; set; }
    /// <summary>When it was applied (or dismissed).</summary>
    public DateTime? At { get; set; }
    /// <summary>JSON: what approving applies (the agent's own shape).</summary>
    public string? Payload { get; set; }
    /// <summary>The project agent's proposal it came from, when it came from one.</summary>
    public Guid? FindingId { get; set; }
    public string? Error { get; set; }
    /// <summary>Where the row links to ("/work?item=…").</summary>
    public string? Link { get; set; }
}
