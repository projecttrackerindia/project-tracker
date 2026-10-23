using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Infrastructure.Persistence;

public partial class AppDbContext
{
    /// <summary>
    /// The team password vault. Nothing secret is stored in the clear: <c>Cipher</c> columns hold AES-256-GCM output under a per-item key, and
    /// that key is only ever stored wrapped by the workspace's data key (<c>WrappedItemKey</c> + <c>KeyVersion</c>). Rows are hard-deleted
    /// (no soft-delete flag) so a value removed from the bin is really gone.
    /// </summary>
    private static void ConfigureVault(ModelBuilder b)
    {
        b.Entity<VaultCollection>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.Kind, x.OwnerUserId });
            e.HasIndex(x => new { x.TenantId, x.ProjectId });
            e.HasIndex(x => new { x.TenantId, x.TeamId });
            e.Property(x => x.Name).HasMaxLength(80);
            e.Property(x => x.Description).HasMaxLength(300);
        });
        b.Entity<VaultShare>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.CollectionId });
            e.HasIndex(x => new { x.TenantId, x.PrincipalType, x.PrincipalId });
            e.HasOne<VaultCollection>().WithMany().HasForeignKey(x => x.CollectionId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<VaultItem>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.CollectionId, x.DeletedAt });
            e.HasIndex(x => new { x.TenantId, x.PasswordFingerprint });
            e.HasIndex(x => new { x.TenantId, x.KeyVersion });
            e.HasIndex(x => new { x.TenantId, x.ExpiresAt });
            e.HasIndex(x => new { x.TenantId, x.BreachCheckedAt });
            e.Property(x => x.Title).HasMaxLength(120);
            e.Property(x => x.Url).HasMaxLength(500);
            e.Property(x => x.UsernameHint).HasMaxLength(80);
            e.Property(x => x.Tags).HasMaxLength(400);
            e.Property(x => x.FieldsJson).HasMaxLength(8000);
            e.Property(x => x.WrappedItemKey).HasMaxLength(500);
            e.Property(x => x.PasswordFingerprint).HasMaxLength(64);
            e.Property(x => x.RotationReason).HasMaxLength(300);
            e.Property(x => x.LinksJson).HasMaxLength(4000);
            e.HasOne<VaultCollection>().WithMany().HasForeignKey(x => x.CollectionId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<VaultItemVersion>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.ItemId, x.CreatedAt });
            e.HasIndex(x => new { x.TenantId, x.KeyVersion });
            e.Property(x => x.WrappedItemKey).HasMaxLength(500);
            e.Property(x => x.Reason).HasMaxLength(200);
            e.HasOne<VaultItem>().WithMany().HasForeignKey(x => x.ItemId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<VaultAttachment>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.ItemId });
            e.HasIndex(x => new { x.TenantId, x.KeyVersion });
            e.Property(x => x.FileName).HasMaxLength(120);
            e.Property(x => x.ContentType).HasMaxLength(100);
            e.Property(x => x.WrappedItemKey).HasMaxLength(500);
            e.HasOne<VaultItem>().WithMany().HasForeignKey(x => x.ItemId).OnDelete(DeleteBehavior.Cascade);
        });
    }
}
