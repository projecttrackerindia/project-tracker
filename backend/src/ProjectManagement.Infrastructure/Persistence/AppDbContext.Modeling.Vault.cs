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

        // The sealed (zero-knowledge) side: public keys, wrapped secrets and wrapped collection keys only.
        b.Entity<VaultIdentity>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId }).IsUnique();
            e.Property(x => x.X25519Public).HasMaxLength(64);
            e.Property(x => x.MlKemPublic).HasMaxLength(2000);
            e.Property(x => x.Ed25519Public).HasMaxLength(64);
            e.Property(x => x.SelfSignature).HasMaxLength(120);
            e.Property(x => x.Fingerprint).HasMaxLength(80);
        });
        b.Entity<VaultUnlock>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId });
            e.Property(x => x.Label).HasMaxLength(80);
            e.Property(x => x.CredentialId).HasMaxLength(1400);
            e.Property(x => x.Salt).HasMaxLength(200);
            e.Property(x => x.Params).HasMaxLength(200);
            e.Property(x => x.WrappedSeed).HasMaxLength(400);
        });
        b.Entity<VaultKeyEnvelope>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.CollectionId, x.KeyVersion });
            e.HasIndex(x => new { x.TenantId, x.RecipientUserId });
            e.Property(x => x.Envelope).HasMaxLength(4000);
            e.Property(x => x.Signature).HasMaxLength(120);
            e.HasOne<VaultCollection>().WithMany().HasForeignKey(x => x.CollectionId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<VaultAccessRequest>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.CollectionId, x.Status });
            e.HasIndex(x => new { x.TenantId, x.RequesterId, x.Status });
            e.HasIndex(x => new { x.TenantId, x.ItemId, x.RequesterId });
            e.Property(x => x.Reason).HasMaxLength(500);
            e.Property(x => x.DecisionNote).HasMaxLength(300);
        });
        b.Entity<VaultDeviceLink>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId, x.ExpiresAt });
            e.Property(x => x.Label).HasMaxLength(80);
            e.Property(x => x.X25519Public).HasMaxLength(64);
            e.Property(x => x.MlKemPublic).HasMaxLength(2000);
            e.Property(x => x.Envelope).HasMaxLength(4000);
            e.Property(x => x.Signature).HasMaxLength(120);
            e.Property(x => x.IpAddress).HasMaxLength(64);
            e.Property(x => x.UserAgent).HasMaxLength(300);
        });
        b.Entity<VaultRecoveryShare>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId });
            e.HasIndex(x => new { x.TenantId, x.TrusteeUserId });
            e.Property(x => x.Envelope).HasMaxLength(4000);
            e.Property(x => x.Signature).HasMaxLength(120);
        });
        b.Entity<VaultRecoveryRequest>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId, x.ExpiresAt });
            e.Property(x => x.X25519Public).HasMaxLength(64);
            e.Property(x => x.MlKemPublic).HasMaxLength(2000);
            e.Property(x => x.IpAddress).HasMaxLength(64);
            e.Property(x => x.UserAgent).HasMaxLength(300);
        });
        b.Entity<VaultMachineBinding>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.CollectionId });
            e.Property(x => x.Provider).HasMaxLength(20);
            e.Property(x => x.Repository).HasMaxLength(140);
            e.Property(x => x.RepositoryId).HasMaxLength(40);
            e.Property(x => x.RefPattern).HasMaxLength(200);
            e.Property(x => x.Environment).HasMaxLength(60);
            e.Property(x => x.Label).HasMaxLength(80);
            e.Property(x => x.LastRun).HasMaxLength(200);
            e.HasOne<VaultCollection>().WithMany().HasForeignKey(x => x.CollectionId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<VaultSecretLink>(e =>
        {
            e.HasIndex(x => x.TokenHash).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.CreatedBy, x.CreatedAt });
            e.HasIndex(x => x.ExpiresAt);
            e.Property(x => x.TokenHash).HasMaxLength(64);
            e.Property(x => x.Note).HasMaxLength(200);
            e.Property(x => x.Cipher).HasMaxLength(140000);
            e.Property(x => x.Salt).HasMaxLength(64);
            e.Property(x => x.Params).HasMaxLength(64);
            e.Property(x => x.LastOpenedIp).HasMaxLength(64);
            e.Property(x => x.Views).IsConcurrencyToken();   // two openings at once: only one gets the last view
        });
        b.Entity<VaultRecoveryRelease>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.RequestId });
            e.Property(x => x.Envelope).HasMaxLength(4000);
            e.Property(x => x.Signature).HasMaxLength(120);
        });
    }
}
