using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Infrastructure.Persistence;

public partial class AppDbContext
{
    /// <summary>
    /// Quality: test cases, runs and one result per case in a run. Plain rows with ids (no foreign keys), like the AI action log; a case or a
    /// run on a project follows who may see that project (the automatic query filter on ProjectId).
    /// </summary>
    private static void ConfigureQuality(ModelBuilder b)
    {
        b.Entity<TestCase>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.Number }).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.ProjectId });
            e.Property(x => x.Key).HasMaxLength(20);
            e.Property(x => x.Title).HasMaxLength(300);
            e.Property(x => x.Steps).HasMaxLength(8000);
            e.Property(x => x.Expected).HasMaxLength(2000);
            e.Property(x => x.Priority).HasMaxLength(16);
            e.Property(x => x.Tags).HasMaxLength(300);
        });
        b.Entity<TestRun>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.ProjectId, x.CreatedAt });
            e.Property(x => x.Name).HasMaxLength(120);
            e.Property(x => x.Environment).HasMaxLength(40);
            e.Property(x => x.Build).HasMaxLength(40);
            e.Property(x => x.Status).HasMaxLength(16);
        });
        b.Entity<TestResult>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.RunId, x.CaseId }).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.CaseId });
            e.Property(x => x.Status).HasMaxLength(16);
            e.Property(x => x.Actual).HasMaxLength(2000);
            e.Property(x => x.Evidence).HasMaxLength(16000);
        });
    }
}
