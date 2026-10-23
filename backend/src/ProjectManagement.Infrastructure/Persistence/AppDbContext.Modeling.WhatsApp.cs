using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Infrastructure.Persistence;

public partial class AppDbContext
{
    public DbSet<WhatsAppDelivery> WhatsAppDeliveries => Set<WhatsAppDelivery>();
    public DbSet<WhatsAppContactLink> WhatsAppContactLinks => Set<WhatsAppContactLink>();
    public DbSet<WhatsAppConnection> WhatsAppConnections => Set<WhatsAppConnection>();
    public DbSet<WhatsAppInboundReceipt> WhatsAppInboundReceipts => Set<WhatsAppInboundReceipt>();

    private static void ConfigureWhatsApp(ModelBuilder b)
    {
        b.Entity<WhatsAppDelivery>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.NotificationId }).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.State, x.AvailableAt });
            e.HasIndex(x => new { x.TenantId, x.State, x.LeaseUntil });
            e.HasIndex(x => new { x.TenantId, x.State, x.ExpiresAt });
            e.HasIndex(x => new { x.TenantId, x.CreatedAt });
            e.HasIndex(x => new { x.TenantId, x.UserId, x.AttemptedAt });
            e.HasIndex(x => new { x.TenantId, x.AttemptedAt });
            e.HasIndex(x => new { x.TenantId, x.CallbackTag }).IsUnique();
            e.HasIndex(x => new { x.ConnectionId, x.ProviderMessageId }).IsUnique();
            e.Property(x => x.Category).HasMaxLength(30); e.Property(x => x.ResourceKind).HasMaxLength(20);
            e.Property(x => x.State).HasMaxLength(20); e.Property(x => x.Reason).HasMaxLength(60);
            e.Property(x => x.ConfigurationHash).HasMaxLength(64); e.Property(x => x.RecipientHash).HasMaxLength(64);
            e.Property(x => x.CallbackTag).HasMaxLength(100); e.Property(x => x.ProviderMessageId).HasMaxLength(200);
        });
        b.Entity<WhatsAppContactLink>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId }).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.PhoneHash }).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.ChallengeHash });
            e.Property(x => x.PhoneHash).HasMaxLength(64);
            e.Property(x => x.ConfigurationHash).HasMaxLength(64);
            e.Property(x => x.ChallengeHash).HasMaxLength(64);
            e.Property(x => x.ConsentVersion).HasMaxLength(80);
            e.Property(x => x.NotificationConsentVersion).HasMaxLength(80);
            e.Property(x => x.NotificationTimeZone).HasMaxLength(100);
        });
        b.Entity<WhatsAppConnection>(e =>
        {
            e.HasIndex(x => x.TenantId).IsUnique();
            e.HasIndex(x => x.RetentionPolledAt);
            // Retained inactive mappings cannot be silently reassigned to a different customer.
            e.HasIndex(x => new { x.AppId, x.PhoneNumberId }).IsUnique();
            e.Property(x => x.TemplatesConfigurationHash).HasMaxLength(64);
            e.Property(x => x.TemplatesState).HasMaxLength(20);
            e.Property(x => x.TaskAssignmentTemplateState).HasMaxLength(20);
            e.Property(x => x.OverdueTemplateState).HasMaxLength(20);
            e.Property(x => x.SupportUpdateTemplateState).HasMaxLength(20);
            e.Property(x => x.ReminderTemplateState).HasMaxLength(20);
            e.Property(x => x.ApprovalTemplateState).HasMaxLength(20);
            e.Property(x => x.HealthState).HasMaxLength(20);
            e.Property(x => x.HealthConfigurationHash).HasMaxLength(64);
            e.Property(x => x.AppId).HasMaxLength(40);
            e.Property(x => x.BusinessAccountId).HasMaxLength(40);
            e.Property(x => x.PhoneNumberId).HasMaxLength(40);
            e.Property(x => x.DisplayName).HasMaxLength(200);
        });
        b.Entity<WhatsAppInboundReceipt>(e =>
        {
            e.HasIndex(x => new { x.AppId, x.PhoneNumberId, x.ProviderMessageId }).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.ReceivedAt });
            e.Property(x => x.AppId).HasMaxLength(40);
            e.Property(x => x.PhoneNumberId).HasMaxLength(40);
            e.Property(x => x.ProviderMessageId).HasMaxLength(200);
            e.Property(x => x.MessageType).HasMaxLength(30);
        });
    }
}