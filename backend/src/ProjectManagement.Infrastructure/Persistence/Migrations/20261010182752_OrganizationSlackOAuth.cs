using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class OrganizationSlackOAuth : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "SlackConnections",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TeamId = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    TeamName = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    AppId = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    BotUserId = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    BotTokenProtected = table.Column<string>(type: "text", nullable: false),
                    Scopes = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    InstalledBy = table.Column<Guid>(type: "uuid", nullable: false),
                    ConnectedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    Active = table.Column<bool>(type: "boolean", nullable: false),
                    LastError = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SlackConnections", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "SlackOAuthAttempts",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    StateHash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    BrowserHash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    ReturnPath = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    ExpiresAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    ConsumedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SlackOAuthAttempts", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_SlackConnections_TeamId",
                table: "SlackConnections",
                column: "TeamId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_SlackConnections_TenantId",
                table: "SlackConnections",
                column: "TenantId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_SlackOAuthAttempts_ExpiresAt",
                table: "SlackOAuthAttempts",
                column: "ExpiresAt");

            migrationBuilder.CreateIndex(
                name: "IX_SlackOAuthAttempts_StateHash",
                table: "SlackOAuthAttempts",
                column: "StateHash",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "SlackConnections");

            migrationBuilder.DropTable(
                name: "SlackOAuthAttempts");
        }
    }
}
