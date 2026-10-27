using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Infrastructure.Persistence;

public partial class AppDbContext
{
    /// <summary>Saved views of lists, public holidays for capacity, and the public status page of a workspace's APIs. Plain rows with ids (no foreign keys).</summary>
    private static void ConfigurePlatformViews(ModelBuilder b)
    {
        b.Entity<SavedView>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.Scope, x.OwnerId });
            e.Property(x => x.Scope).HasMaxLength(20);
            e.Property(x => x.Name).HasMaxLength(80);
            e.Property(x => x.ConfigJson).HasMaxLength(8000);
        });
        b.Entity<Holiday>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.Date, x.Name }).IsUnique();
            e.Property(x => x.Name).HasMaxLength(120);
            e.Property(x => x.Region).HasMaxLength(60);
        });
        b.Entity<StatusPage>(e =>
        {
            e.HasIndex(x => x.TenantId).IsUnique();
            e.HasIndex(x => x.Slug).IsUnique();
            e.Property(x => x.Slug).HasMaxLength(60);
            e.Property(x => x.Title).HasMaxLength(120);
            e.Property(x => x.ComponentsJson).HasMaxLength(8000);
        });
    }
}
