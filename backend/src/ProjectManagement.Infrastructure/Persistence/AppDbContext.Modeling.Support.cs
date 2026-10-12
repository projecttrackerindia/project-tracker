using Microsoft.EntityFrameworkCore;
using ProjectManagement.Domain.Entities;
namespace ProjectManagement.Infrastructure.Persistence;
public partial class AppDbContext
{
    public DbSet<SupportTicket> SupportTickets=>Set<SupportTicket>();
    public DbSet<SupportInteraction> SupportInteractions=>Set<SupportInteraction>();
    public DbSet<SupportTicketLink> SupportTicketLinks=>Set<SupportTicketLink>();
    private static void ConfigureSupport(ModelBuilder b)
    {
        b.Entity<SupportTicket>(e=>{
            e.HasIndex(x=>new{x.TenantId,x.WorkTaskId}).IsUnique();e.HasIndex(x=>new{x.TenantId,x.State,x.TeamId});
            e.HasOne<WorkTask>().WithMany().HasForeignKey(x=>x.WorkTaskId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<Team>().WithMany().HasForeignKey(x=>x.TeamId).OnDelete(DeleteBehavior.SetNull);
            e.Property(x=>x.Version).IsConcurrencyToken();e.Property(x=>x.Category).HasMaxLength(120);e.Property(x=>x.State).HasMaxLength(30);
        });
        b.Entity<SupportInteraction>(e=>{
            e.HasIndex(x=>new{x.TicketId,x.AuthorId,x.RequestKey}).IsUnique();e.HasIndex(x=>new{x.TicketId,x.CreatedAt});
            e.HasOne<SupportTicket>().WithMany().HasForeignKey(x=>x.TicketId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<User>().WithMany().HasForeignKey(x=>x.AuthorId).OnDelete(DeleteBehavior.Restrict);
            e.Property(x=>x.RequestKey).HasMaxLength(100);
        });
        b.Entity<SupportTicketLink>(e=>{
            e.HasIndex(x=>new{x.TicketId,x.RelatedTicketId}).IsUnique();
            e.HasOne<SupportTicket>().WithMany().HasForeignKey(x=>x.TicketId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<SupportTicket>().WithMany().HasForeignKey(x=>x.RelatedTicketId).OnDelete(DeleteBehavior.Cascade);
        });
    }
}
