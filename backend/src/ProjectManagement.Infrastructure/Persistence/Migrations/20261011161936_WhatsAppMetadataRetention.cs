using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class WhatsAppMetadataRetention : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(
                name: "RetentionPolledAt",
                table: "WhatsAppConnections",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_WhatsAppDeliveries_TenantId_CreatedAt",
                table: "WhatsAppDeliveries",
                columns: new[] { "TenantId", "CreatedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_WhatsAppDeliveries_TenantId_State_ExpiresAt",
                table: "WhatsAppDeliveries",
                columns: new[] { "TenantId", "State", "ExpiresAt" });

            migrationBuilder.CreateIndex(
                name: "IX_WhatsAppDeliveries_TenantId_State_LeaseUntil",
                table: "WhatsAppDeliveries",
                columns: new[] { "TenantId", "State", "LeaseUntil" });

            migrationBuilder.CreateIndex(
                name: "IX_WhatsAppConnections_RetentionPolledAt",
                table: "WhatsAppConnections",
                column: "RetentionPolledAt");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_WhatsAppDeliveries_TenantId_CreatedAt",
                table: "WhatsAppDeliveries");

            migrationBuilder.DropIndex(
                name: "IX_WhatsAppDeliveries_TenantId_State_ExpiresAt",
                table: "WhatsAppDeliveries");

            migrationBuilder.DropIndex(
                name: "IX_WhatsAppDeliveries_TenantId_State_LeaseUntil",
                table: "WhatsAppDeliveries");

            migrationBuilder.DropIndex(
                name: "IX_WhatsAppConnections_RetentionPolledAt",
                table: "WhatsAppConnections");

            migrationBuilder.DropColumn(
                name: "RetentionPolledAt",
                table: "WhatsAppConnections");
        }
    }
}
