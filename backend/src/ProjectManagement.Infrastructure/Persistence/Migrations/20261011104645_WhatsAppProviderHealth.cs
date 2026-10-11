using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class WhatsAppProviderHealth : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "HealthAppSubscribed",
                table: "WhatsAppConnections",
                type: "boolean",
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "HealthAssetsVerified",
                table: "WhatsAppConnections",
                type: "boolean",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "HealthAttemptedAt",
                table: "WhatsAppConnections",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "HealthCheckedAt",
                table: "WhatsAppConnections",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "HealthConfigurationHash",
                table: "WhatsAppConnections",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "HealthLeaseId",
                table: "WhatsAppConnections",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "HealthLeaseUntil",
                table: "WhatsAppConnections",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "HealthPhoneVerified",
                table: "WhatsAppConnections",
                type: "boolean",
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "HealthScopesPresent",
                table: "WhatsAppConnections",
                type: "boolean",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "HealthState",
                table: "WhatsAppConnections",
                type: "character varying(20)",
                maxLength: 20,
                nullable: false,
                defaultValue: "unchecked");

            migrationBuilder.AddColumn<bool>(
                name: "HealthTokenValid",
                table: "WhatsAppConnections",
                type: "boolean",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "HealthAppSubscribed",
                table: "WhatsAppConnections");

            migrationBuilder.DropColumn(
                name: "HealthAssetsVerified",
                table: "WhatsAppConnections");

            migrationBuilder.DropColumn(
                name: "HealthAttemptedAt",
                table: "WhatsAppConnections");

            migrationBuilder.DropColumn(
                name: "HealthCheckedAt",
                table: "WhatsAppConnections");

            migrationBuilder.DropColumn(
                name: "HealthConfigurationHash",
                table: "WhatsAppConnections");

            migrationBuilder.DropColumn(
                name: "HealthLeaseId",
                table: "WhatsAppConnections");

            migrationBuilder.DropColumn(
                name: "HealthLeaseUntil",
                table: "WhatsAppConnections");

            migrationBuilder.DropColumn(
                name: "HealthPhoneVerified",
                table: "WhatsAppConnections");

            migrationBuilder.DropColumn(
                name: "HealthScopesPresent",
                table: "WhatsAppConnections");

            migrationBuilder.DropColumn(
                name: "HealthState",
                table: "WhatsAppConnections");

            migrationBuilder.DropColumn(
                name: "HealthTokenValid",
                table: "WhatsAppConnections");
        }
    }
}
