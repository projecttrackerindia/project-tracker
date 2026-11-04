using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Date history for every date that can slip, not only due dates of projects and tasks: start dates, action items, milestones and phases.
    /// Three nullable columns on DueDateChanges (what moved, its id, which date); every existing row stays a project or task due-date change.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261220001000_DateChangesForEveryDate")]
    public partial class DateChangesForEveryDate : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "EntityType",
                table: "DueDateChanges",
                type: "character varying(20)",
                maxLength: 20,
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "EntityId",
                table: "DueDateChanges",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Field",
                table: "DueDateChanges",
                type: "character varying(20)",
                maxLength: 20,
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_DueDateChanges_EntityId",
                table: "DueDateChanges",
                column: "EntityId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(name: "IX_DueDateChanges_EntityId", table: "DueDateChanges");
            migrationBuilder.DropColumn(name: "EntityType", table: "DueDateChanges");
            migrationBuilder.DropColumn(name: "EntityId", table: "DueDateChanges");
            migrationBuilder.DropColumn(name: "Field", table: "DueDateChanges");
        }
    }
}
