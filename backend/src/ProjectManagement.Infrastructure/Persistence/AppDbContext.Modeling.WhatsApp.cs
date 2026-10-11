using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Infrastructure.Persistence;

public partial class AppDbContext
{
    public DbSet<WhatsAppConnection> WhatsAppConnections => Set<WhatsAppConnection>();
    public DbSet<WhatsAppInboundReceipt> WhatsAppInboundReceipts => Set<WhatsAppInboundReceipt>();

    private static void ConfigureWhatsApp(ModelBuilder b)
    {
        b.Entity<WhatsAppConnection>(e =>
        {
            e.HasIndex(x => x.TenantId).IsUnique();
            // Retained inactive mappings cannot be silently reassigned to a different customer.
            e.HasIndex(x => new { x.AppId, x.PhoneNumberId }).IsUnique();
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