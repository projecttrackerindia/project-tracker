using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Ai;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Infrastructure.Persistence;

namespace ProjectManagement.Tests;

/// <summary>
/// 20261111002000_AiAgentActionLog on a real PostgreSQL database with data: workspaces whose agents acted alone before Settings › AI (a project at
/// autonomy 4, a notetaker that creates tasks) get Auto for that agent; everyone else keeps the defaults; a level an admin chose is kept.
/// </summary>
public class AiAgentLevelUpgradeTests
{
    private const string Before = "20261111001000_WorkItems";

    [PostgresExpansionFact]
    public async Task Workspaces_that_relied_on_agents_acting_alone_keep_doing_so()
    {
        var configured = Environment.GetEnvironmentVariable("PM_TEST_POSTGRES")!;
        var databaseName = "pm_upgrade_" + Guid.NewGuid().ToString("N");
        var adminBuilder = new NpgsqlConnectionStringBuilder(configured) { Database = "postgres", Pooling = false };
        await using var admin = new NpgsqlConnection(adminBuilder.ConnectionString);
        await admin.OpenAsync();
        await using (var create = new NpgsqlCommand($"CREATE DATABASE \"{databaseName}\"", admin)) await create.ExecuteNonQueryAsync();
        try
        {
            var connection = new NpgsqlConnectionStringBuilder(configured) { Database = databaseName, Pooling = false };
            var context = new CurrentContext();
            var options = new DbContextOptionsBuilder<AppDbContext>().UseNpgsql(connection.ConnectionString).Options;
            // Migrations belong to AppDbContext itself; the rows are written with the older model (without the columns added later).
            await using (var migrator = new AppDbContext(options, context, TimeProvider.System)) await migrator.GetService<IMigrator>().MigrateAsync(Before);
            await using var db = new BeforeReleasesDb(options, context, TimeProvider.System);

            // Every column these rows use exists at the migration before (only the AiAgentActions table is new).
            var user = new User { Email = "levels@example.test", NormalizedEmail = "LEVELS@EXAMPLE.TEST", DisplayName = "Lead", PasswordHash = "fixture-hash", IsActive = true };
            db.Users.Add(user);
            Tenant Org(string slug, string? levels = null) => new() { Name = slug, Slug = slug, Type = WorkspaceType.Organization, OwnerUserId = user.Id, AiAgentLevels = levels };
            var delegating = Org("delegating"); var notes = Org("notes"); var plain = Org("plain"); var chosen = Org("chosen", "{\"project\":2,\"mail\":1}");
            var switchedOff = Org("switched-off");
            db.Tenants.AddRange(delegating, notes, plain, chosen, switchedOff);
            await db.SaveChangesAsync();
            foreach (var (tenant, autonomy, enabled) in new[] { (delegating, 4, true), (plain, 2, true), (chosen, 4, true), (switchedOff, 4, false) })
            {
                var project = new Project { TenantId = tenant.Id, Name = tenant.Slug, Key = "P" + tenant.Slug[..3].ToUpperInvariant(), OwnerId = user.Id, CreatedAt = DateTime.UtcNow };
                db.Projects.Add(project);
                db.ProjectAgentSettings.Add(new ProjectAgentSettings { TenantId = tenant.Id, ProjectId = project.Id, Enabled = enabled, AutonomyLevel = autonomy,
                    MailboxToken = Guid.NewGuid().ToString("N")[..24], ActingUserId = user.Id, CreatedAt = DateTime.UtcNow });
            }
            db.NotetakerSettings.Add(new NotetakerSettings { TenantId = notes.Id, UserId = user.Id, AutoMinutes = true, AutoTasks = true, CreatedAt = DateTime.UtcNow });
            db.NotetakerSettings.Add(new NotetakerSettings { TenantId = plain.Id, UserId = user.Id, AutoMinutes = true, AutoTasks = false, CreatedAt = DateTime.UtcNow });
            await db.SaveChangesAsync();
            db.ChangeTracker.Clear();

            await using var current = new AppDbContext(options, context, TimeProvider.System);
            await current.Database.MigrateAsync();
            Assert.Empty(await current.Database.GetPendingMigrationsAsync());
            var levels = await db.Tenants.AsNoTracking().ToDictionaryAsync(t => t.Slug, t => AiControlCentre.Parse(t.AiAgentLevels));
            Assert.Equal(AiAgentLevel.Auto, levels["delegating"][AiAgents.Project]);
            Assert.Equal(AiAgentLevel.AskFirst, levels["delegating"][AiAgents.Notetaker]);
            Assert.Equal(AiAgentLevel.Auto, levels["notes"][AiAgents.Notetaker]);
            Assert.Equal(AiAgentLevel.AskFirst, levels["notes"][AiAgents.Project]);
            Assert.Null(await db.Tenants.AsNoTracking().Where(t => t.Slug == "plain").Select(t => t.AiAgentLevels).SingleAsync());
            Assert.Null(await db.Tenants.AsNoTracking().Where(t => t.Slug == "switched-off").Select(t => t.AiAgentLevels).SingleAsync());
            Assert.Equal(AiAgentLevel.AskFirst, levels["chosen"][AiAgents.Project]);   // 2 = Ask first, chosen by an admin: kept
            Assert.Equal(AiAgentLevel.Suggest, levels["chosen"][AiAgents.Mail]);
            Assert.Empty(await db.AiAgentActions.IgnoreQueryFilters().ToListAsync());
        }
        finally
        {
            NpgsqlConnection.ClearAllPools();
            await using var drop = new NpgsqlCommand($"DROP DATABASE \"{databaseName}\" WITH (FORCE)", admin);
            await drop.ExecuteNonQueryAsync();
        }
    }

    /// <summary>The model as it was before 20261113001000_ReleasesAndHealth: the rows here are written at an older migration, so the
    /// Project columns added later (status set by hand) must not be in the INSERTs.</summary>
    private sealed class BeforeReleasesDb(DbContextOptions<AppDbContext> options, CurrentContext current, TimeProvider clock) : AppDbContext(options, current, clock)
    {
        protected override void OnModelCreating(ModelBuilder b)
        {
            base.OnModelCreating(b);
            b.Entity<Project>().Ignore(x => x.HealthOverride).Ignore(x => x.HealthNote).Ignore(x => x.HealthUntil).Ignore(x => x.HealthSetById).Ignore(x => x.HealthSetAt);
        }
    }
}
