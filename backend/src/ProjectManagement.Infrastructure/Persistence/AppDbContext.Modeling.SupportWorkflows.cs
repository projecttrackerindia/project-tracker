using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;
namespace ProjectManagement.Infrastructure.Persistence;
public partial class AppDbContext
{
    public DbSet<SupportWorkflowSchedule> SupportWorkflowSchedules => Set<SupportWorkflowSchedule>();
    public DbSet<SupportWorkflow> SupportWorkflows => Set<SupportWorkflow>();
    public DbSet<SupportWorkflowRevision> SupportWorkflowRevisions => Set<SupportWorkflowRevision>();
    public DbSet<SupportWorkflowEvent> SupportWorkflowEvents => Set<SupportWorkflowEvent>();
    public DbSet<SupportWorkflowRun> SupportWorkflowRuns => Set<SupportWorkflowRun>();
    public DbSet<SupportWorkflowStep> SupportWorkflowSteps => Set<SupportWorkflowStep>();
    private static void ConfigureSupportWorkflows(ModelBuilder b)
    {
        b.Entity<SupportWorkflowSchedule>(e => {
            e.HasIndex(x => new { x.WorkflowId, x.TicketId }).IsUnique(); e.HasIndex(x => new { x.Enabled, x.NextRunAt });
            e.Property(x => x.Version).IsConcurrencyToken();
            e.HasOne<SupportWorkflow>().WithMany().HasForeignKey(x => x.WorkflowId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<SupportTicket>().WithMany().HasForeignKey(x => x.TicketId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Restrict);
        });
        b.Entity<SupportWorkflow>(e => {
            e.Property(x => x.Name).HasMaxLength(120); e.Property(x => x.Version).IsConcurrencyToken();
            e.HasIndex(x => new { x.TenantId, x.Enabled });
            e.HasOne<User>().WithMany().HasForeignKey(x => x.CreatorId).OnDelete(DeleteBehavior.Restrict);
        });
        b.Entity<SupportWorkflowRevision>(e => {
            e.HasIndex(x => new { x.WorkflowId, x.Number }).IsUnique();
            e.HasOne<SupportWorkflow>().WithMany().HasForeignKey(x => x.WorkflowId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.PublishedBy).OnDelete(DeleteBehavior.Restrict);
        });
        b.Entity<SupportWorkflowEvent>(e => {
            e.HasIndex(x => new { x.TenantId, x.RequestKey }).IsUnique(); e.Property(x => x.RequestKey).HasMaxLength(120);
            e.HasIndex(x => new { x.ProcessedAt, x.CreatedAt });
            e.HasOne<SupportTicket>().WithMany().HasForeignKey(x => x.TicketId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<SupportWorkflowRun>(e => {
            e.HasIndex(x => new { x.TenantId, x.WorkflowId, x.RequestKey }).IsUnique(); e.Property(x => x.RequestKey).HasMaxLength(120);
            e.Property(x => x.Version).IsConcurrencyToken(); e.Property(x => x.NodeId).HasMaxLength(40); e.Property(x => x.Status).HasMaxLength(30);
            e.HasIndex(x => new { x.Status, x.AvailableAt, x.TenantId });
            e.HasOne<SupportWorkflow>().WithMany().HasForeignKey(x => x.WorkflowId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<SupportWorkflowRevision>().WithMany().HasForeignKey(x => x.RevisionId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne<SupportTicket>().WithMany().HasForeignKey(x => x.TicketId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.ExecutorId).OnDelete(DeleteBehavior.Restrict);
        });
        b.Entity<SupportWorkflowStep>(e => {
            e.HasIndex(x => new { x.RunId, x.NodeId }).IsUnique(); e.Property(x => x.NodeId).HasMaxLength(40);
            e.HasOne<SupportWorkflowRun>().WithMany().HasForeignKey(x => x.RunId).OnDelete(DeleteBehavior.Cascade);
        });
    }
}