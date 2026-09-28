using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class TaskStageLink : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "StageId",
                table: "Tasks",
                type: "uuid",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_Tasks_StageId",
                table: "Tasks",
                column: "StageId");

            migrationBuilder.AddForeignKey(
                name: "FK_Tasks_ProjectStages_StageId",
                table: "Tasks",
                column: "StageId",
                principalTable: "ProjectStages",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_Tasks_ProjectStages_StageId",
                table: "Tasks");

            migrationBuilder.DropIndex(
                name: "IX_Tasks_StageId",
                table: "Tasks");

            migrationBuilder.DropColumn(
                name: "StageId",
                table: "Tasks");
        }
    }
}
