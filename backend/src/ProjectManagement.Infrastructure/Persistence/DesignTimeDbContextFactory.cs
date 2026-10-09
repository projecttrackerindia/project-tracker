using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;

namespace ProjectManagement.Infrastructure.Persistence;

/// <summary>Used by <c>dotnet ef</c> at design time (no live database needed to scaffold migrations).</summary>
public class DesignTimeDbContextFactory : Microsoft.EntityFrameworkCore.Design.IDesignTimeDbContextFactory<AppDbContext>
{
    public AppDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseNpgsql("Host=localhost;Database=projectmanagement;Username=postgres;Password=postgres")
            .Options;
        return new AppDbContext(options, new CurrentContext(), TimeProvider.System);
    }
}
