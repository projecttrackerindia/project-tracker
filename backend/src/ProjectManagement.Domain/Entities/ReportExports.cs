using ProjectManagement.Domain.Common;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Domain.Enums
{
    /// <summary>Project = task list plus progress/status (the old Tasks + Summary, merged); Workload = per-member open/overdue/done;
    /// Timesheet = logged time. Numeric values are stable (matter for rows already stored): Project keeps Tasks' old 0, Workload
    /// takes Summary's old 1 (a Summary report generated before this change would now be mislabeled "Workload" in the list, but
    /// report exports only live 7 days, so nothing long-lived is affected), Timesheet is unchanged at 2. WorkTasks = operational work
    /// tasks (the same columns as the instant "export this list" button, which uses the same writer).</summary>
    public enum ReportKind { Project, Workload, Timesheet, WorkTasks }
    public enum ReportFormat { Csv, Xlsx, Pdf }
    public enum ReportExportStatus { Queued, Running, Ready, Failed }
}

namespace ProjectManagement.Domain.Entities
{
    /// <summary>
    /// A report someone asked for. It is generated in the background, under that person's own access rights, and kept for a few days
    /// so it can be downloaded later.
    /// </summary>
    public class ReportExport : TenantEntity, ITenantScoped
    {
        public Guid UserId { get; set; }
        public ReportKind Kind { get; set; }
        public ReportFormat Format { get; set; }
        public ReportExportStatus Status { get; set; } = ReportExportStatus.Queued;
        /// <summary>Limits a Project report to one project, or null for everything the person can see.</summary>
        public Guid? ProjectId { get; set; }
        /// <summary>Limits a Workload or Timesheet report to one person, or null for everyone the requester may see
        /// (themself, their reporting line, or the whole workspace, depending on their access).</summary>
        public Guid? TargetUserId { get; set; }
        /// <summary>Length of the period for reports that have one (Project, Timesheet).</summary>
        public int Days { get; set; } = 30;

        public string? FileName { get; set; }
        public string? StorageKey { get; set; }
        public long SizeBytes { get; set; }
        public string? Error { get; set; }
        public DateTime? StartedAt { get; set; }
        public DateTime? CompletedAt { get; set; }
        public DateTime? ExpiresAt { get; set; }
    }
}
