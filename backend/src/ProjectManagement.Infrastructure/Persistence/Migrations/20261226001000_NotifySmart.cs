using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Smart notifications and feedback: NotificationTunings (a person's grouping window and urgent kinds), NotificationMutes (muted projects
    /// and threads), ProblemReports ("Report a problem") and FeatureFlags (per workspace, team or person). New tables only; nothing existing changes.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261226001000_NotifySmart")]
    public partial class NotifySmart : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "FeatureFlags",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    Key = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Scope = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    TargetId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid?>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UpdatedAt = table.Column<DateTime?>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid?>(type: "uuid", nullable: true),
                },
                constraints: table => table.PrimaryKey("PK_FeatureFlags", x => x.Id));

            migrationBuilder.CreateIndex(name: "IX_FeatureFlags_TenantId_Key_Scope_TargetId", table: "FeatureFlags", columns: new[] { "TenantId", "Key", "Scope", "TargetId" }, unique: true);

            migrationBuilder.CreateTable(
                name: "NotificationMutes",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Label = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    Scope = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    TargetId = table.Column<Guid>(type: "uuid", nullable: false),
                    Until = table.Column<DateTime?>(type: "timestamp with time zone", nullable: true),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid?>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UpdatedAt = table.Column<DateTime?>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid?>(type: "uuid", nullable: true),
                },
                constraints: table => table.PrimaryKey("PK_NotificationMutes", x => x.Id));

            migrationBuilder.CreateIndex(name: "IX_NotificationMutes_TenantId_UserId_Scope_TargetId", table: "NotificationMutes", columns: new[] { "TenantId", "UserId", "Scope", "TargetId" }, unique: true);

            migrationBuilder.CreateTable(
                name: "NotificationTunings",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    GroupWindowMinutes = table.Column<int>(type: "integer", nullable: false),
                    Grouping = table.Column<bool>(type: "boolean", nullable: false),
                    PriorityOverrides = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid?>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UpdatedAt = table.Column<DateTime?>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid?>(type: "uuid", nullable: true),
                },
                constraints: table => table.PrimaryKey("PK_NotificationTunings", x => x.Id));

            migrationBuilder.CreateIndex(name: "IX_NotificationTunings_TenantId_UserId", table: "NotificationTunings", columns: new[] { "TenantId", "UserId" }, unique: true);

            migrationBuilder.CreateTable(
                name: "ProblemReports",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    AppVersion = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    ConsoleTail = table.Column<string>(type: "character varying(16000)", maxLength: 16000, nullable: false),
                    EmailedAt = table.Column<DateTime?>(type: "timestamp with time zone", nullable: true),
                    Message = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    NetworkTail = table.Column<string>(type: "character varying(16000)", maxLength: 16000, nullable: false),
                    Route = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    ScreenshotKey = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    Status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    UserAgent = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid?>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UpdatedAt = table.Column<DateTime?>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid?>(type: "uuid", nullable: true),
                },
                constraints: table => table.PrimaryKey("PK_ProblemReports", x => x.Id));

            migrationBuilder.CreateIndex(name: "IX_ProblemReports_TenantId_CreatedAt", table: "ProblemReports", columns: new[] { "TenantId", "CreatedAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "FeatureFlags");
            migrationBuilder.DropTable(name: "NotificationMutes");
            migrationBuilder.DropTable(name: "NotificationTunings");
            migrationBuilder.DropTable(name: "ProblemReports");
        }
    }
}
