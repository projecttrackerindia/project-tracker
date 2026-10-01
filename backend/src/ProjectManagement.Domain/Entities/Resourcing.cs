using ProjectManagement.Domain.Common;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Domain.Enums
{
    /// <summary>Where a person's week of time stands. A week nobody has submitted has no record at all (it is a draft).</summary>
    public enum TimesheetStatus { Submitted, Approved, Rejected }
}

namespace ProjectManagement.Domain.Entities
{
    /// <summary>
    /// One person's week (Monday to Sunday) sent for approval. While it is Submitted or Approved the week is locked: nobody can log, change
    /// or delete time in it until a reviewer returns it (Rejected) or the person withdraws the submission. The totals are a snapshot taken
    /// when it was submitted, so a reviewer approves exactly what they saw.
    /// </summary>
    public class TimesheetApproval : TenantEntity, ITenantScoped
    {
        public Guid UserId { get; set; }
        /// <summary>The Monday the week starts on.</summary>
        public DateOnly WeekStart { get; set; }
        public TimesheetStatus Status { get; set; } = TimesheetStatus.Submitted;
        public int TotalMinutes { get; set; }
        public int BillableMinutes { get; set; }
        /// <summary>What the person said when submitting ("Friday was a public holiday").</summary>
        public string? Note { get; set; }
        public DateTime SubmittedAt { get; set; }
        public Guid? ReviewerId { get; set; }
        public DateTime? ReviewedAt { get; set; }
        /// <summary>Why it was returned (required when rejecting), or an optional remark on approval.</summary>
        public string? ReviewNote { get; set; }
    }

    /// <summary>
    /// A service-level target for operational work: how soon someone must respond to, and resolve, a work task of a given priority.
    /// Rows without a work type are the workspace's defaults; rows with one override the defaults for that type. Either target may be
    /// empty (not measured). Targets are in calendar minutes and are fixed on a work task when it is raised or its priority or type changes.
    /// </summary>
    public class SlaPolicy : TenantEntity, ITenantScoped
    {
        public Guid? WorkTypeId { get; set; }
        public Priority Priority { get; set; }
        public int? ResponseMinutes { get; set; }
        public int? ResolutionMinutes { get; set; }
    }
}
