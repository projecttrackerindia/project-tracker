using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AiUserAndTeamBudgets : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "AiCreditBudgets",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Scope = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    SubjectId = table.Column<Guid>(type: "uuid", nullable: false),
                    MonthlyLimit = table.Column<long>(type: "bigint", nullable: false),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    Version = table.Column<int>(type: "integer", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AiCreditBudgets", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "AiCreditBudgetUsages",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    BudgetId = table.Column<Guid>(type: "uuid", nullable: false),
                    AccountId = table.Column<Guid>(type: "uuid", nullable: false),
                    Spent = table.Column<long>(type: "bigint", nullable: false),
                    Reserved = table.Column<long>(type: "bigint", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AiCreditBudgetUsages", x => x.Id);
                    table.ForeignKey(
                        name: "FK_AiCreditBudgetUsages_AiCreditAccounts_AccountId",
                        column: x => x.AccountId,
                        principalTable: "AiCreditAccounts",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_AiCreditBudgetUsages_AiCreditBudgets_BudgetId",
                        column: x => x.BudgetId,
                        principalTable: "AiCreditBudgets",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "AiCreditBudgetHolds",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ReservationId = table.Column<Guid>(type: "uuid", nullable: false),
                    BudgetUsageId = table.Column<Guid>(type: "uuid", nullable: false),
                    PolicyVersion = table.Column<int>(type: "integer", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AiCreditBudgetHolds", x => x.Id);
                    table.ForeignKey(
                        name: "FK_AiCreditBudgetHolds_AiCreditBudgetUsages_BudgetUsageId",
                        column: x => x.BudgetUsageId,
                        principalTable: "AiCreditBudgetUsages",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_AiCreditBudgetHolds_AiCreditReservations_ReservationId",
                        column: x => x.ReservationId,
                        principalTable: "AiCreditReservations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AiCreditBudgetHolds_BudgetUsageId",
                table: "AiCreditBudgetHolds",
                column: "BudgetUsageId");

            migrationBuilder.CreateIndex(
                name: "IX_AiCreditBudgetHolds_ReservationId_BudgetUsageId",
                table: "AiCreditBudgetHolds",
                columns: new[] { "ReservationId", "BudgetUsageId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_AiCreditBudgetUsages_AccountId",
                table: "AiCreditBudgetUsages",
                column: "AccountId");

            migrationBuilder.CreateIndex(
                name: "IX_AiCreditBudgetUsages_BudgetId",
                table: "AiCreditBudgetUsages",
                column: "BudgetId");

            migrationBuilder.CreateIndex(
                name: "IX_AiCreditBudgetUsages_TenantId_BudgetId_AccountId",
                table: "AiCreditBudgetUsages",
                columns: new[] { "TenantId", "BudgetId", "AccountId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_AiCreditBudgets_TenantId_Scope_SubjectId",
                table: "AiCreditBudgets",
                columns: new[] { "TenantId", "Scope", "SubjectId" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "AiCreditBudgetHolds");

            migrationBuilder.DropTable(
                name: "AiCreditBudgetUsages");

            migrationBuilder.DropTable(
                name: "AiCreditBudgets");
        }
    }
}
