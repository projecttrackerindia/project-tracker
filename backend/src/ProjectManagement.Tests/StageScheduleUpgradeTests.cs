using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Infrastructure.Persistence;

namespace ProjectManagement.Tests;

public class StageScheduleUpgradeTests
{
    // Simulate the actual preceding schema: both new columns are absent, dates already contain customer plans.
    /// <summary>The PostgreSQL schema at the older migration also lacks the columns 20261113001000_ReleasesAndHealth adds (status set by hand).</summary>
    private sealed class PreviousPostgresContext(DbContextOptions<AppDbContext> options, CurrentContext context) : PreviousContextBase(options, context)
    {
        protected override void OnModelCreating(ModelBuilder builder)
        {
            base.OnModelCreating(builder);
            builder.Entity<Project>().Ignore(p => p.HealthOverride).Ignore(p => p.HealthNote).Ignore(p => p.HealthUntil).Ignore(p => p.HealthSetById).Ignore(p => p.HealthSetAt);
        }
    }
    private sealed class PreviousContext(DbContextOptions<AppDbContext> options, CurrentContext context) : PreviousContextBase(options, context);
    private class PreviousContextBase(DbContextOptions<AppDbContext> options, CurrentContext context) : AppDbContext(options, context, TimeProvider.System)
    {
        protected override void OnModelCreating(ModelBuilder builder)
        {
            base.OnModelCreating(builder); builder.Entity<Project>().Ignore(p => p.StageScheduleMode); builder.Entity<ProjectStage>().Ignore(s => s.DurationDays);
            builder.Entity<Tenant>().Ignore(t => t.TimeZone);   // added later by 20261018000050_WorkspaceTimeZone
            builder.Entity<Tenant>().Ignore(t => t.AiAgentLevels);   // added later by 20261111000100_AiControlCentre
        }
    }
    /// <param name="postgres">The PostgreSQL database still at the older migration: the person is written there with the columns it has then
    /// (later migrations add Users columns the current model maps, so the model cannot write that row).</param>
    private static async Task<(Guid Project, Guid Stage)> SeedOldAsync(AppDbContext db, CurrentContext context, string? postgres = null)
    {
        var user = new User { Email = "schedule-upgrade@example.test", NormalizedEmail = "SCHEDULE-UPGRADE@EXAMPLE.TEST", DisplayName = "Existing scheduler", PasswordHash = "fixture-only", IsActive = true };
        var tenant = new Tenant { Name = "Existing organization", Slug = "schedule-upgrade", Type = WorkspaceType.Organization, OwnerUserId = user.Id };
        if (postgres is null) db.Users.Add(user);
        else await OldSchemaRows.InsertAsync(postgres, "Users", new() { ["Id"] = user.Id, ["Email"] = user.Email, ["NormalizedEmail"] = user.NormalizedEmail,
            ["DisplayName"] = user.DisplayName, ["PasswordHash"] = user.PasswordHash, ["IsActive"] = true });
        db.Tenants.Add(tenant); await db.SaveChangesAsync();
        context.UserId = user.Id; context.TenantId = tenant.Id; context.Role = TenantRole.Owner; context.WorkspaceType = WorkspaceType.Organization;
        var group = new ProjectGroup { TenantId = tenant.Id, Name = "Existing delivery", IsActive = true }; db.ProjectGroups.Add(group);
        var project = new Project { TenantId = tenant.Id, Name = "Existing plan", Key = "OLD", OwnerId = user.Id, ProjectGroupId = group.Id,
            StartDate = new(2026, 9, 12), DueDate = new(2026, 12, 20), Version = 5 };
        var stage = new ProjectStage { TenantId = tenant.Id, ProjectId = project.Id, Name = "Preserved stage", PlannedStart = new(2026, 10, 12), PlannedEnd = new(2026, 10, 20), Status = StageStatus.InProgress };
        db.Projects.Add(project); db.ProjectStages.Add(stage); await db.SaveChangesAsync(); return (project.Id, stage.Id);
    }
    private static async Task AssertPreservedAsync(AppDbContext db, Guid projectId, Guid stageId)
    {
        var p = await db.Projects.SingleAsync(p => p.Id == projectId); var s = await db.ProjectStages.SingleAsync(s => s.Id == stageId);
        Assert.Equal(StageScheduleMode.Manual, p.StageScheduleMode); Assert.Equal(5, p.Version); Assert.Equal(new DateOnly(2026, 12, 20), p.DueDate);
        Assert.Null(s.DurationDays); Assert.Equal(new DateOnly(2026, 10, 12), s.PlannedStart); Assert.Equal(new DateOnly(2026, 10, 20), s.PlannedEnd); Assert.Equal(StageStatus.InProgress, s.Status);
    }
    [Fact]
    public async Task Sqlite_development_upgrade_is_repeatable_and_preserves_existing_manual_plans()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:"); await connection.OpenAsync();
        var options = new DbContextOptionsBuilder<AppDbContext>().UseSqlite(connection).Options; var context = new CurrentContext();
        Guid project; Guid stage;
        await using (var old = new PreviousContext(options, context)) { await old.Database.EnsureCreatedAsync(); (project, stage) = await SeedOldAsync(old, context); }
        await using var db = new AppDbContext(options, context, TimeProvider.System);
        await SqliteEnterpriseUpgrade.ApplyAsync(db); await SqliteEnterpriseUpgrade.ApplyAsync(db); await AssertPreservedAsync(db, project, stage);
    }
    [PostgresExpansionFact]
    public async Task PostgreSql_upgrades_the_current_main_schema_without_rescheduling_existing_projects()
    {
        var database = "pm_schedule_upgrade_" + Guid.NewGuid().ToString("N");
        var configured = new NpgsqlConnectionStringBuilder(Environment.GetEnvironmentVariable("PM_TEST_POSTGRES")) { Database = "postgres", Pooling = false };
        await using var admin = new NpgsqlConnection(configured.ConnectionString); await admin.OpenAsync();
        await using (var create = new NpgsqlCommand($"CREATE DATABASE \"{database}\"", admin)) await create.ExecuteNonQueryAsync();
        try
        {
            configured.Database = database; var options = new DbContextOptionsBuilder<AppDbContext>().UseNpgsql(configured.ConnectionString).Options; var context = new CurrentContext();
            await using var db = new AppDbContext(options, context, TimeProvider.System);
            await db.GetService<IMigrator>().MigrateAsync("20261012171600_PlannedTimesheetLeave");
            Guid project; Guid stage;
            await using (var old = new PreviousPostgresContext(options, context)) (project, stage) = await SeedOldAsync(old, context, configured.ConnectionString);
            await db.Database.MigrateAsync(); await db.Database.MigrateAsync(); await AssertPreservedAsync(db, project, stage);
            Assert.Empty(await db.Database.GetPendingMigrationsAsync());
        }
        finally { await using var drop = new NpgsqlCommand($"DROP DATABASE \"{database}\" WITH (FORCE)", admin); await drop.ExecuteNonQueryAsync(); }
    }
}
