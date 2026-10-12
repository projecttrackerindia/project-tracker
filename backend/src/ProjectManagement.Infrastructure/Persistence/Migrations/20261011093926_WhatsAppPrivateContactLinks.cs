using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class WhatsAppPrivateContactLinks : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "WhatsAppContactLinks",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    ConnectionId = table.Column<Guid>(type: "uuid", nullable: false),
                    ConnectionConnectedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    PhoneProtected = table.Column<string>(type: "text", nullable: false),
                    PhoneHash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    ConfigurationHash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    ChallengeHash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    ChallengeIssuedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    ChallengeExpiresAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    VerifiedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    ConsentVersion = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: true),
                    ConsentAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    RateWindowAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    ChallengesIssued = table.Column<int>(type: "integer", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WhatsAppContactLinks", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_WhatsAppContactLinks_TenantId_ChallengeHash",
                table: "WhatsAppContactLinks",
                columns: new[] { "TenantId", "ChallengeHash" });

            migrationBuilder.CreateIndex(
                name: "IX_WhatsAppContactLinks_TenantId_PhoneHash",
                table: "WhatsAppContactLinks",
                columns: new[] { "TenantId", "PhoneHash" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_WhatsAppContactLinks_TenantId_UserId",
                table: "WhatsAppContactLinks",
                columns: new[] { "TenantId", "UserId" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "WhatsAppContactLinks");
        }
    }
}
