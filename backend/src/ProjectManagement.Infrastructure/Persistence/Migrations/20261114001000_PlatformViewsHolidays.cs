using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Saved views of lists (private or shared), public holidays for capacity, a workspace's public API status page, the "keep data in India"
    /// setting, and an index for an item's History (audit rows by entity). Three new tables, one new column with a default and one index:
    /// nothing existing changes.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261114001000_PlatformViewsHolidays")]
    public partial class PlatformViewsHolidays : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(name: "KeepDataInIndia", table: "TenantSecuritySettings", type: "boolean", nullable: false, defaultValue: false);
            migrationBuilder.CreateIndex(name: "IX_AuditLogs_TenantId_EntityId", table: "AuditLogs", columns: new[] { "TenantId", "EntityId" });

            migrationBuilder.CreateTable(
                name: "SavedViews",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    OwnerId = table.Column<Guid>(type: "uuid", nullable: false),
                    Scope = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    Name = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    Shared = table.Column<bool>(type: "boolean", nullable: false),
                    TeamId = table.Column<Guid>(type: "uuid", nullable: true),
                    ConfigJson = table.Column<string>(type: "character varying(8000)", maxLength: 8000, nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SavedViews", x => x.Id);
                });
            migrationBuilder.CreateIndex(name: "IX_SavedViews_TenantId_Scope_OwnerId", table: "SavedViews", columns: new[] { "TenantId", "Scope", "OwnerId" });

            migrationBuilder.CreateTable(
                name: "Holidays",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Date = table.Column<DateOnly>(type: "date", nullable: false),
                    Name = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    Region = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Holidays", x => x.Id);
                });
            migrationBuilder.CreateIndex(name: "IX_Holidays_TenantId_Date_Name", table: "Holidays", columns: new[] { "TenantId", "Date", "Name" }, unique: true);

            migrationBuilder.CreateTable(
                name: "StatusPages",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Slug = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: false),
                    Title = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    Published = table.Column<bool>(type: "boolean", nullable: false),
                    ComponentsJson = table.Column<string>(type: "character varying(8000)", maxLength: 8000, nullable: false),
                    PublishedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_StatusPages", x => x.Id);
                });
            migrationBuilder.CreateIndex(name: "IX_StatusPages_Slug", table: "StatusPages", column: "Slug", unique: true);
            migrationBuilder.CreateIndex(name: "IX_StatusPages_TenantId", table: "StatusPages", column: "TenantId", unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "StatusPages");
            migrationBuilder.DropTable(name: "Holidays");
            migrationBuilder.DropTable(name: "SavedViews");
            migrationBuilder.DropIndex(name: "IX_AuditLogs_TenantId_EntityId", table: "AuditLogs");
            migrationBuilder.DropColumn(name: "KeepDataInIndia", table: "TenantSecuritySettings");
        }
    }
}
