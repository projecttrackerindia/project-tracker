using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class SsoGroupMappings : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "ViaSso",
                table: "TeamMembers",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.CreateTable(
                name: "SsoGroupMappings",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Group = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    TeamId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SsoGroupMappings", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_SsoGroupMappings_TenantId_Group_TeamId",
                table: "SsoGroupMappings",
                columns: new[] { "TenantId", "Group", "TeamId" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "SsoGroupMappings");

            migrationBuilder.DropColumn(
                name: "ViaSso",
                table: "TeamMembers");
        }
    }
}
