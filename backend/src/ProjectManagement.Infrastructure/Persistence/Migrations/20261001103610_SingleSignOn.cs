using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class SingleSignOn : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "AuthMethod",
                table: "UserSessions",
                type: "character varying(32)",
                maxLength: 32,
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "SsoTenantId",
                table: "UserSessions",
                type: "uuid",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "ScimTokens",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Name = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    Prefix = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    TokenHash = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    LastUsedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    RevokedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ScimTokens", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ScimTokens_Tenants_TenantId",
                        column: x => x.TenantId,
                        principalTable: "Tenants",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "SsoConnections",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Protocol = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Name = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    EnforceForDomains = table.Column<bool>(type: "boolean", nullable: false),
                    AutoProvision = table.Column<bool>(type: "boolean", nullable: false),
                    DefaultRole = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    Authority = table.Column<string>(type: "character varying(400)", maxLength: 400, nullable: true),
                    ClientId = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    ClientSecret = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    SamlEntityId = table.Column<string>(type: "character varying(400)", maxLength: 400, nullable: true),
                    SamlSsoUrl = table.Column<string>(type: "character varying(800)", maxLength: 800, nullable: true),
                    SamlCertificate = table.Column<string>(type: "character varying(12000)", maxLength: 12000, nullable: true),
                    LastUsedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SsoConnections", x => x.Id);
                    table.ForeignKey(
                        name: "FK_SsoConnections_Tenants_TenantId",
                        column: x => x.TenantId,
                        principalTable: "Tenants",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "SsoDomains",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Domain = table.Column<string>(type: "character varying(253)", maxLength: 253, nullable: false),
                    VerificationToken = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    VerifiedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    LastCheckedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SsoDomains", x => x.Id);
                    table.ForeignKey(
                        name: "FK_SsoDomains_Tenants_TenantId",
                        column: x => x.TenantId,
                        principalTable: "Tenants",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "UserLogins",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Provider = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Subject = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
                    Email = table.Column<string>(type: "character varying(320)", maxLength: 320, nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    LastUsedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_UserLogins", x => x.Id);
                    table.ForeignKey(
                        name: "FK_UserLogins_Users_UserId",
                        column: x => x.UserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ScimTokens_TenantId",
                table: "ScimTokens",
                column: "TenantId");

            migrationBuilder.CreateIndex(
                name: "IX_ScimTokens_TokenHash",
                table: "ScimTokens",
                column: "TokenHash",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_SsoConnections_TenantId",
                table: "SsoConnections",
                column: "TenantId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_SsoDomains_Domain_Verified",
                table: "SsoDomains",
                column: "Domain",
                unique: true,
                filter: "\"VerifiedAt\" IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_SsoDomains_TenantId_Domain",
                table: "SsoDomains",
                columns: new[] { "TenantId", "Domain" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_UserLogins_Provider_Subject",
                table: "UserLogins",
                columns: new[] { "Provider", "Subject" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_UserLogins_UserId",
                table: "UserLogins",
                column: "UserId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ScimTokens");

            migrationBuilder.DropTable(
                name: "SsoConnections");

            migrationBuilder.DropTable(
                name: "SsoDomains");

            migrationBuilder.DropTable(
                name: "UserLogins");

            migrationBuilder.DropColumn(
                name: "AuthMethod",
                table: "UserSessions");

            migrationBuilder.DropColumn(
                name: "SsoTenantId",
                table: "UserSessions");
        }
    }
}
