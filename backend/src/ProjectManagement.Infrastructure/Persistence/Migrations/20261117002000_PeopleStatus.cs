using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// People &amp; Roles: a member can be suspended (kept in the workspace with their history, but unable to open it). Three new columns on
    /// TenantMembers; every existing member stays Active.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261117002000_PeopleStatus")]
    public partial class PeopleStatus : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "Status",
                table: "TenantMembers",
                type: "character varying(32)",
                maxLength: 32,
                nullable: false,
                defaultValue: "Active");

            migrationBuilder.AddColumn<DateTime>(
                name: "DeactivatedAt",
                table: "TenantMembers",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "DeactivatedBy",
                table: "TenantMembers",
                type: "uuid",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(name: "Status", table: "TenantMembers");
            migrationBuilder.DropColumn(name: "DeactivatedAt", table: "TenantMembers");
            migrationBuilder.DropColumn(name: "DeactivatedBy", table: "TenantMembers");
        }
    }
}
