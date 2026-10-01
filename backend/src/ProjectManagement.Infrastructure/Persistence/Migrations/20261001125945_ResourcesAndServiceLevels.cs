using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class ResourcesAndServiceLevels : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(
                name: "ResolutionDueAt",
                table: "WorkTasks",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "ResolutionRiskAt",
                table: "WorkTasks",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "RespondedAt",
                table: "WorkTasks",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "ResponseDueAt",
                table: "WorkTasks",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "SlaAlerted",
                table: "WorkTasks",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<DateTime>(
                name: "SlaPausedAt",
                table: "WorkTasks",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "SlaPausedMinutes",
                table: "WorkTasks",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<bool>(
                name: "Billable",
                table: "TimeEntries",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<string>(
                name: "CostCurrency",
                table: "Tenants",
                type: "character varying(3)",
                maxLength: 3,
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "BillRate",
                table: "TenantMembers",
                type: "numeric(12,2)",
                precision: 12,
                scale: 2,
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "CostRate",
                table: "TenantMembers",
                type: "numeric(12,2)",
                precision: 12,
                scale: 2,
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "WeeklyCapacityMinutes",
                table: "TenantMembers",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "BillRate",
                table: "Projects",
                type: "numeric(12,2)",
                precision: 12,
                scale: 2,
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "BudgetAmount",
                table: "Projects",
                type: "numeric(14,2)",
                precision: 14,
                scale: 2,
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "BudgetHours",
                table: "Projects",
                type: "numeric(10,2)",
                precision: 10,
                scale: 2,
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "IsBillable",
                table: "Projects",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.CreateTable(
                name: "SlaPolicies",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    WorkTypeId = table.Column<Guid>(type: "uuid", nullable: true),
                    Priority = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    ResponseMinutes = table.Column<int>(type: "integer", nullable: true),
                    ResolutionMinutes = table.Column<int>(type: "integer", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SlaPolicies", x => x.Id);
                    table.ForeignKey(
                        name: "FK_SlaPolicies_WorkTypes_WorkTypeId",
                        column: x => x.WorkTypeId,
                        principalTable: "WorkTypes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "TimesheetApprovals",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    WeekStart = table.Column<DateOnly>(type: "date", nullable: false),
                    Status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    TotalMinutes = table.Column<int>(type: "integer", nullable: false),
                    BillableMinutes = table.Column<int>(type: "integer", nullable: false),
                    Note = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    SubmittedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    ReviewerId = table.Column<Guid>(type: "uuid", nullable: true),
                    ReviewedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    ReviewNote = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TimesheetApprovals", x => x.Id);
                    table.ForeignKey(
                        name: "FK_TimesheetApprovals_Users_UserId",
                        column: x => x.UserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_WorkTasks_Status_ResolutionDueAt",
                table: "WorkTasks",
                columns: new[] { "Status", "ResolutionDueAt" });

            migrationBuilder.CreateIndex(
                name: "IX_WorkTasks_Status_ResponseDueAt",
                table: "WorkTasks",
                columns: new[] { "Status", "ResponseDueAt" });

            migrationBuilder.CreateIndex(
                name: "IX_SlaPolicies_TenantId_WorkTypeId_Priority",
                table: "SlaPolicies",
                columns: new[] { "TenantId", "WorkTypeId", "Priority" });

            migrationBuilder.CreateIndex(
                name: "IX_SlaPolicies_WorkTypeId",
                table: "SlaPolicies",
                column: "WorkTypeId");

            migrationBuilder.CreateIndex(
                name: "IX_TimesheetApprovals_TenantId_Status_WeekStart",
                table: "TimesheetApprovals",
                columns: new[] { "TenantId", "Status", "WeekStart" });

            migrationBuilder.CreateIndex(
                name: "IX_TimesheetApprovals_TenantId_UserId_WeekStart",
                table: "TimesheetApprovals",
                columns: new[] { "TenantId", "UserId", "WeekStart" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_TimesheetApprovals_UserId",
                table: "TimesheetApprovals",
                column: "UserId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "SlaPolicies");

            migrationBuilder.DropTable(
                name: "TimesheetApprovals");

            migrationBuilder.DropIndex(
                name: "IX_WorkTasks_Status_ResolutionDueAt",
                table: "WorkTasks");

            migrationBuilder.DropIndex(
                name: "IX_WorkTasks_Status_ResponseDueAt",
                table: "WorkTasks");

            migrationBuilder.DropColumn(
                name: "ResolutionDueAt",
                table: "WorkTasks");

            migrationBuilder.DropColumn(
                name: "ResolutionRiskAt",
                table: "WorkTasks");

            migrationBuilder.DropColumn(
                name: "RespondedAt",
                table: "WorkTasks");

            migrationBuilder.DropColumn(
                name: "ResponseDueAt",
                table: "WorkTasks");

            migrationBuilder.DropColumn(
                name: "SlaAlerted",
                table: "WorkTasks");

            migrationBuilder.DropColumn(
                name: "SlaPausedAt",
                table: "WorkTasks");

            migrationBuilder.DropColumn(
                name: "SlaPausedMinutes",
                table: "WorkTasks");

            migrationBuilder.DropColumn(
                name: "Billable",
                table: "TimeEntries");

            migrationBuilder.DropColumn(
                name: "CostCurrency",
                table: "Tenants");

            migrationBuilder.DropColumn(
                name: "BillRate",
                table: "TenantMembers");

            migrationBuilder.DropColumn(
                name: "CostRate",
                table: "TenantMembers");

            migrationBuilder.DropColumn(
                name: "WeeklyCapacityMinutes",
                table: "TenantMembers");

            migrationBuilder.DropColumn(
                name: "BillRate",
                table: "Projects");

            migrationBuilder.DropColumn(
                name: "BudgetAmount",
                table: "Projects");

            migrationBuilder.DropColumn(
                name: "BudgetHours",
                table: "Projects");

            migrationBuilder.DropColumn(
                name: "IsBillable",
                table: "Projects");
        }
    }
}
