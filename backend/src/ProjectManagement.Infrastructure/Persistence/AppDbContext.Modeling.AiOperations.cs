using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Infrastructure.Persistence;

public partial class AppDbContext
{
    private static void ConfigureAiOperations(ModelBuilder b)
    {
        b.Entity<AiMessage>().Property(m => m.EstimatedProviderCostUsd).HasPrecision(18, 8);
        b.Entity<AiForecastSnapshot>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.JobId, x.ProjectId }).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.UserId, x.EvidenceAt });
            e.Property(x => x.Confidence).HasMaxLength(16);
            e.Property(x => x.MethodologyVersion).HasMaxLength(64);
        });
        b.Entity<AiCreditAccount>(e => e.HasIndex(x => new { x.TenantId, x.PeriodStart }).IsUnique());
        b.Entity<AiCreditBudget>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.Scope, x.SubjectId }).IsUnique();
            e.Property(x => x.Scope).HasMaxLength(16);
        });
        b.Entity<AiCreditBudgetUsage>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.BudgetId, x.AccountId }).IsUnique();
            e.HasOne<AiCreditBudget>().WithMany().HasForeignKey(x => x.BudgetId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne<AiCreditAccount>().WithMany().HasForeignKey(x => x.AccountId).OnDelete(DeleteBehavior.Restrict);
        });
        b.Entity<AiCreditBudgetHold>(e =>
        {
            e.HasIndex(x => new { x.ReservationId, x.BudgetUsageId }).IsUnique();
            e.HasOne<AiCreditReservation>().WithMany().HasForeignKey(x => x.ReservationId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne<AiCreditBudgetUsage>().WithMany().HasForeignKey(x => x.BudgetUsageId).OnDelete(DeleteBehavior.Restrict);
        });
        b.Entity<AiCreditReservation>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.OperationId }).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.Status, x.ExpiresAt });
            e.Property(x => x.Feature).HasMaxLength(64);
            e.Property(x => x.Status).HasMaxLength(20);
            e.HasOne<AiCreditAccount>().WithMany().HasForeignKey(x => x.AccountId).OnDelete(DeleteBehavior.Restrict);
        });
        b.Entity<AiCreditEntry>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.AccountId, x.CreatedAt });
            e.Property(x => x.Kind).HasMaxLength(32);
            e.Property(x => x.PolicyVersion).HasMaxLength(64);
            e.HasOne<AiCreditAccount>().WithMany().HasForeignKey(x => x.AccountId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne<AiCreditReservation>().WithMany().HasForeignKey(x => x.ReservationId).OnDelete(DeleteBehavior.Restrict);
        });
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
