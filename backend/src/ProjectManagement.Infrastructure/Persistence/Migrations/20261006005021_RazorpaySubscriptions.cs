using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class RazorpaySubscriptions : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "PendingPlanId",
                table: "Subscriptions",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "PendingProviderSubscriptionId",
                table: "Subscriptions",
                type: "character varying(60)",
                maxLength: 60,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Provider",
                table: "Subscriptions",
                type: "character varying(20)",
                maxLength: 20,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ProviderSubscriptionId",
                table: "Subscriptions",
                type: "character varying(60)",
                maxLength: 60,
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "ProviderPlanAmount",
                table: "Plans",
                type: "numeric(18,2)",
                precision: 18,
                scale: 2,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ProviderPlanId",
                table: "Plans",
                type: "text",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "BillingEvents",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Provider = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    ProviderEventId = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    Type = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: false),
                    ReceivedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_BillingEvents", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_Subscriptions_PendingProviderSubscriptionId",
                table: "Subscriptions",
                column: "PendingProviderSubscriptionId");

            migrationBuilder.CreateIndex(
                name: "IX_Subscriptions_ProviderSubscriptionId",
                table: "Subscriptions",
                column: "ProviderSubscriptionId");

            migrationBuilder.CreateIndex(
                name: "IX_BillingEvents_Provider_ProviderEventId",
                table: "BillingEvents",
                columns: new[] { "Provider", "ProviderEventId" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "BillingEvents");

            migrationBuilder.DropIndex(
                name: "IX_Subscriptions_PendingProviderSubscriptionId",
                table: "Subscriptions");

            migrationBuilder.DropIndex(
                name: "IX_Subscriptions_ProviderSubscriptionId",
                table: "Subscriptions");

            migrationBuilder.DropColumn(
                name: "PendingPlanId",
                table: "Subscriptions");

            migrationBuilder.DropColumn(
                name: "PendingProviderSubscriptionId",
                table: "Subscriptions");

            migrationBuilder.DropColumn(
                name: "Provider",
                table: "Subscriptions");

            migrationBuilder.DropColumn(
                name: "ProviderSubscriptionId",
                table: "Subscriptions");

            migrationBuilder.DropColumn(
                name: "ProviderPlanAmount",
                table: "Plans");

            migrationBuilder.DropColumn(
                name: "ProviderPlanId",
                table: "Plans");
        }
    }
}
