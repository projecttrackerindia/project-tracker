using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Infrastructure.Persistence;

namespace ProjectManagement.Tests;

public sealed class PostgresExpansionFactAttribute : FactAttribute
{
    public PostgresExpansionFactAttribute()
    {
        if(string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("PM_TEST_POSTGRES")))
            Skip="Requires a disposable PostgreSQL server; run in the PostgreSQL CI job.";
    }
}

public class PostgresExpansionUpgradeTests
{
    // Last migration on the inspected main base b695a43. Fresh-model API tests alone cannot prove this upgrade path.
    private const string MainMigration="20261010184340_SlackLifecycleReceipts";
    [PostgresExpansionFact]
    public async Task Actual_main_schema_upgrades_twice_and_preserves_existing_account_workspace_and_notification()
    {
        var configured=Environment.GetEnvironmentVariable("PM_TEST_POSTGRES")!;
        var databaseName="pm_upgrade_"+Guid.NewGuid().ToString("N");
        var adminBuilder=new NpgsqlConnectionStringBuilder(configured){Database="postgres",Pooling=false};
        await using var admin=new NpgsqlConnection(adminBuilder.ConnectionString);
        await admin.OpenAsync();
        await using(var create=new NpgsqlCommand($"CREATE DATABASE \"{databaseName}\"",admin))await create.ExecuteNonQueryAsync();
        try
        {
            var connection=new NpgsqlConnectionStringBuilder(configured){Database=databaseName,Pooling=false};
            var context=new CurrentContext();
            await using var db=new AppDbContext(new DbContextOptionsBuilder<AppDbContext>().UseNpgsql(connection.ConnectionString).Options,context,TimeProvider.System);
            await db.GetService<IMigrator>().MigrateAsync(MainMigration);
            var user=new User{Email="upgrade@example.test",NormalizedEmail="UPGRADE@EXAMPLE.TEST",DisplayName="Existing account",PasswordHash="fixture-hash",IsActive=true};
            var tenant=new Tenant{Name="Existing organization",Slug="upgrade-org",Type=WorkspaceType.Organization,OwnerUserId=user.Id};
            db.Users.Add(user);db.Tenants.Add(tenant);await db.SaveChangesAsync();
            context.UserId=user.Id;context.TenantId=tenant.Id;context.Role=TenantRole.Owner;context.WorkspaceType=WorkspaceType.Organization;
            var notification=new Notification{TenantId=tenant.Id,UserId=user.Id,Type=NotificationType.TaskAssigned,Title="Existing notification",Body="Private fixture body"};
            db.Notifications.Add(notification);await db.SaveChangesAsync();
            db.ChangeTracker.Clear();
            await db.Database.MigrateAsync();
            await db.Database.MigrateAsync();
            Assert.Empty(await db.Database.GetPendingMigrationsAsync());
            Assert.Equal("Existing account",(await db.Users.SingleAsync(x=>x.Id==user.Id)).DisplayName);
            var savedTenant=await db.Tenants.SingleAsync(x=>x.Id==tenant.Id);
            Assert.Equal(user.Id,savedTenant.OwnerUserId);Assert.Equal("Existing organization",savedTenant.Name);
            Assert.Equal("Private fixture body",(await db.Notifications.SingleAsync(x=>x.Id==notification.Id)).Body);
            Assert.Empty(await db.PersonalResumes.ToListAsync());Assert.Empty(await db.MicrosoftConnections.ToListAsync());
            Assert.Empty(await db.PersonalCalendarProposals.ToListAsync());Assert.Empty(await db.SupportWorkflows.ToListAsync());
            Assert.Empty(await db.WhatsAppConnections.ToListAsync());Assert.Empty(await db.WhatsAppContactLinks.ToListAsync());
            Assert.Empty(await db.WhatsAppDeliveries.ToListAsync());
            Assert.Empty(await db.PersonalEmailRewrites.ToListAsync());
        }
        finally
        {
            // Only the random database created above is removed; never run migrations against the configured admin database.
            await using var drop=new NpgsqlCommand($"DROP DATABASE \"{databaseName}\" WITH (FORCE)",admin);
            await drop.ExecuteNonQueryAsync();
        }
    }
}
