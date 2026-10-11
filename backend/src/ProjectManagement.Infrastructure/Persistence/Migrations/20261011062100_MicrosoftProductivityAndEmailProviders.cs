using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class MicrosoftProductivityAndEmailProviders : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "VerifierProtected",
                table: "ProviderOAuthAttempts",
                type: "character varying(1000)",
                maxLength: 1000,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ConfirmedSenderEmail",
                table: "PersonalEmailDrafts",
                type: "character varying(254)",
                maxLength: 254,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Provider",
                table: "PersonalEmailDrafts",
                type: "character varying(20)",
                maxLength: 20,
                nullable: false,
                defaultValue: "google");

            migrationBuilder.AddColumn<string>(
                name: "ProviderRequestId",
                table: "PersonalEmailDrafts",
                type: "character varying(200)",
                maxLength: 200,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "MicrosoftConnections",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    ProviderUserId = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    Email = table.Column<string>(type: "character varying(254)", maxLength: 254, nullable: false),
                    Scopes = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: false),
                    RefreshTokenProtected = table.Column<string>(type: "character varying(16000)", maxLength: 16000, nullable: false),
                    AccessTokenProtected = table.Column<string>(type: "character varying(16000)", maxLength: 16000, nullable: false),
                    AccessTokenExpiresAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    ConnectedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MicrosoftConnections", x => x.Id);
                    table.ForeignKey(
                        name: "FK_MicrosoftConnections_Users_UserId",
                        column: x => x.UserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_MicrosoftConnections_TenantId_UserId",
                table: "MicrosoftConnections",
                columns: new[] { "TenantId", "UserId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_MicrosoftConnections_UserId",
                table: "MicrosoftConnections",
                column: "UserId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "MicrosoftConnections");

            migrationBuilder.DropColumn(
                name: "VerifierProtected",
                table: "ProviderOAuthAttempts");

            migrationBuilder.DropColumn(
                name: "ConfirmedSenderEmail",
                table: "PersonalEmailDrafts");

            migrationBuilder.DropColumn(
                name: "Provider",
                table: "PersonalEmailDrafts");

            migrationBuilder.DropColumn(
                name: "ProviderRequestId",
                table: "PersonalEmailDrafts");
        }
    }
}
