using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Attendance: one check-in / check-out day per person per organization-local date (where they worked: office, home or a client's), and
    /// each workspace's attendance rules. Two new tables only: nothing existing changes.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261116002000_Attendance")]
    public partial class Attendance : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "AttendanceDays",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Date = table.Column<DateOnly>(type: "date", nullable: false),
                    CheckInAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CheckOutAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    Mode = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Place = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: true),
                    Note = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    Source = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    AutoClosed = table.Column<bool>(type: "boolean", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AttendanceDays", x => x.Id);
                });
            migrationBuilder.CreateIndex(name: "IX_AttendanceDays_TenantId_UserId_Date", table: "AttendanceDays", columns: new[] { "TenantId", "UserId", "Date" }, unique: true);
            migrationBuilder.CreateIndex(name: "IX_AttendanceDays_TenantId_Date", table: "AttendanceDays", columns: new[] { "TenantId", "Date" });

            migrationBuilder.CreateTable(
                name: "AttendancePolicies",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    HoursSource = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    WorkDays = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    WorkStart = table.Column<TimeOnly>(type: "time without time zone", nullable: false),
                    WorkEnd = table.Column<TimeOnly>(type: "time without time zone", nullable: false),
                    CheckInGraceMinutes = table.Column<int>(type: "integer", nullable: false),
                    CheckOutGraceMinutes = table.Column<int>(type: "integer", nullable: false),
                    AutoClose = table.Column<bool>(type: "boolean", nullable: false),
                    AutoCloseAfterHours = table.Column<int>(type: "integer", nullable: false),
                    AllowedModes = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: false),
                    RequireClientPlace = table.Column<bool>(type: "boolean", nullable: false),
                    PromptAtSignIn = table.Column<bool>(type: "boolean", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AttendancePolicies", x => x.Id);
                });
            migrationBuilder.CreateIndex(name: "IX_AttendancePolicies_TenantId", table: "AttendancePolicies", column: "TenantId", unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "AttendancePolicies");
            migrationBuilder.DropTable(name: "AttendanceDays");
        }
    }
}
