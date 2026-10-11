using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class WhatsAppInboundFoundation : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "WhatsAppConnections",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    AppId = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    BusinessAccountId = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    PhoneNumberId = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    DisplayName = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    AccessTokenProtected = table.Column<string>(type: "text", nullable: false),
                    InstalledBy = table.Column<Guid>(type: "uuid", nullable: false),
                    ConnectedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    Active = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WhatsAppConnections", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "WhatsAppInboundReceipts",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    AppId = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    PhoneNumberId = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    ProviderMessageId = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    MessageType = table.Column<string>(type: "character varying(30)", maxLength: 30, nullable: false),
                    ProviderCreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    ReceivedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WhatsAppInboundReceipts", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_WhatsAppConnections_AppId_PhoneNumberId",
                table: "WhatsAppConnections",
                columns: new[] { "AppId", "PhoneNumberId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_WhatsAppConnections_TenantId",
                table: "WhatsAppConnections",
                column: "TenantId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_WhatsAppInboundReceipts_AppId_PhoneNumberId_ProviderMessage~",
                table: "WhatsAppInboundReceipts",
                columns: new[] { "AppId", "PhoneNumberId", "ProviderMessageId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_WhatsAppInboundReceipts_TenantId_ReceivedAt",
                table: "WhatsAppInboundReceipts",
                columns: new[] { "TenantId", "ReceivedAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "WhatsAppConnections");

            migrationBuilder.DropTable(
                name: "WhatsAppInboundReceipts");
        }
    }
}
