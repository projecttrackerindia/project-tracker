using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Infrastructure.Persistence;

/// <summary>The Desk's omnichannel tables: settings, the inbound queue, engineers, assignments, ticket insights and voice sessions.</summary>
public partial class AppDbContext
{
    public DbSet<DeskSettings> DeskSettings => Set<DeskSettings>();
    public DbSet<DeskInboundEvent> DeskInboundEvents => Set<DeskInboundEvent>();
    public DbSet<DeskEngineer> DeskEngineers => Set<DeskEngineer>();
    public DbSet<DeskAssignment> DeskAssignments => Set<DeskAssignment>();
    public DbSet<DeskTicketInsight> DeskTicketInsights => Set<DeskTicketInsight>();
    public DbSet<DeskVoiceSession> DeskVoiceSessions => Set<DeskVoiceSession>();

    private static void ConfigureDesk(ModelBuilder b)
    {
        b.Entity<DeskSettings>(e =>
        {
            e.HasIndex(x => x.TenantId).IsUnique();
            e.Property(x => x.AckMessage).HasMaxLength(500);
            e.Property(x => x.VoiceLanguages).HasMaxLength(100);
            e.Property(x => x.ConsentPrompt).HasMaxLength(600);
            e.Property(x => x.TelephonyProvider).HasMaxLength(30);
        });
        b.Entity<DeskInboundEvent>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.Provider, x.ProviderMessageId }).IsUnique();
            e.HasIndex(x => new { x.Status, x.NextAttemptAt });
            e.Property(x => x.Provider).HasMaxLength(30);
            e.Property(x => x.ProviderMessageId).HasMaxLength(200);
            e.Property(x => x.MessageType).HasMaxLength(30);
            e.Property(x => x.Status).HasMaxLength(20);
            e.Property(x => x.LastError).HasMaxLength(500);
        });
        b.Entity<DeskEngineer>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId }).IsUnique();
            e.Property(x => x.Status).HasMaxLength(20);
            e.Property(x => x.Skills).HasMaxLength(1000);
            e.Property(x => x.Department).HasMaxLength(80);
        });
        b.Entity<DeskAssignment>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.WorkTaskId, x.Active });
            e.HasIndex(x => new { x.Active, x.AcceptDueAt });
            e.Property(x => x.Method).HasMaxLength(20);
            e.Property(x => x.Reason).HasMaxLength(300);
        });
        b.Entity<DeskTicketInsight>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.WorkTaskId }).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.NeedsReview });
            e.Property(x => x.Channel).HasMaxLength(20);
            e.Property(x => x.Category).HasMaxLength(80);
            e.Property(x => x.Priority).HasMaxLength(20);
            e.Property(x => x.Department).HasMaxLength(80);
            e.Property(x => x.Skills).HasMaxLength(300);
            e.Property(x => x.Summary).HasMaxLength(2000);
            e.Property(x => x.Source).HasMaxLength(20);
            e.Property(x => x.Organization).HasMaxLength(120);
        });
        b.Entity<DeskVoiceSession>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.WorkTaskId });
            e.HasIndex(x => x.RetainUntil);
            e.Property(x => x.Channel).HasMaxLength(20);
            e.Property(x => x.Direction).HasMaxLength(20);
            e.Property(x => x.Language).HasMaxLength(10);
            e.Property(x => x.Status).HasMaxLength(20);
            e.Property(x => x.Summary).HasMaxLength(2000);
            e.Property(x => x.RecordingKey).HasMaxLength(300);
            e.Property(x => x.RecordingContentType).HasMaxLength(100);
            e.Property(x => x.Provider).HasMaxLength(30);
            e.Property(x => x.ProviderCallId).HasMaxLength(200);
        });
    }
}
