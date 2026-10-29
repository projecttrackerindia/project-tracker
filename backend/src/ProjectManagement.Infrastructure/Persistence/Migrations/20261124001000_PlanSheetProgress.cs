using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Plan sheet progress: a task's progress can be set by hand (the sheet's slider and fill handle) when there is no checklist or sub-items
    /// to work it out from. One new nullable column on WorkItems; every existing task keeps its worked-out progress.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261124001000_PlanSheetProgress")]
    public partial class PlanSheetProgress : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "ManualProgress",
                table: "WorkItems",
                type: "integer",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(name: "ManualProgress", table: "WorkItems");
        }
    }
}
