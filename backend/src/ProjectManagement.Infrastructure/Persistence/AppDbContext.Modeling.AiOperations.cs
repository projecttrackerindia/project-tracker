using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Infrastructure.Persistence;

public partial class AppDbContext
{
    private static void ConfigureAiOperations(ModelBuilder b)
    {
        b.Entity<AiJob>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId, x.IdempotencyKey }).IsUnique();
            e.HasIndex(x => new { x.Status, x.AvailableAt, x.Priority });
            e.HasIndex(x => new { x.TenantId, x.UserId, x.CreatedAt });
            e.Property(x => x.Kind).HasMaxLength(32);
            e.Property(x => x.Title).HasMaxLength(120);
            e.Property(x => x.IdempotencyKey).HasMaxLength(120);
            e.Property(x => x.Status).HasMaxLength(20);
            e.Property(x => x.ErrorCode).HasMaxLength(64);
            e.Property(x => x.AccessFingerprint).HasMaxLength(64);
        });
        b.Entity<AiSchedule>(e =>
        {
            e.HasIndex(x => new { x.Enabled, x.NextRunAt });
            e.HasIndex(x => new { x.TenantId, x.UserId });
            e.Property(x => x.Kind).HasMaxLength(32);
            e.Property(x => x.Title).HasMaxLength(120);
        });
    }
}
