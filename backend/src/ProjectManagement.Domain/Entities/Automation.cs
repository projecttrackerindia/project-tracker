using ProjectManagement.Domain.Common;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Domain.Enums
{
    public enum SprintStatus { Planned, Active, Completed }
    /// <summary>Event triggers run when a task changes; DueSoon, Overdue and Stale are checked on a schedule (with <c>TriggerDays</c>).</summary>
    public enum AutomationTrigger { TaskCreated, StatusChanged, PriorityChanged, DueSoon, Overdue, Stale }
    public enum AutomationAction { SetPriority, SetAssignee, MoveToStatus, AddLabel, Notify, AddComment }
    /// <summary>Who an action refers to: a chosen person, or whoever reported / is assigned the task.</summary>
    public enum AutomationTarget { User, Reporter, Assignee }
}

namespace ProjectManagement.Domain.Entities
{
    /// <summary>
    /// Time somebody spent on a task. A finished entry has <see cref="Minutes"/>; a running timer has no <see cref="EndedAt"/> yet
    /// and its minutes are filled in when it stops. Each person has at most one running timer.
    /// </summary>
    public class TimeEntry : TenantEntity, ITenantScoped
    {
        /// <summary>The project task the time was spent on. Exactly one of <see cref="TaskId"/> and <see cref="WorkTaskId"/> is set.</summary>
        public Guid? TaskId { get; set; }
        /// <summary>The work task (operational work or an action item) the time was spent on.</summary>
        public Guid? WorkTaskId { get; set; }
        /// <summary>The task's project, or the work task's related project when it has one (for project time reports and filters).</summary>
        public Guid? ProjectId { get; set; }
        public Guid UserId { get; set; }
        public DateOnly WorkDate { get; set; }
        public int Minutes { get; set; }
        public string? Note { get; set; }
        /// <summary>Set for entries recorded with the timer; null for entries typed in by hand.</summary>
        public DateTime? StartedAt { get; set; }
        public DateTime? EndedAt { get; set; }
        /// <summary>Time that can be charged to a client. Starts from the project's setting and can be changed per entry.</summary>
        public bool Billable { get; set; }

        public bool IsRunning => StartedAt is not null && EndedAt is null;

        public User? User { get; set; }
    }

    /// <summary>
    /// "When this happens to a task, do that" (spec section on automation). A rule belongs to one project, or - with no project - to the
    /// whole workspace, where statuses are named by category ("a Done status") because each project has its own. A rule can do several
    /// things: the first action is in the Action* columns, the rest in <see cref="MoreActionsJson"/>.
    /// </summary>
    public class AutomationRule : TenantEntity, ITenantScoped
    {
        public Guid? ProjectId { get; set; }
        public string Name { get; set; } = "";
        public bool IsEnabled { get; set; } = true;

        public AutomationTrigger Trigger { get; set; }
        /// <summary>StatusChanged: only when the task moves into this status (null = any status).</summary>
        public Guid? WhenStatusId { get; set; }
        /// <summary>PriorityChanged: only when the task gets this priority (null = any).</summary>
        public Priority? WhenPriority { get; set; }
        /// <summary>Workspace rules, StatusChanged: only when the new status is in this category (null = any).</summary>
        public StatusCategory? WhenStatusCategory { get; set; }
        /// <summary>DueSoon: this many days before the due date. Overdue: this many days after it. Stale: no change for this many days.</summary>
        public int? TriggerDays { get; set; }

        public AutomationAction Action { get; set; }
        public Priority? ActionPriority { get; set; }
        public Guid? ActionStatusId { get; set; }
        /// <summary>Workspace rules, MoveToStatus: the project's first status in this category.</summary>
        public StatusCategory? ActionStatusCategory { get; set; }
        public Guid? ActionLabelId { get; set; }
        public AutomationTarget ActionTarget { get; set; } = AutomationTarget.User;
        public Guid? ActionUserId { get; set; }
        public string? ActionText { get; set; }
        /// <summary>The second and later actions, as JSON (the same fields as the first).</summary>
        public string? MoreActionsJson { get; set; }

        public int RunCount { get; set; }
        public DateTime? LastRunAt { get; set; }
    }

    /// <summary>A scheduled rule already ran for this task in this period (a due date, or a day without changes), so it does not run again.</summary>
    public class AutomationRun : TenantEntity, ITenantScoped
    {
        public Guid RuleId { get; set; }
        public Guid TaskId { get; set; }
        public string Period { get; set; } = "";
    }
}
