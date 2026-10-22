using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>Pages: a document can sit under another (ParentId, ordered by PageOrder) and carry an emoji icon. Additive only.</summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261106000100_DocumentPages")]
    public partial class DocumentPages : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(name: "ParentId", table: "Documents", type: "uuid", nullable: true);
            migrationBuilder.AddColumn<int>(name: "PageOrder", table: "Documents", type: "integer", nullable: false, defaultValue: 0);
            migrationBuilder.AddColumn<string>(name: "Icon", table: "Documents", type: "character varying(16)", maxLength: 16, nullable: true);
            migrationBuilder.CreateIndex(name: "IX_Documents_TenantId_ParentId_PageOrder", table: "Documents", columns: new[] { "TenantId", "ParentId", "PageOrder" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(name: "IX_Documents_TenantId_ParentId_PageOrder", table: "Documents");
            migrationBuilder.DropColumn(name: "Icon", table: "Documents");
            migrationBuilder.DropColumn(name: "PageOrder", table: "Documents");
            migrationBuilder.DropColumn(name: "ParentId", table: "Documents");
        }
    }
}
