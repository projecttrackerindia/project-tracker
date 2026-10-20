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

namespace ProjectManagement.Domain.Entities
{
    /// <summary>
    /// How the workspace runs Operations: whether service-level clocks count business hours only (and which hours and days, in which time
    /// zone), and who hears about it when a resolution target is missed. One row per workspace; none means calendar hours and no escalation.
    /// </summary>
    public class OperationsSettings : TenantEntity, ITenantScoped
    {
        public bool BusinessHoursOnly { get; set; }
        /// <summary>Minutes after midnight the working day starts and ends (09:00 to 18:00 by default).</summary>
        public int DayStartMinutes { get; set; } = 9 * 60;
        public int DayEndMinutes { get; set; } = 18 * 60;
        /// <summary>Working days as bits, Monday = 1 ... Sunday = 64 (Monday to Friday = 31).</summary>
        public int WorkDays { get; set; } = 31;
        /// <summary>The zone business hours are in; empty = the workspace's default zone.</summary>
        public string? TimeZone { get; set; }
        public bool EscalateOnBreach { get; set; }
        /// <summary>Who is told when a resolution target is missed (a team lead); a routing rule's own contact wins for its work type.</summary>
        public Guid? EscalateToUserId { get; set; }
    }

    /// <summary>
    /// Who new operational work goes to when it is raised without an assignee: for one work type (or, without a type, for every type that has
    /// no rule of its own), taking turns (round_robin) or picking whoever has the least open work (least_loaded) among the chosen people.
    /// </summary>
    public class WorkRoutingRule : TenantEntity, ITenantScoped
    {
        public Guid? WorkTypeId { get; set; }
        public string Mode { get; set; } = "round_robin";
        /// <summary>The people work is shared between, as a JSON array of user ids, in turn order.</summary>
        public string MemberIds { get; set; } = "[]";
        public Guid? LastAssignedUserId { get; set; }
        /// <summary>Who hears about a missed resolution target on this type (overrides the workspace's escalation contact).</summary>
        public Guid? EscalateToUserId { get; set; }
        public bool Enabled { get; set; } = true;
    }
}
