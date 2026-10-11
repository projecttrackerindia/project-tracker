using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Infrastructure.Persistence;
using ProjectManagement.Tests.Infrastructure;

namespace ProjectManagement.Tests;

[Collection("api")]
public class MicrosoftMigrationTests(ApiFactory factory)
{
    [Fact]
    public async Task Existing_Gmail_receipt_upgrades_without_changing_content_or_inventing_sender()
    {
        using var scope=factory.Services.CreateScope();
        await using var connection=new SqliteConnection("Data Source=:memory:");await connection.OpenAsync();
        var options=new DbContextOptionsBuilder<AppDbContext>().UseSqlite(connection).Options;
        await using var db=new AppDbContext(options,scope.ServiceProvider.GetRequiredService<ICurrentContext>(),TimeProvider.System);
        var assembly=db.GetService<IMigrationsAssembly>();
        var generator=db.GetService<IMigrationsSqlGenerator>();
        async Task Apply(string id)
        {
            var migration=assembly.CreateMigration(assembly.Migrations[id],db.Database.ProviderName!);
            foreach(var command in generator.Generate(migration.UpOperations,db.Model))
                await db.Database.ExecuteSqlRawAsync(command.CommandText);
        }
        // Reconstruct only the prior integration tables from their actual migrations.
        // Historical PostgreSQL-only migrations are not SQLite-compatible; this verifies the additive delta.
        await db.Database.ExecuteSqlRawAsync("""CREATE TABLE "Users" ("Id" TEXT NOT NULL PRIMARY KEY)""");
        await Apply("20261011051417_DurableProviderOAuthAttempts");
        await Apply("20261011053210_PersonalEmailDrafts");
        var uid=Guid.NewGuid();var tid=Guid.NewGuid();var id=Guid.NewGuid();var now=DateTime.UtcNow;
        await db.Database.ExecuteSqlInterpolatedAsync($"""INSERT INTO "Users" ("Id") VALUES ({uid})""");
        await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO "PersonalEmailDrafts" ("Id","UserId","TenantId","Recipient","Subject","Body","Status","Version","ProviderMessageId","ConfirmedAt","AcceptedAt","CreatedAt")
            VALUES ({id},{uid},{tid},{"recipient@example.test"},{"Existing subject"},{"Existing body"},{"accepted"},{3},{"existing-gmail-id"},{now},{now},{now})
            """);
        await SqliteEnterpriseUpgrade.ApplyAsync(db);
        await SqliteEnterpriseUpgrade.ApplyAsync(db); // A repeated startup must preserve the same receipt.
        var receipt=await db.PersonalEmailDrafts.IgnoreQueryFilters().SingleAsync(d=>d.Id==id);
        Assert.Equal("google",receipt.Provider);Assert.Equal("Existing body",receipt.Body);
        Assert.Equal("existing-gmail-id",receipt.ProviderMessageId);Assert.Equal("accepted",receipt.Status);
        Assert.Equal(3,receipt.Version);Assert.Null(receipt.ConfirmedSenderEmail);Assert.Null(receipt.ProviderRequestId);
        Assert.Empty(await db.MicrosoftConnections.IgnoreQueryFilters().ToArrayAsync());
        Assert.Empty(await db.SupportWorkflows.IgnoreQueryFilters().ToArrayAsync());
        Assert.Empty(await db.PersonalResumes.IgnoreQueryFilters().ToArrayAsync());
        Assert.Empty(await db.PersonalCalendarProposals.IgnoreQueryFilters().ToArrayAsync());
        Assert.Empty(await db.WhatsAppConnections.IgnoreQueryFilters().ToArrayAsync());
        Assert.Empty(await db.WhatsAppInboundReceipts.IgnoreQueryFilters().ToArrayAsync());
        Assert.Empty(await db.WhatsAppContactLinks.IgnoreQueryFilters().ToArrayAsync());
        Assert.Empty(await db.WhatsAppDeliveries.IgnoreQueryFilters().ToArrayAsync());
    }
    [Fact]
    public async Task Prior_WhatsApp_mapping_upgrades_twice_without_inventing_token_expiry_or_changing_ownership()
    {
        using var scope = factory.Services.CreateScope();
        await using var connection = new SqliteConnection("Data Source=:memory:"); await connection.OpenAsync();
        await using var db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>().UseSqlite(connection).Options,
            scope.ServiceProvider.GetRequiredService<ICurrentContext>(), TimeProvider.System);
        var assembly = db.GetService<IMigrationsAssembly>(); var generator = db.GetService<IMigrationsSqlGenerator>();
        var previous = assembly.CreateMigration(assembly.Migrations["20261011073057_WhatsAppInboundFoundation"], db.Database.ProviderName!);
        await db.Database.ExecuteSqlRawAsync("""CREATE TABLE "Users" ("Id" TEXT NOT NULL PRIMARY KEY)""");
        foreach (var command in generator.Generate(previous.UpOperations, db.Model)) await db.Database.ExecuteSqlRawAsync(command.CommandText);
        var id = Guid.NewGuid(); var tenant = Guid.NewGuid(); var user = Guid.NewGuid(); var now = DateTime.UtcNow;
        await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO "WhatsAppConnections" ("Id","TenantId","AppId","BusinessAccountId","PhoneNumberId","DisplayName","AccessTokenProtected","InstalledBy","ConnectedAt","Active","CreatedAt")
            VALUES ({id},{tenant},{"123"},{"456"},{"789"},{"Existing business"},{"protected-fixture"},{user},{now},{true},{now})
            """);
        await SqliteEnterpriseUpgrade.ApplyAsync(db); await SqliteEnterpriseUpgrade.ApplyAsync(db);
        var row = await db.WhatsAppConnections.IgnoreQueryFilters().SingleAsync();
        Assert.Equal(tenant, row.TenantId); Assert.Equal("789", row.PhoneNumberId); Assert.Equal("protected-fixture", row.AccessTokenProtected);
        Assert.True(row.Active); Assert.Null(row.TokenExpiresAt);Assert.Null(row.DeliveryPolledAt);
        Assert.Equal("unchecked",row.HealthState);Assert.Null(row.HealthAttemptedAt);Assert.Null(row.HealthCheckedAt);
        Assert.Null(row.HealthLeaseId);Assert.Null(row.HealthTokenValid);Assert.Null(row.HealthScopesPresent);
        Assert.Null(row.HealthAssetsVerified);Assert.Null(row.HealthAppSubscribed);Assert.Null(row.HealthPhoneVerified);
        Assert.Equal("unchecked",row.TemplatesState);Assert.Null(row.TemplatesCheckedAt);Assert.Null(row.TemplatesAttemptedAt);
        Assert.Null(row.TemplatesLeaseId);Assert.Null(row.TemplatesLeaseUntil);Assert.Null(row.TemplatesConfigurationHash);
        Assert.Equal("unchecked",row.TaskAssignmentTemplateState);Assert.Equal("unchecked",row.OverdueTemplateState);Assert.Equal("unchecked",row.SupportUpdateTemplateState);
        Assert.Empty(await db.WhatsAppContactLinks.IgnoreQueryFilters().ToArrayAsync());
        Assert.Empty(await db.WhatsAppDeliveries.IgnoreQueryFilters().ToArrayAsync());
    }
    [Fact]
    public async Task Prior_verified_phone_upgrade_preserves_identity_without_inventing_notification_consent()
    {
        using var scope = factory.Services.CreateScope();
        await using var connection = new SqliteConnection("Data Source=:memory:"); await connection.OpenAsync();
        await using var db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>().UseSqlite(connection).Options,
            scope.ServiceProvider.GetRequiredService<ICurrentContext>(), TimeProvider.System);
        var assembly = db.GetService<IMigrationsAssembly>(); var generator = db.GetService<IMigrationsSqlGenerator>();
        await db.Database.ExecuteSqlRawAsync("""CREATE TABLE "Users" ("Id" TEXT NOT NULL PRIMARY KEY)""");
        var previous = assembly.CreateMigration(assembly.Migrations["20261011093926_WhatsAppPrivateContactLinks"], db.Database.ProviderName!);
        foreach (var command in generator.Generate(previous.UpOperations, db.Model)) await db.Database.ExecuteSqlRawAsync(command.CommandText);
        var id=Guid.NewGuid();var user=Guid.NewGuid();var tenant=Guid.NewGuid();var installation=Guid.NewGuid();var now=DateTime.UtcNow;
        await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO "WhatsAppContactLinks" ("Id","UserId","TenantId","ConnectionId","ConnectionConnectedAt","PhoneProtected","PhoneHash","ConfigurationHash","VerifiedAt","ConsentVersion","ConsentAt","RateWindowAt","ChallengesIssued","CreatedAt")
            VALUES ({id},{user},{tenant},{installation},{now},{"protected-fixture-phone"},{"fingerprint-fixture"},{"configuration-fixture"},{now},{"whatsapp-account-link-v1"},{now},{now},{4},{now})
            """);
        await SqliteEnterpriseUpgrade.ApplyAsync(db); await SqliteEnterpriseUpgrade.ApplyAsync(db);
        var row = await db.WhatsAppContactLinks.IgnoreQueryFilters().SingleAsync();
        Assert.Equal(user,row.UserId);Assert.Equal(tenant,row.TenantId);Assert.Equal(installation,row.ConnectionId);
        Assert.Equal("protected-fixture-phone",row.PhoneProtected);Assert.Equal(now,row.VerifiedAt);Assert.Equal(4,row.ChallengesIssued);
        Assert.Equal("whatsapp-account-link-v1",row.ConsentVersion);Assert.Equal(0,row.NotificationPreferencesVersion);
        Assert.Null(row.NotificationConsentVersion);Assert.Null(row.NotificationConsentAt);Assert.Null(row.NotificationConsentExpiresAt);
        Assert.False(row.NotifyTaskAssignments);Assert.False(row.NotifyOverdue);Assert.False(row.NotifySupportUpdates);
        Assert.Equal(1320,row.NotificationQuietStartMinutes);Assert.Equal(480,row.NotificationQuietEndMinutes);
    }

}
