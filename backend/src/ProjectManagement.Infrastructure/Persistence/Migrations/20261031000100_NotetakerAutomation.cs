using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>Notetaker: email the minutes, create their tasks and erase the transcript automatically. Additive only.</summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261031000100_NotetakerAutomation")]
    public partial class NotetakerAutomation : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(name: "AutoEmail", table: "NotetakerSettings", type: "boolean", nullable: false, defaultValue: true);
            migrationBuilder.AddColumn<bool>(name: "AutoTasks", table: "NotetakerSettings", type: "boolean", nullable: false, defaultValue: false);
            migrationBuilder.AddColumn<bool>(name: "DeleteTranscript", table: "NotetakerSettings", type: "boolean", nullable: false, defaultValue: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(name: "AutoEmail", table: "NotetakerSettings");
            migrationBuilder.DropColumn(name: "AutoTasks", table: "NotetakerSettings");
            migrationBuilder.DropColumn(name: "DeleteTranscript", table: "NotetakerSettings");
        }
    }
}
