using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Module consolidation:
    /// - Action items become work tasks of the kind "ActionItem" (one model for follow-ups and operational work). Every existing action
    ///   item is copied across first, keeping its id, its project, its people, its dates and its status, and numbered after the workspace's
    ///   existing work tasks; only then is the old table dropped. Runs in one transaction, so it either all happens or none of it does.
    /// - Time entries can belong to a work task as well as to a project task (exactly one of the two).
    /// - Projects get a delivery method (existing projects: Hybrid, which keeps every planning tool they have today).
    /// - Milestones can mark the end of a timeline stage.
    /// </summary>
    public partial class ModuleConsolidation : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // ---- work tasks can hold action items
            migrationBuilder.AlterColumn<Guid>(
                name: "WorkTypeId",
                table: "WorkTasks",
                type: "uuid",
                nullable: true,
                oldClrType: typeof(Guid),
                oldType: "uuid");

            migrationBuilder.AddColumn<Guid>(
                name: "CompletedBy",
                table: "WorkTasks",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Kind",
                table: "WorkTasks",
                type: "character varying(32)",
                maxLength: 32,
                nullable: false,
                defaultValue: "Operational");

            // ---- move every action item across, then drop the old table
            migrationBuilder.Sql("""
                INSERT INTO "WorkTasks" ("Id", "TenantId", "Kind", "Number", "Title", "Description", "WorkTypeId", "RelatedProjectId", "AssigneeId", "ReporterId",
                    "Priority", "Status", "StartDate", "DueDate", "CompletedAt", "CompletedBy", "Version", "IsDeleted", "DeletedAt", "DeletedBy",
                    "CreatedAt", "CreatedBy", "UpdatedAt", "UpdatedBy")
                SELECT a."Id", a."TenantId", 'ActionItem',
                    COALESCE((SELECT MAX(w."Number") FROM "WorkTasks" w WHERE w."TenantId" = a."TenantId"), 0)
                        + ROW_NUMBER() OVER (PARTITION BY a."TenantId" ORDER BY a."CreatedAt", a."Id"),
                    a."Title", a."Details", NULL, a."ProjectId", a."AssigneeId", COALESCE(a."CreatedBy", p."OwnerId"),
                    a."Priority",
                    CASE a."Status" WHEN 'Open' THEN 'ToDo' WHEN 'InProgress' THEN 'InProgress' ELSE 'Completed' END,
                    NULL, a."DueDate", a."CompletedAt", a."CompletedBy", 1, FALSE, NULL, NULL,
                    a."CreatedAt", a."CreatedBy", a."UpdatedAt", a."UpdatedBy"
                FROM "ActionItems" a
                JOIN "Projects" p ON p."Id" = a."ProjectId";
                """);

            migrationBuilder.DropTable(
                name: "ActionItems");

            // ---- time on work tasks
            migrationBuilder.AlterColumn<Guid>(
                name: "TaskId",
                table: "TimeEntries",
                type: "uuid",
                nullable: true,
                oldClrType: typeof(Guid),
                oldType: "uuid");

            migrationBuilder.AlterColumn<Guid>(
                name: "ProjectId",
                table: "TimeEntries",
                type: "uuid",
                nullable: true,
                oldClrType: typeof(Guid),
                oldType: "uuid");

            migrationBuilder.AddColumn<Guid>(
                name: "WorkTaskId",
                table: "TimeEntries",
                type: "uuid",
                nullable: true);

            // ---- delivery method and milestone stages
            migrationBuilder.AddColumn<string>(
                name: "DeliveryMethod",
                table: "Projects",
                type: "character varying(32)",
                maxLength: 32,
                nullable: false,
                defaultValue: "Hybrid");

            migrationBuilder.AddColumn<Guid>(
                name: "StageId",
                table: "Milestones",
                type: "uuid",
                nullable: true);

            // ---- indexes, constraints and keys
            migrationBuilder.CreateIndex(
                name: "IX_WorkTasks_TenantId_Kind_RelatedProjectId",
                table: "WorkTasks",
                columns: new[] { "TenantId", "Kind", "RelatedProjectId" });

            migrationBuilder.CreateIndex(
                name: "IX_TimeEntries_WorkTaskId_WorkDate",
                table: "TimeEntries",
                columns: new[] { "WorkTaskId", "WorkDate" });

            migrationBuilder.AddCheckConstraint(
                name: "CK_TimeEntries_OneTarget",
                table: "TimeEntries",
                sql: "(\"TaskId\" IS NOT NULL AND \"WorkTaskId\" IS NULL) OR (\"TaskId\" IS NULL AND \"WorkTaskId\" IS NOT NULL)");

            migrationBuilder.CreateIndex(
                name: "IX_Milestones_StageId",
                table: "Milestones",
                column: "StageId");

            migrationBuilder.AddForeignKey(
                name: "FK_Milestones_ProjectStages_StageId",
                table: "Milestones",
                column: "StageId",
                principalTable: "ProjectStages",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);

            migrationBuilder.AddForeignKey(
                name: "FK_TimeEntries_WorkTasks_WorkTaskId",
                table: "TimeEntries",
                column: "WorkTaskId",
                principalTable: "WorkTasks",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // ---- recreate the action items table and move action items back into it
            migrationBuilder.CreateTable(
                name: "ActionItems",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    AssigneeId = table.Column<Guid>(type: "uuid", nullable: true),
                    CompletedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CompletedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    Details = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    DueDate = table.Column<DateOnly>(type: "date", nullable: true),
                    Priority = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    ProjectId = table.Column<Guid>(type: "uuid", nullable: false),
                    Status = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    Title = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ActionItems", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ActionItems_ProjectId_Status",
                table: "ActionItems",
                columns: new[] { "ProjectId", "Status" });

            migrationBuilder.CreateIndex(
                name: "IX_ActionItems_TenantId_AssigneeId",
                table: "ActionItems",
                columns: new[] { "TenantId", "AssigneeId" });

            migrationBuilder.Sql("""
                INSERT INTO "ActionItems" ("Id", "TenantId", "ProjectId", "Title", "Details", "AssigneeId", "DueDate", "Priority", "Status",
                    "CompletedAt", "CompletedBy", "CreatedAt", "CreatedBy", "UpdatedAt", "UpdatedBy")
                SELECT w."Id", w."TenantId", w."RelatedProjectId", w."Title", LEFT(w."Description", 2000), w."AssigneeId", w."DueDate", w."Priority",
                    CASE w."Status" WHEN 'ToDo' THEN 'Open' WHEN 'Completed' THEN 'Completed' WHEN 'Cancelled' THEN 'Completed' ELSE 'InProgress' END,
                    w."CompletedAt", w."CompletedBy", w."CreatedAt", w."CreatedBy", w."UpdatedAt", w."UpdatedBy"
                FROM "WorkTasks" w
                WHERE w."Kind" = 'ActionItem' AND w."IsDeleted" = FALSE AND w."RelatedProjectId" IS NOT NULL;
                DELETE FROM "TimeEntries" WHERE "WorkTaskId" IS NOT NULL;
                DELETE FROM "WorkTaskComments" WHERE "WorkTaskId" IN (SELECT "Id" FROM "WorkTasks" WHERE "Kind" = 'ActionItem');
                DELETE FROM "WorkTaskAttachments" WHERE "WorkTaskId" IN (SELECT "Id" FROM "WorkTasks" WHERE "Kind" = 'ActionItem');
                DELETE FROM "WorkTasks" WHERE "Kind" = 'ActionItem';
                """);

            migrationBuilder.DropForeignKey(
                name: "FK_Milestones_ProjectStages_StageId",
                table: "Milestones");

            migrationBuilder.DropForeignKey(
                name: "FK_TimeEntries_WorkTasks_WorkTaskId",
                table: "TimeEntries");

            migrationBuilder.DropIndex(
                name: "IX_WorkTasks_TenantId_Kind_RelatedProjectId",
                table: "WorkTasks");

            migrationBuilder.DropIndex(
                name: "IX_TimeEntries_WorkTaskId_WorkDate",
                table: "TimeEntries");

            migrationBuilder.DropCheckConstraint(
                name: "CK_TimeEntries_OneTarget",
                table: "TimeEntries");

            migrationBuilder.DropIndex(
                name: "IX_Milestones_StageId",
                table: "Milestones");

            migrationBuilder.DropColumn(
                name: "CompletedBy",
                table: "WorkTasks");

            migrationBuilder.DropColumn(
                name: "Kind",
                table: "WorkTasks");

            migrationBuilder.DropColumn(
                name: "WorkTaskId",
                table: "TimeEntries");

            migrationBuilder.DropColumn(
                name: "DeliveryMethod",
                table: "Projects");

            migrationBuilder.DropColumn(
                name: "StageId",
                table: "Milestones");

            migrationBuilder.AlterColumn<Guid>(
                name: "WorkTypeId",
                table: "WorkTasks",
                type: "uuid",
                nullable: false,
                defaultValue: new Guid("00000000-0000-0000-0000-000000000000"),
                oldClrType: typeof(Guid),
                oldType: "uuid",
                oldNullable: true);

            migrationBuilder.AlterColumn<Guid>(
                name: "TaskId",
                table: "TimeEntries",
                type: "uuid",
                nullable: false,
                defaultValue: new Guid("00000000-0000-0000-0000-000000000000"),
                oldClrType: typeof(Guid),
                oldType: "uuid",
                oldNullable: true);

            migrationBuilder.AlterColumn<Guid>(
                name: "ProjectId",
                table: "TimeEntries",
                type: "uuid",
                nullable: false,
                defaultValue: new Guid("00000000-0000-0000-0000-000000000000"),
                oldClrType: typeof(Guid),
                oldType: "uuid",
                oldNullable: true);
        }
    }
}
