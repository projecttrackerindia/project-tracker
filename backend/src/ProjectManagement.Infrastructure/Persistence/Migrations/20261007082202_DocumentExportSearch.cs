using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class DocumentExportSearch : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "DocumentId",
                table: "ReportExports",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "VersionId",
                table: "ReportExports",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "SearchIndexedAt",
                table: "Documents",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "SearchText",
                table: "Documents",
                type: "text",
                nullable: true);
        
            if (migrationBuilder.ActiveProvider.Contains("Npgsql", StringComparison.OrdinalIgnoreCase))
            {
                // Trigram index so a word can be found anywhere in a document's text quickly. If the database does not allow the extension, search still works (it scans).
                migrationBuilder.Sql(@"DO $$ BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE INDEX IF NOT EXISTS ""IX_Documents_SearchText_trgm"" ON ""Documents"" USING gin (""SearchText"" gin_trgm_ops);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pg_trgm is not available: document search will scan instead of using an index';
END $$;");
            }
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            if (migrationBuilder.ActiveProvider.Contains("Npgsql", StringComparison.OrdinalIgnoreCase))
                migrationBuilder.Sql(@"DROP INDEX IF EXISTS ""IX_Documents_SearchText_trgm"";");

            migrationBuilder.DropColumn(
                name: "DocumentId",
                table: "ReportExports");

            migrationBuilder.DropColumn(
                name: "VersionId",
                table: "ReportExports");

            migrationBuilder.DropColumn(
                name: "SearchIndexedAt",
                table: "Documents");

            migrationBuilder.DropColumn(
                name: "SearchText",
                table: "Documents");
        }
    }
}
