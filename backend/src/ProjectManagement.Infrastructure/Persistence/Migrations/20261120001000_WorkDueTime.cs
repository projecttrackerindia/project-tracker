using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ProjectManagement.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Due times: a task, issue, action item or ticket can be due at a time of day on its due date (in the workspace's zone), not only by the
    /// end of the day. One new nullable column on WorkItems; every existing item keeps a date-only due.
    /// </summary>
    [DbContext(typeof(AppDbContext))]
    [Migration("20261120001000_WorkDueTime")]
    public partial class WorkDueTime : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<TimeOnly>(
                name: "DueTime",
                table: "WorkItems",
                type: "time without time zone",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(name: "DueTime", table: "WorkItems");
        }
    }
}
