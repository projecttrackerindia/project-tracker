using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>Meaning-based search: pieces of pages and work with a compact meaning vector each. Additive only.</summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261106001800_AssistantMeaningSearch")]
    public partial class AssistantMeaningSearch : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "AiSearchChunks",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    SourceKind = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    SourceId = table.Column<Guid>(type: "uuid", nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: true),
                    Part = table.Column<int>(type: "integer", nullable: false),
                    Title = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    Text = table.Column<string>(type: "character varying(1300)", maxLength: 1300, nullable: false),
                    Vector = table.Column<byte[]>(type: "bytea", nullable: false),
                    Scale = table.Column<float>(type: "real", nullable: false),
                    Model = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    ContentHash = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    IndexedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AiSearchChunks", x => x.Id);
                });
            migrationBuilder.CreateIndex(name: "IX_AiSearchChunks_SourceId", table: "AiSearchChunks", column: "SourceId");
            migrationBuilder.CreateIndex(name: "IX_AiSearchChunks_TenantId_IndexedAt", table: "AiSearchChunks", columns: new[] { "TenantId", "IndexedAt" });
            migrationBuilder.CreateIndex(name: "IX_AiSearchChunks_TenantId_SourceKind_SourceId", table: "AiSearchChunks", columns: new[] { "TenantId", "SourceKind", "SourceId" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "AiSearchChunks");
        }
    }
}
