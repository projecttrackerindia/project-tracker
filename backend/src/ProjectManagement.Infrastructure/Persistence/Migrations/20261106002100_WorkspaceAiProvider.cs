using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>A workspace's own Claude or ChatGPT key (encrypted) and each person's agreement to use it. Additive only.</summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261106002100_WorkspaceAiProvider")]
    public partial class WorkspaceAiProvider : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "AiWorkspaceProviders",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Provider = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    KeyProtected = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    KeyHint = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: false),
                    QuickModel = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    StandardModel = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    DeepModel = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    FallbackToPlatform = table.Column<bool>(type: "boolean", nullable: false),
                    Version = table.Column<int>(type: "integer", nullable: false),
                    LastCheckedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    LastError = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AiWorkspaceProviders", x => x.Id);
                });
            migrationBuilder.CreateIndex(name: "IX_AiWorkspaceProviders_TenantId", table: "AiWorkspaceProviders", column: "TenantId", unique: true);

            migrationBuilder.CreateTable(
                name: "AiProviderConsents",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Provider = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Version = table.Column<int>(type: "integer", nullable: false),
                    AgreedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    WithdrawnAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AiProviderConsents", x => x.Id);
                });
            migrationBuilder.CreateIndex(name: "IX_AiProviderConsents_TenantId_UserId", table: "AiProviderConsents", columns: new[] { "TenantId", "UserId" }, unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "AiProviderConsents");
            migrationBuilder.DropTable(name: "AiWorkspaceProviders");
        }
    }
}
