using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Infrastructure.Persistence;

public partial class AppDbContext
{
    private static void ConfigureAiOperations(ModelBuilder b)
    {
        b.Entity<AiMessage>().Property(m => m.EstimatedProviderCostUsd).HasPrecision(18, 8);
        b.Entity<CallRoom>(e =>
        {
            e.HasIndex(x => x.RoomName).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.Status, x.StartedAt });
            e.HasIndex(x => new { x.TenantId, x.ProjectId });
            e.HasIndex(x => new { x.TenantId, x.ConversationId });
            e.Property(x => x.Title).HasMaxLength(200);
            e.Property(x => x.RoomName).HasMaxLength(80);
            e.Property(x => x.Kind).HasMaxLength(16);
            e.Property(x => x.Status).HasMaxLength(16);
            e.HasIndex(x => new { x.TenantId, x.MeetingId });
            e.HasIndex(x => new { x.TenantId, x.WorkspaceMeetingId });
        });
        b.Entity<PersonalConnectionSettings>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId }).IsUnique();
            e.Property(x => x.MeetingService).HasMaxLength(16);
            e.Property(x => x.SlackMessages).HasMaxLength(8);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<SlackUserLink>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId }).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.SlackUserId }).IsUnique();
            e.Property(x => x.SlackTeamId).HasMaxLength(32);
            e.Property(x => x.SlackUserId).HasMaxLength(32);
            e.Property(x => x.Name).HasMaxLength(200);
            e.Property(x => x.Email).HasMaxLength(254);
            e.Property(x => x.LastError).HasMaxLength(300);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<CallParticipant>(e =>
        {
            e.HasIndex(x => new { x.CallId, x.UserId }).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.UserId });
            e.Property(x => x.Role).HasMaxLength(16);
            e.HasOne<CallRoom>().WithMany().HasForeignKey(x => x.CallId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<AiWorkspaceProvider>(e =>
        {
            e.HasIndex(x => x.TenantId).IsUnique();
            e.Property(x => x.Provider).HasMaxLength(16);
            e.Property(x => x.KeyProtected).HasMaxLength(2000);
            e.Property(x => x.KeyHint).HasMaxLength(8);
            e.Property(x => x.QuickModel).HasMaxLength(100);
            e.Property(x => x.StandardModel).HasMaxLength(100);
            e.Property(x => x.DeepModel).HasMaxLength(100);
            e.Property(x => x.LastError).HasMaxLength(300);
        });
        b.Entity<AiProviderConsent>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId }).IsUnique();
            e.Property(x => x.Provider).HasMaxLength(16);
        });
        b.Entity<AiEvaluationRun>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.RanAt });
            e.Property(x => x.Model).HasMaxLength(100);
            e.Property(x => x.Mode).HasMaxLength(16);
            e.Property(x => x.SummaryJson).HasMaxLength(8000);
        });
        b.Entity<AiSearchChunk>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.SourceKind, x.SourceId });
            e.HasIndex(x => new { x.SourceId });
            e.HasIndex(x => new { x.TenantId, x.IndexedAt });
            e.Property(x => x.SourceKind).HasMaxLength(16);
            e.Property(x => x.Title).HasMaxLength(200);
            e.Property(x => x.Text).HasMaxLength(1300);
            e.Property(x => x.Model).HasMaxLength(64);
            e.Property(x => x.ContentHash).HasMaxLength(32);
        });
        b.Entity<AiWatch>(e =>
        {
            e.HasIndex(x => new { x.State, x.LastCheckedAt });
            e.HasIndex(x => new { x.TenantId, x.UserId, x.State });
            e.HasIndex(x => new { x.TenantId, x.TargetId });
            e.Property(x => x.Kind).HasMaxLength(16);
            e.Property(x => x.TargetType).HasMaxLength(16);
            e.Property(x => x.TargetKey).HasMaxLength(40);
            e.Property(x => x.TargetTitle).HasMaxLength(200);
            e.Property(x => x.Status).HasMaxLength(80);
            e.Property(x => x.Note).HasMaxLength(300);
            e.Property(x => x.Link).HasMaxLength(300);
            e.Property(x => x.State).HasMaxLength(16);
            e.Property(x => x.Outcome).HasMaxLength(300);
        });
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
