using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class OrganizationChart : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "OrgRoleId",
                table: "TenantMembers",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "ReportsToUserId",
                table: "TenantMembers",
                type: "uuid",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "OrgRoles",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Name = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: false),
                    Description = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    Color = table.Column<string>(type: "character varying(9)", maxLength: 9, nullable: false),
                    ParentRoleId = table.Column<Guid>(type: "uuid", nullable: true),
                    SortOrder = table.Column<int>(type: "integer", nullable: false),
                    PosX = table.Column<double>(type: "double precision", nullable: true),
                    PosY = table.Column<double>(type: "double precision", nullable: true),
                    IsDeleted = table.Column<bool>(type: "boolean", nullable: false),
                    DeletedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    DeletedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    PreviousParentRoleId = table.Column<Guid>(type: "uuid", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_OrgRoles", x => x.Id);
                    table.ForeignKey(
                        name: "FK_OrgRoles_OrgRoles_ParentRoleId",
                        column: x => x.ParentRoleId,
                        principalTable: "OrgRoles",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_TenantMembers_OrgRoleId",
                table: "TenantMembers",
                column: "OrgRoleId");

            migrationBuilder.CreateIndex(
                name: "IX_TenantMembers_ReportsToUserId",
                table: "TenantMembers",
                column: "ReportsToUserId");

            migrationBuilder.CreateIndex(
                name: "IX_OrgRoles_ParentRoleId",
                table: "OrgRoles",
                column: "ParentRoleId");

            migrationBuilder.CreateIndex(
                name: "IX_OrgRoles_TenantId_ParentRoleId",
                table: "OrgRoles",
                columns: new[] { "TenantId", "ParentRoleId" });

            migrationBuilder.AddForeignKey(
                name: "FK_TenantMembers_OrgRoles_OrgRoleId",
                table: "TenantMembers",
                column: "OrgRoleId",
                principalTable: "OrgRoles",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);

            migrationBuilder.AddForeignKey(
                name: "FK_TenantMembers_Users_ReportsToUserId",
                table: "TenantMembers",
                column: "ReportsToUserId",
                principalTable: "Users",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_TenantMembers_OrgRoles_OrgRoleId",
                table: "TenantMembers");

            migrationBuilder.DropForeignKey(
                name: "FK_TenantMembers_Users_ReportsToUserId",
                table: "TenantMembers");

            migrationBuilder.DropTable(
                name: "OrgRoles");

            migrationBuilder.DropIndex(
                name: "IX_TenantMembers_OrgRoleId",
                table: "TenantMembers");

            migrationBuilder.DropIndex(
                name: "IX_TenantMembers_ReportsToUserId",
                table: "TenantMembers");

            migrationBuilder.DropColumn(
                name: "OrgRoleId",
                table: "TenantMembers");

            migrationBuilder.DropColumn(
                name: "ReportsToUserId",
                table: "TenantMembers");
        }
    }
}
