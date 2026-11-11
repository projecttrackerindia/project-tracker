using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Infrastructure.Persistence;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

/// <summary>
/// Read-replica support: reports, insights, search and portfolio aggregates read through <see cref="IReadDb"/>; with no ReadOnly connection
/// string that is the primary; with one, a context that refuses every write. Writes keep working either way, because they never use it.
/// </summary>
[Collection("api")]
public class ReadReplicaTests(ApiFactory factory)
{
    private ReadReplicaSettings Settings => factory.Services.GetRequiredService<ReadReplicaSettings>();
    private string Primary => factory.Services.GetRequiredService<IConfiguration>().GetConnectionString("Default")!;

    [Fact]
    public void Without_a_read_only_connection_reads_use_the_primary_context()
    {
        Assert.False(Settings.Enabled);
        using var scope = factory.Services.CreateScope();
        var read = scope.ServiceProvider.GetRequiredService<IReadDb>();
        Assert.False(read.IsReplica);
        Assert.Same(scope.ServiceProvider.GetRequiredService<IAppDbContext>(), read.Db);
    }

    [Theory]
    [InlineData("SELECT 1", false)]
    [InlineData("  select \"p\".\"Id\" from \"Projects\" as \"p\"", false)]
    [InlineData("-- tag\nSELECT 1", false)]
    [InlineData("INSERT INTO x VALUES (1)", true)]
    [InlineData("update x set a = 1", true)]
    [InlineData("-- ExecuteDelete\nDELETE FROM x", true)]
    [InlineData("UPDATED_AT", false)]
    public void Write_statements_are_recognized(string sql, bool write) => Assert.Equal(write, ReadOnlyCommandGuard.IsWrite(sql));

    [Fact]
    public async Task With_a_replica_screens_read_from_it_and_every_write_still_goes_to_the_primary()
    {
        var owner = await TestClient.RegisterAsync(factory, "Replica Owner");
        await owner.CreateOrgAsync("Replica Org");
        await owner.UpgradeAsync("BUSINESS");
        var project = await owner.CreateProjectAsync("Replica project");
        await owner.CreateTaskAsync(project, "Before the replica");

        Settings.ConnectionString = Primary;   // the "replica" is the same database behind the read-only guard
        try
        {
            // The read screens answer through the guarded context.
            Assert.Equal(HttpStatusCode.OK, (await owner.Get("/api/v1/reports/summary?days=7")).Status);
            Assert.Equal(HttpStatusCode.OK, (await owner.Get("/api/v1/dashboard")).Status);
            Assert.Equal(HttpStatusCode.OK, (await owner.Get("/api/v1/search?q=Replica")).Status);
            Assert.Equal(HttpStatusCode.OK, (await owner.Get("/api/v1/portfolio/board")).Status);
            Assert.Equal(HttpStatusCode.OK, (await owner.Get("/api/v1/activity")).Status);

            // Writes never touch it: they succeed while the replica refuses everything.
            var task = await owner.CreateTaskAsync(project, "Written with a replica on", new { title = "Written with a replica on" });
            Assert.NotNull(task);
            Assert.Equal(HttpStatusCode.OK, (await owner.Put($"/api/v1/projects/{project}/health", new { health = "AtRisk", note = "Testing the replica" })).Status);

            using var scope = factory.Services.CreateScope();
            var read = scope.ServiceProvider.GetRequiredService<IReadDb>();
            Assert.True(read.IsReplica);
            Assert.NotSame(scope.ServiceProvider.GetRequiredService<IAppDbContext>(), read.Db);
            Assert.True(await read.Db.Projects.IgnoreQueryFilters().AnyAsync(p => p.Id == project));

            read.Db.Notes.Add(new Note { TenantId = owner.WorkspaceId, OwnerId = owner.UserId, Title = "never saved" });
            await Assert.ThrowsAsync<ReadReplicaWriteException>(() => read.Db.SaveChangesAsync());
            await Assert.ThrowsAsync<ReadReplicaWriteException>(() => read.Db.Projects.IgnoreQueryFilters().Where(p => p.Id == project).ExecuteDeleteAsync());
            Assert.True(await scope.ServiceProvider.GetRequiredService<IAppDbContext>().Projects.IgnoreQueryFilters().AnyAsync(p => p.Id == project));
        }
        finally { Settings.ConnectionString = null; }
    }
}
