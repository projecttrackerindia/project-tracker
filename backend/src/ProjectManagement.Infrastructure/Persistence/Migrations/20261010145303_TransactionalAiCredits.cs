using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class TransactionalAiCredits : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "AiCreditAccounts",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    PeriodStart = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
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
                    table.PrimaryKey("PK_AiCreditAccounts", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "AiCreditReservations",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    AccountId = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    OperationId = table.Column<Guid>(type: "uuid", nullable: false),
                    Amount = table.Column<int>(type: "integer", nullable: false),
                    Charged = table.Column<int>(type: "integer", nullable: false),
                    Feature = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Status = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    ExpiresAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    SettledAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AiCreditReservations", x => x.Id);
                    table.ForeignKey(
                        name: "FK_AiCreditReservations_AiCreditAccounts_AccountId",
                        column: x => x.AccountId,
                        principalTable: "AiCreditAccounts",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "AiCreditEntries",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    AccountId = table.Column<Guid>(type: "uuid", nullable: false),
                    ReservationId = table.Column<Guid>(type: "uuid", nullable: true),
                    UserId = table.Column<Guid>(type: "uuid", nullable: true),
                    Kind = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    SpentDelta = table.Column<long>(type: "bigint", nullable: false),
                    ReservedDelta = table.Column<long>(type: "bigint", nullable: false),
                    PolicyVersion = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AiCreditEntries", x => x.Id);
                    table.ForeignKey(
                        name: "FK_AiCreditEntries_AiCreditAccounts_AccountId",
                        column: x => x.AccountId,
                        principalTable: "AiCreditAccounts",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_AiCreditEntries_AiCreditReservations_ReservationId",
                        column: x => x.ReservationId,
                        principalTable: "AiCreditReservations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AiCreditAccounts_TenantId_PeriodStart",
                table: "AiCreditAccounts",
                columns: new[] { "TenantId", "PeriodStart" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_AiCreditEntries_AccountId",
                table: "AiCreditEntries",
                column: "AccountId");

            migrationBuilder.CreateIndex(
                name: "IX_AiCreditEntries_ReservationId",
                table: "AiCreditEntries",
                column: "ReservationId");

            migrationBuilder.CreateIndex(
                name: "IX_AiCreditEntries_TenantId_AccountId_CreatedAt",
                table: "AiCreditEntries",
                columns: new[] { "TenantId", "AccountId", "CreatedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_AiCreditReservations_AccountId",
                table: "AiCreditReservations",
                column: "AccountId");

            migrationBuilder.CreateIndex(
                name: "IX_AiCreditReservations_TenantId_OperationId",
                table: "AiCreditReservations",
                columns: new[] { "TenantId", "OperationId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_AiCreditReservations_TenantId_Status_ExpiresAt",
                table: "AiCreditReservations",
                columns: new[] { "TenantId", "Status", "ExpiresAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "AiCreditEntries");

            migrationBuilder.DropTable(
                name: "AiCreditReservations");

            migrationBuilder.DropTable(
                name: "AiCreditAccounts");
        }
    }
}
