using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class PerSeatPricing : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "BillingPeriod",
                table: "Subscriptions",
                type: "text",
                nullable: false,
                defaultValue: "monthly");

            migrationBuilder.AddColumn<string>(
                name: "PendingBillingPeriod",
                table: "Subscriptions",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "PendingSeats",
                table: "Subscriptions",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "Seats",
                table: "Subscriptions",
                type: "integer",
                nullable: false,
                defaultValue: 1);

            migrationBuilder.AddColumn<bool>(
                name: "PerSeat",
                table: "Plans",
                type: "boolean",
                nullable: false,
                defaultValue: false);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "BillingPeriod",
                table: "Subscriptions");

            migrationBuilder.DropColumn(
                name: "PendingBillingPeriod",
                table: "Subscriptions");

            migrationBuilder.DropColumn(
                name: "PendingSeats",
                table: "Subscriptions");

            migrationBuilder.DropColumn(
                name: "Seats",
                table: "Subscriptions");

            migrationBuilder.DropColumn(
                name: "PerSeat",
                table: "Plans");
        }
    }
}
