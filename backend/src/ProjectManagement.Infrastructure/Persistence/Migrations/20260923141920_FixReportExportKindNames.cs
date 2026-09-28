using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// ReportKind is stored by name (a varchar column, not an int), so renaming its members left any row still in its
    /// 7-day retention window with an unparseable Kind. Re-labels existing rows to match: the old Tasks export kind
    /// (task list) became Project (task list plus progress/status), and Summary (task totals + project progress +
    /// workload + completions) became Workload (now just per-person open/overdue/done) - not a perfect semantic
    /// match, but the file each row points to was already built under the old definition, so this is a label fix
    /// for the list view, not a claim that the stored file matches the new Workload report's shape.
    /// </summary>
    public partial class FixReportExportKindNames : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("UPDATE \"ReportExports\" SET \"Kind\" = 'Project' WHERE \"Kind\" = 'Tasks';");
            migrationBuilder.Sql("UPDATE \"ReportExports\" SET \"Kind\" = 'Workload' WHERE \"Kind\" = 'Summary';");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("UPDATE \"ReportExports\" SET \"Kind\" = 'Tasks' WHERE \"Kind\" = 'Project';");
            migrationBuilder.Sql("UPDATE \"ReportExports\" SET \"Kind\" = 'Summary' WHERE \"Kind\" = 'Workload';");
        }
    }
}
