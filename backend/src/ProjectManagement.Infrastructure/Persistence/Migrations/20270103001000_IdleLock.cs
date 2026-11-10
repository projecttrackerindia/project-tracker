using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// "Sign out after inactivity": the workspace's idle time (TenantSecuritySettings.IdleTimeoutMinutes, 30 by default, 0 = never) and, on each
    /// session, when the person last really used the app, whether it is locked, and how many unlock attempts in a row were wrong. Nothing existing changes.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20270103001000_IdleLock")]
    public partial class IdleLock : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(name: "IdleTimeoutMinutes", table: "TenantSecuritySettings", type: "integer", nullable: false, defaultValue: 30);
            migrationBuilder.AddColumn<DateTime>(name: "LastActivityAt", table: "UserSessions", type: "timestamp with time zone", nullable: true);
            migrationBuilder.AddColumn<DateTime>(name: "LockedAt", table: "UserSessions", type: "timestamp with time zone", nullable: true);
            migrationBuilder.AddColumn<int>(name: "UnlockFailures", table: "UserSessions", type: "integer", nullable: false, defaultValue: 0);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(name: "IdleTimeoutMinutes", table: "TenantSecuritySettings");
            migrationBuilder.DropColumn(name: "LastActivityAt", table: "UserSessions");
            migrationBuilder.DropColumn(name: "LockedAt", table: "UserSessions");
            migrationBuilder.DropColumn(name: "UnlockFailures", table: "UserSessions");
        }
    }
}
