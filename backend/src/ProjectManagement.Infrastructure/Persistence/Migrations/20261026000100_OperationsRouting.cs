using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>Operations: business-hours service levels and escalation (one row per workspace), and who new work is routed to. Additive only.</summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261026000100_OperationsRouting")]
    public partial class OperationsRouting : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "OperationsSettings",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    BusinessHoursOnly = table.Column<bool>(type: "boolean", nullable: false),
                    DayStartMinutes = table.Column<int>(type: "integer", nullable: false),
                    DayEndMinutes = table.Column<int>(type: "integer", nullable: false),
                    WorkDays = table.Column<int>(type: "integer", nullable: false),
                    TimeZone = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    EscalateOnBreach = table.Column<bool>(type: "boolean", nullable: false),
                    EscalateToUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table => table.PrimaryKey("PK_OperationsSettings", x => x.Id));
            migrationBuilder.CreateIndex(name: "IX_OperationsSettings_TenantId", table: "OperationsSettings", column: "TenantId", unique: true);

            migrationBuilder.CreateTable(
                name: "WorkRoutingRules",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    WorkTypeId = table.Column<Guid>(type: "uuid", nullable: true),
                    Mode = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    MemberIds = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: false),
                    LastAssignedUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    EscalateToUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WorkRoutingRules", x => x.Id);
                    table.ForeignKey(name: "FK_WorkRoutingRules_WorkTypes_WorkTypeId", column: x => x.WorkTypeId, principalTable: "WorkTypes", principalColumn: "Id", onDelete: ReferentialAction.Cascade);
                });
            migrationBuilder.CreateIndex(name: "IX_WorkRoutingRules_TenantId_WorkTypeId", table: "WorkRoutingRules", columns: new[] { "TenantId", "WorkTypeId" });
            migrationBuilder.CreateIndex(name: "IX_WorkRoutingRules_WorkTypeId", table: "WorkRoutingRules", column: "WorkTypeId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "WorkRoutingRules");
            migrationBuilder.DropTable(name: "OperationsSettings");
        }
    }
}
