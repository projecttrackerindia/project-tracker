using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Single active session with approve-on-other-device: SessionApprovals (a sign-in on a new device waiting for a signed-in device to allow it),
    /// Users.SingleSession (the person's own choice), TenantSecuritySettings.SingleActiveSession (an organization's rule) and
    /// UserSessions.EndedReason ("Signed out because you signed in on ..."). Both settings default to off.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261130001000_SessionApproval")]
    public partial class SessionApprovals : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(name: "SingleSession", table: "Users", type: "boolean", nullable: false, defaultValue: false);
            migrationBuilder.AddColumn<bool>(name: "SingleActiveSession", table: "TenantSecuritySettings", type: "boolean", nullable: false, defaultValue: false);
            migrationBuilder.AddColumn<string>(name: "EndedReason", table: "UserSessions", type: "character varying(200)", maxLength: 200, nullable: true);

            migrationBuilder.CreateTable(
                name: "SessionApprovals",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    WorkspaceId = table.Column<Guid>(type: "uuid", nullable: true),
                    SsoTenantId = table.Column<Guid>(type: "uuid", nullable: true),
                    Method = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    SecretHash = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    Code = table.Column<int>(type: "integer", nullable: false),
                    Status = table.Column<int>(type: "integer", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    ExpiresAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    DecidedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    DecidedBySessionId = table.Column<Guid>(type: "uuid", nullable: true),
                    DecidedVia = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: true),
                    IpAddress = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    UserAgent = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    Device = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    App = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Location = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: true),
                    EmailTokenHash = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    EmailSentAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    FallbackFailures = table.Column<int>(type: "integer", nullable: false),
                    ResultSessionId = table.Column<Guid>(type: "uuid", nullable: true),
                },
                constraints: table => table.PrimaryKey("PK_SessionApprovals", x => x.Id));

            migrationBuilder.CreateIndex(name: "IX_SessionApprovals_UserId_CreatedAt", table: "SessionApprovals", columns: new[] { "UserId", "CreatedAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "SessionApprovals");
            migrationBuilder.DropColumn(name: "EndedReason", table: "UserSessions");
            migrationBuilder.DropColumn(name: "SingleActiveSession", table: "TenantSecuritySettings");
            migrationBuilder.DropColumn(name: "SingleSession", table: "Users");
        }
    }
}
