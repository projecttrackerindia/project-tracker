using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class DocumentVersionsSharingFiles : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Release D1 numbered a first draft 0.1; a draft now carries the number of the version it grew from (0.0 until the first publish).
            migrationBuilder.Sql(ActiveProvider.Contains("Npgsql", StringComparison.OrdinalIgnoreCase)
                ? "UPDATE \"DocumentVersions\" SET \"Minor\" = 0 WHERE \"IsDraft\" = TRUE AND \"Major\" = 0 AND \"Minor\" = 1"
                : "UPDATE \"DocumentVersions\" SET \"Minor\" = 0 WHERE \"IsDraft\" = 1 AND \"Major\" = 0 AND \"Minor\" = 1");

            migrationBuilder.AddColumn<Guid>(
                name: "PublishedVersionId",
                table: "Documents",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "PublishedAt",
                table: "DocumentVersions",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "PublishedBy",
                table: "DocumentVersions",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "RestoredFromId",
                table: "DocumentVersions",
                type: "uuid",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "DocumentFiles",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    DocumentId = table.Column<Guid>(type: "uuid", nullable: false),
                    FileName = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    ContentType = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    SizeBytes = table.Column<long>(type: "bigint", nullable: false),
                    StorageKey = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    Sha256 = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DocumentFiles", x => x.Id);
                    table.ForeignKey(
                        name: "FK_DocumentFiles_Documents_DocumentId",
                        column: x => x.DocumentId,
                        principalTable: "Documents",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "DocumentGrants",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    DocumentId = table.Column<Guid>(type: "uuid", nullable: false),
                    PrincipalType = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    PrincipalId = table.Column<Guid>(type: "uuid", nullable: false),
                    Level = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Deny = table.Column<bool>(type: "boolean", nullable: false),
                    ExpiresAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    Note = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DocumentGrants", x => x.Id);
                    table.ForeignKey(
                        name: "FK_DocumentGrants_Documents_DocumentId",
                        column: x => x.DocumentId,
                        principalTable: "Documents",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_DocumentFiles_DocumentId",
                table: "DocumentFiles",
                column: "DocumentId");

            migrationBuilder.CreateIndex(
                name: "IX_DocumentFiles_TenantId_DocumentId",
                table: "DocumentFiles",
                columns: new[] { "TenantId", "DocumentId" });

            migrationBuilder.CreateIndex(
                name: "IX_DocumentGrants_DocumentId",
                table: "DocumentGrants",
                column: "DocumentId");

            migrationBuilder.CreateIndex(
                name: "IX_DocumentGrants_TenantId_DocumentId_PrincipalType_PrincipalI~",
                table: "DocumentGrants",
                columns: new[] { "TenantId", "DocumentId", "PrincipalType", "PrincipalId", "Deny" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_DocumentGrants_TenantId_PrincipalType_PrincipalId",
                table: "DocumentGrants",
                columns: new[] { "TenantId", "PrincipalType", "PrincipalId" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "DocumentFiles");

            migrationBuilder.DropTable(
                name: "DocumentGrants");

            migrationBuilder.DropColumn(
                name: "PublishedVersionId",
                table: "Documents");

            migrationBuilder.DropColumn(
                name: "PublishedAt",
                table: "DocumentVersions");

            migrationBuilder.DropColumn(
                name: "PublishedBy",
                table: "DocumentVersions");

            migrationBuilder.DropColumn(
                name: "RestoredFromId",
                table: "DocumentVersions");
        }
    }
}
