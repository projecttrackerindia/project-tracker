using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class DurableWhatsAppNotificationDelivery : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(
                name: "DeliveryPolledAt",
                table: "WhatsAppConnections",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "WhatsAppDeliveries",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    NotificationId = table.Column<Guid>(type: "uuid", nullable: false),
                    ConnectionId = table.Column<Guid>(type: "uuid", nullable: false),
                    ConnectionConnectedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    ContactId = table.Column<Guid>(type: "uuid", nullable: false),
                    PreferencesVersion = table.Column<int>(type: "integer", nullable: false),
                    ConfigurationHash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Category = table.Column<string>(type: "character varying(30)", maxLength: 30, nullable: false),
                    ResourceKind = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    ResourceId = table.Column<Guid>(type: "uuid", nullable: false),
                    ResourceProjectId = table.Column<Guid>(type: "uuid", nullable: true),
                    State = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    Reason = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: true),
                    AvailableAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    ExpiresAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    LeaseId = table.Column<Guid>(type: "uuid", nullable: true),
                    LeaseUntil = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    PreparationAttempts = table.Column<int>(type: "integer", nullable: false),
                    AttemptedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    AcceptedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    ProviderStatusAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    ProviderMessageId = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    CallbackTag = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    RecipientHash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WhatsAppDeliveries", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_WhatsAppDeliveries_ConnectionId_ProviderMessageId",
                table: "WhatsAppDeliveries",
                columns: new[] { "ConnectionId", "ProviderMessageId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_WhatsAppDeliveries_TenantId_AttemptedAt",
                table: "WhatsAppDeliveries",
                columns: new[] { "TenantId", "AttemptedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_WhatsAppDeliveries_TenantId_CallbackTag",
                table: "WhatsAppDeliveries",
                columns: new[] { "TenantId", "CallbackTag" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_WhatsAppDeliveries_TenantId_NotificationId",
                table: "WhatsAppDeliveries",
                columns: new[] { "TenantId", "NotificationId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_WhatsAppDeliveries_TenantId_State_AvailableAt",
                table: "WhatsAppDeliveries",
                columns: new[] { "TenantId", "State", "AvailableAt" });

            migrationBuilder.CreateIndex(
                name: "IX_WhatsAppDeliveries_TenantId_UserId_AttemptedAt",
                table: "WhatsAppDeliveries",
                columns: new[] { "TenantId", "UserId", "AttemptedAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "WhatsAppDeliveries");

            migrationBuilder.DropColumn(
                name: "DeliveryPolledAt",
                table: "WhatsAppConnections");
        }
    }
}
