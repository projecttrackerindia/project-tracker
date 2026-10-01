using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Enums
{
    /// <summary>
    /// Where a test finding stands. Observed is what a tester marks as "Observed / Failed"; the developer works on it (InProgress),
    /// says it is Fixed, and the tester confirms it (Resolved) - or sends it back to Observed if it still fails.
    /// </summary>
    public enum IssueStatus { Observed, InProgress, Fixed, Resolved }
}

namespace ProjectManagement.Domain.Entities
{
    using ProjectManagement.Domain.Enums;

    /// <summary>
    /// Something a tester found while checking a stage of a project (a failed test, an error, a feature that does not work as expected).
    /// A stage cannot be completed while any of its issues is unresolved, so the project only moves on once testing has passed.
    /// </summary>
    public class StageIssue : TenantEntity, ITenantScoped
    {
        public Guid ProjectId { get; set; }
        /// <summary>The stage the issue was found in. Null when that stage was deleted afterwards (the issue stays as history).</summary>
        public Guid? StageId { get; set; }
        /// <summary>Position in the project's list of issues (1, 2, 3 ...); shown as PRJ-I3.</summary>
        public int Number { get; set; }
        public string Title { get; set; } = "";
        /// <summary>What was done, what was expected and what happened instead.</summary>
        public string? Details { get; set; }
        public Priority Severity { get; set; } = Priority.Medium;
        public IssueStatus Status { get; set; } = IssueStatus.Observed;
        public Guid ReporterId { get; set; }
        /// <summary>Who is fixing it.</summary>
        public Guid? AssigneeId { get; set; }
        public DateTime? ResolvedAt { get; set; }
        public Guid? ResolvedBy { get; set; }
    }

    /// <summary>One step in the life of an issue: reported, assigned, moved to another status, edited. Together they are the issue's history.</summary>
    public class StageIssueEvent : TenantEntity, ITenantScoped
    {
        public Guid IssueId { get; set; }
        /// <summary>reported, status, assigned or edited.</summary>
        public string Kind { get; set; } = "";
        public IssueStatus? FromStatus { get; set; }
        public IssueStatus? ToStatus { get; set; }
        public string? Note { get; set; }
        public Guid? ActorId { get; set; }
    }
}
