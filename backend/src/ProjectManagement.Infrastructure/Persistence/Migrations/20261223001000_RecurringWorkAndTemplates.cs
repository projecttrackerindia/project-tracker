using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Repeating tasks (TaskRecurrences: the rule; TaskOccurrences: which task is which occurrence) and project/task templates (WorkTemplates).
    /// New tables only; nothing existing changes.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261223001000_RecurringWorkAndTemplates")]
    public partial class RecurringWorkAndTemplates : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "TaskRecurrences",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: false),
                    Title = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    Description = table.Column<string>(type: "character varying(20000)", maxLength: 20000, nullable: true),
                    Priority = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    AssigneeId = table.Column<Guid>(type: "uuid", nullable: true),
                    Frequency = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Interval = table.Column<int>(type: "integer", nullable: false),
                    DaysOfWeek = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: true),
                    MonthDay = table.Column<int>(type: "integer", nullable: true),
                    MonthWeek = table.Column<int>(type: "integer", nullable: true),
                    MonthWeekday = table.Column<int>(type: "integer", nullable: true),
                    EndAfter = table.Column<int>(type: "integer", nullable: true),
                    EndBy = table.Column<DateOnly>(type: "date", nullable: true),
                    AnchorDate = table.Column<DateOnly>(type: "date", nullable: false),
                    SkippedDates = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: true),
                    LeadDays = table.Column<int>(type: "integer", nullable: true),
                    IsActive = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                },
                constraints: table => table.PrimaryKey("PK_TaskRecurrences", x => x.Id));
            migrationBuilder.CreateIndex(name: "IX_TaskRecurrences_TenantId_IsActive", table: "TaskRecurrences", columns: new[] { "TenantId", "IsActive" });

            migrationBuilder.CreateTable(
                name: "TaskOccurrences",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    RecurrenceId = table.Column<Guid>(type: "uuid", nullable: false),
                    TaskId = table.Column<Guid>(type: "uuid", nullable: false),
                    Index = table.Column<int>(type: "integer", nullable: false),
                    Date = table.Column<DateOnly>(type: "date", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                },
                constraints: table => table.PrimaryKey("PK_TaskOccurrences", x => x.Id));
            migrationBuilder.CreateIndex(name: "IX_TaskOccurrences_RecurrenceId_Index", table: "TaskOccurrences", columns: new[] { "RecurrenceId", "Index" }, unique: true);
            migrationBuilder.CreateIndex(name: "IX_TaskOccurrences_TenantId_TaskId", table: "TaskOccurrences", columns: new[] { "TenantId", "TaskId" });

            migrationBuilder.CreateTable(
                name: "WorkTemplates",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Kind = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Name = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    Description = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    ContentJson = table.Column<string>(type: "text", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                },
                constraints: table => table.PrimaryKey("PK_WorkTemplates", x => x.Id));
            migrationBuilder.CreateIndex(name: "IX_WorkTemplates_TenantId_Kind", table: "WorkTemplates", columns: new[] { "TenantId", "Kind" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "WorkTemplates");
            migrationBuilder.DropTable(name: "TaskOccurrences");
            migrationBuilder.DropTable(name: "TaskRecurrences");
        }
    }
}
