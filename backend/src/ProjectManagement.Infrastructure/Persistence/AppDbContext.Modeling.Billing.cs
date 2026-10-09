using System.Linq.Expressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Common;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Infrastructure.Persistence;

public partial class AppDbContext
{
    private static void ConfigureBilling(ModelBuilder b)
    {
        b.Entity<Plan>(e =>
        {
            e.HasIndex(x => x.Code).IsUnique();
            e.Property(x => x.Code).HasMaxLength(20);
            e.HasMany(x => x.Features).WithOne().HasForeignKey(x => x.PlanId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<PlanFeature>(e => { e.HasIndex(x => new { x.PlanId, x.FeatureKey }).IsUnique(); e.Property(x => x.FeatureKey).HasMaxLength(60); });
        b.Entity<Subscription>(e =>
        {
            e.HasIndex(x => x.TenantId).IsUnique();
            e.HasIndex(x => x.ProviderSubscriptionId); e.HasIndex(x => x.PendingProviderSubscriptionId);
            e.Property(x => x.Provider).HasMaxLength(20); e.Property(x => x.ProviderSubscriptionId).HasMaxLength(60); e.Property(x => x.PendingProviderSubscriptionId).HasMaxLength(60);
            e.HasOne(x => x.Plan).WithMany().HasForeignKey(x => x.PlanId).OnDelete(DeleteBehavior.Restrict);
        });
        b.Entity<Invoice>(e => { e.HasIndex(x => new { x.TenantId, x.IssuedAt }); e.Property(x => x.Number).HasMaxLength(40); });
    }
}
