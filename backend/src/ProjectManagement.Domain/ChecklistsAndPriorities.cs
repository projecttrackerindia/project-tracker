using ProjectManagement.Domain.Common;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Domain.Entities
{
    /// <summary>One line of a task's checklist: a small step that is either done or not.</summary>
    public class ChecklistItem : TenantEntity, ITenantScoped
    {
        public Guid TaskId { get; set; }
        public string Title { get; set; } = "";
        public bool IsDone { get; set; }
        public double Position { get; set; }
        public DateTime? CompletedAt { get; set; }
        public Guid? CompletedBy { get; set; }
    }

    /// <summary>
    /// How a workspace names and colours one of the four priority levels (for example Critical shown as "P0" in red). The level itself
    /// stays fixed so sorting, reports and automation rules keep meaning the same thing everywhere.
    /// </summary>
    public class PrioritySetting : TenantEntity, ITenantScoped
    {
        public Priority Level { get; set; }
        public string Name { get; set; } = "";
        public string Color { get; set; } = "#94a3b8";
    }
}
