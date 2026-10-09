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
    private static void ConfigureDocuments(ModelBuilder b)
    {
        b.Entity<DocumentType>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.Code }).IsUnique();
            e.Property(x => x.Code).HasMaxLength(24);
            e.Property(x => x.Name).HasMaxLength(60);
            e.Property(x => x.Description).HasMaxLength(300);
            e.Property(x => x.Icon).HasMaxLength(32);
            e.Property(x => x.Color).HasMaxLength(9);
            e.Property(x => x.TemplateJson).HasMaxLength(20000);
        });
        b.Entity<Document>(e =>
        {
            // Tenant first in every index: one workspace's queries never walk another's rows.
            e.HasIndex(x => new { x.TenantId, x.Number }).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.ProjectId, x.UpdatedAt });
            e.HasIndex(x => new { x.TenantId, x.TeamId, x.UpdatedAt });
            e.HasIndex(x => new { x.TenantId, x.TypeId });
            e.HasIndex(x => new { x.TenantId, x.OwnerId });
            e.HasIndex(x => new { x.TenantId, x.Status, x.UpdatedAt });
            e.Property(x => x.Title).HasMaxLength(200);
            e.Property(x => x.Revision).IsConcurrencyToken();
            e.Property(x => x.ApiHash).HasMaxLength(64);
            e.HasOne(x => x.Type).WithMany().HasForeignKey(x => x.TypeId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne(x => x.Owner).WithMany().HasForeignKey(x => x.OwnerId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne(x => x.Project).WithMany().HasForeignKey(x => x.ProjectId).OnDelete(DeleteBehavior.SetNull);
            e.HasOne<Team>().WithMany().HasForeignKey(x => x.TeamId).OnDelete(DeleteBehavior.SetNull);
        });
        b.Entity<DocumentVersion>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.DocumentId, x.Major, x.Minor });
            e.Property(x => x.ChangeSummary).HasMaxLength(500);
            e.Property(x => x.ChangeReason).HasMaxLength(500);
            e.Property(x => x.ContentHash).HasMaxLength(64);
            e.HasOne<Document>().WithMany().HasForeignKey(x => x.DocumentId).OnDelete(DeleteBehavior.Cascade);
            e.HasMany(x => x.Sections).WithOne().HasForeignKey(x => x.VersionId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<DocumentSection>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.VersionId, x.SortOrder });
            e.Property(x => x.Key).HasMaxLength(40);
            e.Property(x => x.Title).HasMaxLength(120);
        });
        b.Entity<DocumentTag>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.DocumentId, x.Tag }).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.Tag });
            e.Property(x => x.Tag).HasMaxLength(40);
            e.HasOne<Document>().WithMany().HasForeignKey(x => x.DocumentId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<DocumentGrant>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.DocumentId, x.PrincipalType, x.PrincipalId, x.Deny }).IsUnique();
            // "Which documents can this person, team or role open through a grant?" is asked for every document list.
            e.HasIndex(x => new { x.TenantId, x.PrincipalType, x.PrincipalId });
            e.Property(x => x.Note).HasMaxLength(300);
            e.HasOne<Document>().WithMany().HasForeignKey(x => x.DocumentId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<DocumentFile>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.DocumentId });
            e.Property(x => x.FileName).HasMaxLength(200);
            e.Property(x => x.ContentType).HasMaxLength(120);
            e.Property(x => x.StorageKey).HasMaxLength(200);
            e.Property(x => x.Sha256).HasMaxLength(64);
            e.HasOne<Document>().WithMany().HasForeignKey(x => x.DocumentId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<DocumentLink>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.DocumentId, x.TargetType, x.TargetId, x.Relation, x.RequirementId }).IsUnique();
            // "Which documents describe this task?" is asked on every task screen.
            e.HasIndex(x => new { x.TenantId, x.TargetType, x.TargetId });
            e.HasIndex(x => new { x.TenantId, x.RequirementId });
            e.HasOne<Document>().WithMany().HasForeignKey(x => x.DocumentId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<WorkflowDefinition>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.TypeId });
            e.Property(x => x.Name).HasMaxLength(80);
            e.Property(x => x.StepsJson).HasMaxLength(8000);
        });
        b.Entity<DocumentApproval>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.DocumentId, x.SubmittedAt });
            e.HasIndex(x => new { x.TenantId, x.State });
            e.Property(x => x.ContentHash).HasMaxLength(64);
            e.Property(x => x.WorkflowName).HasMaxLength(80);
            e.Property(x => x.StepsJson).HasMaxLength(16000);
            e.Property(x => x.Summary).HasMaxLength(500);
            e.Property(x => x.Reason).HasMaxLength(500);
            e.Property(x => x.ClosedNote).HasMaxLength(500);
            e.HasOne<Document>().WithMany().HasForeignKey(x => x.DocumentId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<ApprovalDecision>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.ApprovalId, x.StepIndex });
            e.Property(x => x.Comment).HasMaxLength(1000);
            e.HasOne<DocumentApproval>().WithMany().HasForeignKey(x => x.ApprovalId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<AccessRequest>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.DocumentId, x.Status });
            e.HasIndex(x => new { x.TenantId, x.RequesterId, x.Status });
            e.Property(x => x.Reason).HasMaxLength(500);
            e.Property(x => x.DecisionNote).HasMaxLength(500);
            e.HasOne<Document>().WithMany().HasForeignKey(x => x.DocumentId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<SensitiveValue>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.DocumentId });
            e.HasIndex(x => new { x.TenantId, x.KeyVersion });
            e.Property(x => x.Label).HasMaxLength(80);
            e.Property(x => x.Note).HasMaxLength(200);
            e.Property(x => x.Cipher).HasMaxLength(12000);
            e.HasOne<Document>().WithMany().HasForeignKey(x => x.DocumentId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<DocumentKey>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.Version }).IsUnique();
            e.Property(x => x.WrappedKey).HasMaxLength(500);
        });
        b.Entity<StepUpGrant>(e =>
        {
            e.HasIndex(x => x.TokenHash).IsUnique();
            e.HasIndex(x => x.ExpiresAt);
            e.Property(x => x.TokenHash).HasMaxLength(64);
        });
        b.Entity<ApiDefinition>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.DocumentId, x.Name }).IsUnique();
            e.Property(x => x.Name).HasMaxLength(80);
            e.Property(x => x.Description).HasMaxLength(2000);
            e.Property(x => x.BasePath).HasMaxLength(200);
            e.Property(x => x.Version).HasMaxLength(40);
            e.Property(x => x.AuthNote).HasMaxLength(500);
            e.Property(x => x.ServersJson).HasMaxLength(4000);
            e.HasOne<Document>().WithMany().HasForeignKey(x => x.DocumentId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<ApiEndpoint>(e =>
        {
            // The tree is read by API and ordered by path; a search by path fragment scans one workspace's rows.
            e.HasIndex(x => new { x.TenantId, x.DefinitionId, x.Path, x.Method }).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.DocumentId });
            e.HasIndex(x => new { x.TenantId, x.Path });
            e.Property(x => x.Path).HasMaxLength(400);
            e.Property(x => x.Summary).HasMaxLength(300);
            e.Property(x => x.Tag).HasMaxLength(80);
            e.Property(x => x.Hash).HasMaxLength(64);
            e.HasOne<ApiDefinition>().WithMany().HasForeignKey(x => x.DefinitionId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<Document>().WithMany().HasForeignKey(x => x.DocumentId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<ApiSnapshot>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.VersionId }).IsUnique();
            e.HasOne<DocumentVersion>().WithMany().HasForeignKey(x => x.VersionId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<EndpointRevision>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.VersionId, x.DefinitionName, x.Path, x.Method });
            e.Property(x => x.DefinitionName).HasMaxLength(80);
            e.Property(x => x.Path).HasMaxLength(400);
            e.Property(x => x.Summary).HasMaxLength(300);
            e.Property(x => x.Tag).HasMaxLength(80);
            e.HasOne<DocumentVersion>().WithMany().HasForeignKey(x => x.VersionId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<DocumentRequirement>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.DocumentId, x.Number }).IsUnique();
            e.Property(x => x.Title).HasMaxLength(300);
            e.Property(x => x.Detail).HasMaxLength(2000);
            e.HasOne<Document>().WithMany().HasForeignKey(x => x.DocumentId).OnDelete(DeleteBehavior.Cascade);
        });
    }
}
