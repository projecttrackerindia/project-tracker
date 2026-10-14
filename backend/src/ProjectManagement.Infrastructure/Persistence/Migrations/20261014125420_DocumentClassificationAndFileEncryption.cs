using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class DocumentClassificationAndFileEncryption : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "Classification",
                table: "Documents",
                type: "integer",
                nullable: false,
                defaultValue: 1); // DocumentClassification.Internal - matches the entity's C# default so existing rows and any direct-SQL insert get the same value EF's own model default would

            migrationBuilder.AddColumn<bool>(
                name: "Encrypted",
                table: "DocumentFiles",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<int>(
                name: "KeyVersion",
                table: "DocumentFiles",
                type: "integer",
                nullable: false,
                defaultValue: 0);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "Classification",
                table: "Documents");

            migrationBuilder.DropColumn(
                name: "Encrypted",
                table: "DocumentFiles");

            migrationBuilder.DropColumn(
                name: "KeyVersion",
                table: "DocumentFiles");
        }
    }
}
