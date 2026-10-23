using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>Account security: workspace sign-in rules, when a password was chosen and its length, new-device sign-ins and "this wasn't me". Additive only.</summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261106001000_AccountSecurity")]
    public partial class AccountSecurity : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(name: "MinPasswordLength", table: "TenantSecuritySettings", type: "integer", nullable: false, defaultValue: 0);
            migrationBuilder.AddColumn<int>(name: "SessionHours", table: "TenantSecuritySettings", type: "integer", nullable: false, defaultValue: 0);
            migrationBuilder.AddColumn<string>(name: "AllowedSignIn", table: "TenantSecuritySettings", type: "character varying(100)", maxLength: 100, nullable: false, defaultValue: "");
            migrationBuilder.AddColumn<DateTime>(name: "PasswordChangedAt", table: "Users", type: "timestamp with time zone", nullable: true);
            migrationBuilder.AddColumn<int>(name: "PasswordLength", table: "Users", type: "integer", nullable: true);
            migrationBuilder.AddColumn<bool>(name: "NewDevice", table: "UserSessions", type: "boolean", nullable: false, defaultValue: false);
            migrationBuilder.AddColumn<DateTime>(name: "ReportedAt", table: "UserSessions", type: "timestamp with time zone", nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(name: "MinPasswordLength", table: "TenantSecuritySettings");
            migrationBuilder.DropColumn(name: "SessionHours", table: "TenantSecuritySettings");
            migrationBuilder.DropColumn(name: "AllowedSignIn", table: "TenantSecuritySettings");
            migrationBuilder.DropColumn(name: "PasswordChangedAt", table: "Users");
            migrationBuilder.DropColumn(name: "PasswordLength", table: "Users");
            migrationBuilder.DropColumn(name: "NewDevice", table: "UserSessions");
            migrationBuilder.DropColumn(name: "ReportedAt", table: "UserSessions");
        }
    }
}
