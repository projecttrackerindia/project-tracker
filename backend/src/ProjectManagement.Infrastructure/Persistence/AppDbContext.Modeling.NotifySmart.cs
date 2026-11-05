using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Infrastructure.Persistence;

public partial class AppDbContext
{
    /// <summary>
    /// Smart notifications (a person's grouping and priority choices, their muted projects and threads), "Report a problem" reports and
    /// feature flags. Plain rows with ids, filtered to the workspace like every other tenant-owned row.
    /// </summary>
    private static void ConfigureNotifySmart(ModelBuilder b)
    {
        b.Entity<NotificationTuning>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId }).IsUnique();
            e.Property(x => x.PriorityOverrides).HasMaxLength(2000);
        });
        b.Entity<NotificationMute>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId, x.Scope, x.TargetId }).IsUnique();
            e.Property(x => x.Scope).HasMaxLength(16);
            e.Property(x => x.Label).HasMaxLength(200);
        });
        b.Entity<ProblemReport>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.CreatedAt });
            e.Property(x => x.Message).HasMaxLength(4000);
            e.Property(x => x.Route).HasMaxLength(500);
            e.Property(x => x.AppVersion).HasMaxLength(64);
            e.Property(x => x.UserAgent).HasMaxLength(500);
            e.Property(x => x.ConsoleTail).HasMaxLength(16000);
            e.Property(x => x.NetworkTail).HasMaxLength(16000);
            e.Property(x => x.ScreenshotKey).HasMaxLength(200);
            e.Property(x => x.Status).HasMaxLength(16);
        });
        b.Entity<FeatureFlag>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.Key, x.Scope, x.TargetId }).IsUnique();
            e.Property(x => x.Key).HasMaxLength(64);
            e.Property(x => x.Scope).HasMaxLength(16);
        });
    }
}
