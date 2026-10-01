using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Enums
{
    /// <summary>Where a project action item stands. (Action items are small follow-ups; they do not go through a project's task workflow.)</summary>
    public enum ActionItemStatus { Open, InProgress, Completed }
}

namespace ProjectManagement.Domain.Entities
{
    using ProjectManagement.Domain.Enums;

    /// <summary>
    /// A follow-up for a project that is not a task on its timeline: something agreed in a status meeting ("get the client's sign-off", "confirm the
    /// vendor date"), with an owner, a due date and a priority. Shown on the Project Status page.
    /// </summary>
    public class ActionItem : TenantEntity, ITenantScoped
    {
        public Guid ProjectId { get; set; }
        public string Title { get; set; } = "";
        public string? Details { get; set; }
        public Guid? AssigneeId { get; set; }
        public DateOnly? DueDate { get; set; }
        public Priority Priority { get; set; } = Priority.Medium;
        public ActionItemStatus Status { get; set; } = ActionItemStatus.Open;
        public DateTime? CompletedAt { get; set; }
        public Guid? CompletedBy { get; set; }
    }
}
