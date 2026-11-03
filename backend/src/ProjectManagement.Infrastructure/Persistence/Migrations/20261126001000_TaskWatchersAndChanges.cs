using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Plan sheet follow-ups: people can watch a task (TaskWatchers), and each change made on the sheet is kept (TaskChanges) so its notice and e-mail
    /// can show before → after with its effect and offer Undo. Two new tables; nothing existing changes.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261126001000_TaskWatchersAndChanges")]
    public partial class TaskWatchersAndChanges : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "TaskWatchers",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TaskId = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TaskWatchers", x => x.Id);
                });
            migrationBuilder.CreateIndex(name: "IX_TaskWatchers_TenantId_TaskId_UserId", table: "TaskWatchers", columns: new[] { "TenantId", "TaskId", "UserId" }, unique: true);
            migrationBuilder.CreateIndex(name: "IX_TaskWatchers_TenantId_UserId", table: "TaskWatchers", columns: new[] { "TenantId", "UserId" });

            migrationBuilder.CreateTable(
                name: "TaskChanges",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TaskId = table.Column<Guid>(type: "uuid", nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: false),
                    FromProjectId = table.Column<Guid>(type: "uuid", nullable: true),
                    ActorId = table.Column<Guid>(type: "uuid", nullable: false),
                    BeforeDue = table.Column<DateOnly>(type: "date", nullable: true),
                    AfterDue = table.Column<DateOnly>(type: "date", nullable: true),
                    BeforeStart = table.Column<DateOnly>(type: "date", nullable: true),
                    AfterStart = table.Column<DateOnly>(type: "date", nullable: true),
                    BeforeAssigneeId = table.Column<Guid>(type: "uuid", nullable: true),
                    AfterAssigneeId = table.Column<Guid>(type: "uuid", nullable: true),
                    BeforeStatusId = table.Column<Guid>(type: "uuid", nullable: false),
                    AfterStatusId = table.Column<Guid>(type: "uuid", nullable: false),
                    Effect = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    UndoneAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TaskChanges", x => x.Id);
                });
            migrationBuilder.CreateIndex(name: "IX_TaskChanges_TenantId_TaskId_CreatedAt", table: "TaskChanges", columns: new[] { "TenantId", "TaskId", "CreatedAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "TaskChanges");
            migrationBuilder.DropTable(name: "TaskWatchers");
        }
    }
}
