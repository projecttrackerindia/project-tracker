using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>Data-protection keys kept in the database instead of the container's disk, and which stages were started by their tasks. Additive only.</summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261027000100_DataProtectionKeys")]
    public partial class DataProtectionKeys : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "DataProtectionKeys",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    FriendlyName = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    Xml = table.Column<string>(type: "text", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table => table.PrimaryKey("PK_DataProtectionKeys", x => x.Id));
            migrationBuilder.CreateTable(
                name: "StageAutoStarts",
                columns: table => new { Id = table.Column<Guid>(type: "uuid", nullable: false), StageId = table.Column<Guid>(type: "uuid", nullable: false) },
                constraints: table =>
                {
                    table.PrimaryKey("PK_StageAutoStarts", x => x.Id);
                    table.ForeignKey(name: "FK_StageAutoStarts_ProjectStages_StageId", column: x => x.StageId, principalTable: "ProjectStages", principalColumn: "Id", onDelete: ReferentialAction.Cascade);
                });
            migrationBuilder.CreateIndex(name: "IX_StageAutoStarts_StageId", table: "StageAutoStarts", column: "StageId", unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "StageAutoStarts");
            migrationBuilder.DropTable(name: "DataProtectionKeys");
        }
    }
}
