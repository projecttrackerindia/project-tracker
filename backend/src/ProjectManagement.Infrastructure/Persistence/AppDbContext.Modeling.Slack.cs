using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Infrastructure.Persistence;

public partial class AppDbContext
{
    public DbSet<SlackConnection> SlackConnections => Set<SlackConnection>();
    public DbSet<SlackOAuthAttempt> SlackOAuthAttempts => Set<SlackOAuthAttempt>();
    public DbSet<SlackEventReceipt> SlackEventReceipts => Set<SlackEventReceipt>();

    private static void ConfigureSlack(ModelBuilder b)
    {
        b.Entity<SlackConnection>(e =>
        {
            e.HasIndex(x => x.TenantId).IsUnique();
            e.HasIndex(x => x.TeamId).IsUnique();
            e.Property(x => x.TeamId).HasMaxLength(40);
            e.Property(x => x.TeamName).HasMaxLength(200);
            e.Property(x => x.AppId).HasMaxLength(40);
            e.Property(x => x.BotUserId).HasMaxLength(40);
            e.Property(x => x.Scopes).HasMaxLength(1000);
            e.Property(x => x.LastError).HasMaxLength(100);
        });
        b.Entity<SlackEventReceipt>(e =>
        {
            e.HasIndex(x => new { x.AppId, x.TeamId, x.EventId }).IsUnique();
            e.HasIndex(x => x.ReceivedAt);
            e.Property(x => x.AppId).HasMaxLength(40);
            e.Property(x => x.TeamId).HasMaxLength(40);
            e.Property(x => x.EventId).HasMaxLength(128);
        });
        b.Entity<SlackOAuthAttempt>(e =>
        {
            e.HasIndex(x => x.StateHash).IsUnique();
            e.HasIndex(x => x.ExpiresAt);
            e.Property(x => x.StateHash).HasMaxLength(64);
            e.Property(x => x.BrowserHash).HasMaxLength(64);
            e.Property(x => x.ReturnPath).HasMaxLength(200);
        });
    }
}
