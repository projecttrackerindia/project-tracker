using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Quality ↔ API docs: a test case records what it verifies (API endpoints, documents) as a JSON list. One new column on TestCases; every
    /// existing case starts with no links.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261119001000_QualityDocLinks")]
    public partial class QualityDocLinks : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "LinksJson",
                table: "TestCases",
                type: "character varying(4000)",
                maxLength: 4000,
                nullable: false,
                defaultValue: "[]");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(name: "LinksJson", table: "TestCases");
        }
    }
}
