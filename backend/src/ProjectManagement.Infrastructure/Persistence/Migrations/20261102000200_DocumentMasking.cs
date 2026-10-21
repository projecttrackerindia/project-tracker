using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>Masking of personal and secret data in documents: the workspace's switch and its own rules. Additive only.</summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261102000200_DocumentMasking")]
    public partial class DocumentMasking : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "DocumentMaskingSettings",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    DisabledBuiltIns = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                },
                constraints: table => table.PrimaryKey("PK_DocumentMaskingSettings", x => x.Id));
            migrationBuilder.CreateIndex(name: "IX_DocumentMaskingSettings_TenantId", table: "DocumentMaskingSettings", column: "TenantId", unique: true);

            migrationBuilder.CreateTable(
                name: "MaskingRules",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    Field = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    Match = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    Strategy = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    Label = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                },
                constraints: table => table.PrimaryKey("PK_MaskingRules", x => x.Id));
            migrationBuilder.CreateIndex(name: "IX_MaskingRules_TenantId", table: "MaskingRules", column: "TenantId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "MaskingRules");
            migrationBuilder.DropTable(name: "DocumentMaskingSettings");
        }
    }
}
