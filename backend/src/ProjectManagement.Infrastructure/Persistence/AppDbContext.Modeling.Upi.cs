using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Infrastructure.Persistence;

public partial class AppDbContext
{
    /// <summary>Payments for plans by UPI QR (until a payment gateway is connected).</summary>
    private static void ConfigureUpi(ModelBuilder b)
    {
        b.Entity<UpiPayment>(e =>
        {
            e.HasIndex(x => x.Reference).IsUnique();
            // One bank transaction pays for one plan purchase.
            e.HasIndex(x => x.Utr).IsUnique().HasFilter("\"Utr\" IS NOT NULL");
            e.HasIndex(x => new { x.Status, x.CreatedAt });
            e.HasIndex(x => new { x.TenantId, x.CreatedAt });
            e.HasIndex(x => new { x.AccountId, x.CreatedAt });
            e.Property(x => x.PlanCode).HasMaxLength(32);
            e.Property(x => x.Period).HasMaxLength(16);
            e.Property(x => x.Amount).HasPrecision(18, 2);
            e.Property(x => x.Currency).HasMaxLength(8);
            e.Property(x => x.Description).HasMaxLength(300);
            e.Property(x => x.Reference).HasMaxLength(24);
            e.Property(x => x.AccountId).HasMaxLength(120);
            e.Property(x => x.AccountLabel).HasMaxLength(80);
            e.Property(x => x.Status).HasMaxLength(16);
            e.Property(x => x.Utr).HasMaxLength(32);
            e.Property(x => x.DecisionNote).HasMaxLength(300);
            e.Property(x => x.FailureReason).HasMaxLength(200);
        });
    }
}
