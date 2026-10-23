using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>
/// "Tell me when…": one person asked to be told once when something happens to a piece of work or a project - it is done, it reaches a
/// status, it becomes overdue, or it slips past a date. Checked in the background; it fires once and then stops. Private to its owner.
/// </summary>
public class AiWatch : TenantEntity, ITenantScoped
{
    public Guid UserId { get; set; }
    /// <summary>"done", "status", "overdue" or "slips".</summary>
    public string Kind { get; set; } = "done";
    /// <summary>"Task", "Operational", "ActionItem" or "Project".</summary>
    public string TargetType { get; set; } = "Task";
    public Guid TargetId { get; set; }
    public string TargetKey { get; set; } = "";
    public string TargetTitle { get; set; } = "";
    /// <summary>The project the work belongs to (or the project itself), so the watch follows the person's project access.</summary>
    public Guid? ProjectId { get; set; }
    /// <summary>For "status": the status name to wait for.</summary>
    public string? Status { get; set; }
    /// <summary>For "slips": the date it must not go past.</summary>
    public DateOnly? OnDate { get; set; }
    public string? Note { get; set; }
    public string? Link { get; set; }
    /// <summary>"active", "fired", "stopped" (by the person) or "ended" (expired, or the work is gone).</summary>
    public string State { get; set; } = "active";
    public DateTime ExpiresAt { get; set; }
    public DateTime? FiredAt { get; set; }
    /// <summary>What was found when it fired ("ATL-12 is Done").</summary>
    public string? Outcome { get; set; }
    public DateTime? LastCheckedAt { get; set; }
}
