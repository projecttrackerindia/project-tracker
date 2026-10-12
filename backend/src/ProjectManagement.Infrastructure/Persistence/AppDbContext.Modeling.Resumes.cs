using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;
namespace ProjectManagement.Infrastructure.Persistence;
public partial class AppDbContext
{
    public DbSet<ResumeExportPurchase> ResumeExportPurchases => Set<ResumeExportPurchase>();
    public DbSet<PersonalFileDeletion> PersonalFileDeletions => Set<PersonalFileDeletion>();
    public DbSet<PersonalResume> PersonalResumes => Set<PersonalResume>();
    public DbSet<ResumeVersion> ResumeVersions => Set<ResumeVersion>();
    public DbSet<EmployeeCertification> EmployeeCertifications => Set<EmployeeCertification>();
    private void ConfigureResumes(ModelBuilder b)
    {
        b.Entity<PersonalFileDeletion>(e=>{
            e.Property(x=>x.StorageKey).HasMaxLength(200);
            e.HasIndex(x=>x.AvailableAt);
        });
        b.Entity<ResumeExportPurchase>(e=>{
            e.HasIndex(x=>new{x.UserId,x.ResumeVersionId,x.TemplateId,x.Format}).IsUnique();
            e.HasIndex(x=>x.ProviderOrderId).IsUnique();e.HasIndex(x=>x.ProviderPaymentId).IsUnique();
            e.HasOne<User>().WithMany().HasForeignKey(x=>x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<ResumeVersion>().WithMany().HasForeignKey(x=>x.ResumeVersionId).OnDelete(DeleteBehavior.SetNull);
            e.Property(x=>x.Version).IsConcurrencyToken();e.Property(x=>x.Format).HasMaxLength(10);
            e.HasQueryFilter(x=>x.UserId==CurrentUserId);
        });
        b.Entity<PersonalResume>(e => {
            e.HasIndex(x => new { x.UserId, x.CreatedAt });
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.Property(x => x.Title).HasMaxLength(200);
            e.Property(x => x.Version).IsConcurrencyToken();
            e.HasQueryFilter(x => x.UserId == CurrentUserId);
        });
        b.Entity<ResumeVersion>(e => {
            e.HasIndex(x => new { x.ResumeId, x.Number }).IsUnique();
            e.HasOne<PersonalResume>().WithMany().HasForeignKey(x => x.ResumeId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasQueryFilter(x => x.UserId == CurrentUserId);
        });
        b.Entity<EmployeeCertification>(e => {
            e.HasIndex(x => new { x.UserId, x.ExpiresOn });
            e.HasOne<User>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.Property(x => x.Name).HasMaxLength(200); e.Property(x => x.Issuer).HasMaxLength(200);
            e.Property(x => x.Version).IsConcurrencyToken();
            e.HasQueryFilter(x => x.UserId == CurrentUserId);
        });
    }
}
