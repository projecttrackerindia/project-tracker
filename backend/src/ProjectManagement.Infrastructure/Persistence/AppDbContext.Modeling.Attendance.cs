using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Infrastructure.Persistence;

public partial class AppDbContext
{
    /// <summary>Check-in / check-out days (one per person per organization-local date) and the workspace's attendance rules. Plain rows with ids.</summary>
    private static void ConfigureAttendance(ModelBuilder b)
    {
        b.Entity<AttendanceDay>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId, x.Date }).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.Date });
            e.Property(x => x.Mode).HasMaxLength(16);
            e.Property(x => x.Place).HasMaxLength(120);
            e.Property(x => x.Note).HasMaxLength(300);
            e.Property(x => x.Source).HasMaxLength(16);
        });
        b.Entity<AttendancePolicy>(e =>
        {
            e.HasIndex(x => x.TenantId).IsUnique();
            e.Property(x => x.HoursSource).HasMaxLength(16);
            e.Property(x => x.WorkDays).HasMaxLength(20);
            e.Property(x => x.AllowedModes).HasMaxLength(60);
        });
    }
}
