using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Releases (the work items going out together, the test runs that check them, a go/no-go) and a project status set by hand (on track /
    /// at risk / late with why, until when and who). Two new tables and nullable columns only: nothing existing changes.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261113001000_ReleasesAndHealth")]
    public partial class ReleasesAndHealth : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(name: "HealthOverride", table: "Projects", type: "character varying(16)", maxLength: 16, nullable: true);
            migrationBuilder.AddColumn<string>(name: "HealthNote", table: "Projects", type: "character varying(300)", maxLength: 300, nullable: true);
            migrationBuilder.AddColumn<DateOnly>(name: "HealthUntil", table: "Projects", type: "date", nullable: true);
            migrationBuilder.AddColumn<Guid>(name: "HealthSetById", table: "Projects", type: "uuid", nullable: true);
            migrationBuilder.AddColumn<DateTime>(name: "HealthSetAt", table: "Projects", type: "timestamp with time zone", nullable: true);

            migrationBuilder.AddColumn<Guid>(name: "ReleaseId", table: "TestRuns", type: "uuid", nullable: true);
            migrationBuilder.CreateIndex(name: "IX_TestRuns_TenantId_ReleaseId", table: "TestRuns", columns: new[] { "TenantId", "ReleaseId" });

            migrationBuilder.CreateTable(
                name: "Releases",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: true),
                    Name = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    TargetDate = table.Column<DateOnly>(type: "date", nullable: true),
                    Status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Notes = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: true),
                    ApprovedById = table.Column<Guid>(type: "uuid", nullable: true),
                    ApprovedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    ShippedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Releases", x => x.Id);
                });
            migrationBuilder.CreateIndex(name: "IX_Releases_TenantId_ProjectId_TargetDate", table: "Releases", columns: new[] { "TenantId", "ProjectId", "TargetDate" });

            migrationBuilder.CreateTable(
                name: "ReleaseItems",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ReleaseId = table.Column<Guid>(type: "uuid", nullable: false),
                    WorkItemId = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ReleaseItems", x => x.Id);
                });
            migrationBuilder.CreateIndex(name: "IX_ReleaseItems_TenantId_ReleaseId_WorkItemId", table: "ReleaseItems", columns: new[] { "TenantId", "ReleaseId", "WorkItemId" }, unique: true);
            migrationBuilder.CreateIndex(name: "IX_ReleaseItems_TenantId_WorkItemId", table: "ReleaseItems", columns: new[] { "TenantId", "WorkItemId" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "ReleaseItems");
            migrationBuilder.DropTable(name: "Releases");
            migrationBuilder.DropIndex(name: "IX_TestRuns_TenantId_ReleaseId", table: "TestRuns");
            migrationBuilder.DropColumn(name: "ReleaseId", table: "TestRuns");
            migrationBuilder.DropColumn(name: "HealthOverride", table: "Projects");
            migrationBuilder.DropColumn(name: "HealthNote", table: "Projects");
            migrationBuilder.DropColumn(name: "HealthUntil", table: "Projects");
            migrationBuilder.DropColumn(name: "HealthSetById", table: "Projects");
            migrationBuilder.DropColumn(name: "HealthSetAt", table: "Projects");
        }
    }
}
