using ProjectManagement.Domain.Common;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Domain.Enums
{
    public enum SprintStatus { Planned, Active, Completed }
    public enum AutomationTrigger { TaskCreated, StatusChanged, PriorityChanged }
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
        public Guid TaskId { get; set; }
        public Guid ProjectId { get; set; }
        public Guid UserId { get; set; }
        public DateOnly WorkDate { get; set; }
        public int Minutes { get; set; }
        public string? Note { get; set; }
        /// <summary>Set for entries recorded with the timer; null for entries typed in by hand.</summary>
        public DateTime? StartedAt { get; set; }
        public DateTime? EndedAt { get; set; }

        public bool IsRunning => StartedAt is not null && EndedAt is null;

        public User? User { get; set; }
    }

    /// <summary>"When this happens to a task, do that" (spec section on automation). Rules belong to one project.</summary>
    public class AutomationRule : TenantEntity, ITenantScoped
    {
        public Guid ProjectId { get; set; }
        public string Name { get; set; } = "";
        public bool IsEnabled { get; set; } = true;

        public AutomationTrigger Trigger { get; set; }
        /// <summary>StatusChanged: only when the task moves into this status (null = any status).</summary>
        public Guid? WhenStatusId { get; set; }
        /// <summary>PriorityChanged: only when the task gets this priority (null = any).</summary>
        public Priority? WhenPriority { get; set; }

        public AutomationAction Action { get; set; }
        public Priority? ActionPriority { get; set; }
        public Guid? ActionStatusId { get; set; }
        public Guid? ActionLabelId { get; set; }
        public AutomationTarget ActionTarget { get; set; } = AutomationTarget.User;
        public Guid? ActionUserId { get; set; }
        public string? ActionText { get; set; }

        public int RunCount { get; set; }
        public DateTime? LastRunAt { get; set; }
    }
}
