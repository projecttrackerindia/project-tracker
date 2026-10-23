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
            // Raw SQL with the columns the main schema has: the current model maps columns later migrations add (Users.PasswordChangedAt...).
            await InsertAsync(connection.ConnectionString,"Users",new(){["Id"]=user.Id,["Email"]=user.Email,["NormalizedEmail"]=user.NormalizedEmail,
                ["DisplayName"]=user.DisplayName,["PasswordHash"]=user.PasswordHash,["IsActive"]=true});
            // The workspace row is written with the columns the main schema had: the current model also maps columns added by
            // later migrations (Tenants.TimeZone), which do not exist yet at this point of the upgrade.
            await db.Database.ExecuteSqlInterpolatedAsync($@"INSERT INTO ""Tenants"" (""Id"",""Name"",""Slug"",""Type"",""OwnerUserId"",""Status"",""TrialUsed"",""AiDisabled"",""ProjectVisibility"",""IsDeleted"",""CreatedAt"")
                VALUES ({tenant.Id},{tenant.Name},{tenant.Slug},{"Organization"},{user.Id},{"Active"},{false},{false},{0},{false},{DateTime.UtcNow})");
            context.UserId=user.Id;context.TenantId=tenant.Id;context.Role=TenantRole.Owner;context.WorkspaceType=WorkspaceType.Organization;
            // Raw SQL for the same reason: the current model maps Notifications.DeliverAfter, added by a later migration.
            var notification=new Notification{Id=Guid.NewGuid()};
            await db.Database.ExecuteSqlInterpolatedAsync($@"INSERT INTO ""Notifications"" (""Id"",""TenantId"",""UserId"",""Type"",""Title"",""Body"",""InApp"",""Browser"",""EmailPending"",""EmailAttempts"",""PushPending"",""CreatedAt"")
                VALUES ({notification.Id},{tenant.Id},{user.Id},{"TaskAssigned"},{"Existing notification"},{"Private fixture body"},{true},{true},{false},{0},{false},{DateTime.UtcNow})");
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
            NpgsqlConnection.ClearAllPools();
            // Only the random database created above is removed; never run migrations against the configured admin database.
            await using var drop=new NpgsqlCommand($"DROP DATABASE \"{databaseName}\" WITH (FORCE)",admin);
            await drop.ExecuteNonQueryAsync();
        }
    }

    /// <summary>
    /// Inserts a row with the given values, filling every other required column of the table as it is at this point of the upgrade (no default:
    /// false, 0, empty text, now). Later migrations add columns the current model maps, so the model cannot write rows into the old schema.
    /// </summary>
    private static async Task InsertAsync(string connectionString,string table,Dictionary<string,object> values)
    {
        await using var c=new NpgsqlConnection(connectionString);
        await c.OpenAsync();
        var required=new List<(string Name,string Type)>();
        await using(var q=new NpgsqlCommand("SELECT column_name, data_type FROM information_schema.columns WHERE table_name=@t AND is_nullable='NO' AND column_default IS NULL",c))
        {
            q.Parameters.AddWithValue("t",table);
            await using var r=await q.ExecuteReaderAsync();
            while(await r.ReadAsync())required.Add((r.GetString(0),r.GetString(1)));
        }
        foreach(var (name,type) in required)
        {
            if(values.ContainsKey(name))continue;
            values[name]=type switch
            {
                "boolean"=>false,
                "integer" or "smallint"=>0,
                "bigint"=>0L,
                "numeric" or "double precision" or "real"=>0m,
                "uuid"=>Guid.Empty,
                "timestamp with time zone" or "timestamp without time zone"=>DateTime.UtcNow,
                "date"=>DateOnly.FromDateTime(DateTime.UtcNow),
                _=>"",
            };
        }
        var names=values.Keys.ToList();
        await using var insert=new NpgsqlCommand($"INSERT INTO \"{table}\" ({string.Join(",",names.Select(n=>$"\"{n}\""))}) VALUES ({string.Join(",",names.Select((_,i)=>$"@p{i}"))})",c);
        for(var i=0;i<names.Count;i++)insert.Parameters.AddWithValue($"p{i}",values[names[i]]);
        await insert.ExecuteNonQueryAsync();
    }
}
