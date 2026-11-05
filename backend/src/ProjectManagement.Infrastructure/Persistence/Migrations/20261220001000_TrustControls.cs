using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Trust controls, all off or neutral by default: TenantSecuritySettings.MfaScope ("all" or "admins") and MfaGraceUntil (a grace period
    /// for the two-step rule), TenantSecuritySettings.IpOwnerBypass (an Owner signed in with two-step verification is never locked out by the
    /// IP allowlist; true, as the safe default), and TenantDataPolicy.DeletedItemsRetentionDays (how long the bin keeps soft-deleted items;
    /// null keeps them). New columns only; nothing existing changes.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261220001000_TrustControls")]
    public partial class TrustControls : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(name: "MfaScope", table: "TenantSecuritySettings", type: "character varying(20)", maxLength: 20, nullable: false, defaultValue: "all");
            migrationBuilder.AddColumn<DateTime>(name: "MfaGraceUntil", table: "TenantSecuritySettings", type: "timestamp with time zone", nullable: true);
            migrationBuilder.AddColumn<bool>(name: "IpOwnerBypass", table: "TenantSecuritySettings", type: "boolean", nullable: false, defaultValue: true);
            migrationBuilder.AddColumn<int>(name: "DeletedItemsRetentionDays", table: "TenantDataPolicies", type: "integer", nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(name: "MfaScope", table: "TenantSecuritySettings");
            migrationBuilder.DropColumn(name: "MfaGraceUntil", table: "TenantSecuritySettings");
            migrationBuilder.DropColumn(name: "IpOwnerBypass", table: "TenantSecuritySettings");
            migrationBuilder.DropColumn(name: "DeletedItemsRetentionDays", table: "TenantDataPolicies");
        }
    }
}
