using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Infrastructure.Persistence;

public partial class AppDbContext
{
    /// <summary>
    /// Approvals (requests, their chain of steps, their timeline, and each workspace's default chain per type) and Notes. Plain rows with ids
    /// (no foreign keys), like the AI action log; a note on a project follows who may see that project (the automatic query filter on ProjectId).
    /// </summary>
    private static void ConfigureApprovalsAndNotes(ModelBuilder b)
    {
        b.Entity<ApprovalRequest>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.Status, x.CreatedAt });
            e.HasIndex(x => new { x.TenantId, x.RequesterId });
            e.Property(x => x.Type).HasMaxLength(32);
            e.Property(x => x.Title).HasMaxLength(200);
            e.Property(x => x.Summary).HasMaxLength(2000);
            e.Property(x => x.PayloadJson).HasMaxLength(8000);
            e.Property(x => x.Risk).HasMaxLength(16);
            e.Property(x => x.Impact).HasMaxLength(300);
            e.Property(x => x.LinksJson).HasMaxLength(4000);
            e.Property(x => x.Status).HasMaxLength(16);
            e.Property(x => x.Outcome).HasMaxLength(120);
        });
        b.Entity<ApprovalRequestStep>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.RequestId, x.Order }).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.ApproverId, x.Status });
            e.Property(x => x.Role).HasMaxLength(60);
            e.Property(x => x.Status).HasMaxLength(16);
            e.Property(x => x.Comment).HasMaxLength(2000);
        });
        b.Entity<ApprovalRequestEvent>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.RequestId, x.CreatedAt });
            e.Property(x => x.Action).HasMaxLength(16);
            e.Property(x => x.Comment).HasMaxLength(2000);
        });
        b.Entity<ApprovalPolicy>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.Type }).IsUnique();
            e.Property(x => x.Type).HasMaxLength(32);
            e.Property(x => x.StepsJson).HasMaxLength(4000);
        });
        b.Entity<Note>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.OwnerId, x.UpdatedAt });
            e.HasIndex(x => new { x.TenantId, x.ProjectId });
            e.Property(x => x.Title).HasMaxLength(200);
            e.Property(x => x.Folder).HasMaxLength(60);
            e.Property(x => x.Tags).HasMaxLength(400);
            e.Property(x => x.Sharing).HasMaxLength(16);
            e.Property(x => x.SharedWithJson).HasMaxLength(4000);
            e.Property(x => x.LinksJson).HasMaxLength(4000);
        });
    }
}
