using System.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.EntityFrameworkCore.Migrations.Operations;
using Microsoft.EntityFrameworkCore.Storage;

namespace ProjectManagement.Infrastructure.Persistence;

/// <summary>Additive, explicitly reviewed expansion upgrades for EnsureCreated SQLite databases.</summary>
public static class SqliteEnterpriseUpgrade
{
    private static readonly string[] Migrations=[
        "20261011021558_PersonalResumesAndCertifications",
        "20261011023413_ResumeExportsAndSupportTickets",
        "20261011024744_CertificationExpiryReminders",
        "20261011025027_PrivateCertificationAttachments",
        "20261011030531_DurableSupportWorkflows",
        "20261011035406_DurablePersonalFileCleanup",
        "20261011051417_DurableProviderOAuthAttempts",
        "20261011053210_PersonalEmailDrafts",
        "20261011062100_MicrosoftProductivityAndEmailProviders",
        "20261011065223_PersonalCalendarProposals",
        "20261011073057_WhatsAppInboundFoundation",
        "20261011091248_WhatsAppInstallationExpiry",
        "20261011093926_WhatsAppPrivateContactLinks",
        "20261011102347_WhatsAppNotificationConsent",
        "20261011104645_WhatsAppProviderHealth",
        "20261011111118_WhatsAppNotificationTemplates",
        "20261011114854_DurableWhatsAppNotificationDelivery",
        "20261011161936_WhatsAppMetadataRetention",
        "20261011173857_ExplicitInboxConsent"
    ];

    public static async Task ApplyAsync(AppDbContext db,CancellationToken ct=default)
    {
        if(!db.Database.IsSqlite())throw new InvalidOperationException("This upgrade is only for SQLite development databases.");
        var assembly=db.GetService<IMigrationsAssembly>();
        var operations=Migrations.SelectMany(id=>assembly.CreateMigration(assembly.Migrations[id],db.Database.ProviderName!).UpOperations).ToArray();
        // No arbitrary SQL, rebuild, rename, alteration or destructive operation can enter this path.
        if(operations.Any(o=>o is not (CreateTableOperation or AddColumnOperation or CreateIndexOperation)))
            throw new InvalidOperationException("An expansion migration needs explicit SQLite upgrade review.");
        var generator=db.GetService<IMigrationsSqlGenerator>();
        var connection=db.Database.GetDbConnection();
        var opened=connection.State!=ConnectionState.Open;
        if(opened)await db.Database.OpenConnectionAsync(ct);
        try
        {
            await using var tx=await db.Database.BeginTransactionAsync(ct);
            async Task<bool> Exists(string kind,string name)
            {
                await using var command=connection.CreateCommand();command.Transaction=tx.GetDbTransaction();
                command.CommandText="SELECT 1 FROM sqlite_schema WHERE type=@kind AND name=@name LIMIT 1";
                var k=command.CreateParameter();k.ParameterName="@kind";k.Value=kind;command.Parameters.Add(k);
                var n=command.CreateParameter();n.ParameterName="@name";n.Value=name;command.Parameters.Add(n);
                return await command.ExecuteScalarAsync(ct)!=null;
            }
            async Task<bool> ColumnExists(string table,string column)
            {
                await using var command=connection.CreateCommand();command.Transaction=tx.GetDbTransaction();
                // Identifiers originate only in the reviewed migrations, never in request data.
                command.CommandText="PRAGMA table_info(\""+table.Replace("\"","\"\"")+"\")";
                await using var reader=await command.ExecuteReaderAsync(ct);
                while(await reader.ReadAsync(ct))if(reader.GetString(1)==column)return true;
                return false;
            }
            foreach(var operation in operations)
            {
                var exists=operation switch
                {
                    CreateTableOperation table=>await Exists("table",table.Name),
                    CreateIndexOperation index=>await Exists("index",index.Name),
                    AddColumnOperation column=>await ColumnExists(column.Table,column.Name),
                    _=>throw new InvalidOperationException()
                };
                if(exists)continue;
                foreach(var command in generator.Generate([operation],db.Model))
                    await db.Database.ExecuteSqlRawAsync(command.CommandText,ct);
            }
            await tx.CommitAsync(ct);
        }
        finally{if(opened)await db.Database.CloseConnectionAsync();}
    }
}
