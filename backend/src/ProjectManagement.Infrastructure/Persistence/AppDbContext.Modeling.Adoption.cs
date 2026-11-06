using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Infrastructure.Persistence;

public partial class AppDbContext
{
    /// <summary>Adoption: import batches (for undo), client portal links, project inboxes and two-way calendar sync. Plain rows with ids, filtered to the workspace.</summary>
    private static void ConfigureAdoption(ModelBuilder b)
    {
        b.Entity<ImportBatch>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.ProjectId, x.CreatedAt });
            e.Property(x => x.Source).HasMaxLength(16);
            e.Property(x => x.FileName).HasMaxLength(200);
        });
        b.Entity<ClientPortalLink>(e =>
        {
            e.HasIndex(x => x.TokenHash).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.ProjectId });
            e.Property(x => x.Name).HasMaxLength(120);
            e.Property(x => x.TokenHash).HasMaxLength(64);
            e.Property(x => x.TokenPrefix).HasMaxLength(12);
            e.Property(x => x.Fields).HasMaxLength(200);
        });
        b.Entity<ProjectInbox>(e =>
        {
            e.HasIndex(x => x.Token).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.ProjectId }).IsUnique();
            e.Property(x => x.Token).HasMaxLength(24);
            e.Property(x => x.LastError).HasMaxLength(300);
        });
        b.Entity<CalendarSyncLink>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId, x.Provider }).IsUnique();
            e.HasIndex(x => x.ChannelId);
            e.Property(x => x.Provider).HasMaxLength(16);
            e.Property(x => x.ConflictRule).HasMaxLength(16);
            e.Property(x => x.DeltaToken).HasMaxLength(4000);
            e.Property(x => x.ChannelId).HasMaxLength(300);
            e.Property(x => x.ChannelSecret).HasMaxLength(64);
            e.Property(x => x.LastError).HasMaxLength(300);
        });
        b.Entity<CalendarSyncItem>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.LinkId, x.RemoteId });
            e.HasIndex(x => new { x.TenantId, x.LinkId, x.Kind, x.LocalId });
            e.Property(x => x.Kind).HasMaxLength(16);
            e.Property(x => x.Title).HasMaxLength(200);
            e.Property(x => x.RemoteId).HasMaxLength(1000);
            e.Property(x => x.RemoteVersion).HasMaxLength(200);
        });
    }
}
