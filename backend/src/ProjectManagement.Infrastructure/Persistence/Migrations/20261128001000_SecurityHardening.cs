using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Security hardening: Users.LockoutStreak (each lockout in a row doubles the next, see LockoutPolicy) and
    /// TenantSecuritySettings.AllowedEmailDomains (an organization only invites addresses at its listed domains). Two new columns with defaults.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261128001000_SecurityHardening")]
    public partial class SecurityHardening : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(name: "LockoutStreak", table: "Users", type: "integer", nullable: false, defaultValue: 0);
            migrationBuilder.AddColumn<string>(name: "AllowedEmailDomains", table: "TenantSecuritySettings", type: "character varying(2000)", maxLength: 2000, nullable: false, defaultValue: "");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(name: "AllowedEmailDomains", table: "TenantSecuritySettings");
            migrationBuilder.DropColumn(name: "LockoutStreak", table: "Users");
        }
    }
}
