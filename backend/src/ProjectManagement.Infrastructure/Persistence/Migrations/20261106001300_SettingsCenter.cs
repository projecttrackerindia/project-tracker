using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>Settings as one place: a workspace's notification defaults for its members, and setup-health checks marked "not needed here". Additive only.</summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261106001300_SettingsCenter")]
    public partial class SettingsCenter : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "WorkspaceNotificationDefaults",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Channels = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    QuietCustom = table.Column<bool>(type: "boolean", nullable: false),
                    QuietStart = table.Column<TimeOnly>(type: "time without time zone", nullable: true),
                    QuietEnd = table.Column<TimeOnly>(type: "time without time zone", nullable: true),
                    DigestCustom = table.Column<bool>(type: "boolean", nullable: false),
                    DigestTime = table.Column<TimeOnly>(type: "time without time zone", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table => { table.PrimaryKey("PK_WorkspaceNotificationDefaults", x => x.Id); });
            migrationBuilder.CreateIndex(name: "IX_WorkspaceNotificationDefaults_TenantId", table: "WorkspaceNotificationDefaults", column: "TenantId", unique: true);

            migrationBuilder.CreateTable(
                name: "SetupCheckDismissals",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    CheckId = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    Reason = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table => { table.PrimaryKey("PK_SetupCheckDismissals", x => x.Id); });
            migrationBuilder.CreateIndex(name: "IX_SetupCheckDismissals_TenantId_CheckId", table: "SetupCheckDismissals", columns: new[] { "TenantId", "CheckId" }, unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "SetupCheckDismissals");
            migrationBuilder.DropTable(name: "WorkspaceNotificationDefaults");
        }
    }
}
