using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class TenantSoftDeleteAndProjectPosition : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(
                name: "DeletedAt",
                table: "Tenants",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "DeletedBy",
                table: "Tenants",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "IsDeleted",
                table: "Tenants",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<double>(
                name: "Position",
                table: "Projects",
                type: "double precision",
                nullable: false,
                defaultValue: 0.0);

            // Give existing projects a stable board order (creation order, 1024 apart so cards can be inserted between them).
            migrationBuilder.Sql("""
                UPDATE "Projects" p SET "Position" = ranked.rn * 1024
                FROM (SELECT "Id", ROW_NUMBER() OVER (PARTITION BY "TenantId" ORDER BY "CreatedAt") AS rn FROM "Projects") ranked
                WHERE p."Id" = ranked."Id";
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "DeletedAt",
                table: "Tenants");

            migrationBuilder.DropColumn(
                name: "DeletedBy",
                table: "Tenants");

            migrationBuilder.DropColumn(
                name: "IsDeleted",
                table: "Tenants");

            migrationBuilder.DropColumn(
                name: "Position",
                table: "Projects");
        }
    }
}
