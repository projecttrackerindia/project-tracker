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
    private static void ConfigureIdentity(ModelBuilder b)
    {
        b.Entity<User>(e =>
        {
            e.HasIndex(x => x.NormalizedEmail).IsUnique();
            e.Property(x => x.Email).HasMaxLength(254);
            e.Property(x => x.NormalizedEmail).HasMaxLength(254);
            e.Property(x => x.DisplayName).HasMaxLength(100);
            e.HasIndex(x => x.EmailVerificationTokenHash);
            e.HasIndex(x => x.PasswordResetTokenHash);
        });
        b.Entity<BillingEvent>(e => { e.HasIndex(x => new { x.Provider, x.ProviderEventId }).IsUnique(); e.Property(x => x.Provider).HasMaxLength(20); e.Property(x => x.ProviderEventId).HasMaxLength(100); e.Property(x => x.Type).HasMaxLength(60); });
        b.Entity<EmailLog>(e => { e.HasIndex(x => new { x.Status, x.NextAttemptAt }); e.HasIndex(x => x.CreatedAt); e.Property(x => x.ToEmail).HasMaxLength(320); e.Property(x => x.Subject).HasMaxLength(300); e.Property(x => x.Kind).HasMaxLength(30); e.Property(x => x.Error).HasMaxLength(300); });
        b.Entity<EmailSuppression>(e => { e.HasIndex(x => x.Email).IsUnique(); e.Property(x => x.Email).HasMaxLength(320); e.Property(x => x.Reason).HasMaxLength(30); e.Property(x => x.Detail).HasMaxLength(300); });
        b.Entity<PasskeyCredential>(e => { e.HasIndex(x => x.CredentialId).IsUnique(); e.HasIndex(x => x.UserId); e.Property(x => x.CredentialId).HasMaxLength(512); e.Property(x => x.Name).HasMaxLength(80); });
        b.Entity<PasskeyChallenge>(e => { e.HasIndex(x => x.CreatedAt); e.Property(x => x.Purpose).HasMaxLength(20); });
        b.Entity<IdempotencyRecord>(e => { e.HasIndex(x => new { x.UserId, x.Key }).IsUnique(); e.HasIndex(x => x.CreatedAt); e.Property(x => x.Key).HasMaxLength(100); e.Property(x => x.RequestHash).HasMaxLength(64); e.Property(x => x.ContentType).HasMaxLength(120); });
        b.Entity<DeviceLoginRequest>(e => { e.HasIndex(x => new { x.UserId, x.CreatedAt }); e.Property(x => x.SecretHash).HasMaxLength(128); e.Property(x => x.RequesterIp).HasMaxLength(64); e.Property(x => x.RequesterAgent).HasMaxLength(300); });
        b.Entity<UserSession>(e => { e.HasIndex(x => x.UserId); e.Property(x => x.AuthMethod).HasMaxLength(32); });
        b.Entity<RefreshToken>(e =>
        {
            e.HasIndex(x => x.TokenHash).IsUnique();
            e.HasIndex(x => x.SessionId);
            e.Property(x => x.TokenHash).HasMaxLength(128);
        });
        b.Entity<MfaRecoveryCode>(e =>
        {
            e.HasIndex(x => new { x.UserId, x.CodeHash }).IsUnique();
            e.Property(x => x.CodeHash).HasMaxLength(64);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<Tenant>(e =>
        {
            e.HasIndex(x => x.Slug).IsUnique();
            e.HasIndex(x => x.OwnerUserId);
            e.Property(x => x.Name).HasMaxLength(80);
            e.Property(x => x.Slug).HasMaxLength(60);
            e.Property(x => x.CostCurrency).HasMaxLength(3);
            e.Property(x => x.AiInstructions).HasMaxLength(4000);
        });
        b.Entity<TenantMember>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.UserId }).IsUnique();
            e.HasIndex(x => x.UserId);
            e.HasIndex(x => x.OrgRoleId);
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne<OrgRole>().WithMany().HasForeignKey(x => x.OrgRoleId).OnDelete(DeleteBehavior.SetNull);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.ReportsToUserId).OnDelete(DeleteBehavior.SetNull);
            e.Property(x => x.CostRate).HasPrecision(12, 2);
            e.Property(x => x.BillRate).HasPrecision(12, 2);
        });
        b.Entity<OrgRole>(e =>
        {
            e.HasIndex(x => new { x.TenantId, x.ParentRoleId });
            e.Property(x => x.Name).HasMaxLength(60);
            e.Property(x => x.Description).HasMaxLength(300);
            e.Property(x => x.Color).HasMaxLength(9);
            e.Property(x => x.AccessJson).HasMaxLength(4000);
            e.HasOne<OrgRole>().WithMany().HasForeignKey(x => x.ParentRoleId).OnDelete(DeleteBehavior.Restrict);
        });
        b.Entity<TenantInvitation>(e =>
        {
            e.HasIndex(x => x.TokenHash).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.NormalizedEmail });
        });
        b.Entity<RolePermissionOverride>(e => e.HasIndex(x => new { x.TenantId, x.Role, x.Permission }).IsUnique());
        b.Entity<Team>(e =>
        {
            e.HasIndex(x => x.TenantId);
            e.HasMany(x => x.Members).WithOne().HasForeignKey(x => x.TeamId).OnDelete(DeleteBehavior.Cascade);
            e.HasIndex(x => new { x.TenantId, x.ParentTeamId });
        });
        b.Entity<TeamMember>(e =>
        {
            e.HasIndex(x => new { x.TeamId, x.UserId }).IsUnique();
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Restrict);
        });
    }
}
