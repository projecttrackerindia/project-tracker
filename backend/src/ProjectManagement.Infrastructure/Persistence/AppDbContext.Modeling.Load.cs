using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Infrastructure.Persistence;

public partial class AppDbContext
{
    /// <summary>Load: a task's rough size (S/M/L/XL) and each person's "swamped / room" signal per week.</summary>
    private static void ConfigureLoad(ModelBuilder b)
    {
        b.Entity<TaskItem>(e => e.Property(x => x.Size).HasMaxLength(2));
        b.Entity<LoadSignal>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId, x.WeekStart }).IsUnique();
            e.Property(x => x.Signal).HasMaxLength(16);
        });
    }
}
