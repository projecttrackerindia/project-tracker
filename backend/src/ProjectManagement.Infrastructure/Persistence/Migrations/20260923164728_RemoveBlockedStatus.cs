using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// The "Blocked" status is gone from the product: the workflow category, the default status and the timeline stage status.
    /// Enums are stored by name, so existing rows are converted here before the code stops knowing the value.
    /// Tasks in a project's "Blocked" status move to its first Active status (else its first To do status) and the status is
    /// removed, together with any automation rule that pointed at it; any other status that used the Blocked category keeps
    /// its name and becomes Active. Blocked timeline stages and milestones become In progress, and the stage "blocked
    /// reason" column is dropped.
    /// </summary>
    public partial class RemoveBlockedStatus : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            const string blockedIds = "(SELECT \"Id\" FROM \"WorkflowStatuses\" WHERE \"Category\" = 'Blocked' AND \"Name\" = 'Blocked')";
            migrationBuilder.Sql($"DELETE FROM \"AutomationRules\" WHERE \"WhenStatusId\" IN {blockedIds} OR \"ActionStatusId\" IN {blockedIds};");
            migrationBuilder.Sql(
                "UPDATE \"Tasks\" t SET \"StatusId\" = COALESCE(" +
                "(SELECT s.\"Id\" FROM \"WorkflowStatuses\" s WHERE s.\"ProjectId\" = t.\"ProjectId\" AND s.\"Category\" = 'Active' ORDER BY s.\"Order\" LIMIT 1), " +
                "(SELECT s.\"Id\" FROM \"WorkflowStatuses\" s WHERE s.\"ProjectId\" = t.\"ProjectId\" AND s.\"Category\" = 'Todo' ORDER BY s.\"Order\" LIMIT 1)), " +
                "\"Version\" = t.\"Version\" + 1, \"UpdatedAt\" = NOW() " +
                $"WHERE t.\"StatusId\" IN {blockedIds};");
            migrationBuilder.Sql("DELETE FROM \"WorkflowStatuses\" WHERE \"Category\" = 'Blocked' AND \"Name\" = 'Blocked';");
            migrationBuilder.Sql("UPDATE \"WorkflowStatuses\" SET \"Category\" = 'Active' WHERE \"Category\" = 'Blocked';");
            migrationBuilder.Sql("UPDATE \"ProjectStages\" SET \"Status\" = 'InProgress' WHERE \"Status\" = 'Blocked';");
            migrationBuilder.Sql("UPDATE \"Milestones\" SET \"Status\" = 'InProgress' WHERE \"Status\" = 'Blocked';");

            migrationBuilder.DropColumn(
                name: "BlockedReason",
                table: "ProjectStages");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "BlockedReason",
                table: "ProjectStages",
                type: "text",
                nullable: true);
        }
    }
}
