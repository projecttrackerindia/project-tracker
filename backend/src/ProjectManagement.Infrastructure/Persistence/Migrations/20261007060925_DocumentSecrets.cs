using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class DocumentSecrets : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "ChainAnchorHash",
                table: "TenantSecuritySettings",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "ChainAnchorSeq",
                table: "TenantSecuritySettings",
                type: "bigint",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "ChainBrokenAt",
                table: "TenantSecuritySettings",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "ChainBrokenSeq",
                table: "TenantSecuritySettings",
                type: "bigint",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "ChainVerifiedAt",
                table: "TenantSecuritySettings",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ChainVerifiedHash",
                table: "TenantSecuritySettings",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "ChainVerifiedSeq",
                table: "TenantSecuritySettings",
                type: "bigint",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "RevealSeconds",
                table: "TenantSecuritySettings",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<string>(
                name: "Hash",
                table: "AuditLogs",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "PrevHash",
                table: "AuditLogs",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "Seq",
                table: "AuditLogs",
                type: "bigint",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "DocumentKeys",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Version = table.Column<int>(type: "integer", nullable: false),
                    WrappedKey = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    Active = table.Column<bool>(type: "boolean", nullable: false),
                    RetiredAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DocumentKeys", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "SensitiveValues",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    DocumentId = table.Column<Guid>(type: "uuid", nullable: false),
                    Label = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    Note = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    Class = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Cipher = table.Column<string>(type: "character varying(12000)", maxLength: 12000, nullable: false),
                    KeyVersion = table.Column<int>(type: "integer", nullable: false),
                    ValueChangedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    ReencryptedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SensitiveValues", x => x.Id);
                    table.ForeignKey(
                        name: "FK_SensitiveValues_Documents_DocumentId",
                        column: x => x.DocumentId,
                        principalTable: "Documents",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "StepUpGrants",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    TokenHash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    ExpiresAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_StepUpGrants", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AuditLogs_TenantId_Seq",
                table: "AuditLogs",
                columns: new[] { "TenantId", "Seq" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_DocumentKeys_TenantId_Version",
                table: "DocumentKeys",
                columns: new[] { "TenantId", "Version" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_SensitiveValues_DocumentId",
                table: "SensitiveValues",
                column: "DocumentId");

            migrationBuilder.CreateIndex(
                name: "IX_SensitiveValues_TenantId_DocumentId",
                table: "SensitiveValues",
                columns: new[] { "TenantId", "DocumentId" });

            migrationBuilder.CreateIndex(
                name: "IX_SensitiveValues_TenantId_KeyVersion",
                table: "SensitiveValues",
                columns: new[] { "TenantId", "KeyVersion" });

            migrationBuilder.CreateIndex(
                name: "IX_StepUpGrants_ExpiresAt",
                table: "StepUpGrants",
                column: "ExpiresAt");

            migrationBuilder.CreateIndex(
                name: "IX_StepUpGrants_TokenHash",
                table: "StepUpGrants",
                column: "TokenHash",
                unique: true);
        
            if (migrationBuilder.ActiveProvider.Contains("Npgsql", StringComparison.OrdinalIgnoreCase))
            {
                // The audit trail is append-only: the database itself refuses to change or delete a row, whoever asks. The one exception is the
                // retention job, which sets a transaction-local flag while it removes rows older than the workspace's retention period.
                migrationBuilder.Sql(@"
CREATE OR REPLACE FUNCTION audit_log_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' AND current_setting('app.audit_purge', true) = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Audit records cannot be changed or deleted' USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON ""AuditLogs"" FOR EACH ROW EXECUTE FUNCTION audit_log_guard();");
            }
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            if (migrationBuilder.ActiveProvider.Contains("Npgsql", StringComparison.OrdinalIgnoreCase))
                migrationBuilder.Sql(@"DROP TRIGGER IF EXISTS audit_log_immutable ON ""AuditLogs""; DROP FUNCTION IF EXISTS audit_log_guard();");

            migrationBuilder.DropTable(
                name: "DocumentKeys");

            migrationBuilder.DropTable(
                name: "SensitiveValues");

            migrationBuilder.DropTable(
                name: "StepUpGrants");

            migrationBuilder.DropIndex(
                name: "IX_AuditLogs_TenantId_Seq",
                table: "AuditLogs");

            migrationBuilder.DropColumn(
                name: "ChainAnchorHash",
                table: "TenantSecuritySettings");

            migrationBuilder.DropColumn(
                name: "ChainAnchorSeq",
                table: "TenantSecuritySettings");

            migrationBuilder.DropColumn(
                name: "ChainBrokenAt",
                table: "TenantSecuritySettings");

            migrationBuilder.DropColumn(
                name: "ChainBrokenSeq",
                table: "TenantSecuritySettings");

            migrationBuilder.DropColumn(
                name: "ChainVerifiedAt",
                table: "TenantSecuritySettings");

            migrationBuilder.DropColumn(
                name: "ChainVerifiedHash",
                table: "TenantSecuritySettings");

            migrationBuilder.DropColumn(
                name: "ChainVerifiedSeq",
                table: "TenantSecuritySettings");

            migrationBuilder.DropColumn(
                name: "RevealSeconds",
                table: "TenantSecuritySettings");

            migrationBuilder.DropColumn(
                name: "Hash",
                table: "AuditLogs");

            migrationBuilder.DropColumn(
                name: "PrevHash",
                table: "AuditLogs");

            migrationBuilder.DropColumn(
                name: "Seq",
                table: "AuditLogs");
        }
    }
}
